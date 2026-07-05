// Pop-out playlist window. Opened via window.open with a named frame so it's
// same-process/same-origin (main allow-lists 'ampwin-playlist'); the shell
// renders and drives it directly against the controller, so it needs no
// preload or IPC beyond window minimize. Mirrors the default skin's playlist:
// filter, current-track highlight, double-click to play, select + Delete to
// remove, and drag to reorder.

import type { PlayerController } from './controller'
import type { Track } from '../../../shared/types'
import type { TrackMenuRegistry } from '../skin/menuRegistry'
import { native } from '../native'

const STYLE = `
  * { margin: 0; box-sizing: border-box; user-select: none; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: #14161a; }
  body { display: flex; flex-direction: column; font-family: 'Segoe UI', sans-serif;
         color: #c8ccd4; border: 1px solid #3a3f4b; }
  #bar { display: flex; align-items: center; gap: 6px; padding: 5px 8px;
         background: linear-gradient(#262a33, #191c22); border-bottom: 1px solid #000;
         -webkit-app-region: drag; }
  #logo { font-size: 10px; font-weight: bold; letter-spacing: 2px; color: #3fdf6f; }
  #count { flex: 1; font-size: 10px; color: #7a8090; text-align: center; }
  button { -webkit-app-region: no-drag; background: #1d222b; color: #cfd4dd;
           border: 1px solid #000; border-radius: 3px; min-width: 22px; padding: 2px 7px;
           font-size: 12px; cursor: pointer; }
  button:hover { background: #2a3140; }
  #x:hover { background: #7f1f1f; }
  #filter { margin: 5px 6px; background: #0a0c0e; border: 1px solid #000; color: #c8ccd4;
            font-family: Consolas, monospace; font-size: 11px; padding: 4px 6px; border-radius: 2px; }
  #filter:focus { outline: none; border-color: #2d9f57; }
  #list { flex: 1; overflow-y: auto; background: #0a0c0e; font-family: Consolas, monospace; font-size: 11px; }
  .row { display: flex; gap: 6px; padding: 3px 8px; white-space: nowrap; color: #1f7f3f; }
  .row:nth-child(even) { background: rgba(255,255,255,0.02); }
  .row:hover { background: rgba(63,223,111,0.08); }
  .row.sel { background: rgba(63,223,111,0.22); color: #c6f6c6; box-shadow: inset 3px 0 0 #3fdf6f; }
  .row.cur { color: #3fdf6f; font-weight: bold; }
  .row.missing, .row.unreadable { opacity: 0.45; }
  .row.dragging { opacity: 0.4; }
  .row.drop-above { box-shadow: inset 0 2px 0 0 #3fdf6f; }
  .row.drop-below { box-shadow: inset 0 -2px 0 0 #3fdf6f; }
  .num { min-width: 26px; text-align: right; color: #7a8090; }
  .name { flex: 1; overflow: hidden; text-overflow: ellipsis; }
  .dur { color: #7a8090; }
  .empty { padding: 14px; text-align: center; color: #7a8090; }
  .ctx { position: fixed; z-index: 100; background: #1a1e26; border: 1px solid #000; border-radius: 4px;
         box-shadow: 0 6px 20px rgba(0,0,0,.6); padding: 4px; min-width: 170px;
         font-family: 'Segoe UI', sans-serif; font-size: 12px; }
  .ctx .mi { display: flex; justify-content: space-between; gap: 14px; padding: 6px 10px;
             border-radius: 3px; cursor: pointer; white-space: nowrap; color: #cfd4dd; }
  .ctx .mi:hover { background: #2d9f57; color: #fff; }
  .ctx .mi .arr { color: #7a8090; }
  .ctx .mi:hover .arr { color: #fff; }
  .ctx .sep { height: 1px; background: #333; margin: 4px 2px; }
`

function fmt(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return '0:00'
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`
}

type MenuItem = 'sep' | { label: string; action?: () => void; submenu?: MenuItem[] }

export class PlaylistWindow {
  private controller: PlayerController
  private trackMenus: TrackMenuRegistry
  private win: Window | null = null
  private watch: number | null = null
  private unsubs: (() => void)[] = []
  private filter = ''
  private selected = new Set<number>()
  private dragFrom = -1
  private menuPanels: HTMLElement[] = []
  private menuOutside: ((e: Event) => void) | null = null
  private busyStatus: string | null = null
  private statusTimer: number | null = null

  constructor(controller: PlayerController, trackMenus: TrackMenuRegistry) {
    this.controller = controller
    this.trackMenus = trackMenus
  }

  isOpen(): boolean {
    return this.win !== null && !this.win.closed
  }

  toggle(): void {
    if (this.isOpen()) this.win!.focus()
    else this.open()
  }

  open(): void {
    if (this.isOpen()) {
      this.win!.focus()
      return
    }
    const win = window.open('about:blank', 'ampwin-playlist')
    if (!win) {
      console.error('playlist pop-out was blocked')
      return
    }
    this.win = win
    const doc = win.document
    doc.title = 'Ampwin Playlist'
    const style = doc.createElement('style')
    style.textContent = STYLE
    doc.head.appendChild(style)
    doc.body.innerHTML = `
      <div id="bar">
        <span id="logo">AMPWIN</span>
        <span id="count"></span>
        <button id="min" title="Minimize">–</button>
        <button id="x" title="Close">×</button>
      </div>
      <input id="filter" type="text" placeholder="🔍 filter…" />
      <div id="list"></div>`

    doc.getElementById('min')!.addEventListener('click', () => void native.invoke('popout:minimize', 'ampwin-playlist'))
    doc.getElementById('x')!.addEventListener('click', () => win.close())

    const filterEl = doc.getElementById('filter') as HTMLInputElement
    filterEl.addEventListener('input', () => {
      this.filter = filterEl.value.trim().toLowerCase()
      this.render()
    })

    const listEl = doc.getElementById('list')!
    listEl.addEventListener('dblclick', (e) => {
      const row = (e.target as HTMLElement).closest('.row') as HTMLElement | null
      if (row) void this.controller.playIndex(Number(row.dataset.i))
    })
    listEl.addEventListener('mousedown', (e) => {
      const row = (e.target as HTMLElement).closest('.row') as HTMLElement | null
      if (!row) return
      const i = Number(row.dataset.i)
      if ((e as MouseEvent).ctrlKey) this.selected.has(i) ? this.selected.delete(i) : this.selected.add(i)
      else this.selected = new Set([i])
      this.paintSelection()
    })
    doc.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Delete' && this.selected.size) {
        this.controller.model.removeIndices([...this.selected])
        this.selected.clear()
      }
    })
    listEl.addEventListener('contextmenu', (e) => {
      const ev = e as MouseEvent
      const row = (ev.target as HTMLElement).closest('.row') as HTMLElement | null
      if (!row) return
      ev.preventDefault()
      const i = Number(row.dataset.i)
      if (!this.selected.has(i)) {
        this.selected = new Set([i])
        this.paintSelection()
      }
      void this.openContextMenu(ev.clientX, ev.clientY, i)
    })

    // drag to reorder
    listEl.addEventListener('dragstart', (e) => {
      const row = (e.target as HTMLElement).closest('.row') as HTMLElement | null
      if (!row) return
      this.dragFrom = Number(row.dataset.i)
      row.classList.add('dragging')
      ;(e as DragEvent).dataTransfer!.effectAllowed = 'move'
    })
    listEl.addEventListener('dragover', (e) => {
      if (this.dragFrom < 0) return
      e.preventDefault()
      this.clearDropMarks()
      const row = (e.target as HTMLElement).closest('.row') as HTMLElement | null
      if (row) {
        const r = row.getBoundingClientRect()
        row.classList.add((e as DragEvent).clientY < r.top + r.height / 2 ? 'drop-above' : 'drop-below')
      }
    })
    listEl.addEventListener('drop', (e) => {
      if (this.dragFrom < 0) return
      e.preventDefault()
      const row = (e.target as HTMLElement).closest('.row') as HTMLElement | null
      let ins: number
      if (row) {
        const i = Number(row.dataset.i)
        const r = row.getBoundingClientRect()
        ins = (e as DragEvent).clientY < r.top + r.height / 2 ? i : i + 1
      } else {
        ins = this.controller.model.size()
      }
      const to = ins > this.dragFrom ? ins - 1 : ins
      if (to !== this.dragFrom) this.controller.model.move(this.dragFrom, to)
      this.clearDropMarks()
      this.dragFrom = -1
    })
    listEl.addEventListener('dragend', () => {
      listEl.querySelectorAll('.dragging').forEach((r) => r.classList.remove('dragging'))
      this.clearDropMarks()
      this.dragFrom = -1
    })

    this.unsubs.push(this.controller.model.events.on('changed', () => this.render()))
    this.unsubs.push(this.controller.events.on('track', () => this.render()))

    win.addEventListener('unload', () => this.onClosed())
    this.watch = window.setInterval(() => {
      if (this.win && this.win.closed) this.onClosed()
    }, 1000)

    this.render()
  }

  private clearDropMarks(): void {
    this.win?.document
      .querySelectorAll('.drop-above, .drop-below')
      .forEach((r) => r.classList.remove('drop-above', 'drop-below'))
  }

  private matches(t: Track): boolean {
    if (!this.filter) return true
    return `${t.artist || ''} ${t.title || ''}`.toLowerCase().includes(this.filter)
  }

  private paintSelection(): void {
    if (!this.win) return
    this.win.document.querySelectorAll<HTMLElement>('.row').forEach((row) => {
      row.classList.toggle('sel', this.selected.has(Number(row.dataset.i)))
    })
  }

  private render(): void {
    if (!this.isOpen()) return
    const doc = this.win!.document
    const listEl = doc.getElementById('list')
    const countEl = doc.getElementById('count')
    if (!listEl || !countEl) return
    const tracks = this.controller.model.getTracks()
    const current = this.controller.model.getCurrentIndex()
    listEl.textContent = ''
    let shown = 0
    tracks.forEach((t, i) => {
      if (!this.matches(t)) return
      shown++
      const row = doc.createElement('div')
      row.className =
        'row' +
        (i === current ? ' cur' : '') +
        (this.selected.has(i) ? ' sel' : '') +
        (t.missing ? ' missing' : '') +
        (t.unreadable ? ' unreadable' : '')
      row.dataset.i = String(i)
      row.draggable = true
      const num = doc.createElement('span')
      num.className = 'num'
      num.textContent = `${i + 1}.`
      const name = doc.createElement('span')
      name.className = 'name'
      name.textContent = (t.artist ? `${t.artist} — ` : '') + t.title
      const dur = doc.createElement('span')
      dur.className = 'dur'
      dur.textContent = fmt(t.durationSec)
      row.append(num, name, dur)
      listEl.appendChild(row)
    })
    if (shown === 0) {
      const empty = doc.createElement('div')
      empty.className = 'empty'
      empty.textContent = tracks.length === 0 ? 'playlist empty' : 'no matches'
      listEl.appendChild(empty)
    }
    countEl.textContent = this.busyStatus ?? `${tracks.length} track${tracks.length === 1 ? '' : 's'}`
    const cur = listEl.querySelector('.cur') as HTMLElement | null
    if (cur) cur.scrollIntoView({ block: 'nearest' })
  }

  private async openContextMenu(x: number, y: number, i: number): Promise<void> {
    if (!this.win) return
    const tracks = this.controller.model.getTracks()
    const track = tracks[i]
    if (!track) return
    const many = this.selected.size > 1
    // Download applies to the remote (link) tracks in the selection.
    const remoteIdx = [...this.selected].filter((n) => tracks[n] && tracks[n].isRemote)

    const items: MenuItem[] = [
      { label: '▶ Play', action: () => void this.controller.playIndex(i) },
      { label: '⏭ Play next', action: () => this.controller.model.queueNext(i) }
    ]

    // Add the selected track(s) to an existing saved playlist.
    const saved = await this.controller.listSavedPlaylists().catch(() => [])
    if (!this.win) return // window may have closed during the await
    if (saved.length) {
      const sel = this.selected.has(i) ? [...this.selected] : [i]
      const selTracks = sel.map((n) => tracks[n]).filter(Boolean)
      items.push({
        label: '➕ Add to playlist',
        submenu: saved.map((p) => ({
          label: `${p.name} (${p.trackCount})`,
          action: () => {
            void this.controller.addTracksToSavedPlaylist(p.id, selTracks)
            this.setStatus(`➕ added ${selTracks.length} to “${p.name}”`, true)
          }
        }))
      })
    }

    if (remoteIdx.length > 0) {
      const n = remoteIdx.length > 1 ? ` (${remoteIdx.length})` : ''
      items.push({
        label: '⬇ Download' + n,
        submenu: [
          { label: 'Audio (.m4a)', action: () => void this.runDownload(remoteIdx, 'audio') },
          { label: 'Video (no audio)', action: () => void this.runDownload(remoteIdx, 'video') },
          { label: 'Audio + Video (.mp4)', action: () => void this.runDownload(remoteIdx, 'both') }
        ]
      })
    }

    // Convert applies to a single local, readable file.
    if (!track.isRemote && !track.missing && !track.unreadable) {
      const formats = await native.invoke('convert:list', !!track.isVideo).catch(() => [])
      if (!this.win) return // window may have closed during the await
      if (formats.length) {
        items.push({
          label: '🔄 Convert…',
          submenu: formats.map((f) => ({
            label: f.label,
            action: () => void this.runConvert(track, f.id)
          }))
        })
      }
    }

    // Addon-provided context menus (stems, karaokefy, etc.) for local files.
    for (const menu of this.trackMenus.list(track)) {
      items.push({
        label: menu.label,
        submenu: menu.items.map((it) => ({
          label: it.label,
          action: () => void this.trackMenus.invoke(menu.key, it.key, track)
        }))
      })
    }

    items.push('sep')
    items.push({
      label: many ? `✕ Remove ${this.selected.size} tracks` : '✕ Remove from list',
      action: () => {
        const idx = this.selected.has(i) ? [...this.selected] : [i]
        this.controller.model.removeIndices(idx)
        this.selected.clear()
      }
    })
    this.showMenu(x, y, items)
  }

  // Download the given remote playlist indices one at a time, showing progress
  // in the top count bar. Mirrors the default skin's downloadSelection().
  private async runDownload(indices: number[], kind: 'audio' | 'video' | 'both'): Promise<void> {
    const tracks = this.controller.model.getTracks()
    const targets = indices.map((n) => tracks[n]).filter((t) => t && t.isRemote)
    if (!targets.length) return
    const off = native.on('evt:download-progress', ({ percent, phase }) =>
      this.setStatus(`⬇ ${phase} ${Math.round(percent)}%`)
    )
    let done = 0
    for (const t of targets) {
      this.setStatus(`⬇ downloading “${t.title}”…`)
      const local = await this.controller.downloadTrack(t, kind)
      if (local) done++
    }
    off()
    this.setStatus(`✓ downloaded ${done}/${targets.length}`, true)
  }

  private async runConvert(track: Track, formatId: string): Promise<void> {
    const off = native.on('evt:convert-progress', ({ percent }) =>
      this.setStatus(`🔄 converting ${Math.round(percent)}%`)
    )
    this.setStatus(`🔄 converting “${track.title}”…`)
    try {
      await this.controller.convertTrack(track, formatId)
      this.setStatus('✓ converted → downloads/Converted', true)
    } catch {
      this.setStatus('✗ convert failed', true)
    } finally {
      off()
    }
  }

  // Show a transient message in the top count bar; render() honours busyStatus so
  // playlist updates mid-operation don't clobber it. autoClear reverts after 4s.
  private setStatus(msg: string, autoClear = false): void {
    if (!this.win) return
    this.busyStatus = msg
    const el = this.win.document.getElementById('count')
    if (el) el.textContent = msg
    if (this.statusTimer !== null) {
      this.win.clearTimeout(this.statusTimer)
      this.statusTimer = null
    }
    if (autoClear) {
      this.statusTimer = this.win.setTimeout(() => {
        this.busyStatus = null
        this.statusTimer = null
        this.render()
      }, 4000)
    }
  }

  private showMenu(x: number, y: number, items: MenuItem[]): void {
    if (!this.win) return
    this.closeMenu()
    const doc = this.win.document
    const root = this.buildMenuPanel(items, 0)
    doc.body.appendChild(root)
    this.placePanel(root, x, y)
    const close = (e: Event): void => {
      if (!this.menuPanels.some((p) => p.contains(e.target as Node))) this.closeMenu()
    }
    this.menuOutside = close
    setTimeout(() => {
      if (!this.win || this.menuOutside !== close) return
      doc.addEventListener('mousedown', close)
      doc.addEventListener('contextmenu', close)
    }, 0)
  }

  private buildMenuPanel(items: MenuItem[], depth: number): HTMLElement {
    const doc = this.win!.document
    const panel = doc.createElement('div')
    panel.className = 'ctx'
    panel.dataset.depth = String(depth)
    for (const it of items) {
      if (it === 'sep') {
        const sep = doc.createElement('div')
        sep.className = 'sep'
        panel.appendChild(sep)
        continue
      }
      const el = doc.createElement('div')
      el.className = 'mi'
      const label = doc.createElement('span')
      label.textContent = it.label
      el.appendChild(label)
      if (it.submenu) {
        const arr = doc.createElement('span')
        arr.className = 'arr'
        arr.textContent = '▸'
        el.appendChild(arr)
        el.addEventListener('mouseenter', () => {
          this.closeDeeperThan(depth)
          const child = this.buildMenuPanel(it.submenu!, depth + 1)
          doc.body.appendChild(child)
          const pr = el.getBoundingClientRect()
          const cr = child.getBoundingClientRect()
          const vw = doc.documentElement.clientWidth
          let left = pr.right - 2
          if (left + cr.width > vw) left = Math.max(0, pr.left - cr.width + 2)
          this.placePanel(child, left, pr.top)
        })
      } else if (it.action) {
        const act = it.action
        el.addEventListener('mouseenter', () => this.closeDeeperThan(depth))
        el.addEventListener('click', () => {
          this.closeMenu()
          act()
        })
      }
      panel.appendChild(el)
    }
    this.menuPanels.push(panel)
    return panel
  }

  private placePanel(panel: HTMLElement, x: number, y: number): void {
    const doc = this.win!.document
    const r = panel.getBoundingClientRect()
    const vw = doc.documentElement.clientWidth
    const vh = doc.documentElement.clientHeight
    panel.style.left = `${Math.max(0, Math.min(x, vw - r.width))}px`
    panel.style.top = `${Math.max(0, Math.min(y, vh - r.height))}px`
  }

  private closeDeeperThan(depth: number): void {
    this.menuPanels = this.menuPanels.filter((p) => {
      if (Number(p.dataset.depth) > depth) {
        p.remove()
        return false
      }
      return true
    })
  }

  private closeMenu(): void {
    for (const p of this.menuPanels) p.remove()
    this.menuPanels = []
    const doc = this.win?.document
    if (doc && this.menuOutside) {
      doc.removeEventListener('mousedown', this.menuOutside)
      doc.removeEventListener('contextmenu', this.menuOutside)
    }
    this.menuOutside = null
  }

  private onClosed(): void {
    if (!this.win) return
    this.closeMenu()
    if (this.statusTimer !== null) {
      this.win.clearTimeout(this.statusTimer)
      this.statusTimer = null
    }
    this.busyStatus = null
    this.win = null
    if (this.watch !== null) {
      clearInterval(this.watch)
      this.watch = null
    }
    for (const u of this.unsubs) u()
    this.unsubs = []
    this.selected.clear()
  }
}
