// Built-in "Black Screen" visualizer: a plain black surface that draws nothing.
// Useful on its own (a calm, dark backdrop) and as the natural pairing for the
// lyrics overlay — lyrics on black, karaoke-style.

import type { VisualizerPlugin } from './plugin'

export function createBlackScreenPlugin(): VisualizerPlugin {
  let canvas: HTMLCanvasElement | null = null
  let ctx2d: CanvasRenderingContext2D | null = null

  const paint = (): void => {
    if (!canvas || !ctx2d) return
    ctx2d.fillStyle = '#000'
    ctx2d.fillRect(0, 0, canvas.width, canvas.height)
  }

  return {
    id: 'black',
    name: 'Black Screen',

    init(ctx) {
      canvas = ctx.canvas
      ctx2d = canvas.getContext('2d')
      paint()
    },

    // Nothing animates — one clear per frame keeps it black through any resize
    // or DPR change without spinning up audio work.
    render() {
      paint()
    },

    resize(width, height) {
      if (canvas) {
        canvas.width = width
        canvas.height = height
      }
      paint()
    },

    destroy() {
      canvas = null
      ctx2d = null
    }
  }
}
