import { app, globalShortcut, ipcMain } from 'electron'
import { existsSync } from 'fs'
import { createMainWindow, getMainWindow } from './windows'
import { installAmpwinProtocol, registerAmpwinScheme } from './protocol'
import { registerIpcHandlers } from './ipc'
import { sweepCache } from './ffmpeg/cache'
import { getSettings } from './store/settings'
import { saveSessionSync } from './store/playlists'
import { MEDIA_EXTS, PLAYLIST_EXTS, extOf } from '../shared/formats'

// Web Audio must start without a user gesture (playback can begin from IPC/media keys)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

/** Media/playlist paths from a command line (OS "Open with", second instance). */
function openablePaths(argv: string[]): string[] {
  return argv.filter((arg) => {
    if (arg.startsWith('-')) return false
    const ext = extOf(arg)
    return (MEDIA_EXTS.includes(ext) || PLAYLIST_EXTS.includes(ext)) && existsSync(arg)
  })
}

function sendOpenFiles(paths: string[]): void {
  const win = getMainWindow()
  if (!win || paths.length === 0) return
  if (win.isMinimized()) win.restore()
  win.focus()
  win.webContents.send('evt:os-open-files', { paths })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    sendOpenFiles(openablePaths(argv))
  })

  // Synchronous session flush from beforeunload — must complete before the
  // process exits, so the playlist + position survive closing.
  ipcMain.on('session:flush', (_event, state) => {
    saveSessionSync(state)
  })

  registerAmpwinScheme()

  app.whenReady().then(async () => {
    installAmpwinProtocol()
    registerIpcHandlers()

    const settings = await getSettings()
    const win = createMainWindow(settings.windowBounds)
    win.webContents.once('did-finish-load', () => {
      sendOpenFiles(openablePaths(process.argv.slice(1)))
    })

    registerMediaKeys()
    // Non-blocking: clear orphaned .part files and evict LRU past the cap.
    void sweepCache(settings.cacheMaxBytes)
    // Seed the bundled yt-dlp into userData and keep it current (no network for
    // users who never touch YouTube).
    void import('./ytdlp').then(({ initYtDlpAtStartup }) => initYtDlpAtStartup())
  })

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
  })
}

function registerMediaKeys(): void {
  const keys: [string, import('../shared/ipc').MediaKey][] = [
    ['MediaPlayPause', 'play-pause'],
    ['MediaNextTrack', 'next'],
    ['MediaPreviousTrack', 'prev'],
    ['MediaStop', 'stop']
  ]
  for (const [accelerator, action] of keys) {
    const ok = globalShortcut.register(accelerator, () => {
      getMainWindow()?.webContents.send('evt:media-key', action)
    })
    if (!ok) console.warn(`media key ${accelerator} unavailable (in use by another app)`)
  }
}

app.on('window-all-closed', () => {
  app.quit()
})
