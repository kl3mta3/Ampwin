// A DOM lyrics layer drawn over the visualizer surface. Host-owned so it lives
// with the surface (re-attached on every remount). Works over ANY visualizer
// (MilkDrop, bars, black screen) because it's plain DOM, not canvas.
//
// Sources, in priority order: a live transcription stream (Phase C) overrides
// the track's metadata/.lrc lyrics. Synced lyrics highlight the active line and
// smooth-scroll it to center; unsynced lyrics show as a static, dimmed block.
import type { Lyrics } from '../../../shared/types'

export class LyricsOverlay {
  private el: HTMLElement | null = null
  private scroller: HTMLElement | null = null
  private lineEls: HTMLElement[] = []
  private compactLine: HTMLElement | null = null

  private metaLyrics: Lyrics | null = null
  private liveLyrics: Lyrics | null = null
  private enabled = true
  // Compact mode: while a real video/embed is on the surface we don't take over
  // the whole frame — instead we show just the current (synced) line pinned near
  // the bottom, like a subtitle, sitting above the fading transport overlay.
  private compact = false
  private posMs = 0
  private activeIdx = -1

  /** Point the overlay at a (fresh) surface element; rebuilds its contents. */
  attach(el: HTMLElement): void {
    this.el = el
    this.render()
  }

  detach(): void {
    this.el = null
    this.scroller = null
    this.lineEls = []
    this.compactLine = null
  }

  setEnabled(on: boolean): void {
    this.enabled = on
    this.applyVisibility()
  }

  isEnabled(): boolean {
    return this.enabled
  }

  /** Switch to compact (subtitle) mode while a real video/embed is on the surface:
   *  just the current synced line near the bottom, instead of the full overlay. */
  setCompact(on: boolean): void {
    if (this.compact === on) return
    this.compact = on
    this.render()
  }

  setLyrics(l: Lyrics | null): void {
    this.metaLyrics = l
    this.render()
  }

  pushLive(l: Lyrics | null): void {
    this.liveLyrics = l
    this.render()
  }

  clearLive(): void {
    this.liveLyrics = null
    this.render()
  }

  current(): Lyrics | null {
    return this.liveLyrics ?? this.metaLyrics
  }

  hasLyrics(): boolean {
    const c = this.current()
    return !!(c && c.lines.length)
  }

  setPositionMs(ms: number): void {
    this.posMs = ms
    this.updateHighlight()
  }

  /** Test hook: availability/enabled/visibility + active line text + geometry
   *  (the active line's center vs the viewport height — proves centering). */
  debugState(): {
    available: boolean
    enabled: boolean
    visible: boolean
    activeText: string
    viewH: number
    activeCenterY: number
  } {
    const cur = this.current()
    let viewH = 0
    let activeCenterY = -1
    if (this.el) {
      viewH = this.el.clientHeight
      const active = this.activeIdx >= 0 ? this.lineEls[this.activeIdx] : null
      if (active) {
        const er = this.el.getBoundingClientRect()
        const r = active.getBoundingClientRect()
        activeCenterY = r.top + r.height / 2 - er.top
      }
    }
    return {
      available: this.hasLyrics(),
      enabled: this.enabled,
      visible: !!this.el && this.el.style.display !== 'none',
      activeText: this.activeIdx >= 0 && cur ? (cur.lines[this.activeIdx]?.text ?? '') : '',
      viewH,
      activeCenterY
    }
  }

  private applyVisibility(): void {
    if (!this.el) return
    const cur = this.current()
    // Compact mode only makes sense for synced lyrics (there's a "current line").
    // Over video, an unsynced static block would just be noise, so hide it.
    const show = this.enabled && this.hasLyrics() && (!this.compact || !!cur?.synced)
    this.el.style.display = show ? 'flex' : 'none'
  }

  private render(): void {
    const el = this.el
    if (!el) return
    el.textContent = ''
    this.lineEls = []
    this.scroller = null
    this.compactLine = null
    this.activeIdx = -1

    const cur = this.current()
    if (!cur || !cur.lines.length) {
      this.applyVisibility()
      return
    }

    if (this.compact) {
      this.renderCompact(el)
      return
    }

    el.style.cssText =
      'position:absolute;inset:0;pointer-events:none;overflow:hidden;' +
      'display:flex;align-items:center;justify-content:center;' +
      'padding:8% 6%;box-sizing:border-box;text-align:center;' +
      "font-family:'Segoe UI',system-ui,sans-serif;z-index:2"

    const scroller = el.ownerDocument.createElement('div')
    // position:relative so each line's offsetTop is measured against the scroller
    // (transform-independent) — the basis for centering below.
    scroller.style.cssText =
      'position:relative;display:flex;flex-direction:column;gap:0.55em;width:100%;' +
      (cur.synced ? 'transition:transform .35s cubic-bezier(.4,0,.2,1)' : '')
    this.scroller = scroller

    for (const line of cur.lines) {
      const d = el.ownerDocument.createElement('div')
      d.textContent = line.text || (cur.synced ? '♪' : '')
      d.style.cssText =
        'font-size:clamp(15px,2.4vw,30px);font-weight:600;line-height:1.25;' +
        'color:#fff;opacity:' +
        (cur.synced ? '0.32' : '0.7') +
        ';text-shadow:0 2px 10px rgba(0,0,0,.85),0 0 3px rgba(0,0,0,.9);' +
        'transition:opacity .25s,transform .25s,color .25s'
      scroller.appendChild(d)
      this.lineEls.push(d)
    }
    el.appendChild(scroller)
    this.applyVisibility()
    if (cur.synced) this.updateHighlight(true)
  }

  // Subtitle-style single line pinned near the bottom, kept above the transport
  // overlay (which lives in the bottom ~50px of the pop-out / fullscreen window).
  private renderCompact(el: HTMLElement): void {
    el.style.cssText =
      'position:absolute;inset:0;pointer-events:none;overflow:hidden;' +
      'display:flex;align-items:flex-end;justify-content:center;' +
      'padding:0 6% 64px;box-sizing:border-box;text-align:center;' +
      "font-family:'Segoe UI',system-ui,sans-serif;z-index:2"

    const line = el.ownerDocument.createElement('div')
    line.style.cssText =
      'font-size:clamp(16px,2.6vw,32px);font-weight:700;line-height:1.3;color:#fff;' +
      'text-shadow:0 2px 12px rgba(0,0,0,.95),0 0 4px rgba(0,0,0,.95);' +
      'background:rgba(0,0,0,.32);padding:.12em .55em;border-radius:8px;max-width:100%;' +
      'transition:opacity .2s'
    el.appendChild(line)
    this.compactLine = line

    this.applyVisibility()
    // Only synced lyrics drive a "current line"; unsynced stays hidden (see
    // applyVisibility), so this is a no-op for those.
    this.updateHighlight(true)
  }

  private updateHighlight(force = false): void {
    const cur = this.current()
    if (!this.el || !cur || !cur.synced) return
    if (this.compact) {
      this.updateCompact(cur, force)
      return
    }
    if (!this.scroller) return
    const lines = cur.lines
    let idx = -1
    for (let i = 0; i < lines.length; i++) {
      if ((lines[i].timeMs ?? 0) <= this.posMs) idx = i
      else break
    }
    if (idx === this.activeIdx && !force) return
    this.activeIdx = idx

    for (let i = 0; i < this.lineEls.length; i++) {
      const active = i === idx
      const near = Math.abs(i - idx) === 1
      const le = this.lineEls[i]
      le.style.opacity = active ? '1' : near ? '0.55' : '0.28'
      le.style.color = active ? '#7dffb0' : '#fff'
      le.style.transform = active ? 'scale(1.06)' : 'scale(1)'
    }

    const active = this.lineEls[idx]
    if (active) {
      // The scroller is flex-centered in the viewport, so translating it by
      // (scrollerHeight/2 − activeLineCenter) lands the active line dead-center —
      // regardless of surface size (mini, pop-out, fullscreen), padding, or font.
      // offsetTop/offsetHeight are layout values, unaffected by the transform, so
      // this never fights the in-flight scroll animation.
      const y = this.scroller.clientHeight / 2 - (active.offsetTop + active.offsetHeight / 2)
      this.scroller.style.transform = `translateY(${y}px)`
    } else {
      this.scroller.style.transform = 'translateY(0)'
    }
  }

  // Compact mode: swap the single bottom line to the active lyric, hiding it in
  // the gaps between lines (nothing to show yet, or an instrumental break).
  private updateCompact(cur: Lyrics, force: boolean): void {
    const lines = cur.lines
    let idx = -1
    for (let i = 0; i < lines.length; i++) {
      if ((lines[i].timeMs ?? 0) <= this.posMs) idx = i
      else break
    }
    if (idx === this.activeIdx && !force) return
    this.activeIdx = idx
    if (!this.compactLine) return
    const text = idx >= 0 ? (lines[idx]?.text ?? '') : ''
    this.compactLine.textContent = text
    this.compactLine.style.opacity = text ? '1' : '0'
  }
}
