// MilkDrop 2 via Butterchurn, wrapped as a VisualizerPlugin. Preset choice
// and cycling live in VisualizerHost (they must survive canvas re-inits);
// this plugin just renders whatever preset the host hands it.

import type { VisualizerPlugin } from './plugin'
import butterchurnModule, { type ButterchurnVisualizer, type ButterchurnStatic } from 'butterchurn'

export interface ButterchurnHandle {
  /** Load a preset object with a blend transition (seconds). */
  loadPresetObject(preset: object, blendSec: number): void
  showTitle(title: string): void
}

export function createButterchurnPlugin(): VisualizerPlugin & ButterchurnHandle {
  let vis: ButterchurnVisualizer | null = null
  let connectedTo: AudioNode | null = null
  let pendingPreset: { preset: object; blendSec: number } | null = null

  return {
    id: 'butterchurn',
    name: 'MilkDrop (Butterchurn)',

    init(ctx) {
      const butterchurn: ButterchurnStatic = (butterchurnModule.default ??
        butterchurnModule) as ButterchurnStatic
      vis = butterchurn.createVisualizer(ctx.audioContext, ctx.canvas, {
        width: ctx.canvas.width,
        height: ctx.canvas.height,
        pixelRatio: devicePixelRatio,
        textureRatio: 1
      })
      vis.connectAudio(ctx.sourceNode)
      connectedTo = ctx.sourceNode
      if (pendingPreset) {
        vis.loadPreset(pendingPreset.preset, 0)
        pendingPreset = null
      }
    },

    render() {
      vis?.render()
    },

    resize(width, height) {
      vis?.setRendererSize(width, height)
    },

    destroy() {
      if (vis && connectedTo) {
        try {
          vis.disconnectAudio(connectedTo)
        } catch {
          // butterchurn 2.x throws if the node was never fully connected
        }
      }
      vis = null
      connectedTo = null
    },

    loadPresetObject(preset, blendSec) {
      if (vis) vis.loadPreset(preset, blendSec)
      else pendingPreset = { preset, blendSec } // applied on next init
    },

    showTitle(title) {
      try {
        vis?.launchSongTitleAnim(title)
      } catch {
        // optional nicety; some presets/builds lack title anim support
      }
    }
  }
}

export function isButterchurnHandle(p: unknown): p is ButterchurnHandle {
  return !!p && typeof (p as ButterchurnHandle).loadPresetObject === 'function'
}
