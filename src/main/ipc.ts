import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { existsSync, promises as fsp } from 'fs'
import { basename, dirname, extname, join } from 'path'
import type { DialogFilterKind, FileFilter, IpcInvokeMap } from '../shared/ipc'
import {
  AUDIO_EXTS,
  MEDIA_EXTS,
  PLAYLIST_EXTS,
  PRESET_EXTS,
  VIDEO_EXTS,
  extOf,
  isVideoPath
} from '../shared/formats'
import { extractArtwork, probeFile, probeMany } from './metadata'
import { allowMediaPath, artUrlFor, mediaUrlFor } from './protocol'
import { cacheDir, cacheKey, cacheLookup, cachedFlacPath, cachedMp4Path } from './ffmpeg/cache'
import { cancelTranscode, runFfmpegJob, transcodeToFlac } from './ffmpeg/transcoder'
import { videoPlanArgs, videoPlanFor } from './ffmpeg/probe'
import { assertFfmpegAvailable } from './ffmpeg/paths'
import { feedControl, startVideoStream, stopVideoStream } from './videoStream'
import {
  downloadLink,
  downloadsDir,
  ensureYtDlp,
  isInstalled,
  probeLink,
  resolveStream,
  searchYouTube,
  updateYtDlp
} from './ytdlp'
import { isSignedIn, openSignIn, signOut } from './youtubeAuth'
import { getMainWindow } from './windows'
import { convertFile, convertFormats, convertedDir } from './convert'
import { listSkins, openUserSkinsFolder, readSkinEntry } from './skins'
import {
  browseAddons,
  installAddon,
  listInstalled,
  openAddonsFolder,
  setAddonEnabled,
  uninstallAddon
} from './addons'
import { importPresetFiles, listUserPresets, readUserPreset } from './presets'
import { parseM3u, parsePls, serializeM3u } from './playlistFormats'
import { minimizePopout } from './windows'
import { getSettings, patchSettings } from './store/settings'
import {
  deletePlaylist,
  getPlaylist,
  getSession,
  listPlaylists,
  savePlaylist,
  saveSession
} from './store/playlists'

// Thin typed wrapper: handlers are registered against IpcInvokeMap so a
// channel/signature mismatch is a compile error, not a runtime surprise.
function handle<K extends keyof IpcInvokeMap>(
  channel: K,
  fn: (
    event: Electron.IpcMainInvokeEvent,
    ...args: IpcInvokeMap[K]['args']
  ) => Promise<IpcInvokeMap[K]['result']> | IpcInvokeMap[K]['result']
): void {
  ipcMain.handle(channel, (event, ...args) => fn(event, ...(args as IpcInvokeMap[K]['args'])))
}

const DIALOG_FILTERS: Record<DialogFilterKind, FileFilter[]> = {
  media: [
    { name: 'All media', extensions: [...MEDIA_EXTS] },
    { name: 'Audio', extensions: [...AUDIO_EXTS] },
    { name: 'Video', extensions: [...VIDEO_EXTS] },
    { name: 'All files', extensions: ['*'] }
  ],
  audio: [
    { name: 'Audio', extensions: [...AUDIO_EXTS] },
    { name: 'All media', extensions: [...MEDIA_EXTS] },
    { name: 'All files', extensions: ['*'] }
  ],
  video: [
    { name: 'Video', extensions: [...VIDEO_EXTS] },
    { name: 'All files', extensions: ['*'] }
  ],
  playlist: [{ name: 'Playlists', extensions: [...PLAYLIST_EXTS] }],
  preset: [{ name: 'Visualizer presets', extensions: [...PRESET_EXTS] }]
}

function windowOf(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

export function registerIpcHandlers(): void {
  handle('dialog:open-files', async (event, kind = 'audio') => {
    const win = windowOf(event)
    if (!win) return []
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      filters: DIALOG_FILTERS[kind]
    })
    return result.canceled ? [] : result.filePaths
  })

  handle('dialog:open-folder', async (event) => {
    const win = windowOf(event)
    if (!win) return null
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  handle('media:probe', (_event, paths) => probeMany(paths))

  handle('media:prepare', async (event, path, opts) => {
    // Remote URL (a resolved stream): hand it straight to the media element.
    if (/^https?:\/\//i.test(path)) {
      allowMediaPath(path)
      return { url: path, transcoded: false }
    }

    const stat = await fsp.stat(path)
    const sender = event.sender
    const progress = (percent: number): void => {
      if (!sender.isDestroyed()) sender.send('evt:prepare-progress', { path, percent })
    }

    // ---- video: probe codecs, pick the cheapest Chromium-playable route ----
    if (isVideoPath(path)) {
      const plan = await videoPlanFor(path)
      if (!plan) throw new Error('unreadable video file (ffprobe failed)')
      if (plan.kind === 'direct' && !opts?.forceTranscode) {
        allowMediaPath(path)
        return { url: mediaUrlFor(path), transcoded: false }
      }
      assertFfmpegAvailable()
      const key = cacheKey(path, stat.mtimeMs, stat.size)
      const hit = await cacheLookup(key, 'mp4')
      if (hit) {
        allowMediaPath(hit)
        return { url: mediaUrlFor(hit), transcoded: true }
      }
      await fsp.mkdir(cacheDir(), { recursive: true })
      const dest = cachedMp4Path(key)
      const kind = plan.kind === 'direct' ? 'full' : plan.kind // forceTranscode on a direct file
      const { promise } = runFfmpegJob({
        src: path,
        dest,
        outputArgs: videoPlanArgs(kind),
        durationSec: plan.streams.durationSec > 0 ? plan.streams.durationSec : null,
        onProgress: progress
      })
      await promise
      allowMediaPath(dest)
      return { url: mediaUrlFor(dest), transcoded: true }
    }

    // ---- audio ---------------------------------------------------------------
    const probe = await probeFile(path)
    const needsTranscode = opts?.forceTranscode || probe.verdict === 'transcode'

    if (!needsTranscode) {
      allowMediaPath(path)
      return { url: mediaUrlFor(path), transcoded: false }
    }

    assertFfmpegAvailable()
    const key = cacheKey(path, stat.mtimeMs, stat.size)
    const hit = await cacheLookup(key)
    if (hit) {
      allowMediaPath(hit)
      return { url: mediaUrlFor(hit), transcoded: true }
    }

    await fsp.mkdir(cacheDir(), { recursive: true })
    const dest = cachedFlacPath(key)
    const { promise } = transcodeToFlac({
      src: path,
      dest,
      durationSec: probe.durationSec > 0 ? probe.durationSec : null,
      onProgress: progress
    })
    await promise
    allowMediaPath(dest)
    return { url: mediaUrlFor(dest), transcoded: true }
  })

  handle('media:video-plan', async (_event, path) => {
    const plan = await videoPlanFor(path)
    if (!plan) throw new Error('unreadable video file (ffprobe failed)')
    return { direct: plan.kind === 'direct', durationSec: plan.streams.durationSec }
  })

  handle('vstream:start', (event, path, startSec) => {
    assertFfmpegAvailable()
    return startVideoStream(event.sender, path, startSec)
  })

  handle('vstream:stop', (_event, sessionId) => {
    stopVideoStream(sessionId)
  })

  handle('vstream:feed', (_event, sessionId, ctl) => {
    feedControl(sessionId, ctl)
  })

  handle('media:cancel-prepare', async (_event, path) => {
    try {
      const stat = await fsp.stat(path)
      cancelTranscode(cachedFlacPath(cacheKey(path, stat.mtimeMs, stat.size)))
    } catch {
      // source gone — nothing to cancel
    }
  })

  handle('media:artwork', async (_event, path) => {
    allowMediaPath(path)
    const art = await extractArtwork(path)
    return art ? artUrlFor(path) : null
  })

  handle('scan:folder', async (_event, root) => {
    // Recursive media scan, natural sort, bounded depth to dodge junction loops.
    const found: string[] = []
    async function walk(dir: string, depth: number): Promise<void> {
      if (depth > 12) return
      let entries: import('fs').Dirent[]
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      for (const e of entries) {
        const full = join(dir, e.name)
        if (e.isDirectory()) await walk(full, depth + 1)
        else if (MEDIA_EXTS.includes(extOf(e.name))) found.push(full)
      }
    }
    await walk(root, 0)
    return found
  })

  handle('playlist:import', async (_event, path) => {
    const buf = await fsp.readFile(path)
    const ext = extname(path).toLowerCase()
    // .m3u8 is UTF-8 by definition; legacy .m3u is a coin toss — decode as
    // UTF-8 and fall back to latin1 when replacement characters appear.
    let text = buf.toString('utf8')
    if (ext !== '.m3u8' && text.includes('�')) text = buf.toString('latin1')

    const baseDir = dirname(path)
    const parsed = ext === '.pls' ? parsePls(text, baseDir) : parseM3u(text, baseDir)

    const entries = await Promise.all(
      parsed.entries.map(async (e) => {
        let missing = false
        try {
          await fsp.access(e.path)
        } catch {
          missing = true
        }
        return { path: e.path, title: e.title, durationSec: e.durationSec, missing }
      })
    )
    return { name: basename(path, extname(path)), entries, skippedUrls: parsed.skippedUrls }
  })

  handle('playlist:export', async (_event, pl, target, fmt, relativePaths) => {
    const text = serializeM3u(
      pl.tracks.map((t) => ({
        path: t.path,
        title: t.title,
        artist: t.artist,
        durationSec: t.durationSec
      })),
      relativePaths ? { relativeTo: target } : {}
    )
    // .m3u8 → UTF-8; legacy .m3u → latin1 (lossy for non-Latin titles).
    await fsp.writeFile(target, fmt === 'm3u' ? Buffer.from(text, 'latin1') : text)
  })

  handle('skins:list', () => listSkins())
  handle('skins:read-entry', (_event, id) => readSkinEntry(id))
  handle('skins:open-folder', () => openUserSkinsFolder())

  handle('presets:list-user', () => listUserPresets())
  handle('presets:read', (_event, id) => readUserPreset(id))
  handle('presets:import-files', (_event, paths) => importPresetFiles(paths))

  handle('addons:list', () => listInstalled())
  handle('addons:catalog', () => browseAddons())
  handle('addons:install', (event, id) =>
    installAddon(id, (percent) => {
      if (!event.sender.isDestroyed()) event.sender.send('evt:addon-progress', { id, percent })
    })
  )
  handle('addons:uninstall', (_event, id) => uninstallAddon(id))
  handle('addons:set-enabled', (_event, id, enabled) => setAddonEnabled(id, enabled))
  handle('addons:open-folder', () => openAddonsFolder())

  handle('window:apply-skin-spec', (event, spec, includeSize) => {
    const win = windowOf(event)
    if (!win) return
    win.setResizable(spec.resizable !== false)
    win.setMinimumSize(spec.minWidth ?? 320, spec.minHeight ?? 240)
    if (includeSize) win.setSize(Math.round(spec.width), Math.round(spec.height))
  })

  handle('store:settings:get', () => getSettings())
  handle('store:settings:patch', (_event, partial) => patchSettings(partial))
  handle('store:session:get', () => getSession())
  handle('store:session:save', (_event, state) => saveSession(state))
  handle('store:playlists:list', () => listPlaylists())
  handle('store:playlists:get', (_event, id) => getPlaylist(id))
  handle('store:playlists:save', (_event, pl) => savePlaylist(pl))
  handle('store:playlists:delete', (_event, id) => deletePlaylist(id))

  handle('window:minimize', (event) => {
    windowOf(event)?.minimize()
  })

  handle('popout:minimize', (_event, frameName) => {
    minimizePopout(frameName)
  })

  handle('window:toggle-devtools', (event) => {
    event.sender.toggleDevTools()
  })

  handle('window:close', (event) => {
    windowOf(event)?.close()
  })

  handle('window:set-size', (event, width, height) => {
    windowOf(event)?.setSize(Math.round(width), Math.round(height))
  })

  handle('window:set-always-on-top', (event, on) => {
    windowOf(event)?.setAlwaysOnTop(on)
  })

  handle('window:set-fullscreen', (event, on) => {
    windowOf(event)?.setFullScreen(on)
  })

  handle('ytdlp:status', async () => ({ installed: await isInstalled() }))

  handle('ytdlp:ensure', async (event) => {
    try {
      const already = await isInstalled()
      await ensureYtDlp((percent) => {
        if (!event.sender.isDestroyed()) event.sender.send('evt:ytdlp-progress', { percent })
      })
      if (!already) void updateYtDlp() // fresh download: make sure it's current
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  handle('link:probe', (_event, url, audioOnly) => probeLink(url, audioOnly))
  handle('link:resolve', (_event, url, audioOnly) => resolveStream(url, audioOnly))
  handle('yt:search', (_event, query) => searchYouTube(query))

  handle('link:download', async (event, url, kind) => {
    const path = await downloadLink(url, kind, (percent, phase) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('evt:download-progress', { url, percent, phase })
      }
    })
    return { path }
  })

  handle('downloads:open-folder', async () => {
    await fsp.mkdir(downloadsDir(), { recursive: true })
    await shell.openPath(downloadsDir())
  })

  handle('convert:list', (_event, isVideo) => convertFormats(isVideo))

  let lastConvertedPath: string | null = null
  handle('convert:start', async (event, srcPath, formatId) => {
    const path = await convertFile(srcPath, formatId, (percent) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('evt:convert-progress', { srcPath, percent })
      }
    })
    lastConvertedPath = path
    return { path }
  })

  handle('convert:open-folder', async () => {
    // Highlight the newest result when we have one: showItemInFolder always
    // opens a live Explorer view, whereas openPath can re-focus a stale
    // window Windows already has for that folder.
    if (lastConvertedPath && existsSync(lastConvertedPath)) {
      shell.showItemInFolder(lastConvertedPath)
      return
    }
    await fsp.mkdir(convertedDir(), { recursive: true })
    await shell.openPath(convertedDir())
  })
  handle('yt:signin', () => openSignIn(getMainWindow()))
  handle('yt:signed-in', () => isSignedIn())
  handle('yt:sign-out', () => signOut())

  handle('dev:log', async (_event, message) => {
    console.log(`[renderer] ${message}`)
    // Packaged GUI apps have no visible stdout — mirror to a log file so the
    // self-test is verifiable against the installed build too.
    if (process.env['AMPWIN_SELFTEST']) {
      const { app } = await import('electron')
      await fsp
        .appendFile(join(app.getPath('userData'), 'selftest.log'), `${message}\n`)
        .catch(() => {})
    }
  })
}
