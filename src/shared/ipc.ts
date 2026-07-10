// Single source of truth for IPC: channel names + request/response types.
// Preload builds typed invoke wrappers from IpcInvokeMap; main registers
// handlers against it; IpcEventMap covers main -> renderer pushes.

import type {
  AddonInfo,
  ImportedPlaylist,
  LyricLine,
  Lyrics,
  StemModelPack,
  StemsProgress,
  StemsResult,
  LinkProbe,
  Playlist,
  PlaylistMeta,
  PrepareResult,
  PresetInfo,
  SessionState,
  Settings,
  SkinInfo,
  SkinWindowSpec,
  TrackProbe,
  YtSearchResult,
  HttpRequestOptions,
  HttpResponse
} from './types'

export type DialogFilterKind = 'media' | 'audio' | 'video' | 'playlist' | 'preset'

export interface FileFilter {
  name: string
  extensions: string[]
}

export interface IpcInvokeMap {
  'dialog:open-files': { args: [kind?: DialogFilterKind]; result: string[] }
  'dialog:open-folder': { args: []; result: string | null }
  'dialog:save-file': {
    args: [opts: { defaultName: string; filters: FileFilter[] }]
    result: string | null
  }

  'media:probe': { args: [paths: string[]]; result: TrackProbe[] }
  'media:prepare': {
    args: [path: string, opts?: { forceTranscode?: boolean }]
    result: PrepareResult
  }
  'media:cancel-prepare': { args: [path: string]; result: void }
  'media:artwork': { args: [path: string]; result: string | null }
  'scan:folder': { args: [path: string]; result: string[] }

  'store:settings:get': { args: []; result: Settings }
  'store:settings:patch': { args: [partial: Partial<Settings>]; result: Settings }
  'store:session:get': { args: []; result: SessionState | null }
  'store:session:save': { args: [state: SessionState]; result: void }
  'store:playlists:list': { args: []; result: PlaylistMeta[] }
  'store:playlists:get': { args: [id: string]; result: Playlist }
  'store:playlists:save': { args: [pl: Playlist]; result: void }
  'store:playlists:delete': { args: [id: string]; result: void }

  'playlist:import': { args: [path: string]; result: ImportedPlaylist }
  'playlist:export': {
    args: [pl: Playlist, target: string, fmt: 'm3u8' | 'm3u', relativePaths: boolean]
    result: void
  }

  'skins:list': { args: []; result: SkinInfo[] }
  'skins:read-entry': { args: [id: string]; result: { html: string; baseUrl: string } }
  'skins:open-folder': { args: []; result: void }

  'presets:list-user': { args: []; result: PresetInfo[] }
  'presets:read': { args: [id: string]; result: unknown }
  'presets:import-files': { args: [paths: string[]]; result: PresetInfo[] }

  // ---- stems (HTDemucs separation; used by the demucs addons) --------------
  /** Are all of a pack's model files already downloaded? */
  'stems:model-installed': { args: [pack: StemModelPack]; result: boolean }
  /** Separate a local file into stems (downloads models on first use; emits
   *  evt:stems-progress keyed by jobKey). Serialized app-wide. */
  'stems:separate': {
    args: [srcPath: string, pack: StemModelPack, opts: { useGpu: boolean; force: boolean; jobKey: string }]
    result: StemsResult
  }
  'stems:cancel': { args: [jobKey: string]; result: void }
  /** Encode a cached stem WAV into downloads/<folder>/<song>/<stem>.<format>
   *  (folder defaults to 'Stems'; karaokefy passes 'Karaoke'). */
  'stems:export': {
    args: [wavPath: string, format: 'wav' | 'flac' | 'mp3', songName: string, stemName: string, folder?: string]
    result: { path: string }
  }
  'stems:open-folder': { args: [folder?: string]; result: void }
  /** Mix WAV stems into one instrumental WAV beside them (karaokefy). */
  'stems:mix': { args: [wavPaths: string[], outName: string]; result: { path: string; url: string } }

  // ---- lyrics --------------------------------------------------------------
  /** Write an .lrc sidecar next to an audio file (same basename). Karaokefy uses
   *  it for the karaoke file it exported into the app's downloads folder. */
  'lyrics:write-sidecar': { args: [filePath: string, lines: LyricLine[]]; result: { path: string } }
  /** Fetch human-made synced lyrics from LRCLIB (cached in userData). null on miss. */
  'lyrics:fetch-online': {
    args: [q: { artist?: string; title: string; album?: string; durationSec?: number }]
    result: Lyrics | null
  }

 // ---- trusted addon/skin networking --------------------------------------
  /** Main-process HTTP(S), unaffected by renderer CSP/CORS. */
  'network:request': { args: [options: HttpRequestOptions]; result: HttpResponse }

  // ---- addons --------------------------------------------------------------
  /** Installed addons only (no network) — the boot loader reads this. */
  'addons:list': { args: []; result: AddonInfo[] }
  /** Merged repo catalog + installed state for the Addons browser. */
  'addons:catalog': { args: []; result: { addons: AddonInfo[]; catalogError?: string } }
  /** Download + install an addon by id; emits evt:addon-progress. */
  'addons:install': { args: [id: string]; result: AddonInfo }
  'addons:uninstall': { args: [id: string]; result: void }
  'addons:set-enabled': { args: [id: string, enabled: boolean]; result: void }
  'addons:open-folder': { args: []; result: void }

  /** Constrain (and optionally resize) the window per the incoming skin's
   *  manifest. includeSize=false on boot so restored bounds win. */
  'window:apply-skin-spec': { args: [spec: SkinWindowSpec, includeSize: boolean]; result: void }
  /** Minimize a same-process pop-out window by its frame name. */
  'popout:minimize': { args: [frameName: string]; result: void }
  /** F12 — skin authors need to inspect their documents. */
  'window:toggle-devtools': { args: []; result: void }
  'window:minimize': { args: []; result: void }
  'window:close': { args: []; result: void }
  'window:set-size': { args: [width: number, height: number]; result: void }
  'window:set-always-on-top': { args: [on: boolean]; result: void }
  'window:set-fullscreen': { args: [on: boolean]; result: void }

  /** Is this video Chromium-playable as-is, and how long is it? */
  'media:video-plan': { args: [path: string]; result: { direct: boolean; durationSec: number } }

  /** Progressive video streaming: ffmpeg → fragmented MP4 → MSE. Playback
   *  starts instantly; conversion stays ~60s ahead of the playhead via
   *  pipe backpressure. Seeks restart the stream at the target time. */
  'vstream:start': {
    args: [path: string, startSec: number]
    result: { sessionId: number; mime: string; durationSec: number }
  }
  'vstream:stop': { args: [sessionId: number]; result: void }
  'vstream:feed': { args: [sessionId: number, ctl: 'pause' | 'resume']; result: void }

  // ---- links / YouTube -----------------------------------------------------
  /** Is yt-dlp already downloaded? */
  'ytdlp:status': { args: []; result: { installed: boolean } }
  /** Download yt-dlp if missing (emits evt:ytdlp-progress). */
  'ytdlp:ensure': { args: []; result: { ok: boolean; error?: string } }
  /** Add-time: fetch title/duration for a URL (yt-dlp for sites, ffprobe for direct). */
  'link:probe': { args: [url: string, audioOnly: boolean]; result: LinkProbe }
  /** Play-time: resolve a fresh direct stream URL (site links expire). */
  'link:resolve': {
    args: [url: string, audioOnly: boolean]
    result: { streamUrl: string; isVideo: boolean }
  }
  'yt:search': { args: [query: string]; result: YtSearchResult[] }
  /** Expand a playlist/mix/radio URL into its entries (flat, capped). */
  'link:expand-playlist': { args: [url: string]; result: YtSearchResult[] }
  /** Download a URL to the downloads folder; emits evt:download-progress. */
  'link:download': {
    args: [url: string, kind: 'audio' | 'video' | 'both']
    result: { path: string }
  }
  'downloads:open-folder': { args: []; result: void }

  // ---- convert (right-click a local file) ----------------------------------
  'convert:list': { args: [isVideo: boolean]; result: { id: string; label: string }[] }
  /** Convert a local file to a format; emits evt:convert-progress. */
  'convert:start': { args: [srcPath: string, formatId: string]; result: { path: string } }
  'convert:open-folder': { args: []; result: void }
  /** Open a YouTube sign-in window; resolves signed-in state on close. */
  'yt:signin': { args: []; result: { signedIn: boolean } }
  'yt:signed-in': { args: []; result: boolean }
  'yt:sign-out': { args: []; result: void }

  /** Dev aid: surface renderer messages in the main-process stdout. */
  'dev:log': { args: [message: string]; result: void }
}

export type MediaKey = 'play-pause' | 'next' | 'prev' | 'stop'

export interface IpcEventMap {
  'evt:prepare-progress': { path: string; percent: number }
  'evt:os-open-files': { paths: string[] }
  'evt:media-key': MediaKey
  'evt:vstream-data': { sessionId: number; chunk: Uint8Array }
  'evt:vstream-end': { sessionId: number }
  'evt:vstream-error': { sessionId: number; message: string }
  'evt:ytdlp-progress': { percent: number }
  'evt:download-progress': { url: string; percent: number; phase: string }
  'evt:convert-progress': { srcPath: string; percent: number }
  'evt:addon-progress': { id: string; percent: number }
  'evt:stems-progress': { jobKey: string; progress: StemsProgress }
}

export type InvokeChannel = keyof IpcInvokeMap
export type EventChannel = keyof IpcEventMap
