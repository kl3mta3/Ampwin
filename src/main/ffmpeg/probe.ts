import { execFile } from 'child_process'
import { extOf } from '../../shared/formats'
import { ffprobePath } from './paths'

/** Duration via ffprobe, for exotic formats music-metadata can't parse. */
export function ffprobeDuration(path: string): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      ffprobePath(),
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', path],
      { timeout: 15000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve(null)
          return
        }
        try {
          const parsed = JSON.parse(stdout) as { format?: { duration?: string } }
          const dur = parseFloat(parsed.format?.duration ?? '')
          resolve(isFinite(dur) && dur > 0 ? dur : null)
        } catch {
          resolve(null)
        }
      }
    )
  })
}

// ---- video stream probing + playback planning ------------------------------
// Real-world video (WEBRip MKVs etc.) routinely mixes Chromium-playable video
// (H.264) with audio Chromium cannot decode (AC3/DTS/EAC3), in containers it
// won't open (MKV/AVI). We probe the actual codecs and pick the cheapest
// ffmpeg path that yields a Chromium-playable MP4.

export interface VideoStreams {
  videoCodec: string | null
  audioCodec: string | null
  durationSec: number
}

export function ffprobeStreams(path: string): Promise<VideoStreams | null> {
  return new Promise((resolve) => {
    execFile(
      ffprobePath(),
      [
        '-v', 'error',
        '-show_entries', 'stream=codec_type,codec_name',
        '-show_entries', 'format=duration',
        '-of', 'json',
        path
      ],
      { timeout: 20000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve(null)
          return
        }
        try {
          const parsed = JSON.parse(stdout) as {
            streams?: { codec_type?: string; codec_name?: string }[]
            format?: { duration?: string }
          }
          const video = parsed.streams?.find((s) => s.codec_type === 'video')
          const audio = parsed.streams?.find((s) => s.codec_type === 'audio')
          const dur = parseFloat(parsed.format?.duration ?? '')
          resolve({
            videoCodec: video?.codec_name ?? null,
            audioCodec: audio?.codec_name ?? null,
            durationSec: isFinite(dur) && dur > 0 ? dur : 0
          })
        } catch {
          resolve(null)
        }
      }
    )
  })
}

const CHROMIUM_VIDEO = ['h264', 'vp8', 'vp9', 'av1']
const CHROMIUM_AUDIO = ['aac', 'mp3', 'opus', 'vorbis', 'flac']
const CHROMIUM_VIDEO_CONTAINERS = ['mp4', 'm4v', 'webm']

export type VideoPlanKind =
  | 'direct' // Chromium plays the file as-is
  | 'remux' // compatible codecs, wrong container — stream-copy to MP4 (seconds)
  | 'audio' // compatible video, bad audio (AC3/DTS...) — copy video, encode audio (fast)
  | 'full' // incompatible video codec — full re-encode (slow, cached)

export interface VideoPlan {
  kind: VideoPlanKind
  streams: VideoStreams
}

export async function videoPlanFor(path: string): Promise<VideoPlan | null> {
  const streams = await ffprobeStreams(path)
  if (!streams || !streams.videoCodec) return null
  const videoOk = CHROMIUM_VIDEO.includes(streams.videoCodec)
  const audioOk = streams.audioCodec === null || CHROMIUM_AUDIO.includes(streams.audioCodec)
  const containerOk = CHROMIUM_VIDEO_CONTAINERS.includes(extOf(path))
  let kind: VideoPlanKind
  if (videoOk && audioOk && containerOk) kind = 'direct'
  else if (videoOk && audioOk) kind = 'remux'
  else if (videoOk) kind = 'audio'
  else kind = 'full'
  return { kind, streams }
}

/** ffmpeg output args (between -i and the destination) for a video plan.
 *  Keeps first video + first audio stream; subtitles/data can't ride in MP4. */
export function videoPlanArgs(kind: Exclude<VideoPlanKind, 'direct'>): string[] {
  const base = ['-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-movflags', '+faststart']
  switch (kind) {
    case 'remux':
      return [...base, '-c:v', 'copy', '-c:a', 'copy', '-f', 'mp4']
    case 'audio':
      return [...base, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-f', 'mp4']
    case 'full':
      return [
        ...base,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
        '-f', 'mp4'
      ]
  }
}
