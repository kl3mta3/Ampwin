// EmbedPlayer: drives a YouTube /embed iframe over the IFrame API postMessage
// protocol, so a video we CAN'T extract a stream for (DRM, region/format walls)
// still plays — in YouTube's own player, on the visualizer surface.
//
// It's a genuine fallback, not a peer of real playback: the audio is inside
// YouTube's cross-origin frame, so it can't be tapped for the visualizer,
// downloaded, or run through stems. Autoplay + YouTube's built-in controls
// work regardless; the postMessage wiring adds transport sync (play/pause/seek,
// position, ended→next) when YouTube answers our handshake, and degrades to
// "use the embedded controls" if it doesn't.

import { Emitter } from '../emitter'

const YT_ORIGIN = 'https://www.youtube.com'

interface EmbedEvents extends Record<string, unknown[]> {
  state: [playing: boolean]
  position: [posSec: number, durSec: number]
  ended: []
}

/** Extract an 11-char YouTube video id from any YouTube URL, or null. */
export function youtubeId(url: string): string | null {
  try {
    const u = new URL(url)
    if (/(^|\.)youtube\.com$/.test(u.hostname)) {
      const v = u.searchParams.get('v')
      if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v
      const m = /\/(embed|shorts|v)\/([A-Za-z0-9_-]{11})/.exec(u.pathname)
      if (m) return m[2]
    }
    if (u.hostname === 'youtu.be') {
      const id = u.pathname.slice(1, 12)
      if (/^[A-Za-z0-9_-]{11}$/.test(id)) return id
    }
  } catch {
    /* not a URL */
  }
  return null
}

export class EmbedPlayer {
  readonly events = new Emitter<EmbedEvents>()
  private iframe: HTMLIFrameElement
  private ready = false
  private queued: string[] = []
  private onMessage: (e: MessageEvent) => void
  private destroyed = false

  constructor(iframe: HTMLIFrameElement, videoId: string, opts: { volume?: number; startSec?: number } = {}) {
    this.iframe = iframe
    this.onMessage = (e): void => this.handleMessage(e)
    iframe.ownerDocument.defaultView?.addEventListener('message', this.onMessage)
    iframe.addEventListener('load', () => this.onLoad(opts.volume))
    // origin= helps YouTube accept our postMessage transport bridge; from an
    // Electron file://-class page it may still decline (then the embed's own
    // controls drive it — it still plays).
    const origin = iframe.ownerDocument.defaultView?.location.origin || ''
    // start= resumes at the current position when the surface is rebuilt
    // (pop-out / fullscreen) — the embed is a fresh iframe each time.
    const startSec = opts.startSec && opts.startSec > 1 ? Math.floor(opts.startSec) : 0
    iframe.src =
      `${YT_ORIGIN}/embed/${encodeURIComponent(videoId)}` +
      `?autoplay=1&enablejsapi=1&rel=0&modestbranding=1&playsinline=1&fs=1` +
      (startSec > 0 ? `&start=${startSec}` : '') +
      (origin && origin !== 'null' ? `&origin=${encodeURIComponent(origin)}` : '')
  }

  private onLoad(volume?: number): void {
    if (this.destroyed) return
    this.ready = true
    // Register to receive onStateChange / infoDelivery events.
    this.send({ event: 'listening', id: 'ampwin', channel: 'widget' })
    for (const m of this.queued) this.iframe.contentWindow?.postMessage(m, YT_ORIGIN)
    this.queued = []
    if (volume != null) this.setVolume(volume)
  }

  private send(obj: unknown): void {
    const msg = JSON.stringify(obj)
    if (this.ready && this.iframe.contentWindow) this.iframe.contentWindow.postMessage(msg, YT_ORIGIN)
    else this.queued.push(msg)
  }

  private command(func: string, args: unknown[] = []): void {
    this.send({ event: 'command', func, args, id: 'ampwin', channel: 'widget' })
  }

  play(): void {
    this.command('playVideo')
  }
  pause(): void {
    this.command('pauseVideo')
  }
  stop(): void {
    this.command('stopVideo')
  }
  seek(sec: number): void {
    this.command('seekTo', [sec, true])
  }
  setVolume(v: number): void {
    if (v <= 0) this.command('mute')
    else {
      this.command('unMute')
      this.command('setVolume', [Math.round(Math.min(1, v) * 100)])
    }
  }

  private handleMessage(e: MessageEvent): void {
    if (this.destroyed || !e.origin.includes('youtube.com')) return
    let data: { event?: string; info?: unknown }
    try {
      data = typeof e.data === 'string' ? JSON.parse(e.data) : (e.data as typeof data)
    } catch {
      return
    }
    if (!data || typeof data !== 'object') return
    if (data.event === 'onStateChange') {
      const info = data.info // -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued
      if (info === 0) this.events.emit('ended')
      else if (info === 1) this.events.emit('state', true)
      else if (info === 2) this.events.emit('state', false)
    } else if (data.event === 'infoDelivery' && data.info && typeof data.info === 'object') {
      const info = data.info as { currentTime?: number; duration?: number }
      if (typeof info.currentTime === 'number' && typeof info.duration === 'number') {
        this.events.emit('position', info.currentTime, info.duration)
      }
    }
  }

  destroy(): void {
    this.destroyed = true
    this.iframe.ownerDocument.defaultView?.removeEventListener('message', this.onMessage)
    try {
      this.iframe.removeAttribute('src')
    } catch {
      /* ignore */
    }
    this.events.removeAll()
  }
}
