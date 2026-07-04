// VisualizerPlugin registry. Butterchurn (M4) and the built-in 'bars'
// analyser are both registered through this — the same interface skins use
// for third-party visualizers, so the abstraction is proven by the built-ins.

import type { VisualizerPlugin } from '../../../shared/skin-api'

export type { VisualizerPlugin }

export class PluginRegistry {
  private plugins = new Map<string, VisualizerPlugin>()
  /** Plugin ids registered by the current skin (removed on skin teardown). */
  private skinOwned = new Set<string>()

  register(plugin: VisualizerPlugin, ownedBySkin: boolean): void {
    if (this.plugins.has(plugin.id)) {
      throw new Error(`visualizer id already registered: ${plugin.id}`)
    }
    this.plugins.set(plugin.id, plugin)
    if (ownedBySkin) this.skinOwned.add(plugin.id)
  }

  get(id: string): VisualizerPlugin | undefined {
    return this.plugins.get(id)
  }

  list(): { id: string; name: string }[] {
    return [...this.plugins.values()].map((p) => ({ id: p.id, name: p.name }))
  }

  /** Called on skin teardown; returns the removed ids. */
  removeSkinOwned(): string[] {
    const removed = [...this.skinOwned]
    for (const id of removed) this.plugins.delete(id)
    this.skinOwned.clear()
    return removed
  }
}
