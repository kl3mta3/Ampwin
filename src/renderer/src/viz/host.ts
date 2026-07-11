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

import type { Lyrics, PlayState, PresetInfo, Settings, VizCycleOptions } from '../../../shared/types'
import { native } from '../native'
import { Emitter } from '../emitter'
import type { AudioGraph } from '../audio/graph'
import { PluginRegistry, type VisualizerPlugin } from './plugin'
import { createBarsPlugin } from './barsPlugin'
import { createBlackScreenPlugin } from './blackScreenPlugin'
import { createButterchurnPlugin, isButterchurnHandle } from './butterchurnPlugin'
import { LyricsOverlay } from './lyricsOverlay'
import { PresetCatalog } from './presets'
import { VizSurface, type SurfaceMount } from './surface'
import { VideoStreamPlayer } from '../audio/videoStream'
import { EmbedPlayer } from './embedPlayer'

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
  /** The set of available visualizers changed (addon registered/removed). */
  visualizers: [list: { id: string; name: string }[]]
  /** The current track/live source has lyrics to show (or no longer does). */
  'lyrics-available': [available: boolean]
  /** The show-lyrics toggle changed. */
  'lyrics-enabled': [enabled: boolean]
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
  /** seconds */
  getPosition(): number
  getDuration(): number
  seek(seconds: number): void
  onPosition(cb: (posSec: number, durSec: number) => void): () => void
}

const fmtT = (s: number): string =>
  isFinite(s) && s > 0 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00'

/** An auto-hiding transport overlay (buttons + seek + volume) pinned to the
 *  bottom of `host`. Appears on mouse move, fades after a few idle seconds.
 *  Used by BOTH the visualizer pop-out and fullscreen. Returns a teardown. */
function mountControlsOverlay(
  doc: Document,
  host: HTMLElement,
  t: TransportControls,
  opts: { win?: Window; frameName?: string; onExit?: () => void }
): () => void {
  const mk = (tag: string, css: string, text = ''): HTMLElement => {
    const el = doc.createElement(tag)
    el.style.cssText = css
    if (text) el.textContent = text
    return el
  }
  const BTN =
    "-webkit-app-region:no-drag;background:rgba(29,34,43,.9);color:#e6e9ef;border:1px solid #000;border-radius:4px;" +
    'min-width:34px;padding:5px 9px;font-size:15px;cursor:pointer'
  const bar = mk(
    'div',
    'position:absolute;left:0;right:0;bottom:0;z-index:6;display:flex;align-items:center;gap:8px;' +
      'padding:10px 14px;background:linear-gradient(transparent,rgba(6,8,11,.9));' +
      "font-family:'Segoe UI',sans-serif;opacity:0;pointer-events:none;transition:opacity .25s;-webkit-app-region:drag"
  )
  const prev = mk('button', BTN, '⏮')
  const play = mk('button', BTN, '▶')
  const stop = mk('button', BTN, '⏹')
  const next = mk('button', BTN, '⏭')
  const time = mk('span', '-webkit-app-region:no-drag;font-family:Consolas,monospace;font-size:12px;color:#8ce8ac;min-width:92px')
  const seek = mk('input', '-webkit-app-region:no-drag;flex:1;accent-color:#3fae66;cursor:pointer') as HTMLInputElement
  seek.type = 'range'
  seek.min = '0'
  seek.max = '1000'
  seek.value = '0'
  const volIcon = mk('span', 'font-size:14px', '🔊')
  const vol = mk('input', '-webkit-app-region:no-drag;width:84px;accent-color:#2d9f57;cursor:pointer') as HTMLInputElement
  vol.type = 'range'
  vol.min = '0'
  vol.max = '100'
  bar.append(prev, play, stop, next, time, seek, volIcon, vol)
  if (opts.frameName) {
    const min = mk('button', BTN, '–')
    const close = mk('button', BTN, '×')
    min.addEventListener('click', () => void native.invoke('popout:minimize', opts.frameName as 'ampwin-viz'))
    close.addEventListener('click', () => opts.win?.close())
    bar.append(min, close)
  } else if (opts.onExit) {
    const exit = mk('button', BTN, '⤢')
    exit.title = 'Exit fullscreen'
    exit.addEventListener('click', () => opts.onExit?.())
    bar.append(exit)
  }
  host.appendChild(bar)

  // ---- center controls (back 10s, play/pause, forward 30s) ----------------
  const CENTER_BTN =
    '-webkit-app-region:no-drag;background:rgba(20,24,32,.75);color:#e6e9ef;' +
    'border:2px solid rgba(255,255,255,.25);border-radius:50%;width:56px;height:56px;' +
    'font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center;' +
    'transition:background .15s,border-color .15s'
  const center = mk(
    'div',
    'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:6;' +
      'display:flex;align-items:center;gap:28px;opacity:0;pointer-events:none;transition:opacity .25s'
  )
  const back10 = mk('button', CENTER_BTN)
  back10.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 2a10 10 0 1 1-7.07 2.93"/><polyline points="2 2 2 7 7 7"/><text x="12" y="16" fill="currentColor" stroke="none" font-size="8" text-anchor="middle" font-weight="bold">10</text></svg>'
  back10.title = 'Back 10 seconds'
  const centerPlay = mk('button', CENTER_BTN.replace('width:56px;height:56px', 'width:66px;height:66px').replace('font-size:20px', 'font-size:26px'))
  centerPlay.textContent = '▶'
  centerPlay.title = 'Play / Pause'
  const fwd30 = mk('button', CENTER_BTN)
  fwd30.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.5 2a10 10 0 1 0 7.07 2.93"/><polyline points="22 2 22 7 17 7"/><text x="12" y="16" fill="currentColor" stroke="none" font-size="8" text-anchor="middle" font-weight="bold">30</text></svg>'
  fwd30.title = 'Forward 30 seconds'
  center.append(back10, centerPlay, fwd30)
  host.appendChild(center)

  back10.addEventListener('click', () => { t.seek(Math.max(0, t.getPosition() - 10)) })
  centerPlay.addEventListener('click', () => t.togglePlay())
  fwd30.addEventListener('click', () => { t.seek(Math.min(t.getDuration(), t.getPosition() + 30)) })

  // hover glow
  for (const btn of [back10, centerPlay, fwd30]) {
    btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(40,50,65,.9)'; btn.style.borderColor = 'rgba(255,255,255,.5)' })
    btn.addEventListener('mouseleave', () => { btn.style.background = 'rgba(20,24,32,.75)'; btn.style.borderColor = 'rgba(255,255,255,.25)' })
  }

  // ---- auto-hide -----------------------------------------------------------
  const view = doc.defaultView as Window & typeof globalThis
  let hideTimer: number | null = null
  const show = (): void => {
    bar.style.opacity = '1'
    bar.style.pointerEvents = 'auto'
    center.style.opacity = '1'
    center.style.pointerEvents = 'auto'
    if (hideTimer !== null) view.clearTimeout(hideTimer)
    hideTimer = view.setTimeout(() => {
      bar.style.opacity = '0'
      bar.style.pointerEvents = 'none'
      center.style.opacity = '0'
      center.style.pointerEvents = 'none'
    }, 2600)
  }
  host.addEventListener('mousemove', show)
  show() // flash on open

  // ---- wiring --------------------------------------------------------------
  const setGlyph = (s: PlayState): void => {
    play.textContent = s === 'playing' ? '⏸' : '▶'
    centerPlay.textContent = s === 'playing' ? '⏸' : '▶'
  }
  prev.addEventListener('click', () => t.previous())
  play.addEventListener('click', () => t.togglePlay())
  stop.addEventListener('click', () => t.stop())
  next.addEventListener('click', () => t.next())
  let seeking = false
  seek.addEventListener('pointerdown', () => (seeking = true))
  seek.addEventListener('input', () => {
    const d = t.getDuration()
    if (d > 0) time.textContent = `${fmtT((Number(seek.value) / 1000) * d)} / ${fmtT(d)}`
  })
  seek.addEventListener('change', () => {
    const d = t.getDuration()
    if (d > 0) t.seek((Number(seek.value) / 1000) * d)
    seeking = false
  })
  vol.addEventListener('input', () => t.setVolume(Number(vol.value) / 100))

  setGlyph(t.getState())
  vol.value = String(Math.round(t.getVolume() * 100))
  const p0 = t.getPosition()
  const d0 = t.getDuration()
  time.textContent = `${fmtT(p0)} / ${fmtT(d0)}`
  if (d0 > 0) seek.value = String(Math.round((p0 / d0) * 1000))

  const unState = t.onState(setGlyph)
  const unVol = t.onVolume((v) => (vol.value = String(Math.round(v * 100))))
  const unPos = t.onPosition((pos, dur) => {
    if (seeking) return
    time.textContent = `${fmtT(pos)} / ${fmtT(dur)}`
    if (dur > 0) seek.value = String(Math.round((pos / dur) * 1000))
  })

  return () => {
    if (hideTimer !== null) view.clearTimeout(hideTimer)
    host.removeEventListener('mousemove', show)
    unState()
    unVol()
    unPos()
    bar.remove()
    center.remove()
  }
}

export class VisualizerHost {
  readonly events = new Emitter<HostEvents>()
  readonly registry = new PluginRegistry()
  readonly catalog = new PresetCatalog()
  private readonly lyricsOverlay = new LyricsOverlay()

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
  // file directly; 'stream' plays a progressive ffmpeg→MSE conversion; 'embed'
  // is the YouTube-iframe fallback for un-extractable videos.
  private mode: 'viz' | 'video' | 'embed' = 'viz'
  private videoSrc:
    | { kind: 'url'; url: string }
    | { kind: 'stream'; path: string; durationSec: number }
    | { kind: 'embed'; videoId: string }
    | null = null
  /** Caller-provided duration (seconds) used as a fallback when the <video>
   *  element doesn't report a finite duration (progressive/transcoded streams).
   *  Set by showVideo / showVideoStream; YouTube and local files override this
   *  once the element's own duration becomes available. */
  private knownDuration = 0
  private streamPlayer: VideoStreamPlayer | null = null
  private embedPlayer: EmbedPlayer | null = null
  private videoPosition = 0
  private videoVolume = 1
  // Taps the surface <video>'s audio into the graph (destination + analyser) so
  // a visualizer can react to a video's audio. Created once per <video> element
  // (createMediaElementSource is one-shot); torn down with the surface.
  private videoTapNode: MediaElementAudioSourceNode | null = null
  private videoTapEl: HTMLVideoElement | null = null
  // Guards wireVideo so re-applying the mode doesn't restart a playing video.
  private videoWiredEl: HTMLVideoElement | null = null

  // Fullscreen + pop-out.
  private fsContainer: HTMLElement | null = null
  private popoutWin: Window | null = null
  private popoutWatch: number | null = null
  private transport: TransportControls | null = null
  private overlayUnsub: (() => void) | null = null

  constructor(graph: AudioGraph) {
    this.graph = graph
    this.registry.register(createButterchurnPlugin(), 'builtin')
    this.registry.register(createBarsPlugin(), 'builtin')
    this.registry.register(createBlackScreenPlugin(), 'builtin')

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
    this.lyricsOverlay.setEnabled(settings.showLyrics)
    void this.catalog.load()
  }

  getDebugInfo(): {
    activeId: string
    frameCount: number
    presetId: string | null
    lastPresetError: string | null
    mode: 'viz' | 'video' | 'embed'
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
    this.embedPlayer?.destroy()
    this.embedPlayer = null
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
    this.lyricsOverlay.detach()
    // The audio tap is bound to the surface's <video>, about to be destroyed. A
    // live video re-wires on the next mount and resumes at this.videoPosition
    // (players were already torn down above).
    if (this.videoTapNode) {
      try {
        this.videoTapNode.disconnect()
      } catch {
        /* ignore */
      }
      this.videoTapNode = null
    }
    this.videoTapEl = null
    this.videoWiredEl = null
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

  /** True once the embed iframe has navigated cross-origin — i.e. YouTube's
   *  player actually loaded (a blank/same-origin iframe stays readable). */
  debugEmbedLoaded(): boolean {
    const f = this.surface?.embed
    if (!f) return false
    try {
      void f.contentWindow?.location.href // same-origin (blank) → readable
      return false
    } catch {
      return true // cross-origin → YouTube loaded
    }
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
    this.lyricsOverlay.attach(this.surface.lyrics)
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
    // Over real video/embed, don't take the whole frame — show just the current
    // synced line near the bottom (subtitle style). Full overlay in viz mode.
    this.lyricsOverlay.setCompact(this.mode !== 'viz')
    // A url/stream video plays whenever it's loaded — visible in 'video' mode,
    // hidden (but still playing, feeding the analyser) in 'viz' mode so a chosen
    // visualizer can react to it.
    if (this.videoSrc && this.videoSrc.kind !== 'embed') this.wireVideo()
    if (this.mode === 'video') {
      this.surface.showVideo()
      this.stopLoop()
      this.stopCycleTimer()
    } else if (this.mode === 'embed') {
      this.surface.showEmbed()
      this.stopLoop()
      this.stopCycleTimer()
      this.wireEmbed()
    } else {
      this.surface.showCanvas()
      this.startLoop()
      this.startCycleTimer()
    }
  }

  private wireEmbed(): void {
    if (!this.surface || this.videoSrc?.kind !== 'embed' || this.embedPlayer) return
    // Resume where we were (pop-out/fullscreen rebuild the iframe from scratch).
    const player = new EmbedPlayer(this.surface.embed, this.videoSrc.videoId, {
      volume: this.videoVolume,
      startSec: this.videoPosition
    })
    this.embedPlayer = player
    // A couple of loading beats before YouTube's player answers — report a
    // playing state so the skin leaves its 'loading' spinner.
    this.events.emit('videoState', { playing: true, position: 0, duration: 0 })
    player.events.on('state', (playing) => {
      this.events.emit('videoState', { playing, position: this.videoPosition, duration: 0 })
    })
    player.events.on('position', (pos, dur) => {
      this.videoPosition = pos
      this.events.emit('videoState', { playing: true, position: pos, duration: dur })
    })
    player.events.on('ended', () => this.events.emit('videoEnded'))
  }

  /** Route the surface <video>'s audio through the graph: to the speakers AND to
   *  the analyser, so a visualizer can react to a video's audio. Once per element. */
  private wireVideoTap(): void {
    const v = this.surface?.video
    if (!v || this.videoTapEl === v) return
    // The graph's AudioContext belongs to the main window; a popped-out surface's
    // <video> lives in another window and can't be tapped. It still plays there.
    if (v.ownerDocument !== document) return
    try {
      const src = this.graph.ctx.createMediaElementSource(v)
      src.connect(this.graph.ctx.destination) // hear it (v.volume still applies)
      src.connect(this.graph.vizSource) // let the analyser/visualizer see it
      this.videoTapNode = src
      this.videoTapEl = v
    } catch (err) {
      // Already tapped for this element (or unsupported) — it still plays.
      console.error('video audio tap failed', err)
    }
  }

  private wireVideo(): void {
    const v = this.surface?.video
    if (!v || this.videoSrc == null || this.videoSrc.kind === 'embed') return
    // Guard: re-applying the mode (e.g. video↔viz toggle) must not restart it.
    if (this.videoWiredEl === v) return
    this.videoWiredEl = v
    this.wireVideoTap()
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
    } else if (this.videoSrc.kind === 'stream') {
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
      duration: isFinite(v.duration) ? v.duration : this.knownDuration
    })
  }

  /** Show a directly-playable video file on the active surface. */
  showVideo(url: string, opts: { positionSec?: number; volume?: number; durationSec?: number } = {}): void {
    this.stopVideoPlayback()
    this.mode = 'video'
    this.videoSrc = { kind: 'url', url }
    this.videoPosition = opts.positionSec ?? 0
    this.knownDuration = opts.durationSec ?? 0
    if (opts.volume != null) this.videoVolume = opts.volume
    this.applyMode()
    this.events.emit('visualizers', this.listVisualizers())
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
    this.knownDuration = durationSec
    if (opts.volume != null) this.videoVolume = opts.volume
    this.applyMode()
    this.events.emit('visualizers', this.listVisualizers())
  }

  /** YouTube-embed fallback: play an un-extractable video in YouTube's own
   *  player on the surface. No audio tap (visualizer/stems can't see it) — this
   *  is a passive last resort for DRM/blocked videos. */
  showEmbed(videoId: string, opts: { volume?: number } = {}): void {
    this.stopVideoPlayback()
    this.mode = 'embed'
    this.videoSrc = { kind: 'embed', videoId }
    this.videoPosition = 0
    if (opts.volume != null) this.videoVolume = opts.volume
    this.applyMode()
    this.events.emit('visualizers', this.listVisualizers())
  }

  private stopVideoPlayback(): void {
    this.streamPlayer?.destroy()
    this.streamPlayer = null
    this.embedPlayer?.destroy()
    this.embedPlayer = null
    // Leave the audio tap in place (it's reusable for the element's lifetime);
    // just allow the next video to re-wire this element.
    this.videoWiredEl = null
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

  /** Immediately stop whatever video/embed is currently on the surface (pausing
   *  its audio and tearing down the stream/embed), staying in video mode so the
   *  surface just goes black as a loading state. Used when switching tracks so
   *  the old source doesn't keep playing (audio + bandwidth) during the next
   *  track's multi-second resolve — otherwise the switch appears to hang. */
  stopCurrentVideo(): void {
    if (this.mode === 'viz') return
    this.stopVideoPlayback()
  }

  /** Leave video mode; the visualizer returns to the surface. */
  returnToVisualizer(): void {
    this.stopVideoPlayback()
    this.mode = 'viz'
    this.videoSrc = null
    this.videoPosition = 0
    this.applyMode()
    this.events.emit('visualizers', this.listVisualizers())
  }

  isVideoMode(): boolean {
    return this.mode !== 'viz'
  }

  playVideo(): void {
    if (this.mode === 'embed') this.embedPlayer?.play()
    else void this.surface?.video.play().catch(() => {})
  }

  pauseVideo(): void {
    if (this.mode === 'embed') this.embedPlayer?.pause()
    else this.surface?.video.pause()
  }

  seekVideo(seconds: number): void {
    if (this.mode === 'embed') {
      this.embedPlayer?.seek(seconds)
      return
    }
    if (this.streamPlayer) {
      this.streamPlayer.seek(seconds)
      return
    }
    const v = this.surface?.video
    if (!v) return
    const dur = isFinite(v.duration) ? v.duration : (this.knownDuration || Infinity)
    v.currentTime = Math.min(Math.max(0, seconds), dur)
  }

  setVideoVolume(vol: number): void {
    this.videoVolume = Math.min(1, Math.max(0, vol))
    if (this.mode === 'embed') this.embedPlayer?.setVolume(this.videoVolume)
    else if (this.surface) this.surface.video.volume = this.videoVolume
  }

  // ---- visualizer selection --------------------------------------------------

  getActiveVisualizerId(): string {
    // 'video' is a pseudo-entry: it's "selected" whenever the surface shows video.
    return this.mode === 'viz' ? this.activeId : 'video'
  }

  listVisualizers(): { id: string; name: string }[] {
    const list = this.registry.list()
    // Offer "Video" while a video is loaded so the user can flip the surface
    // between watching the video and a visualizer reacting to its audio.
    return this.videoSrc ? [{ id: 'video', name: '📺 Video' }, ...list] : list
  }

  /** Register a plugin and notify listeners so UIs (e.g. the skin's visualizer
   *  dropdown) refresh immediately — addons register asynchronously after boot. */
  registerPlugin(plugin: VisualizerPlugin, owner: Parameters<PluginRegistry['register']>[1]): void {
    this.registry.register(plugin, owner)
    this.events.emit('visualizers', this.registry.list())
  }

  async setActiveVisualizer(id: string): Promise<void> {
    // "Video": flip the surface back to the video (it's still playing). No-op if
    // no video is loaded or we're already showing it.
    if (id === 'video') {
      if (!this.videoSrc || this.mode !== 'viz') return
      this.mode = this.videoSrc.kind === 'embed' ? 'embed' : 'video'
      this.applyMode()
      this.events.emit('visualizers', this.listVisualizers())
      return
    }
    if (!this.registry.get(id)) throw new Error(`unknown visualizer: ${id}`)
    const wasVideo = this.mode !== 'viz'
    const idChanged = id !== this.activeId
    if (!wasVideo && !idChanged && this.active) return
    this.activeId = id
    if (idChanged) void native.invoke('store:settings:patch', { activeVisualizer: id })
    // Switching from video → a visualizer: a url/stream video keeps playing
    // (hidden) and feeds the analyser, so the visualizer reacts to it.
    this.mode = 'viz'
    if (idChanged && this.surface && this.active) {
      try {
        this.active.destroy()
      } catch {
        /* ignore */
      }
      this.active = null
      this.resizeObserver?.disconnect()
      this.resizeObserver = null
      // Recreate the canvas so a WebGL→2D switch gets a clean context; a live
      // video re-wires on the fresh surface and resumes at its position.
      await this.remountSameTarget()
    } else {
      // Same plugin (already initialized) — just show the canvas; the hidden
      // video keeps playing without a reload hiccup.
      this.applyMode()
    }
    this.events.emit('visualizers', this.listVisualizers())
  }

  /** Re-init the active visualizer on its current surface so plugins that tap
   *  the audio at init() (Butterchurn wires its own analyser chain in
   *  connectAudio) re-read the source after it changes upstream — e.g. when
   *  System-audio mode swaps vizSource's input. The shared analyser (spectrum
   *  bars) picks the swap up live and needs no remount, but this is harmless
   *  for it. No-op in video mode. */
  async refreshForSourceChange(): Promise<void> {
    if (this.mode !== 'viz' || !this.surface || !this.active) return
    await this.remountSameTarget()
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
    if (removed.length) this.events.emit('visualizers', this.registry.list())
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
    if (removed.length) this.events.emit('visualizers', this.registry.list())
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

  // ---- lyrics overlay --------------------------------------------------------

  /** Set the current track's lyrics (embedded/.lrc), or null to clear. */
  setLyrics(l: Lyrics | null): void {
    this.lyricsOverlay.setLyrics(l)
    this.events.emit('lyrics-available', this.lyricsOverlay.hasLyrics())
  }

  /** Feed a live (transcription) lyrics source; overrides metadata while present. */
  pushLiveLyrics(l: Lyrics | null): void {
    this.lyricsOverlay.pushLive(l)
    this.events.emit('lyrics-available', this.lyricsOverlay.hasLyrics())
  }

  clearLiveLyrics(): void {
    this.lyricsOverlay.clearLive()
    this.events.emit('lyrics-available', this.lyricsOverlay.hasLyrics())
  }

  /** Playback position (ms) for highlighting the active synced line. */
  setLyricsPosition(ms: number): void {
    this.lyricsOverlay.setPositionMs(ms)
  }

  setLyricsEnabled(on: boolean): void {
    this.lyricsOverlay.setEnabled(on)
    void native.invoke('store:settings:patch', { showLyrics: on })
    this.events.emit('lyrics-enabled', on)
  }

  lyricsEnabled(): boolean {
    return this.lyricsOverlay.isEnabled()
  }

  lyricsAvailable(): boolean {
    return this.lyricsOverlay.hasLyrics()
  }

  /** Test hook for the lyrics overlay state. */
  debugLyrics(): {
    available: boolean
    enabled: boolean
    visible: boolean
    activeText: string
    viewH: number
    activeCenterY: number
  } {
    return this.lyricsOverlay.debugState()
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
    // No static title bar — a single full-window stage with an auto-hiding
    // controls overlay (buttons + seek + volume) that appears on mouse move.
    // The drag-top strip uses the same -webkit-app-region:drag as the bottom
    // controls bar (which already works in this child window).
    doc.head.innerHTML = `<style>
      * { margin: 0; box-sizing: border-box; user-select: none; }
      html, body { width: 100%; height: 100%; overflow: hidden; background: #000; }
      #drag-top { height: 30px; -webkit-app-region: drag; background: transparent; position: relative; z-index: 10; }
      #stage { width: 100%; height: calc(100% - 30px); position: relative; }
    </style>`
    doc.body.innerHTML = '<div id="drag-top"></div><div id="stage"></div>'
    const stage = doc.getElementById('stage')!

    stage.addEventListener('dblclick', () => {
      void native.invoke('window:set-fullscreen', !win.document.fullscreenElement)
    })

    win.addEventListener('resize', () => this.refreshCanvasSize())
    win.addEventListener('unload', () => this.onPopoutClosed())
    this.popoutWatch = window.setInterval(() => {
      if (this.popoutWin && this.popoutWin.closed) this.onPopoutClosed()
    }, 1000)

    void this.mount({ kind: 'own', container: stage })
    if (this.transport) {
      this.overlayUnsub = mountControlsOverlay(doc, stage, this.transport, { win, frameName: 'ampwin-viz' })
    }
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
    this.overlayUnsub?.()
    this.overlayUnsub = null
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
      if (this.transport) {
        this.overlayUnsub = mountControlsOverlay(document, container, this.transport, {
          onExit: () => void this.setFullscreen(false)
        })
      }
    } else if (!on && this.fsContainer) {
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => {})
      this.exitFullscreenCleanup()
    }
  }

  private exitFullscreenCleanup(): void {
    this.overlayUnsub?.()
    this.overlayUnsub = null
    this.teardownSurface()
    this.fsContainer?.remove()
    this.fsContainer = null
    if (this.skinAnchor && this.skinAnchor.isConnected) {
      void this.mount({ kind: 'overlay', anchor: this.skinAnchor })
    }
  }
}
