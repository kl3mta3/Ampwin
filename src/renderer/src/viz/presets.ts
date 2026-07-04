// Preset catalog: bundled butterchurn-presets packs (loaded lazily — they're
// ~1.5 MB of JS) merged with user-imported JSON presets from userData/presets.
// Ids: 'b:<name>' bundled, 'u:<name>' user.

import type { PresetInfo } from '../../../shared/types'
import { native } from '../native'
import basePack from 'butterchurn-presets'
import extraPack from 'butterchurn-presets/lib/butterchurnPresetsExtra.min.js'

export class PresetCatalog {
  private bundled = new Map<string, object>()
  private userInfos: PresetInfo[] = []
  private userCache = new Map<string, object>()
  private loaded = false

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true

    const packs: Record<string, object>[] = [
      getPresetsFrom(basePack.default ?? basePack),
      getPresetsFrom(extraPack.default ?? extraPack)
    ]

    for (const pack of packs) {
      for (const [name, preset] of Object.entries(pack)) {
        if (!this.bundled.has(name)) this.bundled.set(name, preset)
      }
    }

    await this.refreshUser()
  }

  async refreshUser(): Promise<void> {
    this.userInfos = await native.invoke('presets:list-user')
  }

  list(): PresetInfo[] {
    const bundled: PresetInfo[] = [...this.bundled.keys()]
      .sort()
      .map((name) => ({ id: `b:${name}`, name, source: 'bundled' as const }))
    return [...this.userInfos, ...bundled]
  }

  async get(id: string): Promise<object | null> {
    if (id.startsWith('b:')) return this.bundled.get(id.slice(2)) ?? null
    if (id.startsWith('u:')) {
      if (!this.userCache.has(id)) {
        try {
          this.userCache.set(id, (await native.invoke('presets:read', id)) as object)
        } catch (err) {
          console.warn(`failed to read preset ${id}`, err)
          return null
        }
      }
      return this.userCache.get(id) ?? null
    }
    return null
  }

  randomId(excludeId?: string): string | null {
    const all = this.list()
    const pool = all.filter((p) => p.id !== excludeId)
    if (pool.length === 0) return all[0]?.id ?? null
    return pool[Math.floor(Math.random() * pool.length)].id
  }

  neighborId(currentId: string | null, dir: 1 | -1): string | null {
    const all = this.list()
    if (all.length === 0) return null
    const i = all.findIndex((p) => p.id === currentId)
    if (i < 0) return all[0].id
    return all[(i + dir + all.length) % all.length].id
  }
}

function getPresetsFrom(mod: unknown): Record<string, object> {
  const m = mod as { getPresets?: () => Record<string, object> }
  if (typeof m?.getPresets === 'function') return m.getPresets()
  console.warn('preset pack has unexpected shape', mod)
  return {}
}
