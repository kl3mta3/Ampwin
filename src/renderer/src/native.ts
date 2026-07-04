// Typed access to the preload bridge for shell code.
import type { AmpwinNative } from '../../shared/native-api'

declare global {
  interface Window {
    ampwinNative: AmpwinNative
  }
}

export const native: AmpwinNative = window.ampwinNative
