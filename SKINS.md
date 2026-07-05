# Making an Ampwin Skin

A skin is a folder of **plain HTML, CSS, and JavaScript** that completely replaces Ampwin's user interface. No build tools, no frameworks, no imports — if you can make a web page, you can make a skin. This document is self-contained: everything you need is here.

---

## 1. Install & iterate

Skins live in your user skins folder:

```
%APPDATA%\Ampwin\skins\<your-skin-id>\
```

(Open it from inside Ampwin: the skin dropdown lists skins, and `ampwin.skins.openSkinsFolder()` / the default skin's controls open the folder in Explorer.)

Workflow:

1. Create a folder there, e.g. `%APPDATA%\Ampwin\skins\myskin\`
2. Put `skin.json` + `index.html` (+ any css/js/images) inside
3. In Ampwin, pick your skin from the skin dropdown
4. After editing files, switch to another skin and back to reload
5. Press **F12** for DevTools — your skin's document is inspectable (it lives in an iframe inside the player page)

Skins are **trusted local content** — install skins only from sources you trust, just like Winamp skins back in the day.

## 2. Anatomy

```
myskin/
├── skin.json     ← manifest (required)
├── index.html    ← your entire UI (required)
├── skin.css      ← optional, referenced from your HTML
├── skin.js       ← optional, referenced from your HTML
└── anything.png  ← images, fonts, etc.
```

### skin.json

```json
{
  "id": "myskin",
  "name": "My Skin",
  "author": "you",
  "version": "1.0.0",
  "apiVersion": 1,
  "entry": "index.html",
  "window": {
    "width": 500,
    "height": 320,
    "minWidth": 300,
    "minHeight": 200,
    "resizable": true
  },
  "features": []
}
```

Rules:

- `id` — lowercase letters/digits/hyphens only, **must equal the folder name**. `default` is reserved.
- `apiVersion` — must be `1`. Skins with an unknown version are rejected.
- `entry` — the HTML file loaded as your UI (relative to the skin folder).
- `window` — applied when your skin activates: the player window is resized to `width`×`height` and constrained by the minimums. (On app launch, the user's last window size wins.)

### index.html

A normal HTML document. Relative URLs (`<link href="skin.css">`, `<img src="logo.png">`) resolve to files in your skin folder automatically. Inline `<style>` and `<script>` are also fine.

## 3. How your skin runs

- Your document loads inside the player with **`window.ampwin` already available before any of your scripts run** — call it from anywhere, no waiting, no imports.
- When your UI is initialized, you **must call `ampwin.ready()`**. Skins that don't call it within **5 seconds** are rejected and the player reverts to the default skin.
- A JavaScript error thrown *before* `ready()` also rejects the skin. Errors after `ready()` are logged but not fatal.
- The player window is **frameless** — your skin draws all the chrome, including window-drag areas and min/close buttons (see §5).
- The player window is **transparent**: whatever your document doesn't paint
  shows the desktop through. For a classic rectangular skin, give `body` an
  opaque `background` (the default and lite skins do). For an **irregular /
  shaped skin**, leave `html`/`body` transparent and draw your shape with
  normal elements, `border-radius`, `clip-path`, or a PNG — the empty areas
  are see-through. Note: see-through areas still belong to the window (clicks
  there hit the window, not the desktop behind it), so keep your window size
  close to your drawn shape.
- Switching skins never interrupts audio: the audio engine lives outside your document.

Environment notes:

- It's Chromium (latest). All modern CSS/JS works.
- **No Node** — no `require`, no filesystem. Everything goes through `ampwin`.
- **No `window.prompt` / `alert` / `confirm`** — they don't exist in Electron. Build your own inputs.
- **`window.open` is blocked.** Use `ampwin.visualizer.popOut()` for the visualizer pop-out.
- Inline styles/scripts are allowed; remote URLs (CDNs, web fonts) are **blocked** by CSP. Ship every asset in your folder.

## 4. API reference — `window.ampwin`

Everything returns plain data. All `on(...)` subscriptions return an **unsubscribe function** (you rarely need it — subscriptions are cleaned up automatically when your skin unloads). The authoritative TypeScript contract is [`src/shared/skin-api.d.ts`](src/shared/skin-api.d.ts).

### The Track object

```js
{ id, path, title, artist, album, durationSec, codec, verdict, isVideo, missing }
// verdict: 'native' | 'transcode'  (transcode = played via ffmpeg conversion)
// missing: true when the file no longer exists on disk
```

### ampwin.player — playback control

| Call | Effect |
|---|---|
| `play()` / `pause()` / `stop()` | what it says |
| `togglePlay()` | play⇄pause; starts the current playlist entry when idle |
| `next()` / `previous()` | previous() restarts the track if >3 s in (Winamp behavior) |
| `seek(seconds)` | absolute seek |
| `setVolume(v)` | 0..1 |
| `setMuted(bool)` / `setShuffle(bool)` | |
| `setRepeat(mode)` | `'off' \| 'all' \| 'one'` |
| `getSnapshot()` | `{ state, track, positionSec, durationSec, volume, muted, shuffle, repeat, loadingPercent? }` — poll-free way to paint your initial UI |

Events (`ampwin.player.on(event, callback)`):

| Event | Callback args | When |
|---|---|---|
| `'state'` | `('idle'\|'loading'\|'playing'\|'paused')` | play state changes |
| `'track'` | `(track \| null)` | current track changes |
| `'position'` | `(posSec, durSec)` | ~4×/second while playing (audio **and** video) |
| `'volume'` | `(v, muted)` | volume/mute changes |
| `'mode'` | `(shuffle, repeat)` | shuffle/repeat changes |
| `'error'` | `(message, track \| null)` | a track failed to play |

### ampwin.playlist — the current playlist

| Call | Effect |
|---|---|
| `getTracks()` → `Track[]` | |
| `getCurrentIndex()` → `number` | −1 when nothing selected |
| `playIndex(i)` | play a specific row |
| `addPaths(paths, atIndex?)` → `Promise<Track[]>` | probe files and insert (append by default) |
| `removeIndices([i, ...])` | remove rows |
| `move(from, to)` | reorder |
| `clear()` | stop + empty |
| `queueNext(i)` | "play this one next" jump queue |
| `on('changed', (tracks, currentIndex) => ...)` | fires on any list mutation |

`ampwin.playlist.saved.*` — persistent playlists:

| Call | Effect |
|---|---|
| `list()` → `Promise<{id, name, trackCount}[]>` | |
| `load(id)` | replaces the current playlist |
| `saveCurrentAs(name)` → `Promise<id>` | |
| `delete(id)` | |
| `importFromFile()` | file dialog → import `.m3u`/`.m3u8`/`.pls` |
| `exportToFile('m3u8' \| 'm3u')` | save dialog → export |

### ampwin.files — dialogs, drops, artwork

| Call | Effect |
|---|---|
| `openFilesDialog()` → `Promise<string[]>` | multi-select audio files (absolute paths; `[]` on cancel) |
| `openFolderDialog()` → `Promise<string[]>` | folder picker → all media files inside, recursively |
| `getArtworkUrl(track)` → `Promise<string \| null>` | embedded album art as a URL you can put straight into `<img src>` |
| `pathForDroppedFile(file)` → `string` | absolute path for a `File` from a drop event |
| `openPaths(paths)` | open like the OS would: playlist files replace the playlist, media appends (and plays if idle) |

Drag & drop pattern:

```js
document.addEventListener('dragover', (e) => e.preventDefault())
document.addEventListener('drop', (e) => {
  e.preventDefault()
  const paths = [...e.dataTransfer.files].map((f) => ampwin.files.pathForDroppedFile(f))
  if (paths.length) ampwin.files.openPaths(paths)
})
```

### ampwin.visualizer — MilkDrop and friends

| Call | Effect |
|---|---|
| `attach(canvas)` | mount the visualizer onto **your** `<canvas>` element — it resizes automatically with the element |
| `detach()` | |
| `listPresets()` → `PresetInfo[]` | `{id, name, source: 'bundled'\|'user'}` (~245 bundled; may be empty for a moment right after launch while the catalog loads) |
| `loadPreset(id, blendSec?)` | default blend 2.7 s, classic MilkDrop feel |
| `nextPreset()` / `prevPreset()` / `randomPreset()` | |
| `setCycle({enabled, intervalSec?, random?})` | auto-cycle presets |
| `importPresetFiles()` → `Promise<PresetInfo[]>` | dialog → import Butterchurn `.json` presets |
| `setFullscreen(true/false)` | fullscreen visualizer |
| `popOut()` | detach into a separate resizable window with transport buttons; closing it returns the visualizer to your canvas |
| `listVisualizers()` / `getActiveVisualizerId()` / `setActiveVisualizer(id)` | `'butterchurn'` (MilkDrop) and `'bars'` (spectrum) are built in |
| `registerPlugin(plugin)` | add your own visualizer (below) |
| `on('preset', (p) => ...)` | preset changed |

Custom visualizer plugin — your skin can ship its own visualizer:

```js
ampwin.visualizer.registerPlugin({
  id: 'my-scope',
  name: 'Oscilloscope',
  init({ canvas, audioContext, sourceNode, analyser }) {
    // analyser: a shared AnalyserNode tap (fftSize 2048), ready to use
    this.ctx = canvas.getContext('2d')
    this.analyser = analyser
    this.data = new Uint8Array(analyser.fftSize)
  },
  render() {
    this.analyser.getByteTimeDomainData(this.data) // waveform; use getByteFrequencyData for spectrum
    // ...draw onto the canvas...
  },
  resize(w, h) {},
  destroy() {}
})
ampwin.visualizer.setActiveVisualizer('my-scope')
```

The plugin is unregistered automatically when your skin unloads.

### ampwin.window — frameless window control

| Call | Effect |
|---|---|
| `setDragRegion(el, {exclude: [...]})` | make `el` a window-drag handle; list clickable children (buttons!) in `exclude` |
| `minimize()` / `close()` | |
| `setSize(w, h)` | |
| `setAlwaysOnTop(bool)` | |

**Important:** because the window is frameless, a skin without a drag region cannot be moved. Always do:

```js
ampwin.window.setDragRegion(document.getElementById('titlebar'), {
  exclude: [minBtn, closeBtn] // anything inside the bar that must stay clickable
})
```

(CSS `-webkit-app-region: drag` does **not** work inside skins — use the API; it handles the platform details.)

### ampwin.skins

| Call | Effect |
|---|---|
| `list()` → `Promise<SkinInfo[]>` | all installed skins |
| `getActiveId()` / `setActive(id)` | hot-swap — audio keeps playing |
| `openSkinsFolder()` | open the user skins folder in Explorer |

## 5. Complete working example

Drop these two files into `%APPDATA%\Ampwin\skins\tutorial\` and select "Tutorial" from the skin list. This is a fully functional player.

**skin.json**

```json
{
  "id": "tutorial",
  "name": "Tutorial",
  "author": "docs",
  "version": "1.0.0",
  "apiVersion": 1,
  "entry": "index.html",
  "window": { "width": 460, "height": 380, "minWidth": 340, "minHeight": 260, "resizable": true }
}
```

**index.html**

```html
<!doctype html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * { margin: 0; box-sizing: border-box; user-select: none; font-family: 'Segoe UI', sans-serif; }
    html, body { width: 100%; height: 100%; overflow: hidden; }
    body { background: #181822; color: #dde; display: flex; flex-direction: column; }
    #bar { display: flex; gap: 8px; align-items: center; padding: 8px 10px; background: #23233a; }
    #title { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    button { background: #32324e; color: #dde; border: 0; border-radius: 4px; padding: 5px 10px; cursor: pointer; }
    button:hover { background: #44446a; }
    #viz { width: 100%; height: 140px; display: block; background: #000; }
    #seek { width: 100%; }
    #controls { display: flex; gap: 6px; padding: 8px 10px; align-items: center; }
    #list { flex: 1; overflow-y: auto; font-size: 13px; }
    .row { padding: 3px 12px; cursor: default; }
    .row.current { color: #8f8fff; font-weight: bold; }
    .row:hover { background: #23233a; }
  </style>
</head>
<body>
  <div id="bar">
    <span id="title">Tutorial skin</span>
    <button id="min">–</button><button id="x">×</button>
  </div>

  <canvas id="viz"></canvas>
  <div style="padding: 4px 10px"><input id="seek" type="range" min="0" max="1000" value="0"></div>
  <div id="controls">
    <button id="prev">⏮</button><button id="play">▶</button><button id="next">⏭</button>
    <button id="open">open files…</button>
    <span style="flex:1"></span>
    <select id="skins" title="Switch skin"></select>
    <span id="time">0:00</span>
  </div>
  <div id="list"></div>

  <script>
    const $ = (id) => document.getElementById(id)
    const fmt = (s) => isFinite(s) && s > 0
      ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00'

    // 1. window chrome — drag by the top bar, buttons stay clickable
    ampwin.window.setDragRegion($('bar'), { exclude: [$('min'), $('x')] })
    $('min').onclick = () => ampwin.window.minimize()
    $('x').onclick = () => ampwin.window.close()

    // 2. transport
    $('play').onclick = () => ampwin.player.togglePlay()
    $('prev').onclick = () => ampwin.player.previous()
    $('next').onclick = () => ampwin.player.next()
    $('seek').onchange = () => {
      const d = ampwin.player.getSnapshot().durationSec
      if (d > 0) ampwin.player.seek(($('seek').value / 1000) * d)
    }

    // 3. react to the player
    ampwin.player.on('state', (s) => { $('play').textContent = s === 'playing' ? '⏸' : '▶' })
    ampwin.player.on('track', (t) => { $('title').textContent = t ? `${t.artist} — ${t.title}` : 'Tutorial skin' })
    ampwin.player.on('position', (pos, dur) => {
      $('time').textContent = `${fmt(pos)} / ${fmt(dur)}`
      $('seek').value = dur > 0 ? Math.round((pos / dur) * 1000) : 0
    })

    // 4. playlist — double-click plays
    function renderList() {
      const cur = ampwin.playlist.getCurrentIndex()
      $('list').textContent = ''
      ampwin.playlist.getTracks().forEach((t, i) => {
        const row = document.createElement('div')
        row.className = 'row' + (i === cur ? ' current' : '')
        row.textContent = `${i + 1}. ${t.title}`
        row.ondblclick = () => ampwin.playlist.playIndex(i)
        $('list').appendChild(row)
      })
    }
    ampwin.playlist.on('changed', renderList)
    ampwin.player.on('track', renderList)
    renderList()

    // 5. add music
    $('open').onclick = async () => {
      const paths = await ampwin.files.openFilesDialog()
      if (paths.length) ampwin.files.openPaths(paths)
    }
    document.addEventListener('dragover', (e) => e.preventDefault())
    document.addEventListener('drop', (e) => {
      e.preventDefault()
      ampwin.files.openPaths([...e.dataTransfer.files].map((f) => ampwin.files.pathForDroppedFile(f)))
    })

    // 6. the MilkDrop visualizer, on our own canvas
    ampwin.visualizer.attach($('viz'))
    $('viz').onclick = () => ampwin.visualizer.randomPreset()
    $('viz').ondblclick = () => ampwin.visualizer.setFullscreen(true)

    // 7. skin switcher — ALWAYS give users a way out of your skin
    async function fillSkins() {
      const items = await ampwin.skins.list()
      $('skins').textContent = ''
      for (const s of items) {
        const o = document.createElement('option')
        o.value = s.id; o.textContent = s.name
        if (s.id === ampwin.skins.getActiveId()) o.selected = true
        $('skins').appendChild(o)
      }
    }
    $('skins').onchange = () => ampwin.skins.setActive($('skins').value)
    fillSkins()

    // 8. REQUIRED — tell the player we're alive (5s deadline!)
    ampwin.ready()
  </script>
</body>
</html>
```

## 6. Checklist & gotchas

- ☐ `skin.json` `id` matches the folder name exactly, lowercase.
- ☐ `ampwin.ready()` is called, unconditionally, at the end of your init — **the #1 cause of "my skin won't load" is forgetting this** (or throwing an error before reaching it).
- ☐ A drag region is set, or the window can't be moved.
- ☐ Min/close buttons exist somewhere (frameless window = no OS buttons).
- ☐ Give users a way to switch skins (an `ampwin.skins` dropdown). Even if you forget, **Ctrl+Shift+D** always returns to the default skin — a built-in escape hatch no skin can override.
- ☐ Paint your initial UI from `getSnapshot()` / `getTracks()` — events only fire on *changes*, and a track may already be playing when your skin loads (skins hot-swap mid-song).
- ☐ Don't re-render list rows on single click if you want double-click to work on them (replaced DOM nodes break `dblclick`). Toggle classes instead.
- ☐ `listPresets()` can be empty for the first ~second after app launch (catalog loads lazily). Re-query on your dropdown's first open or on the `'preset'` event.
- ☐ Test the failure path: if your skin breaks, Ampwin falls back to the default skin — check DevTools (F12) for your error.

## 7. Sharing a skin

Zip your folder and tell people to extract it into `%APPDATA%\Ampwin\skins\`. That's it — no registration, no manifest server. (In-app zip install is on the roadmap.)
