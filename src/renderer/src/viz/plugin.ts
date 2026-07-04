// VisualizerPlugin registry. Butterchurn (M4) and the built-in 'bars'
// analyser are both registered through this — the same interface skins use
// for third-party visualizers, so the abstraction is proven by the built-ins.
//
// Ownership decides lifetime:
//   'builtin'        — permanent (butterchurn, bars)
//   'skin'           — removed when the current skin tears down
//   'addon:<id>'     — removed when that addon is disabled/uninstalled
// Addon plugins deliberately outlive skin switches, so a visualizer you
// installed keeps working when you change skins.

import type { VisualizerPlugin } from '../../../shared/skin-api'

export type { VisualizerPlugin }

export type PluginOwner = 'builtin' | 'skin' | `addon:${string}`

export class PluginRegistry {
  private plugins = new Map<string, VisualizerPlugin>()
  private owners = new Map<string, PluginOwner>()

  register(plugin: VisualizerPlugin, owner: PluginOwner): void {
    if (this.plugins.has(plugin.id)) {
      throw new Error(`visualizer id already registered: ${plugin.id}`)
    }
    this.plugins.set(plugin.id, plugin)
    this.owners.set(plugin.id, owner)
  }

  get(id: string): VisualizerPlugin | undefined {
    return this.plugins.get(id)
  }

  list(): { id: string; name: string }[] {
    return [...this.plugins.values()].map((p) => ({ id: p.id, name: p.name }))
  }

  private removeByOwner(pred: (owner: PluginOwner) => boolean): string[] {
    const removed: string[] = []
    for (const [id, owner] of this.owners) {
      if (pred(owner)) removed.push(id)
    }
    for (const id of removed) {
      this.plugins.delete(id)
      this.owners.delete(id)
    }
    return removed
  }

  /** Called on skin teardown; returns the removed ids. */
  removeSkinOwned(): string[] {
    return this.removeByOwner((o) => o === 'skin')
  }

  /** Called when an addon is disabled/uninstalled; returns the removed ids. */
  removeAddonOwned(addonId: string): string[] {
    return this.removeByOwner((o) => o === `addon:${addonId}`)
  }
}
