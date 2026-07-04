import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { EventChannel, InvokeChannel, IpcEventMap, IpcInvokeMap } from '../shared/ipc'
import type { AmpwinNative } from '../shared/native-api'

// Shell-only native bridge. Skins never see this object; they get the
// higher-level `window.ampwin` facade built by the renderer shell.

function invoke<K extends InvokeChannel>(
  channel: K,
  ...args: IpcInvokeMap[K]['args']
): Promise<IpcInvokeMap[K]['result']> {
  return ipcRenderer.invoke(channel, ...args)
}

function on<K extends EventChannel>(
  channel: K,
  callback: (payload: IpcEventMap[K]) => void
): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: IpcEventMap[K]): void =>
    callback(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const ampwinNative: AmpwinNative = {
  invoke,
  on,
  flushSession: (state) => {
    ipcRenderer.send('session:flush', state)
  },
  /** Absolute path for a dropped File (File.path no longer exists in Electron). */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  /** Set only when launched with AMPWIN_SELFTEST=<media path>; triggers the dev self-test. */
  selftestPath: process.env['AMPWIN_SELFTEST'] ?? null,
  /** Set with AMPWIN_DEMO=<media path> to auto-load+play a file on boot (dev aid). */
  demoPath: process.env['AMPWIN_DEMO'] ?? null,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  }
}

contextBridge.exposeInMainWorld('ampwinNative', ampwinNative)
