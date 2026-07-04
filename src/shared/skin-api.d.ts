// ===========================================================================
// window.ampwin — the complete API surface available to Ampwin skins.
//
// A skin is a folder with a skin.json manifest and an entry HTML file. The
// entry document is loaded into the player with `window.ampwin` already
// available before any skin script runs. Call `ampwin.ready()` once your UI
// is initialized — skins that don't call it within 5 seconds are rejected
// and the player reverts to the default skin.
//
// This file is the contract. The default skin (skins/default/) is the
// reference implementation and uses nothing beyond what is declared here.
// ===========================================================================

import type {
  AddonInfo,
  PlayerSnapshot,
  PlayState,
  PresetInfo,
  RepeatMode,
  SkinInfo,
  Track,
  YtSearchResult
} from './types'

export type Unsubscribe = () => void

/** Third-party visualizer: register via ampwin.visualizer.registerPlugin().
 *  Lifetime is tied to the skin instance that registered it. */
export interface VisualizerPlugin {
  /** Unique id; 'butterchurn' and 'bars' are reserved by built-ins. */
  id: string
  name: string
  init(ctx: {
    canvas: HTMLCanvasElement
    audioContext: AudioContext
    /** The visualizer audio source — connect your own analysers here. Its input
     *  is whatever is being visualized: Ampwin's own playback, or (in System
     *  audio mode) the whole system's output. Swaps are transparent to you. */
    sourceNode: AudioNode
    /** Convenience shared analyser tap (fftSize 2048). */
    analyser: AnalyserNode
  }): void | Promise<void>
  /** Called once per animation frame while this plugin is active. */
  render(frame: { elapsedMs: number; frameCount: number }): void
  resize(width: number, height: number): void
  /** Disconnect any nodes you connected in init(). */
  destroy(): void
}

export interface AmpwinApi {
  readonly apiVersion: 1

  /** REQUIRED handshake — call once your skin has finished initializing. */
  ready(): void

  player: {
    play(): void
    pause(): void
    stop(): void
    togglePlay(): void
    next(): void
    previous(): void
    seek(seconds: number): void
    /** 0..1 */
    setVolume(v: number): void
    setMuted(m: boolean): void
    setShuffle(on: boolean): void
    setRepeat(mode: RepeatMode): void
    getSnapshot(): PlayerSnapshot
    on(ev: 'state', cb: (s: PlayState) => void): Unsubscribe
    on(ev: 'track', cb: (t: Track | null) => void): Unsubscribe
    /** ~4 Hz while playing. */
    on(ev: 'position', cb: (posSec: number, durSec: number) => void): Unsubscribe
    on(ev: 'volume', cb: (v: number, muted: boolean) => void): Unsubscribe
    on(ev: 'mode', cb: (shuffle: boolean, repeat: RepeatMode) => void): Unsubscribe
    on(ev: 'error', cb: (message: string, track: Track | null) => void): Unsubscribe
  }

  playlist: {
    getTracks(): Track[]
    getCurrentIndex(): number
    playIndex(i: number): void
    /** Probes the files and appends (or inserts) them; returns created tracks. */
    addPaths(paths: string[], atIndex?: number): Promise<Track[]>
    removeIndices(indices: number[]): void
    move(from: number, to: number): void
    clear(): void
    /** Queue-jump: play this index after the current track. */
    queueNext(index: number): void
    /** Open (or focus) the playlist in a separate resizable window. */
    popOut(): void
    on(ev: 'changed', cb: (tracks: Track[], currentIndex: number) => void): Unsubscribe
    saved: {
      list(): Promise<{ id: string; name: string; trackCount: number }[]>
      /** Replaces the current playlist. */
      load(id: string): Promise<void>
      saveCurrentAs(name: string): Promise<string>
      delete(id: string): Promise<void>
      /** File dialog → .m3u/.m3u8/.pls import. */
      importFromFile(): Promise<void>
      exportToFile(fmt?: 'm3u8' | 'm3u'): Promise<void>
    }
  }

  files: {
    /** Multi-select audio file dialog; resolves to absolute paths ([] on cancel). */
    openFilesDialog(): Promise<string[]>
    /** Folder dialog; resolves to the media files found inside (recursive). */
    openFolderDialog(): Promise<string[]>
    /** ampwin:// URL usable directly as <img src>, or null if no embedded art. */
    getArtworkUrl(track: Track): Promise<string | null>
    /** Absolute path for a File dropped onto the skin document. */
    pathForDroppedFile(file: File): string
    /** Open paths the way the OS would: playlist files replace the current
     *  playlist; media files append (and start playing if idle). */
    openPaths(paths: string[]): Promise<void>
  }

  visualizer: {
    /** Mount the visualizer onto a canvas owned by the skin document. */
    attach(canvas: HTMLCanvasElement): Promise<void>
    detach(): void
    listPresets(): PresetInfo[]
    loadPreset(id: string, blendSec?: number): void
    nextPreset(): void
    prevPreset(): void
    randomPreset(): void
    setCycle(opts: { enabled: boolean; intervalSec?: number; random?: boolean }): void
    /** File dialog → import Butterchurn .json presets into the user library. */
    importPresetFiles(): Promise<PresetInfo[]>
    setFullscreen(on: boolean): void
    /** Detach into a separate resizable window with transport buttons in its
     *  title bar. Closing it returns the visualizer to the skin's canvas. */
    popOut(): void
    getActiveVisualizerId(): string
    listVisualizers(): { id: string; name: string }[]
    setActiveVisualizer(id: string): void
    registerPlugin(plugin: VisualizerPlugin): void
    on(ev: 'preset', cb: (p: PresetInfo) => void): Unsubscribe
    /** The available visualizers changed (an addon registered or was removed) —
     *  refresh any visualizer picker. */
    on(ev: 'visualizers', cb: (list: { id: string; name: string }[]) => void): Unsubscribe
  }

  window: {
    minimize(): void
    close(): void
    /** Declare an element as a window-drag handle. Interactive children that
     *  must stay clickable go in opts.exclude. Returns an unsubscriber. */
    setDragRegion(el: HTMLElement, opts?: { exclude?: HTMLElement[] }): Unsubscribe
    setSize(width: number, height: number): void
    setAlwaysOnTop(on: boolean): void
  }

  skins: {
    list(): Promise<SkinInfo[]>
    getActiveId(): string
    /** Hot-swap: audio keeps playing across the switch. */
    setActive(id: string): Promise<void>
    /** Open the user skins folder in Explorer. */
    openSkinsFolder(): void
  }

  /** System-audio visualizer mode: drive the visualizer from the computer's
   *  entire audio output (WASAPI loopback) instead of Ampwin's own playback —
   *  so it reacts to Spotify, a browser, a game, anything. Enabling pauses
   *  Ampwin's own playback; starting local playback (or a video) turns it back
   *  off. State is app-wide (survives skin switches) and not persisted. */
  system: {
    isEnabled(): boolean
    /** Begin capture. Must be called from a user gesture; rejects if the user
     *  cancels or loopback is unavailable. */
    enable(): Promise<void>
    disable(): void
    toggle(): Promise<void>
    on(ev: 'change', cb: (enabled: boolean) => void): Unsubscribe
  }

  /** Addons: user-installable extensions (a folder with addon.json + JS) from a
   *  GitHub repo. An enabled addon loads with this same full API and can, e.g.,
   *  register visualizer plugins that persist across skin switches. */
  addons: {
    /** Installed addons and their enabled state (no network). */
    list(): Promise<AddonInfo[]>
    /** Repo catalog merged with installed state; catalogError set if offline. */
    catalog(): Promise<{ addons: AddonInfo[]; catalogError?: string }>
    /** Download + install by id (does not enable). Listen via on('progress'). */
    install(id: string): Promise<AddonInfo>
    /** Enable/disable: loads or unloads the addon immediately. */
    setEnabled(id: string, enabled: boolean): Promise<void>
    uninstall(id: string): Promise<void>
    openFolder(): void
    /** Install progress (0–100) for a given addon id. */
    on(ev: 'progress', cb: (id: string, percent: number) => void): Unsubscribe
  }

  /** Convert a local file to another format via the bundled ffmpeg. Output
   *  goes to the downloads/Converted folder. */
  convert: {
    /** Format options for the source type (video sources include audio-only). */
    list(isVideo: boolean): Promise<{ id: string; label: string }[]>
    /** Convert; resolves to the saved file path, or rejects with the reason. */
    start(track: Track, formatId: string): Promise<string>
    openFolder(): void
    on(ev: 'progress', cb: (percent: number) => void): Unsubscribe
  }

  /** Remote sources: paste a URL or search YouTube. YouTube needs yt-dlp,
   *  which downloads on first use. Links are added to the playlist like files
   *  and re-resolve on each play (URLs expire). */
  links: {
    /** Is yt-dlp already present (no download needed)? */
    ytdlpInstalled(): Promise<boolean>
    /** Download yt-dlp if missing. Listen via on('download', …). */
    ensureYtDlp(): Promise<{ ok: boolean; error?: string }>
    /** Add a URL as a remote track (audioOnly plays a video link as audio).
     *  Runs a yt-dlp probe to validate + fetch metadata; returns null on failure. */
    add(url: string, audioOnly: boolean): Promise<Track | null>
    /** Add a YouTube search result using its existing metadata — no extra probe,
     *  so it always adds (the stream resolves at play time). Prefer this for
     *  search results over add(result.url). */
    addSearchResult(result: YtSearchResult, audioOnly: boolean): Track
    /** Expand a playlist / mix / radio URL (a link with a `list=` param) and add
     *  every entry (capped). Returns the added tracks; rejects with a reason. */
    addPlaylist(url: string, audioOnly: boolean): Promise<Track[]>
    /** Download a remote track to the downloads folder + add the local file
     *  to the playlist. 'both' merges best video+audio (full quality). */
    download(track: Track, kind: 'audio' | 'video' | 'both'): Promise<Track | null>
    openDownloadsFolder(): void
    /** Search YouTube (downloads yt-dlp on first use). */
    search(query: string): Promise<YtSearchResult[]>
    signInYouTube(): Promise<{ signedIn: boolean }>
    isYouTubeSignedIn(): Promise<boolean>
    signOutYouTube(): Promise<void>
    /** yt-dlp helper download progress (0–100). */
    on(ev: 'download', cb: (percent: number) => void): Unsubscribe
    /** Media file download progress. */
    on(ev: 'fileProgress', cb: (info: { percent: number; phase: string }) => void): Unsubscribe
  }
}

declare global {
  interface Window {
    /** Available synchronously before any skin script executes. */
    ampwin: AmpwinApi
  }
}
