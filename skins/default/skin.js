// Ampwin Classic — the default skin, and the reference use of window.ampwin.
// Plain dependency-free JavaScript: skins need no build step.
/* global ampwin */
;(() => {
  'use strict'

  const $ = (id) => document.getElementById(id)

  // ---- title bar + window drag ------------------------------------------

  $('btn-min').addEventListener('click', () => ampwin.window.minimize())
  $('btn-close').addEventListener('click', () => ampwin.window.close())
  ampwin.window.setDragRegion($('titlebar'), { exclude: [$('btn-min'), $('btn-close')] })

  // ---- helpers ------------------------------------------------------------

  const fmt = (sec) => {
    if (!isFinite(sec) || sec <= 0) return '0:00'
    const m = Math.floor(sec / 60)
    const s = Math.floor(sec % 60)
    return m + ':' + String(s).padStart(2, '0')
  }

  // ---- transport -----------------------------------------------------------

  const playBtn = $('btn-play')
  const seek = $('seek')
  let seeking = false

  $('btn-prev').addEventListener('click', () => ampwin.player.previous())
  playBtn.addEventListener('click', () => ampwin.player.togglePlay())
  $('btn-stop').addEventListener('click', () => ampwin.player.stop())
  $('btn-next').addEventListener('click', () => ampwin.player.next())

  seek.addEventListener('pointerdown', () => (seeking = true))
  seek.addEventListener('change', () => {
    const snap = ampwin.player.getSnapshot()
    if (snap.durationSec > 0) ampwin.player.seek((seek.value / 1000) * snap.durationSec)
    seeking = false
  })

  let loadingTimer = null
  ampwin.player.on('state', (s) => {
    playBtn.textContent = s === 'playing' ? '⏸' : s === 'loading' ? '…' : '▶'
    // Converting a video (remux/transcode) can take a while — show progress.
    clearInterval(loadingTimer)
    loadingTimer = null
    if (s === 'loading') {
      loadingTimer = setInterval(() => {
        const snap = ampwin.player.getSnapshot()
        if (snap.state !== 'loading') {
          clearInterval(loadingTimer)
          loadingTimer = null
          return
        }
        const pct = snap.loadingPercent
        $('title-text').textContent = `⏳ converting… ${pct != null ? pct + '%' : ''}`
      }, 400)
    }
  })

  ampwin.player.on('position', (pos, dur) => {
    $('time-pos').textContent = fmt(pos)
    $('time-dur').textContent = fmt(dur)
    if (!seeking && dur > 0) seek.value = Math.round((pos / dur) * 1000)
  })

  // ---- volume / mute / shuffle / repeat -------------------------------------

  const vol = $('vol')
  const muteBtn = $('btn-mute')
  const shuffleBtn = $('btn-shuffle')
  const repeatBtn = $('btn-repeat')

  vol.addEventListener('input', () => ampwin.player.setVolume(vol.value / 100))
  muteBtn.addEventListener('click', () => {
    ampwin.player.setMuted(!ampwin.player.getSnapshot().muted)
  })
  shuffleBtn.addEventListener('click', () => {
    ampwin.player.setShuffle(!ampwin.player.getSnapshot().shuffle)
  })
  repeatBtn.addEventListener('click', () => {
    const order = ['off', 'all', 'one']
    const cur = ampwin.player.getSnapshot().repeat
    ampwin.player.setRepeat(order[(order.indexOf(cur) + 1) % 3])
  })

  ampwin.player.on('volume', (v, muted) => {
    vol.value = Math.round(v * 100)
    muteBtn.textContent = muted ? '🔇' : '🔊'
  })

  ampwin.player.on('mode', (shuffle, repeat) => {
    shuffleBtn.classList.toggle('on', shuffle)
    repeatBtn.classList.toggle('on', repeat !== 'off')
    $('repeat-mode').textContent = repeat === 'one' ? '1' : ''
  })

  // ---- track info ------------------------------------------------------------

  ampwin.player.on('track', async (t) => {
    $('title-text').textContent = t ? (t.artist ? t.artist + ' — ' : '') + t.title : 'welcome'
    $('track-title').textContent = t ? t.title : 'no track'
    $('track-artist').textContent = t ? t.artist : ''
    $('track-album').textContent = t ? t.album : ''
    $('track-tech').textContent = t
      ? [t.codec, fmt(t.durationSec), t.verdict === 'transcode' ? 'via ffmpeg' : 'native'].join(' · ')
      : ''
    const art = $('art')
    art.hidden = true
    if (t) {
      const url = await ampwin.files.getArtworkUrl(t)
      // Track may have changed while we awaited; only show art for the current one.
      if (url && ampwin.player.getSnapshot().track?.id === t.id) {
        art.src = url
        art.hidden = false
      }
    }
  })

  ampwin.player.on('error', (msg, t) => {
    $('title-text').textContent = '⚠ ' + (t ? t.title + ': ' : '') + msg
  })

  // ---- context menu helper (supports one level of submenus) --------------

  let menuRoot = null
  function closeMenu() {
    menuRoot?.remove()
    menuRoot = null
  }

  function placePanel(panel, x, y) {
    const r = panel.getBoundingClientRect()
    panel.style.left = Math.min(x, window.innerWidth - r.width - 4) + 'px'
    panel.style.top = Math.min(y, window.innerHeight - r.height - 4) + 'px'
  }

  function buildPanel(items) {
    const panel = document.createElement('div')
    panel.className = 'ctx-menu'
    for (const item of items) {
      const row = document.createElement('div')
      row.className = 'ctx-item' + (item.submenu ? ' has-sub' : '')
      row.textContent = item.label + (item.submenu ? '   ▸' : '')
      row.addEventListener('mouseenter', () => {
        if (panel._sub) {
          panel._sub.remove()
          panel._sub = null
        }
        if (item.submenu) {
          const sub = buildPanel(item.submenu)
          menuRoot.appendChild(sub)
          const rr = row.getBoundingClientRect()
          placePanel(sub, rr.right - 3, rr.top)
          panel._sub = sub
        }
      })
      if (!item.submenu) {
        row.addEventListener('click', () => {
          closeMenu()
          item.action()
        })
      }
      panel.appendChild(row)
    }
    return panel
  }

  function showMenu(x, y, items) {
    closeMenu()
    menuRoot = document.createElement('div')
    menuRoot.id = 'ctx-root'
    document.body.appendChild(menuRoot)
    const main = buildPanel(items)
    menuRoot.appendChild(main)
    placePanel(main, x, y)
  }

  document.addEventListener('click', closeMenu)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu()
  })

  // ---- playlist --------------------------------------------------------------

  const listEl = $('playlist')
  let selected = new Set()
  let lastClicked = -1
  let filterQuery = ''

  function matchesFilter(t) {
    if (!filterQuery) return true
    return ((t.artist || '') + ' ' + (t.title || '')).toLowerCase().includes(filterQuery)
  }

  // Filtering is a view concern: hide non-matching rows but keep their real
  // playlist index (data-i), so play/select/drag still act on true positions.
  function applyFilter() {
    let visible = 0
    listEl.querySelectorAll('.pl-row').forEach((row) => {
      const t = ampwin.playlist.getTracks()[Number(row.dataset.i)]
      const show = t && matchesFilter(t)
      row.style.display = show ? '' : 'none'
      if (show) visible++
    })
    listEl.classList.toggle('filtered', !!filterQuery)
    let empty = $('pl-no-matches')
    if (filterQuery && visible === 0) {
      if (!empty) {
        empty = document.createElement('div')
        empty.id = 'pl-no-matches'
        empty.textContent = 'no matches'
        listEl.appendChild(empty)
      }
    } else if (empty) {
      empty.remove()
    }
  }

  function renderPlaylist(tracks, currentIndex) {
    listEl.textContent = ''
    tracks.forEach((t, i) => {
      const row = document.createElement('div')
      row.className =
        'pl-row' +
        (i === currentIndex ? ' current' : '') +
        (selected.has(i) ? ' selected' : '') +
        (t.missing ? ' missing' : '') +
        (t.unreadable ? ' unreadable' : '') +
        (t.isRemote ? ' remote' : '')
      row.dataset.i = i
      row.draggable = true

      const num = document.createElement('span')
      num.className = 'pl-num'
      num.textContent = i + 1 + '.'
      const name = document.createElement('span')
      name.className = 'pl-name'
      name.textContent = (t.artist ? t.artist + ' — ' : '') + t.title
      const dur = document.createElement('span')
      dur.className = 'pl-dur'
      dur.textContent = fmt(t.durationSec)

      row.append(num, name, dur)
      listEl.appendChild(row)
    })
    applyFilter()
    const cur = listEl.querySelector('.current')
    if (cur && cur.style.display !== 'none') cur.scrollIntoView({ block: 'nearest' })
  }

  // filter input
  const searchEl = $('pl-search')
  function setFilter(q) {
    filterQuery = q.trim().toLowerCase()
    $('pl-search-bar').classList.toggle('active', !!filterQuery)
    applyFilter()
  }
  searchEl.addEventListener('input', () => setFilter(searchEl.value))
  searchEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      searchEl.value = ''
      setFilter('')
    }
  })
  $('pl-search-clear').addEventListener('click', () => {
    searchEl.value = ''
    setFilter('')
    searchEl.focus()
  })
  $('pl-downloads').addEventListener('click', () => ampwin.links.openDownloadsFolder())

  // Selection updates classes in place — never re-render on click, or the
  // second click of a double-click lands on a replaced DOM node and the
  // browser won't produce a dblclick event.
  function updateSelectionClasses() {
    listEl.querySelectorAll('.pl-row').forEach((row) => {
      row.classList.toggle('selected', selected.has(Number(row.dataset.i)))
    })
  }

  listEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return
    const row = e.target.closest('.pl-row')
    if (!row) return
    const i = Number(row.dataset.i)
    if (e.shiftKey && lastClicked >= 0) {
      // range select from the last clicked row
      const [a, b] = [Math.min(lastClicked, i), Math.max(lastClicked, i)]
      if (!e.ctrlKey) selected = new Set()
      for (let n = a; n <= b; n++) selected.add(n)
    } else if (e.ctrlKey) {
      selected.has(i) ? selected.delete(i) : selected.add(i)
      lastClicked = i
    } else {
      selected = new Set([i])
      lastClicked = i
    }
    updateSelectionClasses()
  })

  listEl.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.pl-row')
    if (row) ampwin.playlist.playIndex(Number(row.dataset.i))
  })

  // ---- drag to reorder ---------------------------------------------------------

  let dragFrom = -1

  function clearDropMarks() {
    listEl.querySelectorAll('.drop-above, .drop-below').forEach((r) => {
      r.classList.remove('drop-above', 'drop-below')
    })
  }

  listEl.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.pl-row')
    if (!row) return
    dragFrom = Number(row.dataset.i)
    row.classList.add('dragging')
    e.dataTransfer.effectAllowed = 'move'
    // Marker so the document-level file-drop handler ignores internal drags.
    e.dataTransfer.setData('application/x-ampwin-move', String(dragFrom))
  })

  listEl.addEventListener('dragover', (e) => {
    if (dragFrom < 0) return // an external file drag, not a reorder
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    clearDropMarks()
    const row = e.target.closest('.pl-row')
    if (row) {
      const r = row.getBoundingClientRect()
      row.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-above' : 'drop-below')
    }
  })

  listEl.addEventListener('drop', (e) => {
    if (dragFrom < 0) return
    e.preventDefault()
    e.stopPropagation() // don't let the document file-drop handler also fire
    const row = e.target.closest('.pl-row')
    let ins
    if (row) {
      const i = Number(row.dataset.i)
      const r = row.getBoundingClientRect()
      ins = e.clientY < r.top + r.height / 2 ? i : i + 1
    } else {
      ins = ampwin.playlist.getTracks().length // dropped past the last row
    }
    // move(from, to): `to` is the index after the item is removed.
    const to = ins > dragFrom ? ins - 1 : ins
    if (to !== dragFrom) ampwin.playlist.move(dragFrom, to)
    clearDropMarks()
    dragFrom = -1
  })

  listEl.addEventListener('dragend', () => {
    listEl.querySelectorAll('.dragging').forEach((r) => r.classList.remove('dragging'))
    clearDropMarks()
    dragFrom = -1
  })

  listEl.addEventListener('contextmenu', async (e) => {
    const row = e.target.closest('.pl-row')
    if (!row) return
    e.preventDefault()
    const mx = e.clientX
    const my = e.clientY
    const i = Number(row.dataset.i)
    // right-clicking outside the selection re-targets it
    if (!selected.has(i)) {
      selected = new Set([i])
      lastClicked = i
      updateSelectionClasses()
    }
    const many = selected.size > 1
    const tracks = ampwin.playlist.getTracks()
    // Download applies to the remote (link) tracks in the selection.
    const remoteIdx = [...selected].filter((n) => tracks[n] && tracks[n].isRemote)

    const menu = [
      { label: '▶ Play', action: () => ampwin.playlist.playIndex(i) },
      { label: '⏭ Play next', action: () => ampwin.playlist.queueNext(i) }
    ]
    // Add the selected track(s) to an existing saved playlist.
    const savedPls = await ampwin.playlist.saved.list()
    if (savedPls.length > 0) {
      const selTracks = [...selected].map((n) => tracks[n]).filter(Boolean)
      menu.push({
        label: '➕ Add to playlist',
        submenu: savedPls.map((p) => ({
          label: `${p.name} (${p.trackCount})`,
          action: async () => {
            await ampwin.playlist.saved.addTracksTo(p.id, selTracks)
            $('title-text').textContent = `➕ added ${selTracks.length} to “${p.name}”`
          }
        }))
      })
    }
    if (remoteIdx.length > 0) {
      const dl = (kind) => downloadSelection(remoteIdx, kind)
      const n = remoteIdx.length > 1 ? ` (${remoteIdx.length})` : ''
      menu.push({
        label: '⬇ Download' + n,
        submenu: [
          { label: 'Audio (.m4a)', action: () => dl('audio') },
          { label: 'Video (no audio)', action: () => dl('video') },
          { label: 'Audio + Video (.mp4)', action: () => dl('both') }
        ]
      })
    }
    // Convert applies to a single local file (not a remote link).
    const t = tracks[i]
    if (t && !t.isRemote && !t.missing && !t.unreadable) {
      menu.push({ label: '🔄 Convert…', action: () => openConvert(t) })
    }
    // Addon-contributed entries (e.g. Demucs ▸ Get stems) for local files.
    if (t) {
      for (const ext of ampwin.menus.listTrackMenus(t)) {
        menu.push({
          label: ext.label,
          submenu: ext.items.map((it) => ({
            label: it.label,
            action: () => ampwin.menus.invokeTrackMenu(ext.key, it.key, t)
          }))
        })
      }
    }
    menu.push({
      label: many ? `✕ Remove ${selected.size} tracks` : '✕ Remove from list',
      action: () => {
        ampwin.playlist.removeIndices([...selected])
        selected.clear()
      }
    })
    showMenu(mx, my, menu)
  })

  // Download the given playlist indices (remote tracks) one at a time,
  // showing progress in the title marquee.
  let downloading = false
  async function downloadSelection(indices, kind) {
    if (downloading) return
    downloading = true
    const tracks = ampwin.playlist.getTracks()
    const targets = indices.map((n) => tracks[n]).filter((t) => t && t.isRemote)
    const off = ampwin.links.on('fileProgress', ({ percent, phase }) => {
      $('title-text').textContent = `⬇ ${phase} ${Math.round(percent)}%`
    })
    let done = 0
    for (const t of targets) {
      $('title-text').textContent = `⬇ downloading “${t.title}”…`
      const local = await ampwin.links.download(t, kind)
      if (local) done++
    }
    off()
    $('title-text').textContent =
      done === targets.length
        ? `✓ downloaded ${done} file${done === 1 ? '' : 's'} → added to playlist`
        : `downloaded ${done}/${targets.length}`
    downloading = false
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Delete' && selected.size && e.target.tagName !== 'INPUT') {
      ampwin.playlist.removeIndices([...selected])
      selected.clear()
    }
  })

  // ---- convert -----------------------------------------------------------------

  let convertTarget = null
  let converting = false

  async function openConvert(trk) {
    if (converting) return
    convertTarget = trk
    $('convert-title').textContent = 'Convert: ' + trk.title
    $('convert-pick').hidden = false
    $('convert-bar').hidden = true
    $('convert-fill').style.width = '0%'
    $('convert-go').hidden = false
    $('convert-open').hidden = true
    $('convert-cancel').textContent = 'cancel'
    $('convert-status').textContent = ''
    const sel = $('convert-format')
    sel.textContent = ''
    for (const f of await ampwin.convert.list(trk.isVideo)) {
      const o = document.createElement('option')
      o.value = f.id
      o.textContent = f.label
      sel.appendChild(o)
    }
    $('convert-modal').hidden = false
  }

  $('convert-cancel').addEventListener('click', () => ($('convert-modal').hidden = true))
  $('convert-open').addEventListener('click', () => ampwin.convert.openFolder())

  $('convert-go').addEventListener('click', async () => {
    if (converting || !convertTarget) return
    converting = true
    const fmt = $('convert-format').value
    $('convert-pick').hidden = true
    $('convert-go').hidden = true
    $('convert-bar').hidden = false
    $('convert-status').textContent = 'converting…'
    const off = ampwin.convert.on('progress', (pct) => {
      $('convert-fill').style.width = pct + '%'
      $('convert-status').textContent = 'converting… ' + pct + '%'
    })
    const path = await ampwin.convert.start(convertTarget, fmt)
    off()
    converting = false
    if (path) {
      $('convert-fill').style.width = '100%'
      $('convert-status').textContent = '✓ saved to Downloads\\Converted'
      $('convert-open').hidden = false
    } else {
      $('convert-status').textContent = '⚠ conversion failed'
    }
    $('convert-cancel').textContent = 'close'
  })

  ampwin.playlist.on('changed', (tracks, currentIndex) => {
    selected.clear()
    renderPlaylist(tracks, currentIndex)
  })

  ampwin.player.on('track', () => {
    renderPlaylist(ampwin.playlist.getTracks(), ampwin.playlist.getCurrentIndex())
  })

  // playlist actions
  async function addAndMaybePlay(paths) {
    if (!paths.length) return
    const before = ampwin.playlist.getTracks().length
    const added = await ampwin.playlist.addPaths(paths)
    // If nothing is playing, start on the first newly added track.
    if (added.length && ampwin.player.getSnapshot().state === 'idle') {
      ampwin.playlist.playIndex(before)
    }
  }

  async function addFiles() {
    addAndMaybePlay(await ampwin.files.openFilesDialog())
  }
  async function addFolder() {
    addAndMaybePlay(await ampwin.files.openFolderDialog())
  }
  // Single "＋" button → a small menu of the add sources.
  $('btn-add-menu').addEventListener('click', (e) => {
    e.stopPropagation()
    const b = e.currentTarget.getBoundingClientRect()
    showMenu(b.left, b.top, [
      { label: '+ files…', action: () => addFiles() },
      { label: '+ folder…', action: () => addFolder() },
      { label: '+ link…', action: () => openAddLink() }
    ])
  })
  $('btn-remove').addEventListener('click', () => {
    if (selected.size) ampwin.playlist.removeIndices([...selected])
  })
  $('btn-clear').addEventListener('click', () => ampwin.playlist.clear())

  // drag & drop files/folders/playlists anywhere on the skin:
  // openPaths handles it like the OS would (playlists import, media appends)
  document.addEventListener('dragover', (e) => e.preventDefault())
  document.addEventListener('drop', (e) => {
    e.preventDefault()
    const paths = [...e.dataTransfer.files].map((f) => ampwin.files.pathForDroppedFile(f))
    if (paths.length) ampwin.files.openPaths(paths)
  })

  // ---- saved playlists ---------------------------------------------------------

  // Which saved playlist (if any) is currently "open" — drives save behavior.
  let currentPlaylistId = null
  let currentPlaylistName = null
  function setCurrentPlaylist(id, name) {
    currentPlaylistId = id
    currentPlaylistName = name || null
    $('pl-current').textContent = name || ''
    $('btn-playlist-menu').title = id
      ? `Playlist “${name}” — new, save, load, import, export`
      : 'Playlists: new, save, load, import, export'
  }

  // Generic confirm dialog → resolves true/false.
  function confirmDialog(title, msg, okLabel) {
    return new Promise((resolve) => {
      $('confirm-title').textContent = title
      $('confirm-msg').textContent = msg
      $('confirm-ok').textContent = okLabel || 'ok'
      $('confirm-modal').hidden = false
      const finish = (val) => {
        $('confirm-modal').hidden = true
        $('confirm-ok').removeEventListener('click', onOk)
        $('confirm-cancel').removeEventListener('click', onCancel)
        resolve(val)
      }
      const onOk = () => finish(true)
      const onCancel = () => finish(false)
      $('confirm-ok').addEventListener('click', onOk)
      $('confirm-cancel').addEventListener('click', onCancel)
    })
  }

  // New empty playlist — clears tracks and forgets the active saved playlist,
  // so the next save asks for a name.
  function doNewPlaylist() {
    ampwin.playlist.clear()
    setCurrentPlaylist(null, null)
  }

  // Save: in an open playlist → overwrite it silently; otherwise ask for a name
  // (and warn if that name already exists).
  async function doSavePlaylist() {
    if (ampwin.playlist.getTracks().length === 0) {
      $('title-text').textContent = 'nothing to save — add some tracks first'
      return
    }
    if (currentPlaylistId) {
      await ampwin.playlist.saved.saveCurrentAs(currentPlaylistName, currentPlaylistId)
      $('title-text').textContent = `✓ saved “${currentPlaylistName}”`
      return
    }
    $('save-name').value = ''
    $('save-modal').hidden = false
    $('save-name').focus()
  }
  $('save-cancel').addEventListener('click', () => ($('save-modal').hidden = true))
  $('save-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('save-ok').click()
  })
  $('save-ok').addEventListener('click', async () => {
    const name = $('save-name').value.trim()
    $('save-modal').hidden = true
    if (!name) return
    const existing = (await ampwin.playlist.saved.list()).find(
      (p) => p.name.toLowerCase() === name.toLowerCase()
    )
    let overwriteId
    if (existing) {
      const ok = await confirmDialog(
        'Playlist already exists',
        `A saved playlist named “${name}” already exists. Save over it?`,
        'overwrite'
      )
      if (!ok) return
      overwriteId = existing.id
    }
    const id = await ampwin.playlist.saved.saveCurrentAs(name, overwriteId)
    setCurrentPlaylist(id, name)
    $('title-text').textContent = `✓ saved “${name}”`
  })

  // Load: a custom dropdown panel (a native <select> can't do per-row
  // right-click / delete). Left-click a row to load; ✕ or right-click to delete.
  let loadPanel = null
  function closeLoadPanel() {
    loadPanel?.remove()
    loadPanel = null
  }
  document.addEventListener('click', closeLoadPanel)

  async function deleteSaved(item) {
    // Close the panel first so the confirm dialog isn't behind it, reopen after.
    const wasOpen = !!loadPanel
    closeLoadPanel()
    const ok = await confirmDialog(
      'Delete playlist',
      `Delete the saved playlist “${item.name}”? This can’t be undone.`,
      'delete'
    )
    if (ok) {
      await ampwin.playlist.saved.delete(item.id)
      if (currentPlaylistId === item.id) setCurrentPlaylist(null, null)
    }
    if (wasOpen) openLoadPanel()
  }

  async function openLoadPanel() {
    closeLoadPanel()
    const items = await ampwin.playlist.saved.list()
    loadPanel = document.createElement('div')
    loadPanel.id = 'pl-load-panel'
    loadPanel.addEventListener('click', (e) => e.stopPropagation())
    if (items.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'pl-load-empty'
      empty.textContent = 'no saved playlists'
      loadPanel.appendChild(empty)
    } else {
      for (const it of items) {
        const row = document.createElement('div')
        row.className = 'pl-load-row'
        const name = document.createElement('span')
        name.className = 'pl-load-name'
        name.textContent = it.name
        const count = document.createElement('span')
        count.className = 'pl-load-count'
        count.textContent = it.trackCount
        const del = document.createElement('span')
        del.className = 'pl-load-del'
        del.textContent = '✕'
        del.title = `Delete “${it.name}”`
        del.addEventListener('click', (e) => {
          e.stopPropagation()
          deleteSaved(it)
        })
        row.addEventListener('contextmenu', (e) => {
          e.preventDefault()
          e.stopPropagation()
          deleteSaved(it)
        })
        row.addEventListener('click', async () => {
          closeLoadPanel()
          await ampwin.playlist.saved.load(it.id)
          setCurrentPlaylist(it.id, it.name)
        })
        row.append(name, count, del)
        loadPanel.appendChild(row)
      }
    }
    document.body.appendChild(loadPanel)
    // Anchor to the playlist menu button; open upward if there's no room below.
    const b = $('btn-playlist-menu').getBoundingClientRect()
    const ph = loadPanel.offsetHeight
    const top = b.top - ph - 4 > 4 ? b.top - ph - 4 : b.bottom + 4
    loadPanel.style.left = Math.min(b.left, window.innerWidth - loadPanel.offsetWidth - 4) + 'px'
    loadPanel.style.top = top + 'px'
  }
  // Bottom "☰ playlist ▾" dropdown — groups new/save/load/import/export in one
  // place (Load opens the same panel as before, with per-row delete).
  $('btn-playlist-menu').addEventListener('click', (e) => {
    e.stopPropagation()
    if (loadPanel) closeLoadPanel()
    const b = e.currentTarget.getBoundingClientRect()
    showMenu(b.left, b.top, [
      { label: 'Import…', action: () => ampwin.playlist.saved.importFromFile() },
      { label: 'Export…', action: () => ampwin.playlist.saved.exportToFile('m3u8') },
      { label: 'New', action: () => doNewPlaylist() },
      { label: 'Save', action: () => doSavePlaylist() },
      // Defer so the click that opened the menu doesn't immediately close the panel.
      { label: 'Load…', action: () => setTimeout(openLoadPanel, 0) }
    ])
  })

  // ---- add link / YouTube ------------------------------------------------------

  // yt-dlp downloads on first YouTube use; show progress in the given status el.
  async function ensureYtDlpReady(statusEl) {
    if (await ampwin.links.ytdlpInstalled()) return true
    statusEl.textContent = 'Downloading YouTube helper (yt-dlp)…'
    const off = ampwin.links.on('download', (pct) => {
      statusEl.textContent = `Downloading YouTube helper… ${pct}%`
    })
    const res = await ampwin.links.ensureYtDlp()
    off()
    if (!res.ok) {
      statusEl.textContent = `yt-dlp download failed: ${res.error || 'unknown'}`
      return false
    }
    statusEl.textContent = ''
    return true
  }

  const isSiteLink = (url) => /^https?:\/\//i.test(url) && !/\.(mp3|m4a|flac|ogg|opus|wav|mp4|mkv|webm|avi|mov|m3u8)($|\?)/i.test(url)
  // A YouTube playlist / mix / radio link (has a list= param, or /playlist).
  const isPlaylistLink = (url) =>
    /youtube\.com|youtu\.be/i.test(url) && (/[?&]list=/.test(url) || /\/playlist\b/.test(url))

  async function openAddLink() {
    $('link-url').value = ''
    $('link-audio').checked = false
    $('link-status').textContent = ''
    $('link-modal').hidden = false
    $('link-url').focus()
    // reflect current sign-in state on the button
    $('link-signin-btn').textContent = (await ampwin.links.isYouTubeSignedIn()) ? '✓ signed in' : 'sign in'
  }
  $('link-cancel').addEventListener('click', () => ($('link-modal').hidden = true))

  async function submitLink(url, audioOnly, statusEl) {
    url = (url || '').trim()
    if (!url) return false
    if (isSiteLink(url) && !(await ensureYtDlpReady(statusEl))) return false
    const before = ampwin.playlist.getTracks().length

    // Playlist / mix / radio link → add every entry.
    if (isPlaylistLink(url)) {
      statusEl.textContent = 'Loading playlist…'
      let tracks
      try {
        tracks = await ampwin.links.addPlaylist(url, audioOnly)
      } catch (err) {
        statusEl.textContent = 'Could not load playlist: ' + (err.message || err)
        return false
      }
      if (!tracks.length) {
        statusEl.textContent = 'Playlist was empty or unavailable.'
        return false
      }
      statusEl.textContent = `Added ${tracks.length} track${tracks.length === 1 ? '' : 's'} from playlist.`
      if (ampwin.player.getSnapshot().state === 'idle') ampwin.playlist.playIndex(before)
      return true
    }

    statusEl.textContent = 'Adding…'
    const track = await ampwin.links.add(url, audioOnly)
    if (!track) {
      statusEl.textContent = 'Could not add that link.'
      return false
    }
    if (ampwin.player.getSnapshot().state === 'idle') ampwin.playlist.playIndex(before)
    return true
  }

  $('link-add').addEventListener('click', async () => {
    if (await submitLink($('link-url').value, $('link-audio').checked, $('link-status'))) {
      $('link-modal').hidden = true
    }
  })
  $('link-url').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('link-add').click()
  })
  $('link-signin-btn').addEventListener('click', async () => {
    $('link-status').textContent = 'Opening YouTube sign-in…'
    if (!(await ensureYtDlpReady($('link-status')))) return
    const { signedIn } = await ampwin.links.signInYouTube()
    $('link-signin-btn').textContent = signedIn ? '✓ signed in' : 'sign in'
    $('link-status').textContent = signedIn ? 'Signed in to YouTube.' : 'Not signed in.'
  })

  // ---- YouTube search ----------------------------------------------------------

  $('link-search-btn').addEventListener('click', () => {
    $('link-modal').hidden = true
    $('search-audio').checked = $('link-audio').checked
    $('search-q').value = ''
    $('search-results').textContent = ''
    $('search-status').textContent = ''
    $('search-modal').hidden = false
    $('search-q').focus()
  })
  $('search-close').addEventListener('click', () => ($('search-modal').hidden = true))

  async function runSearch() {
    const q = $('search-q').value.trim()
    if (!q) return
    if (!(await ensureYtDlpReady($('search-status')))) return
    $('search-status').textContent = 'Searching…'
    $('search-results').textContent = ''
    let results
    try {
      results = await ampwin.links.search(q)
    } catch (err) {
      $('search-status').textContent = 'Search failed: ' + (err.message || err)
      return
    }
    $('search-status').textContent = `${results.length} results`
    for (const r of results) {
      const row = document.createElement('div')
      row.className = 'sr-row'
      const img = document.createElement('img')
      img.src = r.thumbnail || ''
      img.onerror = () => (img.style.visibility = 'hidden')
      const meta = document.createElement('div')
      meta.className = 'sr-meta'
      const title = document.createElement('div')
      title.className = 'sr-title'
      title.textContent = r.title
      const sub = document.createElement('div')
      sub.className = 'sr-sub'
      sub.textContent = [r.uploader, fmt(r.durationSec)].filter(Boolean).join(' · ')
      meta.append(title, sub)
      row.append(img, meta)
      row.addEventListener('click', () => {
        // Add using the search metadata directly — no second probe that could
        // reject VEVO/age-gated results. The stream resolves when played.
        const before = ampwin.playlist.getTracks().length
        ampwin.links.addSearchResult(r, $('search-audio').checked)
        $('search-status').textContent = 'Added: ' + r.title
        if (ampwin.player.getSnapshot().state === 'idle') ampwin.playlist.playIndex(before)
      })
      $('search-results').appendChild(row)
    }
  }
  $('search-go').addEventListener('click', runSearch)
  $('search-q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runSearch()
  })

  // ---- visualizer ---------------------------------------------------------------

  const vizCanvas = $('viz')
  ampwin.visualizer.attach(vizCanvas)
  vizCanvas.addEventListener('click', () => ampwin.visualizer.randomPreset())
  vizCanvas.addEventListener('dblclick', () => ampwin.visualizer.setFullscreen(true))
  vizCanvas.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    showMenu(e.clientX, e.clientY, [
      { label: '⧉ Pop out window', action: () => ampwin.visualizer.popOut() },
      { label: '⛶ Fullscreen', action: () => ampwin.visualizer.setFullscreen(true) },
      { label: '🎲 Random preset', action: () => ampwin.visualizer.randomPreset() },
      { label: '⏭ Next preset', action: () => ampwin.visualizer.nextPreset() }
    ])
  })
  // Fullscreen has no dedicated button — double-click the visualizer or use its
  // right-click menu.
  $('btn-pl-popout').addEventListener('click', () => ampwin.playlist.popOut())

  // System-audio mode: visualize whatever the whole computer is playing.
  const sysBtn = $('btn-sysaudio')
  sysBtn.addEventListener('click', async () => {
    try {
      await ampwin.system.toggle()
    } catch (err) {
      $('title-text').textContent = '⚠ system audio: ' + (err.message || err)
    }
  })
  ampwin.system.on('change', (on) => {
    sysBtn.classList.toggle('on', on)
    sysBtn.title = on
      ? 'System audio ON — visualizing everything the computer plays. Click to stop.'
      : 'Visualize system audio — Spotify, a browser, any app'
  })
  sysBtn.classList.toggle('on', ampwin.system.isEnabled())

  // Lyrics overlay: on when the toggle is enabled; dimmed when the current song
  // has no lyrics to show.
  const lyricsBtn = $('btn-lyrics')
  function reflectLyrics() {
    const on = ampwin.lyrics.isEnabled()
    const avail = ampwin.lyrics.isAvailable()
    lyricsBtn.classList.toggle('on', on)
    lyricsBtn.classList.toggle('dim', !avail)
    lyricsBtn.title = !avail
      ? 'Lyrics — this song has none embedded (or no .lrc next to it)'
      : on
        ? 'Lyrics ON — showing over the visualizer. Click to hide.'
        : 'Show lyrics over the visualizer'
  }
  lyricsBtn.addEventListener('click', () => ampwin.lyrics.setEnabled(!ampwin.lyrics.isEnabled()))
  ampwin.lyrics.on('change', reflectLyrics)
  ampwin.lyrics.on('available', reflectLyrics)
  reflectLyrics()

  // ---- Equalizer -----------------------------------------------------------
  const eqBtn = $('btn-eq')
  eqBtn.classList.toggle('on', ampwin.eq.isEnabled())
  eqBtn.addEventListener('click', openEqWindow)

  let eqWin = null
  const EQ_PRESETS = {
    Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    Rock: [5, 4, 3, 1, -1, -1, 1, 3, 4, 5],
    Pop: [-1, 2, 4, 4, 2, -1, -2, -2, -1, -1],
    Jazz: [4, 3, 1, 2, -1, -1, 0, 1, 3, 4],
    Classical: [5, 4, 3, 2, -1, -1, 0, 2, 3, 4],
    Dance: [6, 5, 2, 0, -1, -2, -2, 0, 3, 5],
    'Bass Boost': [7, 6, 5, 3, 1, 0, 0, 0, 0, 0],
    'Treble Boost': [0, 0, 0, 0, 0, 1, 3, 5, 6, 7],
    Vocal: [-2, -3, -2, 1, 4, 4, 3, 1, -1, -2],
    Loudness: [6, 4, 0, 0, -2, 0, 0, -1, 4, 6]
  }
  const eqFmtFreq = (f) => (f >= 1000 ? f / 1000 + 'k' : String(f))
  const eqFmtDb = (db) => (db > 0 ? '+' + db : String(db))

  const EQ_CSS = `
    * { margin: 0; box-sizing: border-box; font-family: 'Segoe UI', sans-serif; user-select: none; }
    html, body { width: 100%; height: 100%; overflow: hidden; background: #101318; color: #cfd4dd; }
    body { display: flex; flex-direction: column; }
    #bar { display: flex; align-items: center; gap: 10px; padding: 6px 10px;
           background: linear-gradient(#20242c, #14171d); border-bottom: 1px solid #000; -webkit-app-region: drag; }
    #logo { font-size: 10px; font-weight: bold; letter-spacing: 2px; color: #3fdf6f; }
    #bar label, #bar select, #bar button { -webkit-app-region: no-drag; }
    #enable { font-size: 12px; display: flex; align-items: center; gap: 5px; cursor: pointer; }
    select, button { background: #1d222b; color: #cfd4dd; border: 1px solid #000; border-radius: 3px; padding: 3px 8px; font-size: 12px; cursor: pointer; }
    button:hover, select:hover { background: #2a3140; }
    #x:hover { background: #7f1f1f; }
    .spacer { flex: 1; }
    #eq-body { flex: 1; display: flex; align-items: stretch; justify-content: center; gap: 6px; padding: 10px 12px 6px; }
    .col { display: flex; flex-direction: column; align-items: center; gap: 4px; width: 40px; }
    .col.pre { border-right: 1px solid #2a3140; padding-right: 8px; margin-right: 4px; width: 48px; }
    .val { font-family: Consolas, monospace; font-size: 11px; color: #6fd88f; min-height: 14px; }
    .vslider { writing-mode: vertical-lr; direction: rtl; width: 22px; flex: 1; accent-color: #3fae66; -webkit-app-region: no-drag; cursor: pointer; }
    .lbl { font-size: 10px; color: #9aa1ac; }
  `

  function eqBandCol(id, label, value, range, cls) {
    return (
      `<div class="col ${cls || ''}">` +
      `<div class="val" id="${id}-val">${eqFmtDb(value)}</div>` +
      `<input class="vslider" type="range" id="${id}" min="${range.min}" max="${range.max}" step="1" value="${value}" />` +
      `<div class="lbl">${label}</div>` +
      `</div>`
    )
  }

  function openEqWindow() {
    if (eqWin && !eqWin.closed) {
      eqWin.focus()
      return
    }
    eqWin = window.open('about:blank', 'ampwin-eq')
    if (!eqWin) return
    const doc = eqWin.document
    doc.title = 'Equalizer'
    const style = doc.createElement('style')
    style.textContent = EQ_CSS
    doc.head.appendChild(style)
    eqWin.resizeTo(600, 360)

    const freqs = ampwin.eq.frequencies()
    const range = ampwin.eq.range()
    const gains = ampwin.eq.getGains()
    let cols = eqBandCol('eq-pre', 'PRE', ampwin.eq.getPreamp(), range, 'pre')
    for (let i = 0; i < freqs.length; i++) cols += eqBandCol('eq-b' + i, eqFmtFreq(freqs[i]), gains[i] ?? 0, range)

    doc.body.innerHTML = `
      <div id="bar">
        <span id="logo">EQUALIZER</span>
        <label id="enable"><input type="checkbox" id="eq-on" /> On</label>
        <select id="eq-preset" title="Presets"></select>
        <button id="eq-flat" title="Reset to flat">Flat</button>
        <span class="spacer"></span>
        <button id="x" title="Close">×</button>
      </div>
      <div id="eq-body">${cols}</div>`

    const d = (id) => doc.getElementById(id)
    const presetSel = d('eq-preset')
    presetSel.innerHTML =
      '<option value="">preset…</option>' +
      Object.keys(EQ_PRESETS)
        .map((n) => `<option>${n}</option>`)
        .join('')

    const onChk = d('eq-on')
    onChk.checked = ampwin.eq.isEnabled()
    onChk.addEventListener('change', () => {
      ampwin.eq.setEnabled(onChk.checked)
      eqBtn.classList.toggle('on', onChk.checked)
    })

    const setSlider = (id, db) => {
      const el = d(id)
      const val = d(id + '-val')
      if (el) el.value = db
      if (val) val.textContent = eqFmtDb(db)
    }
    const wire = (id, cb) => {
      const el = d(id)
      const val = d(id + '-val')
      el.addEventListener('input', () => {
        const db = Number(el.value)
        val.textContent = eqFmtDb(db)
        cb(db)
      })
    }

    wire('eq-pre', (db) => ampwin.eq.setPreamp(db))
    for (let i = 0; i < freqs.length; i++) {
      wire('eq-b' + i, ((idx) => (db) => ampwin.eq.setGain(idx, db))(i))
    }

    presetSel.addEventListener('change', () => {
      const arr = EQ_PRESETS[presetSel.value]
      if (!arr) return
      ampwin.eq.setGains(arr)
      for (let i = 0; i < arr.length; i++) setSlider('eq-b' + i, arr[i])
      // A preset is only audible with the EQ on — turn it on for the user.
      if (!onChk.checked) {
        onChk.checked = true
        ampwin.eq.setEnabled(true)
        eqBtn.classList.add('on')
      }
    })

    d('eq-flat').addEventListener('click', () => {
      ampwin.eq.reset()
      setSlider('eq-pre', 0)
      for (let i = 0; i < freqs.length; i++) setSlider('eq-b' + i, 0)
      presetSel.value = ''
    })

    d('x').addEventListener('click', () => eqWin.close())
  }

  const vizSel = $('sel-viz')
  function refreshVisualizers() {
    vizSel.textContent = ''
    for (const v of ampwin.visualizer.listVisualizers()) {
      const opt = document.createElement('option')
      opt.value = v.id
      opt.textContent = v.name
      if (v.id === ampwin.visualizer.getActiveVisualizerId()) opt.selected = true
      vizSel.appendChild(opt)
    }
  }
  // Refresh on open, and reactively when an addon registers/removes a
  // visualizer (they load asynchronously after boot).
  vizSel.addEventListener('mousedown', refreshVisualizers)
  ampwin.visualizer.on('visualizers', refreshVisualizers)
  vizSel.addEventListener('change', () => ampwin.visualizer.setActiveVisualizer(vizSel.value))

  // presets — the catalog loads async, so refresh again when the first
  // preset event arrives and whenever the dropdown is opened
  const presetSel = $('sel-preset')
  function refreshPresets() {
    const presets = ampwin.visualizer.listPresets()
    if (presets.length === 0) return
    presetSel.textContent = ''
    for (const p of presets) {
      const opt = document.createElement('option')
      opt.value = p.id
      opt.textContent = (p.source === 'user' ? '★ ' : '') + p.name
      presetSel.appendChild(opt)
    }
  }
  presetSel.addEventListener('mousedown', () => {
    if (presetSel.options.length <= 1) refreshPresets()
  })
  presetSel.addEventListener('change', () => ampwin.visualizer.loadPreset(presetSel.value))
  ampwin.visualizer.on('preset', (p) => {
    if (presetSel.options.length <= 1) refreshPresets()
    presetSel.value = p.id
  })

  $('btn-preset-rand').addEventListener('click', () => ampwin.visualizer.randomPreset())
  $('btn-preset-import').addEventListener('click', async () => {
    await ampwin.visualizer.importPresetFiles()
    refreshPresets()
  })

  const cycleBtn = $('btn-preset-cycle')
  let cycleOn = true // matches DEFAULT_SETTINGS.vizCycle.enabled
  cycleBtn.classList.add('on')
  cycleBtn.addEventListener('click', () => {
    cycleOn = !cycleOn
    ampwin.visualizer.setCycle({ enabled: cycleOn })
    cycleBtn.classList.toggle('on', cycleOn)
  })

  // ---- skins -----------------------------------------------------------------------

  const skinSel = $('sel-skin')
  async function refreshSkins() {
    const skins = await ampwin.skins.list()
    skinSel.textContent = ''
    for (const s of skins) {
      const opt = document.createElement('option')
      opt.value = s.id
      opt.textContent = s.name
      if (s.id === ampwin.skins.getActiveId()) opt.selected = true
      skinSel.appendChild(opt)
    }
  }
  skinSel.addEventListener('change', () => ampwin.skins.setActive(skinSel.value))

  // ---- addons ------------------------------------------------------------------------

  const addonsList = $('addons-list')
  let addonsCache = []
  let addonsFilter = ''

  function renderAddons() {
    addonsList.textContent = ''
    const q = addonsFilter.toLowerCase()
    const items = addonsCache.filter(
      (a) => !q || (a.name + ' ' + a.description + ' ' + a.author).toLowerCase().includes(q)
    )
    if (items.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'addon-empty'
      empty.textContent = addonsCache.length ? 'no matches' : 'no addons found'
      addonsList.appendChild(empty)
      return
    }
    for (const a of items) {
      const row = document.createElement('div')
      row.className = 'addon-row'

      const meta = document.createElement('div')
      meta.className = 'addon-meta'
      const title = document.createElement('div')
      title.className = 'addon-title'
      title.textContent = a.name + ' '
      const ver = document.createElement('span')
      ver.className = 'addon-ver'
      ver.textContent = 'v' + a.version + (a.author ? ' · ' + a.author : '')
      title.appendChild(ver)
      const desc = document.createElement('div')
      desc.className = 'addon-desc'
      desc.textContent = a.description
      meta.append(title, desc)

      const actions = document.createElement('div')
      actions.className = 'addon-actions'
      if (!a.installed) {
        const btn = document.createElement('button')
        btn.textContent = 'install'
        btn.addEventListener('click', () => installAddon(a, btn))
        actions.appendChild(btn)
      } else {
        const toggle = document.createElement('button')
        toggle.textContent = a.enabled ? 'enabled' : 'disabled'
        toggle.classList.toggle('on', a.enabled)
        toggle.addEventListener('click', async () => {
          toggle.disabled = true
          await ampwin.addons.setEnabled(a.id, !a.enabled)
          a.enabled = !a.enabled
          $('addons-status').textContent = a.enabled
            ? `✓ ${a.name} enabled — pick it from the visualizer dropdown`
            : `${a.name} disabled`
          renderAddons()
          refreshVisualizers()
        })
        actions.appendChild(toggle)
        if (a.updateAvailable) {
          const up = document.createElement('button')
          up.textContent = 'update'
          up.addEventListener('click', () => installAddon(a, up))
          actions.appendChild(up)
        }
        const rm = document.createElement('button')
        rm.textContent = 'uninstall'
        rm.addEventListener('click', async () => {
          await ampwin.addons.uninstall(a.id)
          a.installed = false
          a.enabled = false
          renderAddons()
          refreshVisualizers()
        })
        actions.appendChild(rm)
      }
      row.append(meta, actions)
      addonsList.appendChild(row)
    }
  }

  async function installAddon(a, btn) {
    btn.disabled = true
    const label = btn.textContent
    const off = ampwin.addons.on('progress', (id, pct) => {
      if (id === a.id) btn.textContent = pct + '%'
    })
    try {
      await ampwin.addons.install(a.id)
      a.installed = true
      await ampwin.addons.setEnabled(a.id, true) // auto-enable freshly installed
      a.enabled = true
      a.updateAvailable = false
      $('addons-status').textContent = `✓ installed ${a.name} — pick it from the visualizer dropdown`
    } catch (err) {
      $('addons-status').textContent = '⚠ ' + (err.message || err)
      btn.textContent = label
      btn.disabled = false
    }
    off()
    renderAddons()
    refreshVisualizers()
  }

  async function loadAddons() {
    $('addons-status').textContent = 'loading…'
    try {
      const { addons, catalogError } = await ampwin.addons.catalog()
      addonsCache = addons
      $('addons-status').textContent = catalogError
        ? 'repo offline — showing installed only'
        : addons.length + ' addon' + (addons.length === 1 ? '' : 's')
    } catch (err) {
      addonsCache = await ampwin.addons.list()
      $('addons-status').textContent = 'repo unavailable: ' + (err.message || err)
    }
    renderAddons()
  }

  $('btn-addons').addEventListener('click', () => {
    $('addons-filter').value = ''
    addonsFilter = ''
    addonsCache = []
    addonsList.textContent = ''
    $('addons-status').textContent = ''
    $('addons-modal').hidden = false
    loadAddons()
  })
  $('addons-close').addEventListener('click', () => ($('addons-modal').hidden = true))
  $('addons-refresh').addEventListener('click', loadAddons)
  $('addons-folder').addEventListener('click', () => ampwin.addons.openFolder())
  $('addons-filter').addEventListener('input', () => {
    addonsFilter = $('addons-filter').value.trim()
    renderAddons()
  })

  // ---- keyboard ---------------------------------------------------------------------

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return
    switch (e.key) {
      case ' ':
        e.preventDefault()
        ampwin.player.togglePlay()
        break
      case 'ArrowRight':
        ampwin.player.seek(ampwin.player.getSnapshot().positionSec + 5)
        break
      case 'ArrowLeft':
        ampwin.player.seek(ampwin.player.getSnapshot().positionSec - 5)
        break
    }
  })

  // ---- boot -------------------------------------------------------------------------

  const snap = ampwin.player.getSnapshot()
  renderPlaylist(ampwin.playlist.getTracks(), ampwin.playlist.getCurrentIndex())
  if (snap.track) {
    $('title-text').textContent = (snap.track.artist ? snap.track.artist + ' — ' : '') + snap.track.title
    $('track-title').textContent = snap.track.title
    $('track-artist').textContent = snap.track.artist
    $('track-album').textContent = snap.track.album
  }
  vol.value = Math.round(snap.volume * 100)
  muteBtn.textContent = snap.muted ? '🔇' : '🔊'
  shuffleBtn.classList.toggle('on', snap.shuffle)
  repeatBtn.classList.toggle('on', snap.repeat !== 'off')
  playBtn.textContent = snap.state === 'playing' ? '⏸' : '▶'

  refreshVisualizers()
  refreshSkins()
  setCurrentPlaylist(null, null)

  ampwin.ready()
})()
