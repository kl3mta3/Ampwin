// Playback engine: owns the two <audio> elements, the load/play/pause state
// machine, seeking, volume, and next-track preloading. Playlist decisions
// (what plays next) belong to the controller, not here.

import type { PlayState } from '../../../shared/types'
import { native } from '../native'
import { Emitter } from '../emitter'
import type { AudioGraph } from './graph'

interface EngineEvents extends Record<string, unknown[]> {
  state: [PlayState]
  position: [posSec: number, durSec: number]
  /** Natural end of the active track — controller decides what happens next. */
  ended: []
  error: [message: string]
}

export class AudioEngine {
  readonly events = new Emitter<EngineEvents>()

  private graph: AudioGraph
  private activeIdx = 0
  private state: PlayState = 'idle'
  /** Guards async races: bumped on every load/stop; stale awaits bail out. */
  private token = 0
  /** Path preloaded into the idle element, if any. */
  private preloadedPath: string | null = null
  private currentPath: string | null = null
  private volume = 0.8
  private muted = false

  constructor(graph: AudioGraph) {
    this.graph = graph
    for (const el of graph.elements) {
      el.addEventListener('timeupdate', () => {
        if (el === this.active()) {
          this.events.emit('position', el.currentTime, this.safeDuration())
        }
      })
      el.addEventListener('ended', () => {
        if (el === this.active()) this.events.emit('ended')
      })
      el.addEventListener('error', () => {
        if (el === this.active() && this.state !== 'idle') {
          this.setState('idle')
          this.events.emit(
            'error',
            `cannot play (code ${el.error?.code ?? '?'}): ${el.error?.message ?? 'unknown'}`
          )
        }
      })
    }
  }

  private active(): HTMLAudioElement {
    return this.graph.elements[this.activeIdx]
  }

  private idle(): HTMLAudioElement {
    return this.graph.elements[1 - this.activeIdx]
  }

  private safeDuration(): number {
    const d = this.active().duration
    return isFinite(d) ? d : 0
  }

  private setState(s: PlayState): void {
    if (this.state !== s) {
      this.state = s
      this.events.emit('state', s)
    }
  }

  getState(): PlayState {
    return this.state
  }

  getPosition(): number {
    return this.active().currentTime
  }

  getDuration(): number {
    return this.safeDuration()
  }

  getCurrentPath(): string | null {
    return this.currentPath
  }

  /** Load a track and (optionally) start playing. Uses the preloaded element
   *  when it matches, giving near-gapless transitions. */
  async load(path: string, opts: { autoplay: boolean; forceTranscode?: boolean }): Promise<void> {
    const myToken = ++this.token
    this.setState('loading')

    if (this.preloadedPath === path && !opts.forceTranscode) {
      // Swap roles: preloaded idle element becomes active.
      this.active().pause()
      this.active().removeAttribute('src')
      this.activeIdx = 1 - this.activeIdx
      this.preloadedPath = null
      this.currentPath = path
      await this.startActive(opts.autoplay, myToken)
      return
    }

    try {
      const { url } = await native.invoke('media:prepare', path, {
        forceTranscode: opts.forceTranscode
      })
      if (myToken !== this.token) return // superseded by a newer load/stop
      const el = this.active()
      el.pause()
      el.src = url
      this.currentPath = path
      // A stale preload for some other track is now suspect; drop it.
      if (this.preloadedPath && this.preloadedPath !== path) this.clearPreload()
      await this.startActive(opts.autoplay, myToken)
    } catch (err) {
      if (myToken !== this.token) return
      this.setState('idle')
      this.events.emit('error', `prepare failed: ${(err as Error).message}`)
    }
  }

  private async startActive(autoplay: boolean, myToken: number): Promise<void> {
    const el = this.active()
    try {
      if (autoplay) {
        await el.play()
        if (myToken !== this.token) {
          el.pause()
          return
        }
        this.setState('playing')
      } else {
        this.setState('paused')
      }
      this.events.emit('position', el.currentTime, this.safeDuration())
    } catch (err) {
      if (myToken !== this.token) return
      this.setState('idle')
      this.events.emit('error', `play failed: ${(err as Error).message}`)
    }
  }

  /** Prepare the next track into the idle element ahead of time. */
  async preloadNext(path: string): Promise<void> {
    if (this.preloadedPath === path) return
    try {
      const { url } = await native.invoke('media:prepare', path)
      // Never clobber: the track may have started by other means meanwhile.
      if (this.currentPath === path) return
      const el = this.idle()
      el.src = url
      this.preloadedPath = path
    } catch {
      this.preloadedPath = null
    }
  }

  clearPreload(): void {
    this.idle().removeAttribute('src')
    this.preloadedPath = null
  }

  getPreloadedPath(): string | null {
    return this.preloadedPath
  }

  async play(): Promise<void> {
    if (this.state === 'paused') {
      // Chromium suspends the AudioContext when idle; make sure it's live.
      if (this.graph.ctx.state === 'suspended') await this.graph.ctx.resume()
      await this.active().play()
      this.setState('playing')
    }
  }

  pause(): void {
    if (this.state === 'playing') {
      this.active().pause()
      this.setState('paused')
    }
  }

  stop(): void {
    this.token++
    const el = this.active()
    el.pause()
    el.removeAttribute('src')
    this.currentPath = null
    this.setState('idle')
    this.events.emit('position', 0, 0)
  }

  seek(seconds: number): void {
    const el = this.active()
    if (this.state === 'idle' || !isFinite(el.duration)) return
    el.currentTime = Math.min(Math.max(0, seconds), el.duration)
  }

  /** Perceptual (squared) volume curve, click-free ramp. */
  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v))
    this.applyGain()
  }

  setMuted(m: boolean): void {
    this.muted = m
    this.applyGain()
  }

  getVolume(): number {
    return this.volume
  }

  getMuted(): boolean {
    return this.muted
  }

  private applyGain(): void {
    const target = this.muted ? 0 : this.volume * this.volume
    const g = this.graph.masterGain.gain
    g.setTargetAtTime(target, this.graph.ctx.currentTime, 0.02)
  }
}
