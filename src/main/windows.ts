import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { patchSettings } from './store/settings'

let mainWindow: BrowserWindow | null = null

// Same-process child windows the renderer may open via window.open(frameName).
// Everything else is denied — no skin gets to open arbitrary windows.
const POPOUT_OPTS: Record<string, { width: number; height: number; minWidth: number; minHeight: number }> = {
  'ampwin-viz': { width: 640, height: 420, minWidth: 300, minHeight: 220 },
  'ampwin-playlist': { width: 440, height: 600, minWidth: 300, minHeight: 320 },
  'ampwin-eq': { width: 600, height: 360, minWidth: 460, minHeight: 300 }
}
const popouts = new Map<string, BrowserWindow>()

export function minimizePopout(frameName: string): void {
  const w = popouts.get(frameName)
  if (w && !w.isDestroyed()) w.minimize()
}

export function createMainWindow(bounds?: { x: number; y: number; width: number; height: number } | null): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus()
    return mainWindow
  }

  // Only restore bounds that are still (mostly) on a connected display.
  const usable =
    bounds &&
    screen.getAllDisplays().some((d) => {
      const a = d.workArea
      return (
        bounds.x < a.x + a.width - 40 &&
        bounds.x + bounds.width > a.x + 40 &&
        bounds.y >= a.y - 20 &&
        bounds.y < a.y + a.height - 40
      )
    })

  const winW = usable ? bounds!.width : 680
  const winH = usable ? bounds!.height : 560

  mainWindow = new BrowserWindow({
    width: winW,
    height: winH,
    x: usable ? bounds!.x : undefined,
    y: usable ? bounds!.y : undefined,
    minWidth: 480,
    minHeight: 320,
    frame: false,
    // Transparent so irregular-shaped skins show the desktop through their
    // empty areas instead of a black box. Regular skins paint opaque backgrounds.
    transparent: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Visualizer rAF loop must keep running while unfocused
      backgroundThrottling: false
    }
  })

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow) return
    // Transparent + frameless windows can open at the wrong size (or maximized)
    // in packaged builds on some Windows configs, ignoring the constructor size.
    // Force the intended size here BEFORE showing — idempotent when correct.
    const wasMax = mainWindow.isMaximized()
    if (wasMax) mainWindow.unmaximize()
    const b = mainWindow.getBounds()
    // >8px slop absorbs the frameless border delta; real breakage is 100s of px.
    if (wasMax || Math.abs(b.width - winW) > 8 || Math.abs(b.height - winH) > 8) {
      console.error(`[win] correcting boot size ${b.width}x${b.height} → ${winW}x${winH} (maximized=${wasMax})`)
      mainWindow.setSize(winW, winH)
    }
    mainWindow.show()
  })

  let boundsTimer: NodeJS.Timeout | null = null
  const saveBounds = (): void => {
    if (boundsTimer) clearTimeout(boundsTimer)
    boundsTimer = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isMinimized()) {
        void patchSettings({ windowBounds: mainWindow.getBounds() })
      }
    }, 500)
  }
  mainWindow.on('resize', saveBounds)
  mainWindow.on('move', saveBounds)

  mainWindow.on('closed', () => {
    mainWindow = null
    // The player is gone; headless pop-outs make no sense.
    for (const w of popouts.values()) if (!w.isDestroyed()) w.close()
  })

  mainWindow.webContents.setWindowOpenHandler(({ frameName }) => {
    // Addon-owned windows (stems viewer, settings, …): any 'ampwin-addon-*'
    // frame name is allowed with a standard resizable frame. Addons are
    // user-installed and already run with the full API, so this grants
    // nothing new — it just lets them present UI.
    const opts = POPOUT_OPTS[frameName] ?? (frameName.startsWith('ampwin-addon-')
      ? { width: 760, height: 600, minWidth: 420, minHeight: 300 }
      : null)
    if (opts) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          ...opts,
          frame: false,
          backgroundColor: '#000000',
          webPreferences: { backgroundThrottling: false }
        }
      }
    }
    return { action: 'deny' }
  })

  mainWindow.webContents.on('did-create-window', (child, details) => {
    if (POPOUT_OPTS[details.frameName]) {
      popouts.set(details.frameName, child)
      child.setMenuBarVisibility(false)
      child.on('closed', () => {
        if (popouts.get(details.frameName) === child) popouts.delete(details.frameName)
      })
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}
