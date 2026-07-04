// Frameless-window drag regions for skins.
//
// Chromium computes -webkit-app-region only from the TOP-LEVEL frame, so a
// drag region declared inside the skin iframe does nothing. The skin instead
// calls ampwin.window.setDragRegion(el) and we mirror el's rectangle as an
// overlay div in #overlay-layer (top level) with app-region:drag and
// pointer-events:none — the window drags from that area while clicks fall
// through to the skin's real buttons underneath. Exclusions get no-drag divs.
//
// The iframe fills the window at inset:0, so iframe-local coordinates equal
// top-level coordinates 1:1.

export class DragRegionMirror {
  private overlay: HTMLElement
  private entries = new Set<RegionEntry>()
  private pollTimer: number

  constructor() {
    this.overlay = document.getElementById('overlay-layer')!
    // Cheap safety net for layout changes ResizeObserver can't see (e.g. the
    // element moved because a sibling changed size).
    this.pollTimer = window.setInterval(() => this.syncAll(), 500)
  }

  add(el: HTMLElement, exclude: HTMLElement[] = []): () => void {
    const entry: RegionEntry = {
      el,
      exclude,
      div: this.makeDiv('drag'),
      exDivs: exclude.map(() => this.makeDiv('no-drag')),
      observer: new ResizeObserver(() => this.sync(entry))
    }
    entry.observer.observe(el)
    for (const ex of exclude) entry.observer.observe(ex)
    this.entries.add(entry)
    this.sync(entry)
    return () => this.remove(entry)
  }

  private makeDiv(region: 'drag' | 'no-drag'): HTMLElement {
    const div = document.createElement('div')
    div.style.cssText = `position:absolute;pointer-events:none;-webkit-app-region:${region}`
    this.overlay.appendChild(div)
    return div
  }

  private sync(entry: RegionEntry): void {
    if (!entry.el.isConnected) {
      this.remove(entry)
      return
    }
    place(entry.div, entry.el.getBoundingClientRect())
    entry.exclude.forEach((ex, i) => place(entry.exDivs[i], ex.getBoundingClientRect()))
  }

  private syncAll(): void {
    for (const entry of [...this.entries]) this.sync(entry)
  }

  private remove(entry: RegionEntry): void {
    entry.observer.disconnect()
    entry.div.remove()
    for (const d of entry.exDivs) d.remove()
    this.entries.delete(entry)
  }

  disposeAll(): void {
    for (const entry of [...this.entries]) this.remove(entry)
  }

  destroy(): void {
    this.disposeAll()
    clearInterval(this.pollTimer)
  }
}

interface RegionEntry {
  el: HTMLElement
  exclude: HTMLElement[]
  div: HTMLElement
  exDivs: HTMLElement[]
  observer: ResizeObserver
}

function place(div: HTMLElement, r: DOMRect): void {
  div.style.left = `${r.left}px`
  div.style.top = `${r.top}px`
  div.style.width = `${r.width}px`
  div.style.height = `${r.height}px`
  div.style.display = r.width > 0 && r.height > 0 ? 'block' : 'none'
}
