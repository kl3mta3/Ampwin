// File-extension tables. These are only a *pre-filter* — the real
// native-vs-transcode decision is made per-file from codec info in
// src/main/metadata.ts (an .m4a can hide ALAC, an .ogg can hide Speex).

/** Chromium can usually decode these containers natively. */
export const NATIVE_AUDIO_EXTS = [
  'mp3', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus', 'wav', 'weba'
]

/** Playable only via the ffmpeg transcode path. */
export const TRANSCODE_AUDIO_EXTS = [
  'wma', 'ape', 'wv', 'tta', 'mpc', 'dsf', 'dff', 'shn', 'aiff', 'aif',
  'mka', 'ac3', 'dts', 'spx', 'tak', 'au', 'caf', 'w64', 'amr'
]

export const AUDIO_EXTS = [...NATIVE_AUDIO_EXTS, ...TRANSCODE_AUDIO_EXTS]

export const VIDEO_EXTS = [
  'mp4', 'm4v', 'webm', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'ts', 'm2ts',
  'mpg', 'mpeg', '3gp', 'ogv'
]

export const MEDIA_EXTS = [...AUDIO_EXTS, ...VIDEO_EXTS]

export const PLAYLIST_EXTS = ['m3u', 'm3u8', 'pls']

export const PRESET_EXTS = ['json', 'milk']

export function extOf(path: string): string {
  const i = path.lastIndexOf('.')
  return i < 0 ? '' : path.slice(i + 1).toLowerCase()
}

export function isVideoPath(path: string): boolean {
  return VIDEO_EXTS.includes(extOf(path))
}
