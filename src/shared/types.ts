// Data model shared by main, preload, and renderer.

export type RepeatMode = 'off' | 'all' | 'one'
export type PlayState = 'idle' | 'loading' | 'playing' | 'paused'
export type Verdict = 'native' | 'transcode' | 'unsupported'

export interface Track {
  id: string
  /** Local absolute path, or an http(s) URL for a remote/link track. */
  path: string
  title: string
  artist: string
  album: string
  durationSec: number
  codec: string
  verdict: 'native' | 'transcode'
  isVideo: boolean
  mtimeMs: number
  /** File not found at last check; kept in playlists but greyed out and skipped. */
  missing?: boolean
  /** Exists but couldn't be read/decoded (e.g. corrupt MP4 missing its moov atom). */
  unreadable?: boolean
  /** path is a URL resolved fresh on each play (YouTube links expire). */
  isRemote?: boolean
  /** For remote tracks: user asked for audio only (a video link played as audio). */
  audioOnly?: boolean
}

export interface LinkProbe {
  ok: boolean
  error?: string
  title: string
  durationSec: number
  isVideo: boolean
  uploader?: string
  /** True when this needs yt-dlp (a site link), false for a direct media URL. */
  needsYtDlp: boolean
}

export interface YtSearchResult {
  url: string
  title: string
  durationSec: number
  uploader: string
  thumbnail: string
}

export interface TrackProbe {
  path: string
  ok: boolean
  error?: string
  /** File exists on disk but couldn't be decoded (vs. truly missing). */
  unreadable?: boolean
  title: string
  artist: string
  album: string
  durationSec: number
  codec: string
  verdict: Verdict
  isVideo: boolean
  mtimeMs: number
}

export interface Playlist {
  id: string
  name: string
  tracks: Track[]
  createdAt: number
  updatedAt: number
}

export interface PlaylistMeta {
  id: string
  name: string
  trackCount: number
  updatedAt: number
}

/** Result of parsing an .m3u/.m3u8/.pls file, before probing fills real metadata. */
export interface ImportedPlaylist {
  name: string
  entries: ImportedEntry[]
  /** http(s) lines skipped in v1 (internet radio is phase 2). */
  skippedUrls: string[]
}

export interface ImportedEntry {
  path: string
  /** From #EXTINF / TitleN, used as placeholder until probe completes. */
  title?: string
  durationSec?: number
  missing: boolean
}

export interface PrepareResult {
  /** ampwin://media/... URL ready to assign to an <audio>/<video> element. */
  url: string
  transcoded: boolean
}

export interface SkinWindowSpec {
  width: number
  height: number
  minWidth?: number
  minHeight?: number
  resizable?: boolean
}

export interface SkinInfo {
  id: string
  name: string
  author: string
  version: string
  apiVersion: number
  entry: string
  window: SkinWindowSpec
  features: string[]
  source: 'bundled' | 'user'
}

// ---- addons ----------------------------------------------------------------
// An addon is a folder (addon.json manifest + JS) distributed from a GitHub
// repo. Installed addons live in userData/addons/<id>/ and, when enabled, load
// into a hidden iframe with the full window.ampwin API (like a skin).

/** An addon as listed in a repo's index.json. */
export interface AddonCatalogEntry {
  id: string
  name: string
  version: string
  description: string
  author: string
  /** Entry JS file, relative to the addon folder (default 'main.js'). */
  entry?: string
  /** Files to download when installing (relative paths), e.g. ['addon.json','main.js']. */
  files: string[]
}

/** Merged view for the Addons UI + the boot-time loader. */
export interface AddonInfo {
  id: string
  name: string
  version: string
  description: string
  author: string
  entry: string
  installed: boolean
  enabled: boolean
  /** Newer version available in the repo than the installed one. */
  updateAvailable?: boolean
}

export interface PresetInfo {
  id: string
  name: string
  source: 'bundled' | 'user'
}

export interface VizCycleOptions {
  enabled: boolean
  intervalSec: number
  random: boolean
}

export interface Settings {
  volume: number
  muted: boolean
  shuffle: boolean
  repeat: RepeatMode
  activeSkin: string
  activeVisualizer: string
  vizPresetId: string | null
  vizCycle: VizCycleOptions
  windowBounds: { x: number; y: number; width: number; height: number } | null
  cacheMaxBytes: number
  /** Crash-loop guard: forced back to default skin after 2 boot crashes. */
  bootFailures: number
  /** Ids of installed addons the user has turned on (loaded at boot). */
  enabledAddonIds: string[]
  /** GitHub repo the Addons browser installs from. */
  addonRepoUrl: string
}

export const DEFAULT_SETTINGS: Settings = {
  volume: 0.8,
  muted: false,
  shuffle: false,
  repeat: 'off',
  activeSkin: 'default',
  activeVisualizer: 'butterchurn',
  vizPresetId: null,
  vizCycle: { enabled: true, intervalSec: 25, random: true },
  windowBounds: null,
  // Video conversions are multi-GB; a small cap would thrash them out.
  cacheMaxBytes: 8 * 1024 * 1024 * 1024,
  bootFailures: 0,
  enabledAddonIds: [],
  addonRepoUrl: 'https://github.com/kl3mta3/Ampwin-Addons'
}

/** Auto-saved session: current playlist + position, restored on launch. */
export interface SessionState {
  tracks: Track[]
  currentIndex: number
  positionSec: number
}

export interface PlayerSnapshot {
  state: PlayState
  track: Track | null
  positionSec: number
  durationSec: number
  volume: number
  muted: boolean
  shuffle: boolean
  repeat: RepeatMode
  loadingPercent?: number
}
