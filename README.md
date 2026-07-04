# Ampwin

A Winamp-spirited desktop media player for Windows with a **real MilkDrop visualizer**, fully replaceable **HTML/CSS/JS skins**, and **FFmpeg-backed format support**.

![Electron](https://img.shields.io/badge/Electron-37-47848F) ![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6) ![License](https://img.shields.io/badge/license-MIT-green)

## Features

- **MilkDrop 2 visualizer** via [Butterchurn](https://github.com/jberg/butterchurn) — 245 bundled presets with classic 2.7 s blending, auto-cycle, fullscreen mode, and import of additional Butterchurn `.json` presets. Click the visualizer for a random preset, double-click for fullscreen.
- **Skins**: a skin is a folder of HTML + CSS + JS that completely replaces the player UI, talking to the documented `window.ampwin` API. The default UI is itself a skin. Switching skins never interrupts playback.
- **Plays nearly everything**: MP3, FLAC, Ogg, Opus, AAC/M4A, WAV natively; WMA, ALAC, WavPack, TTA, AIFF, MKA, APE, DSD and more through a bundled FFmpeg that transparently converts to lossless FLAC in a local cache (with progress and full seeking).
- **Video** (MP4/WebM) in a minimal pop-up window — play/pause/prev/next overlay, controlled from the main UI too; mixed audio/video playlists auto-advance.
- **Playlists**: save/load internally, import and export `.m3u`/`.m3u8` (+ `.pls` import), relative-path aware, drag & drop of files, folders, and playlist files.
- Global media keys, Windows SMTC (media overlay) support, session restore (playlist + position), single-instance with "Open with Ampwin".

## Development

```powershell
nvm use 24.15.0        # Node >= 20.19 required
npm install
npm run dev            # launch with hot reload
npm test               # vitest unit tests
npm run typecheck
npm run dist           # build the NSIS installer into dist-installer/
```

Generate test media (tones in every supported format + test videos):

```powershell
.\test-media\generate.ps1
```

Run the end-to-end self-test (plays a file, seeks, swaps skins mid-song, checks the visualizer render loop, round-trips a playlist):

```powershell
$env:AMPWIN_SELFTEST = "$PWD\test-media\tone.mp3"; npm run dev
```

## Writing a skin

**→ Full guide: [SKINS.md](SKINS.md)** — self-contained, with a complete working example skin, the entire API reference, and installation instructions. The short version:

A skin is a folder in `%APPDATA%\Ampwin\skins\` (use **skin selector → open skins folder**):

```
myskin/
├── skin.json      # manifest
├── index.html     # your entire UI
├── skin.css
└── skin.js
```

`skin.json`:

```json
{
  "id": "myskin",
  "name": "My Skin",
  "author": "you",
  "version": "1.0.0",
  "apiVersion": 1,
  "entry": "index.html",
  "window": { "width": 500, "height": 300, "resizable": true }
}
```

Your HTML loads with `window.ampwin` already available — no imports needed. Call `ampwin.ready()` once initialized (skins that don't within 5 s are rejected and the default skin returns). The full typed API is in [`src/shared/skin-api.d.ts`](src/shared/skin-api.d.ts); the bundled skins are reference implementations:

- [`skins/default/`](skins/default) — complete player UI (~300 lines of plain JS)
- [`skins/lite/`](skins/lite) — a whole player in ~30 lines

The essentials:

```js
ampwin.window.setDragRegion(titlebarEl, { exclude: [closeBtn] }) // frameless window drag
ampwin.player.togglePlay()
ampwin.player.on('position', (pos, dur) => { /* update seek bar */ })
ampwin.playlist.on('changed', (tracks, current) => { /* render list */ })
ampwin.visualizer.attach(myCanvas)                               // mount MilkDrop
ampwin.visualizer.registerPlugin({ id, name, init, render, resize, destroy }) // custom visualizers
ampwin.ready()
```

## Importing visualizer presets

**Import…** in the default skin accepts Butterchurn `.json` presets (thousands of converted MilkDrop presets circulate online). Raw `.milk` conversion is planned (the conversion toolchain is experimental).

## Bundled binaries

Release builds ship every external tool inside the app — end users install nothing:

- **FFmpeg / ffprobe** (~139 MB) come from the `ffmpeg-static` / `ffprobe-static` npm
  packages and are copied into `resources/bin/` at package time. Resolved from there
  in the packaged app, or from `node_modules/` in dev.
- **yt-dlp** (~17 MB) is fetched into `build/bin/` by `scripts/fetch-ytdlp.mjs` (run
  automatically by `npm run dist`) and copied into `resources/bin/`. On first launch
  the app seeds it into `%APPDATA%\Ampwin\bin\` (writable) — no download needed — and
  self-updates that copy daily (`yt-dlp -U`), since YouTube changes break old versions.
  FFmpeg is static and needs no updates.

Building from source: `npm install` provides FFmpeg; `npm run dist` fetches yt-dlp
automatically (best-effort — if offline, the app downloads yt-dlp at runtime on first
YouTube use instead). The binaries themselves are gitignored, so the repo stays small.

## Architecture notes

- The renderer keeps a persistent "app shell" (audio engine + Web Audio graph + visualizer host); skins live in a same-origin `srcdoc` iframe below it, which is why the music never stops when you switch skins.
- Media is served over a custom `ampwin://` protocol with a manual HTTP Range responder (seeking), path-allowlisted per session.
- Unsupported codecs are converted by the bundled `ffmpeg.exe` to FLAC (compression level 0 — hundreds-of-× realtime) in `%APPDATA%\Ampwin\transcode-cache`, LRU-capped at 1 GB.
