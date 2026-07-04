// VisualizerHost: owns the single rAF loop, the active plugin, the render
// SURFACE, preset catalog + cycling, fullscreen, pop-out, and video playback.
//
// The host renders onto a host-owned VizSurface (a fresh <canvas> + a <video>)
// rather than drawing on the skin's canvas directly. That fixes two things:
//   - a fresh canvas per plugin never carries a stale WebGL/2D context (the
//     spectrum-bars bug), and
//   - video shares the surface with the visualizer, so a video plays exactly
//     where the visualizer would — mini view, pop-out window, or fullscreen.
// The skin's canvas is used only as a positioning anchor (+ its own clicks).

import type { PlayState, PresetInfo, Settings, VizCycleOptions } from '../../../shared/types'
import { native } from '../native'
import { Emitter } from '../emitter'
import type { AudioGraph } from '../audio/graph'
import { PluginRegistry, type VisualizerPlugin } from './plugin'
import { createBarsPlugin } from './barsPlugin'
import { createButterchurnPlugin, isButterchurnHandle } from './butterchurnPlugin'
import { PresetCatalog } from './presets'
import { VizSurface, type SurfaceMount } from './surface'
import { VideoStreamPlayer } from '../audio/videoStream'

const DEFAULT_BLEND_SEC = 2.7

export interface VideoState {
  playing: boolean
  position: number
  duration: number
}

interface HostEvents extends Record<string, unknown[]> {
  preset: [PresetInfo]
  videoState: [VideoState]
  videoEnded: []
  videoError: [message: string]
}

/** Minimal transport surface for the pop-out / fullscreen buttons — provided by
 *  the shell so the host stays decoupled from the controller. */
export interface TransportControls {
  togglePlay(): void
  stop(): void
  next(): void
  previous(): void
  getState(): PlayState
  onState(cb: (s: PlayState) => void): () => void
  /** 0..1 */
  getVolume(): number
  setVolume(v: number): void
  onVolume(cb: (v: number) => void): () => void
}

export class VisualizerHost {
  readonly events = new Emitter<HostEvents>()
  readonly registry = new PluginRegistry()
  readonly catalog = new PresetCatalog()

  private graph: AudioGraph
  private surface: VizSurface | null = null
  /** Click/dblclick target for host-owned ('own') mounts; used by tests too. */
  private surfaceInteraction: HTMLElement | null = null
  /** Last skin canvas from attach() — where to return after pop-out/fullscreen. */
  private skinAnchor: HTMLElement | null = null

  private active: VisualizerPlugin | null = null
  private activeId = 'butterchurn'
  private rafId: number | null = null
  private frameCount = 0
  private startedAt = 0
  private resizeObserver: ResizeObserver | null = null

  private currentPresetId: string | null = null
  private cycle: VizCycleOptions = { enabled: true, intervalSec: 25, random: true }
  private cycleTimer: number | null = null
  private lastPresetError: string | null = null

  // Video state (independent of which surface is showing it). 'url' plays a
  // file directly; 'stream' plays a progressive ffmpeg→MSE conversion.
  private mode: 'viz' | 'video' = 'viz'
  private videoSrc:
    | { kind: 'url'; url: string }
    | { kind: 'stream'; path: string; durationSec: number }
    | null = null
  private streamPlayer: VideoStreamPlayer | null = null
  private videoPosition = 0
  private videoVolume = 1

  // Fullscreen + pop-out.
  private fsContainer: HTMLElement | null = null
  private popoutWin: Window | null = null
  private popoutWatch: number | null = null
  private transport: TransportControls | null = null
  private transportUnsub: (() => void) | null = null

  constructor(graph: AudioGraph) {
    this.graph = graph
    this.registry.register(createButterchurnPlugin(), 'builtin')
    this.registry.register(createBarsPlugin(), 'builtin')

    document.addEventListener('visibilitychange', () => {
      if (this.mode !== 'viz') return
      if (document.visibilityState === 'visible') this.startLoop()
      else if (!this.isPoppedOut()) this.stopLoop()
    })
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && this.fsContainer) this.exitFullscreenCleanup()
    })
  }

  attachTransport(transport: TransportControls): void {
    this.transport = transport
  }

  init(settings: Settings): void {
    if (this.registry.get(settings.activeVisualizer)) this.activeId = settings.activeVisualizer
    this.currentPresetId = settings.vizPresetId
    this.cycle = { ...settings.vizCycle }
    void this.catalog.load()
  }

  getDebugInfo(): {
    activeId: string
    frameCount: number
    presetId: string | null
    lastPresetError: string | null
    mode: 'viz' | 'video'
  } {
    return {
      activeId: this.activeId,
      frameCount: this.frameCount,
      presetId: this.currentPresetId,
      lastPresetError: this.lastPresetError,
      mode: this.mode
    }
  }

  // ---- surface lifecycle -----------------------------------------------------

  /** Called by skins via ampwin.visualizer.attach(canvas). The canvas is the
   *  positioning anchor; the host overlays its own surface on it. */
  async attach(skinCanvas: HTMLCanvasElement): Promise<void> {
    this.skinAnchor = skinCanvas
    // Pop-out / fullscreen own the surface; a skin (re)attach just updates the
    // return target without stealing the visualizer away from them.
    if (this.isPoppedOut() || this.fsContainer) return
    await this.mount({ kind: 'overlay', anchor: skinCanvas })
  }

  detach(): void {
    this.teardownSurface()
    this.skinAnchor = null
  }

  private teardownSurface(): void {
    // The stream player is bound to this surface's <video>; a new surface
    // (pop-out/fullscreen swap) gets a fresh player resumed at videoPosition.
    this.streamPlayer?.destroy()
    this.streamPlayer = null
    this.stopLoop()
    this.stopCycleTimer()
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    if (this.active) {
      try {
        this.active.destroy()
      } catch (err) {
        console.error('visualizer destroy failed', err)
      }
      this.active = null
    }
    this.surface?.destroy()
    this.surface = null
    this.surfaceInteraction = null
  }

  // ---- test hooks ------------------------------------------------------------

  /** Which context the active surface canvas holds — proves the fresh-canvas
   *  fix: Butterchurn → 'webgl', spectrum bars → '2d'. */
  debugCanvasContext(): 'webgl' | '2d' | 'none' {
    const c = this.surface?.canvas
    if (!c) return 'none'
    if (c.getContext('webgl') || c.getContext('webgl2')) return 'webgl'
    if (c.getContext('2d')) return '2d'
    return 'none'
  }

  /** Fire the surface's click handler (fullscreen/pop-out) as a real click would. */
  debugClickSurface(): void {
    this.surfaceInteraction?.click()
  }

  /** Verify the mini-view overlay sits exactly on the skin's anchor canvas —
   *  if it didn't, the visualizer and video would render off-screen. */
  debugSurfaceMatchesAnchor(): { ok: boolean; detail: string } | null {
    if (!this.surface || !this.skinAnchor) return null
    const a = this.skinAnchor.getBoundingClientRect()
    const s = this.surface.canvas.getBoundingClientRect()
    const ok =
      Math.abs(a.left - s.left) < 2 &&
      Math.abs(a.top - s.top) < 2 &&
      Math.abs(a.width - s.width) < 2 &&
      Math.abs(a.height - s.height) < 2
    return {
      ok,
      detail: `anchor ${a.width.toFixed(0)}x${a.height.toFixed(0)}@${a.left.toFixed(0)},${a.top.toFixed(0)} vs surface ${s.width.toFixed(0)}x${s.height.toFixed(0)}@${s.left.toFixed(0)},${s.top.toFixed(0)}`
    }
  }

  private async mount(mountSpec: SurfaceMount): Promise<void> {
    this.teardownSurface()
    this.surface = new VizSurface(mountSpec)
    if (mountSpec.kind === 'own') this.bindInteraction(this.surface.interactionTarget)
    await this.initActivePlugin()
    this.applyMode()
  }

  private bindInteraction(el: HTMLElement): void {
    this.surfaceInteraction = el
    el.style.cursor = 'pointer'
    el.addEventListener('click', () => {
      if (this.mode === 'video') this.transport?.togglePlay()
      else this.randomPreset()
    })
    el.addEventListener('dblclick', () => {
      // Double-click exits fullscreen; harmless in the pop-out.
      if (this.fsContainer) void this.setFullscreen(false)
    })
  }

  private async initActivePlugin(): Promise<void> {
    if (!this.surface) return
    const plugin = this.registry.get(this.activeId) ?? this.registry.get('bars')!
    this.active = plugin

    const canvas = this.surface.canvas
    const dpr = this.surface.view.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    canvas.width = Math.max(1, Math.round(rect.width * dpr))
    canvas.height = Math.max(1, Math.round(rect.height * dpr))

    try {
      await plugin.init({
        canvas,
        audioContext: this.graph.ctx,
        sourceNode: this.graph.vizSource,
        analyser: this.graph.analyser
      })
    } catch (err) {
      console.error(`visualizer "${plugin.id}" init failed`, err)
      void native.invoke('dev:log', `[viz] init failed for ${plugin.id}: ${(err as Error)?.stack ?? err}`)
      this.active = null
      return
    }

    const ro = new this.surface.view.ResizeObserver(() => this.refreshCanvasSize())
    this.resizeObserver = ro
    ro.observe(canvas)

    try {
      await this.applyCurrentPreset(0)
    } catch (err) {
      this.lastPresetError = String(err)
      console.error('initial preset failed', err)
    }
  }

  refreshCanvasSize(): void {
    if (!this.surface || !this.active) return
    const c = this.surface.canvas
    const dpr = this.surface.view.devicePixelRatio || 1
    const r = c.getBoundingClientRect()
    const w = Math.max(1, Math.round(r.width * dpr))
    const h = Math.max(1, Math.round(r.height * dpr))
    if (w !== c.width || h !== c.height) {
      c.width = w
      c.height = h
      this.active.resize(w, h)
    }
  }

  private startLoop(): void {
    if (this.rafId !== null || !this.active || this.mode !== 'viz') return
    this.startedAt = performance.now()
    const tick = (): void => {
      this.rafId = requestAnimationFrame(tick)
      if (this.active) {
        try {
          this.active.render({
            elapsedMs: performance.now() - this.startedAt,
            frameCount: this.frameCount++
          })
        } catch (err) {
          console.error('visualizer render failed; detaching', err)
          this.teardownSurface()
        }
      }
    }
    this.rafId = requestAnimationFrame(tick)
  }

  private stopLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
  }

  // ---- viz vs video ----------------------------------------------------------

  private applyMode(): void {
    if (!this.surface) return
    if (this.mode === 'video') {
      this.surface.showVideo()
      this.stopLoop()
      this.stopCycleTimer()
      this.wireVideo()
    } else {
      this.surface.showCanvas()
      this.startLoop()
      this.startCycleTimer()
    }
  }

  private wireVideo(): void {
    const v = this.surface?.video
    if (!v || this.videoSrc == null) return
    v.volume = this.videoVolume
    v.ontimeupdate = (): void => {
      this.videoPosition = v.currentTime
      this.emitVideoState()
    }
    v.onplay = (): void => this.emitVideoState()
    v.onpause = (): void => this.emitVideoState()
    v.onended = (): void => this.events.emit('videoEnded')
    v.onerror = (): void => {
      const codes = ['', 'aborted', 'network error', 'decode failed', 'format not supported']
      const msg = `${codes[v.error?.code ?? 0] || 'unknown'}${v.error?.message ? ` (${v.error.message})` : ''}`
      console.error('video element error:', msg)
      this.events.emit('videoError', msg)
    }

    if (this.videoSrc.kind === 'url') {
      v.onloadedmetadata = (): void => {
        if (this.videoPosition > 0) v.currentTime = this.videoPosition
      }
      v.src = this.videoSrc.url
      void v.play().catch((err) => console.error('video play failed', err))
    } else {
      // Progressive stream: the player owns src (MediaSource) and resumes at
      // the remembered position (surface swaps mid-video restart the stream).
      this.streamPlayer = new VideoStreamPlayer(v, this.videoSrc.path, this.videoSrc.durationSec)
      void this.streamPlayer.start(this.videoPosition).catch((err) => {
        console.error('video stream start failed', err)
        this.events.emit('videoError', (err as Error).message)
      })
    }
  }

  private emitVideoState(): void {
    const v = this.surface?.video
    if (!v) return
    this.events.emit('videoState', {
      playing: !v.paused && !v.ended,
      position: v.currentTime,
      duration: isFinite(v.duration) ? v.duration : 0
    })
  }

  /** Show a directly-playable video file on the active surface. */
  showVideo(url: string, opts: { positionSec?: number; volume?: number } = {}): void {
    this.stopVideoPlayback()
    this.mode = 'video'
    this.videoSrc = { kind: 'url', url }
    this.videoPosition = opts.positionSec ?? 0
    if (opts.volume != null) this.videoVolume = opts.volume
    this.applyMode()
  }

  /** Progressively stream a video that Chromium can't play directly —
   *  playback starts immediately while ffmpeg converts ahead of the playhead. */
  showVideoStream(
    path: string,
    durationSec: number,
    opts: { positionSec?: number; volume?: number } = {}
  ): void {
    this.stopVideoPlayback()
    this.mode = 'video'
    this.videoSrc = { kind: 'stream', path, durationSec }
    this.videoPosition = opts.positionSec ?? 0
    if (opts.volume != null) this.videoVolume = opts.volume
    this.applyMode()
  }

  private stopVideoPlayback(): void {
    this.streamPlayer?.destroy()
    this.streamPlayer = null
    const v = this.surface?.video
    if (v) {
      try {
        v.pause()
      } catch {
        /* ignore */
      }
      v.removeAttribute('src')
      v.load()
    }
  }

  /** Leave video mode; the visualizer returns to the surface. */
  returnToVisualizer(): void {
    this.stopVideoPlayback()
    this.mode = 'viz'
    this.videoSrc = null
    this.videoPosition = 0
    this.applyMode()
  }

  isVideoMode(): boolean {
    return this.mode === 'video'
  }

  playVideo(): void {
    void this.surface?.video.play().catch(() => {})
  }

  pauseVideo(): void {
    this.surface?.video.pause()
  }

  seekVideo(seconds: number): void {
    if (this.streamPlayer) {
      this.streamPlayer.seek(seconds)
      return
    }
    const v = this.surface?.video
    if (v && isFinite(v.duration)) v.currentTime = Math.min(Math.max(0, seconds), v.duration)
  }

  setVideoVolume(vol: number): void {
    this.videoVolume = Math.min(1, Math.max(0, vol))
    if (this.surface) this.surface.video.volume = this.videoVolume
  }

  // ---- visualizer selection --------------------------------------------------

  getActiveVisualizerId(): string {
    return this.activeId
  }

  listVisualizers(): { id: string; name: string }[] {
    return this.registry.list()
  }

  async setActiveVisualizer(id: string): Promise<void> {
    if (!this.registry.get(id)) throw new Error(`unknown visualizer: ${id}`)
    if (id === this.activeId && this.active) return
    this.activeId = id
    void native.invoke('store:settings:patch', { activeVisualizer: id })
    // Re-init the plugin on a fresh canvas (new context type is fine now).
    if (this.surface && this.active) {
      try {
        this.active.destroy()
      } catch {
        /* ignore */
      }
      this.active = null
      this.resizeObserver?.disconnect()
      this.resizeObserver = null
      // Recreate the canvas so a WebGL→2D switch gets a clean context.
      await this.remountSameTarget()
    }
  }

  /** Rebuild the surface at its current location (used to get a fresh canvas). */
  private async remountSameTarget(): Promise<void> {
    if (this.popoutWin && !this.popoutWin.closed) {
      const stage = this.popoutWin.document.getElementById('stage')
      if (stage) await this.mount({ kind: 'own', container: stage })
    } else if (this.fsContainer) {
      await this.mount({ kind: 'own', container: this.fsContainer })
    } else if (this.skinAnchor) {
      await this.mount({ kind: 'overlay', anchor: this.skinAnchor })
    }
  }

  onSkinTeardown(): void {
    const removed = this.registry.removeSkinOwned()
    if (removed.includes(this.activeId)) this.activeId = 'butterchurn'
    if (this.fsContainer) void this.setFullscreen(false)
    // A pop-out keeps rendering; only its return target dies with the skin.
    if (this.isPoppedOut()) {
      this.skinAnchor = null
      return
    }
    this.teardownSurface()
    this.skinAnchor = null
  }

  /** An addon was disabled/uninstalled: drop its visualizer plugins. If one of
   *  them was active, fall back to butterchurn and re-init on the live surface
   *  so the view keeps rendering. */
  onAddonTeardown(addonId: string): void {
    const removed = this.registry.removeAddonOwned(addonId)
    if (removed.includes(this.activeId)) {
      this.activeId = 'butterchurn'
      if (this.surface && this.mode === 'viz') void this.remountSameTarget()
    }
  }

  // ---- presets ---------------------------------------------------------------

  listPresets(): PresetInfo[] {
    return this.catalog.list()
  }

  getCurrentPresetId(): string | null {
    return this.currentPresetId
  }

  loadPreset(id: string, blendSec = DEFAULT_BLEND_SEC): void {
    void this.loadPresetAsync(id, blendSec, true)
  }

  private async loadPresetAsync(id: string, blendSec: number, persist: boolean): Promise<void> {
    await this.catalog.load()
    const preset = await this.catalog.get(id)
    if (!preset) return
    this.currentPresetId = id
    if (isButterchurnHandle(this.active)) {
      try {
        this.active.loadPresetObject(preset, blendSec)
        this.lastPresetError = null
      } catch (err) {
        this.lastPresetError = String(err)
        console.error(`preset "${id}" failed to load`, err)
        return
      }
    }
    const info = this.catalog.list().find((p) => p.id === id)
    if (info) this.events.emit('preset', info)
    if (persist) void native.invoke('store:settings:patch', { vizPresetId: id })
    this.restartCycleTimer()
  }

  private async applyCurrentPreset(blendSec: number): Promise<void> {
    if (!isButterchurnHandle(this.active)) return
    await this.catalog.load()
    let id = this.currentPresetId
    if (!id || !(await this.catalog.get(id))) id = this.catalog.randomId()
    if (id) await this.loadPresetAsync(id, blendSec, false)
  }

  nextPreset(): void {
    const id = this.catalog.neighborId(this.currentPresetId, 1)
    if (id) this.loadPreset(id)
  }

  prevPreset(): void {
    const id = this.catalog.neighborId(this.currentPresetId, -1)
    if (id) this.loadPreset(id)
  }

  randomPreset(): void {
    const id = this.catalog.randomId(this.currentPresetId ?? undefined)
    if (id) this.loadPreset(id)
  }

  setCycle(opts: { enabled: boolean; intervalSec?: number; random?: boolean }): void {
    this.cycle = {
      enabled: opts.enabled,
      intervalSec: Math.max(5, opts.intervalSec ?? this.cycle.intervalSec),
      random: opts.random ?? this.cycle.random
    }
    void native.invoke('store:settings:patch', { vizCycle: this.cycle })
    this.restartCycleTimer()
  }

  getCycle(): VizCycleOptions {
    return { ...this.cycle }
  }

  private startCycleTimer(): void {
    this.stopCycleTimer()
    if (!this.cycle.enabled || !this.surface || this.mode !== 'viz') return
    this.cycleTimer = window.setInterval(() => {
      if (this.cycle.random) this.randomPreset()
      else this.nextPreset()
    }, this.cycle.intervalSec * 1000)
  }

  private stopCycleTimer(): void {
    if (this.cycleTimer !== null) {
      clearInterval(this.cycleTimer)
      this.cycleTimer = null
    }
  }

  private restartCycleTimer(): void {
    if (this.cycleTimer !== null || this.cycle.enabled) this.startCycleTimer()
  }

  showTitle(title: string): void {
    if (isButterchurnHandle(this.active)) this.active.showTitle(title)
  }

  async importPresetFiles(): Promise<PresetInfo[]> {
    const paths = await native.invoke('dialog:open-files', 'preset')
    if (paths.length === 0) return []
    const imported = await native.invoke('presets:import-files', paths)
    await this.catalog.refreshUser()
    if (imported.length > 0) this.loadPreset(imported[0].id)
    return imported
  }

  // ---- pop-out window --------------------------------------------------------

  isPoppedOut(): boolean {
    return this.popoutWin !== null && !this.popoutWin.closed
  }

  popOut(): void {
    if (this.isPoppedOut()) {
      this.popoutWin!.focus()
      return
    }
    if (this.fsContainer) void this.setFullscreen(false)

    const win = window.open('about:blank', 'ampwin-viz')
    if (!win) {
      console.error('viz pop-out was blocked')
      return
    }
    this.popoutWin = win

    const doc = win.document
    doc.title = 'Ampwin Visualizer'
    doc.head.innerHTML = `<style>
      * { margin: 0; box-sizing: border-box; user-select: none; }
      html, body { width: 100%; height: 100%; overflow: hidden; background: #000; }
      body { display: flex; flex-direction: column; font-family: 'Segoe UI', sans-serif; }
      #bar { display: flex; align-items: center; gap: 5px; padding: 5px 8px;
             background: linear-gradient(#20242c, #14171d); border-bottom: 1px solid #000;
             -webkit-app-region: drag; }
      #logo { font-size: 10px; font-weight: bold; letter-spacing: 2px; color: #3fdf6f; margin-right: 6px; }
      button { -webkit-app-region: no-drag; background: #1d222b; color: #cfd4dd;
               border: 1px solid #000; border-radius: 3px; min-width: 30px;
               padding: 3px 8px; font-size: 13px; cursor: pointer; }
      button:hover { background: #2a3140; }
      #x:hover { background: #7f1f1f; }
      #sp { flex: 1; }
      #vol { -webkit-app-region: no-drag; width: 70px; accent-color: #2d9f57; }
      #stage { flex: 1; min-height: 0; position: relative; }
    </style>`
    doc.body.innerHTML = `
      <div id="bar">
        <span id="logo">AMPWIN</span>
        <button id="b-prev" title="Previous">⏮</button>
        <button id="b-play" title="Play/Pause">▶</button>
        <button id="b-stop" title="Stop">⏹</button>
        <button id="b-next" title="Next">⏭</button>
        <span id="sp"></span>
        <span title="Volume">🔊</span>
        <input id="vol" type="range" min="0" max="100" value="80" title="Volume" />
        <button id="b-min" title="Minimize">–</button>
        <button id="x" title="Close">×</button>
      </div>
      <div id="stage"></div>`

    const t = this.transport
    const playBtn = doc.getElementById('b-play')!
    const setPlayGlyph = (s: PlayState): void => {
      playBtn.textContent = s === 'playing' ? '⏸' : '▶'
    }
    doc.getElementById('b-prev')!.addEventListener('click', () => t?.previous())
    playBtn.addEventListener('click', () => t?.togglePlay())
    doc.getElementById('b-stop')!.addEventListener('click', () => t?.stop())
    doc.getElementById('b-next')!.addEventListener('click', () => t?.next())
    doc.getElementById('b-min')!.addEventListener('click', () => void native.invoke('popout:minimize', 'ampwin-viz'))
    doc.getElementById('x')!.addEventListener('click', () => win.close())
    const volEl = doc.getElementById('vol') as HTMLInputElement
    if (t) {
      setPlayGlyph(t.getState())
      volEl.value = String(Math.round(t.getVolume() * 100))
      volEl.addEventListener('input', () => t.setVolume(Number(volEl.value) / 100))
      const unState = t.onState(setPlayGlyph)
      const unVol = t.onVolume((v) => (volEl.value = String(Math.round(v * 100))))
      this.transportUnsub = () => {
        unState()
        unVol()
      }
    }

    win.addEventListener('resize', () => this.refreshCanvasSize())
    win.addEventListener('unload', () => this.onPopoutClosed())
    this.popoutWatch = window.setInterval(() => {
      if (this.popoutWin && this.popoutWin.closed) this.onPopoutClosed()
    }, 1000)

    void this.mount({ kind: 'own', container: doc.getElementById('stage')! })
  }

  closePopout(): void {
    if (this.popoutWin && !this.popoutWin.closed) this.popoutWin.close()
    else this.onPopoutClosed()
  }

  private onPopoutClosed(): void {
    if (!this.popoutWin) return
    this.popoutWin = null
    if (this.popoutWatch !== null) {
      clearInterval(this.popoutWatch)
      this.popoutWatch = null
    }
    this.transportUnsub?.()
    this.transportUnsub = null
    this.teardownSurface()
    if (this.skinAnchor && this.skinAnchor.isConnected) {
      void this.mount({ kind: 'overlay', anchor: this.skinAnchor })
    }
  }

  // ---- fullscreen ------------------------------------------------------------

  async setFullscreen(on: boolean): Promise<void> {
    if (on && this.isPoppedOut()) return
    if (on && !this.fsContainer) {
      const container = document.createElement('div')
      container.style.cssText = 'position:absolute;inset:0;background:#000;pointer-events:auto'
      document.getElementById('overlay-layer')!.appendChild(container)
      this.fsContainer = container
      await container.requestFullscreen().catch(() => {})
      await this.mount({ kind: 'own', container })
    } else if (!on && this.fsContainer) {
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => {})
      this.exitFullscreenCleanup()
    }
  }

  private exitFullscreenCleanup(): void {
    this.teardownSurface()
    this.fsContainer?.remove()
    this.fsContainer = null
    if (this.skinAnchor && this.skinAnchor.isConnected) {
      void this.mount({ kind: 'overlay', anchor: this.skinAnchor })
    }
  }
}
