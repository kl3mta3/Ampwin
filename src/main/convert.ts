// Right-click ▸ Convert: re-encode a local file to a chosen format via the
// bundled ffmpeg, saving into <userData>/downloads/Converted. Reuses the
// runFfmpegJob pipeline (progress, dedup, cancel).

import { app } from 'electron'
import { existsSync, promises as fsp } from 'fs'
import { basename, extname, join } from 'path'
import { runFfmpegJob } from './ffmpeg/transcoder'
import { ffprobeDuration } from './ffmpeg/probe'
import { assertFfmpegAvailable } from './ffmpeg/paths'

interface ConvertFormat {
  id: string
  label: string
  ext: string
  args: string[]
}

// Curated set of common targets (ffmpeg supports far more, but these cover
// virtually all real use). Audio formats double as "extract audio" for video.
// NOTE: output goes to <dest>.part while encoding, so ffmpeg can't infer the
// format from the extension — every preset must pass an explicit -f.
const AUDIO_FORMATS: ConvertFormat[] = [
  { id: 'mp3', label: 'MP3', ext: 'mp3', args: ['-vn', '-c:a', 'libmp3lame', '-q:a', '2', '-f', 'mp3'] },
  { id: 'm4a', label: 'M4A (AAC)', ext: 'm4a', args: ['-vn', '-c:a', 'aac', '-b:a', '256k', '-f', 'ipod'] },
  { id: 'flac', label: 'FLAC (lossless)', ext: 'flac', args: ['-vn', '-c:a', 'flac', '-f', 'flac'] },
  { id: 'wav', label: 'WAV (lossless)', ext: 'wav', args: ['-vn', '-c:a', 'pcm_s16le', '-f', 'wav'] },
  { id: 'ogg', label: 'OGG (Vorbis)', ext: 'ogg', args: ['-vn', '-c:a', 'libvorbis', '-q:a', '5', '-f', 'ogg'] },
  { id: 'opus', label: 'Opus', ext: 'opus', args: ['-vn', '-c:a', 'libopus', '-b:a', '160k', '-f', 'opus'] }
]

const VIDEO_FORMATS: ConvertFormat[] = [
  {
    id: 'mp4',
    label: 'MP4 (H.264 / AAC)',
    ext: 'mp4',
    args: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-f', 'mp4']
  },
  {
    id: 'webm',
    label: 'WebM (VP9 / Opus)',
    ext: 'webm',
    args: ['-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-row-mt', '1', '-c:a', 'libopus', '-b:a', '160k', '-f', 'webm']
  },
  {
    id: 'mkv',
    label: 'MKV (H.264 / AAC)',
    ext: 'mkv',
    args: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-c:a', 'aac', '-b:a', '192k', '-f', 'matroska']
  },
  {
    id: 'mov',
    label: 'MOV (H.264 / AAC)',
    ext: 'mov',
    args: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-f', 'mov']
  },
  {
    id: 'gif',
    label: 'Animated GIF (no audio)',
    ext: 'gif',
    args: ['-vf', 'fps=12,scale=480:-1:flags=lanczos', '-an', '-f', 'gif']
  }
]

/** Options for the convert dropdown, filtered to the source's type. Video
 *  sources also get the audio formats as "Audio only — …". */
export function convertFormats(isVideo: boolean): { id: string; label: string }[] {
  if (!isVideo) return AUDIO_FORMATS.map((f) => ({ id: f.id, label: f.label }))
  return [
    ...VIDEO_FORMATS.map((f) => ({ id: f.id, label: f.label })),
    ...AUDIO_FORMATS.map((f) => ({ id: f.id, label: `Audio only — ${f.label}` }))
  ]
}

function findFormat(id: string): ConvertFormat | undefined {
  return [...VIDEO_FORMATS, ...AUDIO_FORMATS].find((f) => f.id === id)
}

export function convertedDir(): string {
  return join(app.getPath('userData'), 'downloads', 'Converted')
}

export async function convertFile(
  srcPath: string,
  formatId: string,
  onProgress: (percent: number) => void
): Promise<string> {
  const fmt = findFormat(formatId)
  if (!fmt) throw new Error(`unknown format: ${formatId}`)
  assertFfmpegAvailable()
  await fsp.mkdir(convertedDir(), { recursive: true })

  const base = basename(srcPath, extname(srcPath))
  let dest = join(convertedDir(), `${base}.${fmt.ext}`)
  for (let n = 1; existsSync(dest); n++) {
    dest = join(convertedDir(), `${base} (${n}).${fmt.ext}`)
  }

  const dur = await ffprobeDuration(srcPath)
  const { promise } = runFfmpegJob({
    src: srcPath,
    dest,
    outputArgs: fmt.args,
    durationSec: dur,
    onProgress: (p) => onProgress(Math.round(p))
  })
  await promise
  return dest
}
