// Web Audio graph, created once at shell boot and shared for the app's life:
//
//   audioElA ─ MediaElementSourceA ─┐
//                                   ├─→ mixerGain ─→ masterGain ─→ destination
//   audioElB ─ MediaElementSourceB ─┘      │
//                                          └─→ analyser (tap for skins/plugins)
//
// Butterchurn later connects to mixerGain and builds its own analyser.
// MediaElementSourceNode is once-per-element, so the two <audio> elements are
// created here and reused forever by swapping src.

export interface AudioGraph {
  ctx: AudioContext
  /** Pre-volume mix point — visualizers tap here so volume doesn't affect them. */
  mixerGain: GainNode
  masterGain: GainNode
  analyser: AnalyserNode
  elements: [HTMLAudioElement, HTMLAudioElement]
}

export function createAudioGraph(hostLayer: HTMLElement): AudioGraph {
  const ctx = new AudioContext()

  const mixerGain = ctx.createGain()
  const masterGain = ctx.createGain()
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 2048

  mixerGain.connect(masterGain)
  masterGain.connect(ctx.destination)
  mixerGain.connect(analyser)

  const make = (): HTMLAudioElement => {
    const el = new Audio()
    el.preload = 'auto'
    hostLayer.appendChild(el)
    ctx.createMediaElementSource(el).connect(mixerGain)
    return el
  }

  return { ctx, mixerGain, masterGain, analyser, elements: [make(), make()] }
}
