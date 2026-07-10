# Building Ampwin addons

This guide explains how to create, test, package, and publish an addon for
Ampwin. Addons are trusted JavaScript extensions installed by the user. They
run independently of the active skin and receive the public `window.ampwin`
API for playback, playlists, menus, visualizers, files, networking, lyrics,
stems, conversion, and other supported host features.

The authoritative API contract is `src/shared/skin-api.d.ts` in the Ampwin
source repository. Existing addons in `addons-repo/` are working references.

## 1. How addons run

Each enabled addon runs in its own hidden iframe. Ampwin creates the iframe,
binds `window.ampwin`, sets the addon's folder as its base URL, and loads the
manifest's entry script.

Important consequences:

- Addons are plain browser JavaScript. No bundler is required.
- Node.js and Electron modules are not directly available.
- Use `window.ampwin` for native/player operations.
- Use `ampwin.network.request()` for external HTTP(S), not `fetch()`.
- Addon globals and timers are isolated from other addons.
- Disabling or uninstalling an addon removes its iframe and registered host
  integrations.
- Addons remain loaded when the active skin changes.
- Unlike skins, addons do not need to call `ampwin.ready()`.

## 2. Repository layout

The addon repository has a root catalog and one directory per addon:

```text
/
├── index.json
├── my-addon/
│   ├── addon.json
│   ├── main.js
│   ├── styles.css       optional
│   └── icon.png         optional
└── another-addon/
    ├── addon.json
    └── main.js
```

The directory name must exactly match the addon id.

Valid ids contain lowercase ASCII letters, numbers, and hyphens:

```text
my-addon
lyrics-plus
visualizer-2
```

Do not use spaces, uppercase letters, underscores, `..`, absolute paths, or
backslashes in catalog file paths.

## 3. The addon manifest

Every addon requires `addon.json`:

```json
{
  "apiVersion": 1,
  "id": "my-addon",
  "name": "My Addon",
  "version": "1.0.0",
  "description": "A short explanation of what the addon does.",
  "author": "Your Name",
  "entry": "main.js"
}
```

Rules:

- `apiVersion` must match the Ampwin addon API version.
- `id` must match the directory name.
- `entry` is relative to the addon directory and defaults to `main.js`.
- Use semantic versions such as `1.0.0`, `1.1.0`, and `2.0.0`.
- Keep descriptions short enough to display in the Addons browser.

## 4. Add the addon to `index.json`

Add a catalog entry at the repository root:

```json
{
  "addons": [
    {
      "id": "my-addon",
      "name": "My Addon",
      "version": "1.0.0",
      "description": "A short explanation of what the addon does.",
      "author": "Your Name",
      "entry": "main.js",
      "files": [
        "addon.json",
        "main.js",
        "styles.css",
        "icon.png"
      ]
    }
  ]
}
```

The `files` array is the install list. Include every file the addon needs. A
file omitted from this list will not be downloaded during installation.

The catalog version and `addon.json` version should always match. Ampwin marks
an update available when the installed and catalog versions differ.

## 5. Minimal entry script

Use an immediately invoked function expression so variables do not leak into
the iframe global scope:

```js
/* global ampwin */
;(() => {
  'use strict'

  const ADDON_ID = 'my-addon'

  function start() {
    console.log(`${ADDON_ID} loaded`, ampwin.apiVersion)
  }

  start()
})()
```

There are no imports for `ampwin`; Ampwin provides it before `main.js` runs.

## 6. Add a track context menu

Track menus are the standard entry point for addons that operate on local
playlist items:

```js
/* global ampwin */
;(() => {
  'use strict'

  async function inspectTrack(track) {
    try {
      console.log('selected track', track.path)
    } catch (error) {
      console.error('inspection failed', error)
    }
  }

  ampwin.menus.registerTrackMenu({
    label: 'My Addon',
    items: [
      {
        label: 'Inspect track',
        action: (track) => void inspectTrack(track)
      }
    ]
  })
})()
```

Registered addon menus currently appear only for playable local tracks. Remote,
missing, and unreadable tracks are excluded by the host.

Always catch errors inside asynchronous menu actions. The menu callback itself
is synchronous, so an unhandled rejected promise will not be caught by the menu
registry.

## 7. Open an addon window

Addons are headless by default. For a user interface, open a named addon window
and populate its document:

```js
let addonWindow = null

function openWindow() {
  if (addonWindow && !addonWindow.closed) {
    addonWindow.focus()
    return
  }

  addonWindow = window.open('about:blank', 'ampwin-addon-my-addon')
  if (!addonWindow) throw new Error('Ampwin could not open the addon window')

  const doc = addonWindow.document
  doc.title = 'My Addon'
  doc.head.innerHTML = `
    <style>
      * { box-sizing: border-box; }
      html, body { margin: 0; width: 100%; height: 100%; }
      body {
        background: #101318;
        color: #d7dce5;
        font: 13px "Segoe UI", sans-serif;
      }
      header {
        display: flex;
        align-items: center;
        padding: 8px 10px;
        background: #181d25;
        -webkit-app-region: drag;
      }
      button { -webkit-app-region: no-drag; }
      header .title { flex: 1; font-weight: 600; }
    </style>`

  doc.body.innerHTML = `
    <header>
      <span class="title">My Addon</span>
      <button id="close">Close</button>
    </header>
    <main id="content"></main>`

  doc.getElementById('close').onclick = () => addonWindow.close()
  addonWindow.addEventListener('unload', () => {
    addonWindow = null
  })
}
```

The frame name must start with `ampwin-addon-`. Reuse one stable name per
window so repeated actions focus the existing window instead of opening copies.

Do not assume the addon's hidden iframe and its visible window share DOM
elements. Keep references deliberately and test `win.closed` before UI updates.

## 8. Player and playlist operations

Read the player state:

```js
const snapshot = ampwin.player.getSnapshot()
console.log(snapshot.track, snapshot.state, snapshot.positionSec)
```

Control playback:

```js
ampwin.player.play()
ampwin.player.pause()
ampwin.player.seek(30)
ampwin.player.next()
```

Listen for changes and retain the returned cleanup function when you create
your own short-lived UI:

```js
const offTrack = ampwin.player.on('track', (track) => {
  console.log('now playing', track)
})

// When your window/component is destroyed:
offTrack()
```

Add local files to the current playlist:

```js
const tracks = await ampwin.playlist.addPaths([absoluteFilePath])
```

Play a current-playlist item:

```js
const index = ampwin.playlist.getTracks().findIndex((track) => track.id === wantedId)
if (index >= 0) ampwin.playlist.playIndex(index)
```

Add tracks to a saved playlist without replacing the current playlist:

```js
const saved = await ampwin.playlist.saved.list()
await ampwin.playlist.saved.addTracksTo(savedPlaylistId, tracks)
```

Use `ampwin.links` for host-supported URL media and YouTube workflows. Do not
pretend an unrelated service is a YouTube result merely to create a track; if a
new generic remote-track API is required, add it to the public Ampwin API.

## 9. External HTTP(S)

Renderer CSP blocks direct external `fetch()` calls. Use:

```js
const response = await ampwin.network.request({
  url: 'https://example.com/api/items',
  headers: { Accept: 'application/json' },
  timeoutMs: 15_000
})

if (!response.ok) throw new Error(`HTTP ${response.status}`)
const value = JSON.parse(response.body)
```

Feature-detect the bridge for compatibility with older Ampwin builds:

```js
if (!ampwin.network?.request) {
  throw new Error('This addon requires an Ampwin version with network.request support')
}
```

See `ADDON_NETWORKING.md` for JSON POST requests, authentication headers,
binary responses, timeouts, response limits, and cleanup.

## 10. Addon settings and credentials

Small addon settings can use `localStorage`. Prefix every key with the addon id
because installed extensions may share an origin-level storage area:

```js
const PREFIX = 'my-addon:'

function readEnabled() {
  return localStorage.getItem(PREFIX + 'enabled') === 'true'
}

function writeEnabled(enabled) {
  localStorage.setItem(PREFIX + 'enabled', String(enabled))
}
```

Do not log passwords or tokens. Provide an explicit sign-out action that
removes credentials. Do not store more user information than the addon needs.

## 11. Visualizer addons

Register a visualizer plugin to make it appear in Ampwin's visualizer picker:

```js
let context = null
let analyser = null
let samples = null

ampwin.visualizer.registerPlugin({
  id: 'my-visualizer',
  name: 'My Visualizer',

  init(ctx) {
    context = ctx.canvas.getContext('2d')
    analyser = ctx.audioContext.createAnalyser()
    analyser.fftSize = 2048
    samples = new Uint8Array(analyser.frequencyBinCount)
    ctx.sourceNode.connect(analyser)
  },

  render() {
    if (!context || !analyser || !samples) return
    analyser.getByteFrequencyData(samples)
    // Draw the current frame here.
  },

  resize(width, height) {
    // Store dimensions if render() needs them.
  },

  destroy() {
    try { analyser?.disconnect() } catch {}
    analyser = null
    samples = null
    context = null
  }
})
```

Disconnect addon-created audio nodes in `destroy()`. Ampwin removes registered
plugins automatically when the addon is disabled or uninstalled.

## 12. Lyrics

Retrieve cached/online lyrics through the host:

```js
const lyrics = await ampwin.lyrics.fetchOnline(track)
if (lyrics?.synced) {
  console.log(lyrics.lines)
}
```

Write a sidecar only beside a file the addon is authorized to create or manage:

```js
await ampwin.lyrics.writeSidecar(outputPath, lyrics.lines)
```

For long operations, use a visible state, a strict deadline, retries for
transient failures, and a final error state. A timeout should not silently claim
that lyrics do not exist.

## 13. Stems and conversion

The stems API accepts a model-pack description and downloads its declared model
files on first use. Listen for progress using the same job key passed to
`separate()`:

```js
const jobKey = `${track.path}::my-model`
const offProgress = ampwin.stems.on('progress', (key, progress) => {
  if (key !== jobKey) return
  console.log(progress.phase, progress.percent, progress.detail)
})

try {
  const result = await ampwin.stems.separate(track, pack, { jobKey })
  console.log(result.stems)
} finally {
  offProgress()
}
```

Only one separation runs app-wide. Provide cancellation with
`ampwin.stems.cancel(jobKey)` and handle a rejected operation visibly.

Use `ampwin.convert` for supported local-file conversions and
`ampwin.stems.export` for stem output. Never overwrite the user's source file
unless the user explicitly requested it.

## 14. Cleanup and lifecycle

The host automatically tracks public API subscriptions and registrations owned
by the addon's facade. Addon-created resources still need cleanup:

- Close or detach addon-created audio/video elements.
- Clear `setTimeout` and `setInterval` timers.
- Remove DOM listeners from external/addon windows.
- Cancel stems jobs when their UI closes.
- Disconnect custom Web Audio nodes.
- Ignore async UI results after the target window closes.

Example:

```js
let pollTimer = null
let disposed = false

function dispose() {
  disposed = true
  if (pollTimer !== null) clearTimeout(pollTimer)
  pollTimer = null
}

window.addEventListener('unload', dispose)
```

## 15. Error handling

Every asynchronous user action should use `try/catch/finally`:

```js
async function run(button, status) {
  button.disabled = true
  status.textContent = 'working…'

  try {
    await doWork()
    status.textContent = 'complete'
  } catch (error) {
    status.textContent = `failed: ${error?.message || error}`
  } finally {
    button.disabled = false
  }
}
```

Do not swallow errors while leaving a progress indicator active. Distinguish
between “not found,” “timed out,” “cancelled,” and “failed.”

## 16. Local testing

For manual development:

1. Start Ampwin and open the Addons browser.
2. Use its folder button to open the user addons directory.
3. Create `<addons directory>/<addon-id>/`.
4. Copy `addon.json`, `main.js`, and every required asset into it.
5. Restart Ampwin so it rescans installed manifests.
6. Enable the addon in the Addons browser.
7. Open DevTools with F12 and check console/main-process errors.
8. Disable and re-enable the addon after replacing its entry script, or use the
   catalog update flow once it is published.

Test at minimum:

- Fresh install and first enable.
- Disable/re-enable without restarting.
- Uninstall while its window is open.
- Skin switching while the addon remains enabled.
- Offline/network timeout behavior.
- Authentication failure and sign-out.
- Empty playlist, missing files, and unsupported media.
- Closing the addon window during an async operation.
- App restart with saved addon settings.

## 17. Publishing and updates

Before publishing:

1. Ensure `addon.json` and `index.json` use the same id, version, entry, name,
   description, and author.
2. Include every required file in the catalog `files` array.
3. Use forward-slash relative paths only.
4. Increment the semantic version for every published update.
5. Test installation from the repository, not only a manually copied folder.
6. Document permissions, network services, downloads, model sizes, and stored
   credentials in the addon README or description.

Ampwin downloads catalog files from the configured GitHub repository's `main`
branch, falling back to `master`. Installation is staged and then swapped into
place so a partial download does not leave a half-installed addon.

## 18. Compatibility and API changes

Check `ampwin.apiVersion` and feature-detect recently added methods:

```js
if (ampwin.apiVersion !== 1) {
  throw new Error(`Unsupported Ampwin addon API: ${ampwin.apiVersion}`)
}

if (!ampwin.network?.request) {
  throw new Error('This addon requires network.request support')
}
```

If an addon requires a capability that does not exist, do not reach into
`window.parent`, the preload bridge, or internal DOM. Add a general public API
capability that future addons can reuse, document it in `skin-api.d.ts`, and
increment the API version when compatibility requires it.

## 19. Security expectations

Addons are trusted code approved and installed by the user, but they should
still follow least-surprise behavior:

- Explain external network services and large downloads.
- Never transmit local file paths, playlist contents, or credentials unless
  that is an explicit feature the user invoked.
- Never execute downloaded scripts.
- Validate remote JSON before using it.
- Restrict accepted URLs to the service the addon is designed for.
- Keep tokens out of logs and UI error strings.
- Require a user gesture for destructive, paid, or externally visible actions.
- Preserve user media and unrelated settings.

## 20. Release checklist

- [ ] Folder name and manifest id match.
- [ ] Manifest and catalog versions match.
- [ ] Every asset appears in `files`.
- [ ] Entry script works with a fresh local install.
- [ ] Async errors restore the UI.
- [ ] Timers, listeners, windows, and audio nodes are cleaned up.
- [ ] Network calls have deadlines and visible failures.
- [ ] Credentials can be removed through sign-out.
- [ ] Disable, re-enable, skin switching, and restart were tested.
- [ ] The addon documents its network services and downloads.
- [ ] No Ampwin internal/private object is used.

