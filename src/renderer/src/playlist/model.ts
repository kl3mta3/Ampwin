// In-memory playlist: track list, current index, explicit play-next queue,
// shuffle order, repeat mode. Pure logic — no audio, no IPC.

import type { RepeatMode, Track } from '../../../shared/types'
import { Emitter } from '../emitter'

interface ModelEvents extends Record<string, unknown[]> {
  changed: [tracks: Track[], currentIndex: number]
  mode: [shuffle: boolean, repeat: RepeatMode]
}

export class PlaylistModel {
  readonly events = new Emitter<ModelEvents>()

  private tracks: Track[] = []
  private currentIndex = -1
  /** Explicit "play next" jumps (track ids, not indices — stable across moves). */
  private queue: string[] = []
  private shuffleOrder: string[] = []
  shuffle = false
  repeat: RepeatMode = 'off'

  getTracks(): Track[] {
    return [...this.tracks]
  }

  getCurrentIndex(): number {
    return this.currentIndex
  }

  getCurrentTrack(): Track | null {
    return this.tracks[this.currentIndex] ?? null
  }

  size(): number {
    return this.tracks.length
  }

  trackAt(index: number): Track | null {
    return this.tracks[index] ?? null
  }

  private emitChanged(): void {
    this.events.emit('changed', this.getTracks(), this.currentIndex)
  }

  setCurrentIndex(index: number): void {
    if (index >= -1 && index < this.tracks.length) {
      this.currentIndex = index
      this.emitChanged()
    }
  }

  replaceAll(tracks: Track[], currentIndex = -1): void {
    this.tracks = [...tracks]
    this.currentIndex = currentIndex
    this.queue = []
    this.regenerateShuffle()
    this.emitChanged()
  }

  add(tracks: Track[], atIndex?: number): void {
    const insertAt = atIndex === undefined ? this.tracks.length : atIndex
    this.tracks.splice(insertAt, 0, ...tracks)
    if (insertAt <= this.currentIndex) this.currentIndex += tracks.length
    this.regenerateShuffle()
    this.emitChanged()
  }

  removeIndices(indices: number[]): void {
    const toRemove = new Set(indices)
    const removedIds = new Set(this.tracks.filter((_, i) => toRemove.has(i)).map((t) => t.id))
    const currentId = this.tracks[this.currentIndex]?.id
    this.tracks = this.tracks.filter((_, i) => !toRemove.has(i))
    this.queue = this.queue.filter((id) => !removedIds.has(id))
    this.currentIndex = currentId
      ? this.tracks.findIndex((t) => t.id === currentId)
      : Math.min(this.currentIndex, this.tracks.length - 1)
    this.regenerateShuffle()
    this.emitChanged()
  }

  move(from: number, to: number): void {
    if (from < 0 || from >= this.tracks.length || to < 0 || to >= this.tracks.length) return
    const currentId = this.tracks[this.currentIndex]?.id
    const [item] = this.tracks.splice(from, 1)
    this.tracks.splice(to, 0, item)
    if (currentId) this.currentIndex = this.tracks.findIndex((t) => t.id === currentId)
    this.emitChanged()
  }

  clear(): void {
    this.tracks = []
    this.currentIndex = -1
    this.queue = []
    this.shuffleOrder = []
    this.emitChanged()
  }

  queueNext(index: number): void {
    const track = this.tracks[index]
    if (track) this.queue.push(track.id)
  }

  setShuffle(on: boolean): void {
    this.shuffle = on
    this.regenerateShuffle()
    this.events.emit('mode', this.shuffle, this.repeat)
  }

  setRepeat(mode: RepeatMode): void {
    this.repeat = mode
    this.events.emit('mode', this.shuffle, this.repeat)
  }

  /** Fisher–Yates over track ids, current track pinned first. */
  private regenerateShuffle(): void {
    const ids = this.tracks.map((t) => t.id)
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[ids[i], ids[j]] = [ids[j], ids[i]]
    }
    const currentId = this.tracks[this.currentIndex]?.id
    if (currentId) {
      const pos = ids.indexOf(currentId)
      if (pos > 0) {
        ids.splice(pos, 1)
        ids.unshift(currentId)
      }
    }
    this.shuffleOrder = ids
  }

  private indexOfId(id: string): number {
    return this.tracks.findIndex((t) => t.id === id)
  }

  private isPlayable(index: number): boolean {
    const t = this.tracks[index]
    return !!t && !t.missing && !t.unreadable
  }

  /**
   * Next index to play, or null to stop.
   * @param forEnded true when the current track finished naturally (repeat-one
   *                 applies) vs. an explicit user "next" (repeat-one skipped).
   */
  nextIndex(forEnded: boolean): number | null {
    if (this.tracks.length === 0) return null

    if (forEnded && this.repeat === 'one') return this.currentIndex

    // Explicit queue wins, skipping entries that have vanished.
    while (this.queue.length > 0) {
      const idx = this.indexOfId(this.queue.shift()!)
      if (idx >= 0 && this.isPlayable(idx)) return idx
    }

    const order = this.shuffle
      ? this.shuffleOrder.map((id) => this.indexOfId(id)).filter((i) => i >= 0)
      : this.tracks.map((_, i) => i)
    if (order.length === 0) return null

    const posInOrder = order.indexOf(this.currentIndex)
    // Walk forward looking for the next playable track (skip missing files),
    // at most one full lap.
    for (let step = 1; step <= order.length; step++) {
      const raw = posInOrder + step
      if (raw >= order.length && this.repeat !== 'all') return null
      const idx = order[raw % order.length]
      if (this.isPlayable(idx)) return idx
      if (idx === this.currentIndex) break
    }
    return null
  }

  prevIndex(): number | null {
    if (this.tracks.length === 0) return null
    const order = this.shuffle
      ? this.shuffleOrder.map((id) => this.indexOfId(id)).filter((i) => i >= 0)
      : this.tracks.map((_, i) => i)
    const posInOrder = order.indexOf(this.currentIndex)
    for (let step = 1; step <= order.length; step++) {
      const raw = posInOrder - step
      if (raw < 0 && this.repeat !== 'all') return null
      const idx = order[(raw + order.length) % order.length]
      if (this.isPlayable(idx)) return idx
      if (idx === this.currentIndex) break
    }
    return null
  }
}
