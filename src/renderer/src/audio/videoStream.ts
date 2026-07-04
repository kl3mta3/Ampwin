// MSE driver for progressive video: receives fragmented-MP4 chunks from the
// main process and feeds them into a <video> via MediaSource. Keeps a rolling
// window buffered — up to AHEAD_MAX_SEC past the playhead (backpressure
// pauses ffmpeg beyond that) and TRIM_BEHIND_SEC behind it for small rewinds.
// Seeks inside the buffered window are native; seeks outside restart the
// ffmpeg session at the target time (fragments carry original timestamps via
// -copyts, so buffered ranges always sit at true media time).

import { native } from '../native'

const AHEAD_MAX_SEC = 60
const AHEAD_RESUME_SEC = 30
const TRIM_BEHIND_SEC = 30

export class VideoStreamPlayer {
  private video: HTMLVideoElement
  private path: string
  private durationSec: number

  private sessionId: number | null = null
  private mediaSource: MediaSource | null = null
  private sourceBuffer: SourceBuffer | null = null
  private queue: Uint8Array[] = []
  private streamEnded = false
  private feedPaused = false
  private destroyed = false
  private housekeeping: number | null = null
  private unsubs: (() => void)[] = []

  constructor(video: HTMLVideoElement, path: string, durationSec: number) {
    this.video = video
    this.path = path
    this.durationSec = durationSec

    this.unsubs.push(
      native.on('evt:vstream-data', ({ sessionId, chunk }) => {
        if (sessionId !== this.sessionId) return
        this.queue.push(chunk)
        this.pump()
      }),
      native.on('evt:vstream-end', ({ sessionId }) => {
        if (sessionId !== this.sessionId) return
        this.streamEnded = true
        this.pump()
      }),
      native.on('evt:vstream-error', ({ sessionId, message }) => {
        if (sessionId !== this.sessionId) return
        console.error('video stream error:', message)
        // Surface through the element's normal error path.
        this.video.dispatchEvent(new Event('error'))
      })
    )
  }

  async start(atSec = 0): Promise<void> {
    await this.openSession(atSec)
    this.housekeeping = window.setInterval(() => this.manageBuffer(), 500)
  }

  /** Native seek inside the buffered window; stream restart outside it. */
  seek(seconds: number): void {
    const t = Math.min(Math.max(0, seconds), this.durationSec || Infinity)
    if (this.isBuffered(t)) {
      this.video.currentTime = t
      return
    }
    void this.restartAt(t)
  }

  destroy(): void {
    this.destroyed = true
    if (this.housekeeping !== null) clearInterval(this.housekeeping)
    for (const u of this.unsubs) u()
    this.unsubs = []
    this.closeSession()
    this.detachMediaSource()
  }

  // ---- session / MediaSource lifecycle ------------------------------------

  private async openSession(atSec: number): Promise<void> {
    this.queue = []
    this.streamEnded = false
    this.feedPaused = false

    const { sessionId, mime, durationSec } = await native.invoke('vstream:start', this.path, atSec)
    if (this.destroyed) {
      void native.invoke('vstream:stop', sessionId)
      return
    }
    this.sessionId = sessionId
    if (durationSec > 0) this.durationSec = durationSec

    if (!MediaSource.isTypeSupported(mime)) {
      throw new Error(`MSE rejected ${mime}`)
    }

    const ms = new MediaSource()
    this.mediaSource = ms
    await new Promise<void>((resolve) => {
      ms.addEventListener('sourceopen', () => resolve(), { once: true })
      this.video.src = URL.createObjectURL(ms)
    })
    if (this.destroyed) return

    if (this.durationSec > 0) {
      try {
        ms.duration = this.durationSec
      } catch {
        /* not fatal */
      }
    }
    const sb = ms.addSourceBuffer(mime)
    sb.mode = 'segments'
    this.sourceBuffer = sb
    sb.addEventListener('updateend', () => this.pump())

    this.video.currentTime = atSec
    void this.video.play().catch(() => {})
    this.pump()
  }

  private closeSession(): void {
    if (this.sessionId !== null) {
      void native.invoke('vstream:stop', this.sessionId)
      this.sessionId = null
    }
  }

  private detachMediaSource(): void {
    this.sourceBuffer = null
    this.mediaSource = null
    this.queue = []
    // Releasing the object URL implicitly detaches the MediaSource.
    if (this.video.src.startsWith('blob:')) {
      URL.revokeObjectURL(this.video.src)
    }
  }

  private async restartAt(t: number): Promise<void> {
    this.closeSession()
    this.detachMediaSource()
    if (this.destroyed) return
    try {
      await this.openSession(t)
    } catch (err) {
      console.error('stream seek restart failed', err)
      this.video.dispatchEvent(new Event('error'))
    }
  }

  // ---- buffer plumbing ------------------------------------------------------

  private pump(): void {
    const sb = this.sourceBuffer
    if (!sb || sb.updating || this.destroyed) return

    if (this.queue.length > 0) {
      const chunk = this.queue.shift()!
      try {
        sb.appendBuffer(chunk as BufferSource)
      } catch (err) {
        if ((err as DOMException).name === 'QuotaExceededError') {
          // Buffer full: put it back, trim aggressively, retry on updateend.
          this.queue.unshift(chunk)
          this.trimBehind(true)
        } else {
          console.error('appendBuffer failed', err)
          this.video.dispatchEvent(new Event('error'))
        }
      }
      return
    }

    if (this.streamEnded && this.mediaSource?.readyState === 'open') {
      try {
        this.mediaSource.endOfStream()
      } catch {
        /* raced with a restart */
      }
    }
  }

  private isBuffered(t: number): boolean {
    const b = this.video.buffered
    for (let i = 0; i < b.length; i++) {
      // Small tolerance at range edges.
      if (t >= b.start(i) - 0.05 && t < b.end(i) - 0.2) return true
    }
    return false
  }

  private bufferedAhead(): number {
    const ct = this.video.currentTime
    const b = this.video.buffered
    for (let i = 0; i < b.length; i++) {
      if (ct >= b.start(i) - 0.05 && ct <= b.end(i)) return b.end(i) - ct
    }
    return 0
  }

  private manageBuffer(): void {
    if (!this.sourceBuffer || this.sessionId === null) return
    const ahead = this.bufferedAhead()
    if (!this.feedPaused && ahead > AHEAD_MAX_SEC) {
      this.feedPaused = true
      void native.invoke('vstream:feed', this.sessionId, 'pause')
    } else if (this.feedPaused && ahead < AHEAD_RESUME_SEC) {
      this.feedPaused = false
      void native.invoke('vstream:feed', this.sessionId, 'resume')
    }
    this.trimBehind(false)
  }

  private trimBehind(aggressive: boolean): void {
    const sb = this.sourceBuffer
    if (!sb || sb.updating) return
    const b = this.video.buffered
    if (b.length === 0) return
    const keep = aggressive ? 5 : TRIM_BEHIND_SEC
    const cutoff = this.video.currentTime - keep
    if (b.start(0) < cutoff - 1) {
      try {
        sb.remove(0, cutoff)
      } catch {
        /* raced with teardown */
      }
    }
  }
}
