// Built-in fallback visualizer: classic spectrum bars off the shared
// analyser tap. Trivial on purpose — it proves the VisualizerPlugin
// interface and gives skins something to draw before Butterchurn loads.

import type { VisualizerPlugin } from './plugin'

export function createBarsPlugin(): VisualizerPlugin {
  let canvas: HTMLCanvasElement | null = null
  let ctx2d: CanvasRenderingContext2D | null = null
  let analyser: AnalyserNode | null = null
  let data: Uint8Array<ArrayBuffer> | null = null

  return {
    id: 'bars',
    name: 'Spectrum Bars',

    init(ctx) {
      canvas = ctx.canvas
      ctx2d = canvas.getContext('2d')
      analyser = ctx.analyser
      data = new Uint8Array(analyser.frequencyBinCount)
    },

    render() {
      if (!canvas || !ctx2d || !analyser || !data) return
      analyser.getByteFrequencyData(data)
      const w = canvas.width
      const h = canvas.height
      ctx2d.fillStyle = '#000'
      ctx2d.fillRect(0, 0, w, h)
      const bars = 64
      const step = Math.floor(data.length / 2 / bars) // ignore top octave (mostly empty)
      const barW = w / bars
      for (let i = 0; i < bars; i++) {
        let sum = 0
        for (let j = 0; j < step; j++) sum += data[i * step + j]
        const v = sum / step / 255
        const barH = v * h
        const hue = 120 - v * 90 // green → yellow → orange as it gets loud
        ctx2d.fillStyle = `hsl(${hue}, 80%, ${35 + v * 25}%)`
        ctx2d.fillRect(i * barW + 1, h - barH, barW - 2, barH)
      }
    },

    resize(width, height) {
      if (canvas) {
        canvas.width = width
        canvas.height = height
      }
    },

    destroy() {
      canvas = null
      ctx2d = null
      analyser = null
      data = null
    }
  }
}
