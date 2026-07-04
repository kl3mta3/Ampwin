// System-audio visualizer mode: capture the computer's entire audio OUTPUT
// (WASAPI loopback) and feed it to the visualizer, so Ampwin reacts to whatever
// any app is playing — Spotify, a browser, a game — including DRM-protected
// audio, because this taps the mixed output, never the app's decoder.
//
// Mechanism: the main process installs a display-media handler that answers
// getDisplayMedia() with { audio: 'loopback' } (see main/systemAudio.ts). We
// request a stream, discard its video track, and splice the audio into the
// graph by swapping vizSource's input: mixerGain is disconnected and the
// loopback MediaStreamSource is connected in its place. The loopback is only
// ever routed to vizSource → analyser (never to destination), so there is no
// echo. Disabling reconnects mixerGain and stops the capture.
//
// State lives here (shell-scoped), so it survives skin switches. Nothing is
// persisted: the capture is a per-session stream that needs a user gesture to
// start, so re-enabling on every launch would be surprising.

import type { AudioGraph } from './graph'
import { Emitter } from '../emitter'

interface SystemAudioEvents extends Record<string, unknown[]> {
  change: [enabled: boolean]
}

export class SystemAudioCapture {
  readonly events = new Emitter<SystemAudioEvents>()

  private graph: AudioGraph
  private stream: MediaStream | null = null
  private srcNode: MediaStreamAudioSourceNode | null = null
  private enabled = false

  constructor(graph: AudioGraph) {
    this.graph = graph
  }

  isEnabled(): boolean {
    return this.enabled
  }

  /** Begin capturing system audio into the visualizer. Requires a user
   *  gesture (called from a button click). Rejects if capture is unavailable
   *  or the user cancels the picker. */
  async enable(): Promise<void> {
    if (this.enabled) return

    // The main-process handler returns a screen video source + loopback audio;
    // getDisplayMedia rejects audio-only, so we ask for both and drop video.
    const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
    for (const t of stream.getVideoTracks()) t.stop()

    const audioTracks = stream.getAudioTracks()
    if (audioTracks.length === 0) {
      stream.getTracks().forEach((t) => t.stop())
      throw new Error('no system audio was captured (loopback unavailable)')
    }
    // If the user revokes the capture (via the OS "stop sharing" affordance),
    // the track ends — mirror that into a clean disable.
    audioTracks[0].addEventListener('ended', () => this.disable())

    const audioOnly = new MediaStream(audioTracks)
    const src = this.graph.ctx.createMediaStreamSource(audioOnly)

    // Swap the visualizer's input: own playback out, loopback in.
    try {
      this.graph.mixerGain.disconnect(this.graph.vizSource)
    } catch {
      /* not connected (double-enable guard already handles the normal case) */
    }
    src.connect(this.graph.vizSource)

    // The AudioContext can be suspended if nothing has played yet.
    void this.graph.ctx.resume().catch(() => {})

    this.stream = stream
    this.srcNode = src
    this.enabled = true
    this.events.emit('change', true)
  }

  /** Stop capturing and restore the visualizer to the app's own playback. */
  disable(): void {
    if (!this.enabled) return
    try {
      this.srcNode?.disconnect()
    } catch {
      /* ignore */
    }
    this.stream?.getTracks().forEach((t) => t.stop())
    // Restore the normal path: own playback → vizSource.
    try {
      this.graph.mixerGain.connect(this.graph.vizSource)
    } catch {
      /* already connected */
    }
    this.stream = null
    this.srcNode = null
    this.enabled = false
    this.events.emit('change', false)
  }

  async toggle(): Promise<void> {
    if (this.enabled) this.disable()
    else await this.enable()
  }
}
