// Shape of the preload bridge (window.ampwinNative). Lives in shared/ so
// the renderer can type it without importing the preload project.
// Shell-only: skins never see this; they get the window.ampwin facade.

import type { EventChannel, InvokeChannel, IpcEventMap, IpcInvokeMap } from './ipc'
import type { SessionState } from './types'

export interface AmpwinNative {
  /** Synchronous fire-and-forget session save for beforeunload. */
  flushSession(state: SessionState): void

  invoke<K extends InvokeChannel>(
    channel: K,
    ...args: IpcInvokeMap[K]['args']
  ): Promise<IpcInvokeMap[K]['result']>

  /** Subscribe to a main-process push event; returns unsubscribe. */
  on<K extends EventChannel>(channel: K, callback: (payload: IpcEventMap[K]) => void): () => void

  /** Absolute path for a dropped File (File.path no longer exists in Electron). */
  pathForFile(file: File): string

  /** Set only when launched with AMPWIN_SELFTEST=<media path>; triggers the dev self-test. */
  selftestPath: string | null

  /** Set with AMPWIN_DEMO=<media path> to auto-load+play a file on boot (dev aid). */
  demoPath: string | null

  versions: { electron: string; chrome: string; node: string }
}
