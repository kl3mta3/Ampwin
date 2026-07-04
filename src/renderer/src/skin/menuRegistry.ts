// TrackMenuRegistry: lets addons contribute entries to the playlist's
// right-click menu (e.g. "Demucs v4 ▸ Get stems"). Addons register a labeled
// entry with sub-items + callbacks; skins list the entries when building their
// context menu and route clicks back through invoke(). Registration returns an
// unsubscriber, and facades track it, so disabling an addon removes its menus.
//
// Entries apply to LOCAL files only (that's the only current consumer shape);
// skins are told this via the listing so they can gate on track state.

import type { Track } from '../../../shared/types'
import { Emitter } from '../emitter'

export interface TrackMenuListing {
  key: string
  label: string
  items: { key: string; label: string }[]
}

interface RegisteredMenu {
  key: string
  label: string
  items: { key: string; label: string; action: (track: Track) => void }[]
}

interface MenuEvents extends Record<string, unknown[]> {
  changed: []
}

let nextKey = 1

export class TrackMenuRegistry {
  readonly events = new Emitter<MenuEvents>()
  private menus = new Map<string, RegisteredMenu>()

  register(spec: { label: string; items: { label: string; action: (track: Track) => void }[] }): () => void {
    const key = `m${nextKey++}`
    this.menus.set(key, {
      key,
      label: spec.label,
      items: spec.items.map((it, i) => ({ key: `i${i}`, label: it.label, action: it.action }))
    })
    this.events.emit('changed')
    return () => {
      if (this.menus.delete(key)) this.events.emit('changed')
    }
  }

  /** Menu entries applicable to this track (local, playable files only). */
  list(track: Track): TrackMenuListing[] {
    if (track.isRemote || track.missing || track.unreadable) return []
    return [...this.menus.values()].map((m) => ({
      key: m.key,
      label: m.label,
      items: m.items.map((it) => ({ key: it.key, label: it.label }))
    }))
  }

  invoke(menuKey: string, itemKey: string, track: Track): void {
    const menu = this.menus.get(menuKey)
    const item = menu?.items.find((it) => it.key === itemKey)
    if (!item) return
    try {
      item.action(track)
    } catch (err) {
      console.error(`track menu "${menu?.label}" action failed`, err)
    }
  }
}
