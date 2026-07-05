// Web Audio graph, created once at shell boot and shared for the app's life:
//
//   audioElA ─ MediaElementSourceA ─┐
//                                   ├─→ mixerGain ─→ masterGain ─→ destination
//   audioElB ─ MediaElementSourceB ─┘      │
//                                          └─→ vizSource ─→ analyser (skins/plugins)
//
// vizSource is a stable node the visualizer + analyser read from. Its INPUT is
// swappable: normally mixerGain (the app's own playback), but "System audio"
// mode disconnects mixerGain and feeds a WASAPI loopback stream in instead, so
// the visualizer reacts to whatever the whole system is playing. vizSource is
// NEVER connected to masterGain/destination — feeding a loopback capture back
// to the speakers would echo. Butterchurn connects its own analyser to
// vizSource; because that node is stable, swapping its upstream input is
// transparent and needs no plugin re-init.
//
// MediaElementSourceNode is once-per-element, so the two <audio> elements are
// created here and reused forever by swapping src.
//
// The equalizer sits on the PLAYBACK path only (mixerGain → eq → masterGain);
// vizSource still taps mixerGain (pre-EQ) so it also works for the system-audio
// loopback, which must not be EQ'd.

import { Equalizer } from './eq'

export interface AudioGraph {
  ctx: AudioContext
  /** Pre-volume mix point for the app's own playback. */
  mixerGain: GainNode
  masterGain: GainNode
  /** Stable node the visualizer + analyser read from; its input is swappable
   *  (own playback ↔ system loopback) without touching downstream consumers. */
  vizSource: GainNode
  analyser: AnalyserNode
  /** Realtime 10-band graphic EQ on the app's own playback. */
  eq: Equalizer
  elements: [HTMLAudioElement, HTMLAudioElement]
}

export function createAudioGraph(hostLayer: HTMLElement): AudioGraph {
  const ctx = new AudioContext()

  const mixerGain = ctx.createGain()
  const masterGain = ctx.createGain()
  const vizSource = ctx.createGain()
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 2048
  const eq = new Equalizer(ctx)

  // Playback path runs through the EQ; the visualizer tap stays pre-EQ.
  mixerGain.connect(eq.input)
  eq.output.connect(masterGain)
  masterGain.connect(ctx.destination)
  mixerGain.connect(vizSource)
  vizSource.connect(analyser)

  const make = (): HTMLAudioElement => {
    const el = new Audio()
    el.preload = 'auto'
    hostLayer.appendChild(el)
    ctx.createMediaElementSource(el).connect(mixerGain)
    return el
  }

  return { ctx, mixerGain, masterGain, vizSource, analyser, eq, elements: [make(), make()] }
}
