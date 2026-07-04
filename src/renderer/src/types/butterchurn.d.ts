// Hand-written declarations — butterchurn ships no types. Both packages are
// UMD bundles; Vite's CJS interop may put exports on the default or on the
// namespace, so consumers access them defensively.

declare module 'butterchurn' {
  export interface ButterchurnVisualizer {
    connectAudio(node: AudioNode): void
    disconnectAudio(node: AudioNode): void
    loadPreset(preset: object, blendTimeSec?: number): void
    setRendererSize(width: number, height: number): void
    render(): void
    launchSongTitleAnim(title: string): void
  }

  export interface ButterchurnStatic {
    createVisualizer(
      audioContext: AudioContext,
      canvas: HTMLCanvasElement,
      options: {
        width: number
        height: number
        pixelRatio?: number
        textureRatio?: number
      }
    ): ButterchurnVisualizer
  }

  const butterchurn: ButterchurnStatic & { default?: ButterchurnStatic }
  export default butterchurn
}

declare module 'butterchurn-presets' {
  export interface PresetPack {
    getPresets(): Record<string, object>
  }
  const pack: PresetPack & { default?: PresetPack }
  export default pack
}

declare module 'butterchurn-presets/lib/butterchurnPresetsExtra.min.js' {
  import type { PresetPack } from 'butterchurn-presets'
  const pack: PresetPack & { default?: PresetPack }
  export default pack
}
