// Pop-out playlist window. Opened via window.open with a named frame so it's
// same-process/same-origin (main allow-lists 'ampwin-playlist'); the shell
// renders and drives it directly against the controller, so it needs no
// preload or IPC beyond window minimize. Mirrors the default skin's playlist:
// filter, current-track highlight, double-click to play, select + Delete to
// remove, and drag to reorder.

import type { PlayerController } from './controller'
import type { Track } from '../../../shared/types'
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
`

function fmt(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return '0:00'
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`
}

export class PlaylistWindow {
  private controller: PlayerController
  private win: Window | null = null
  private watch: number | null = null
  private unsubs: (() => void)[] = []
  private filter = ''
  private selected = new Set<number>()
  private dragFrom = -1

  constructor(controller: PlayerController) {
    this.controller = controller
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
    countEl.textContent = `${tracks.length} track${tracks.length === 1 ? '' : 's'}`
    const cur = listEl.querySelector('.cur') as HTMLElement | null
    if (cur) cur.scrollIntoView({ block: 'nearest' })
  }

  private onClosed(): void {
    if (!this.win) return
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
