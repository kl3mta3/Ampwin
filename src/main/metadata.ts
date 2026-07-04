import { promises as fsp } from 'fs'
import { basename } from 'path'
import { parseFile, selectCover } from 'music-metadata'
import type { TrackProbe, Verdict } from '../shared/types'
import { NATIVE_AUDIO_EXTS, extOf, isVideoPath } from '../shared/formats'
import { ffprobeDuration, videoPlanFor } from './ffmpeg/probe'

// Codec substrings Chromium cannot decode even when the container looks
// native (the .m4a/ALAC trap, .ogg/Speex, non-PCM .wav).
const NON_NATIVE_CODEC_MARKERS = ['alac', 'speex', 'adpcm', 'mulaw', 'alaw', 'gsm']

function verdictFor(path: string, codec: string | undefined, isVideo: boolean): Verdict {
  if (isVideo) return 'native' // real video verdicts come from probeVideoFile
  const ext = extOf(path)
  const codecLc = (codec ?? '').toLowerCase()
  if (NON_NATIVE_CODEC_MARKERS.some((marker) => codecLc.includes(marker))) return 'transcode'
  if (NATIVE_AUDIO_EXTS.includes(ext)) return 'native'
  return 'transcode'
}

export async function probeFile(path: string): Promise<TrackProbe> {
  const fallbackTitle = basename(path).replace(/\.[^.]+$/, '')
  const isVideo = isVideoPath(path)
  let mtimeMs = 0
  try {
    const stat = await fsp.stat(path)
    mtimeMs = stat.mtimeMs
  } catch (err) {
    return {
      path,
      ok: false,
      error: `file not accessible: ${(err as Error).message}`,
      title: fallbackTitle,
      artist: '',
      album: '',
      durationSec: 0,
      codec: '',
      verdict: 'unsupported',
      isVideo,
      mtimeMs: 0
    }
  }

  // Video: music-metadata is unreliable for MKV/AVI and knows nothing about
  // codec playability — ffprobe the streams and plan the playback route.
  if (isVideo) {
    const plan = await videoPlanFor(path)
    if (!plan) {
      // stat() above succeeded, so the file exists — it's corrupt/unreadable
      // (e.g. an incomplete download missing its moov atom), not missing.
      return {
        path,
        ok: false,
        unreadable: true,
        error: 'unreadable video file (corrupt or incomplete — ffprobe found no valid stream)',
        title: fallbackTitle,
        artist: '',
        album: '',
        durationSec: 0,
        codec: '',
        verdict: 'unsupported',
        isVideo: true,
        mtimeMs
      }
    }
    const codec = [plan.streams.videoCodec, plan.streams.audioCodec].filter(Boolean).join('/')
    return {
      path,
      ok: true,
      title: fallbackTitle,
      artist: '',
      album: '',
      durationSec: plan.streams.durationSec,
      codec,
      verdict: plan.kind === 'direct' ? 'native' : 'transcode',
      isVideo: true,
      mtimeMs
    }
  }

  try {
    const meta = await parseFile(path, { duration: true, skipCovers: true })
    const codec = meta.format.codec ?? meta.format.container ?? ''
    let durationSec = meta.format.duration ?? 0
    if (durationSec <= 0) durationSec = (await ffprobeDuration(path)) ?? 0
    return {
      path,
      ok: true,
      title: meta.common.title || fallbackTitle,
      artist: meta.common.artist ?? '',
      album: meta.common.album ?? '',
      durationSec,
      codec,
      verdict: verdictFor(path, codec, isVideo),
      isVideo,
      mtimeMs
    }
  } catch {
    // music-metadata couldn't parse it (some exotic formats); ffmpeg may
    // still decode it, so fall back to ffprobe for the duration.
    return {
      path,
      ok: true,
      title: fallbackTitle,
      artist: '',
      album: '',
      durationSec: (await ffprobeDuration(path)) ?? 0,
      codec: '',
      verdict: isVideo ? 'native' : 'transcode',
      isVideo,
      mtimeMs
    }
  }
}

// ---- embedded album art -----------------------------------------------

export interface ArtEntry {
  data: Buffer
  mime: string
}

/** Small LRU of extracted covers, keyed by path|mtime. */
const artCache = new Map<string, ArtEntry | null>()
const ART_CACHE_MAX = 64

export async function extractArtwork(path: string): Promise<ArtEntry | null> {
  let key: string
  try {
    const stat = await fsp.stat(path)
    key = `${path}|${stat.mtimeMs}`
  } catch {
    return null
  }
  if (artCache.has(key)) {
    const hit = artCache.get(key)!
    // refresh LRU position
    artCache.delete(key)
    artCache.set(key, hit)
    return hit
  }
  let entry: ArtEntry | null = null
  try {
    const meta = await parseFile(path, { duration: false })
    const cover = selectCover(meta.common.picture)
    if (cover) entry = { data: Buffer.from(cover.data), mime: cover.format }
  } catch {
    entry = null
  }
  artCache.set(key, entry)
  while (artCache.size > ART_CACHE_MAX) {
    artCache.delete(artCache.keys().next().value!)
  }
  return entry
}

export async function probeMany(paths: string[]): Promise<TrackProbe[]> {
  // Bounded concurrency so a 500-file drop doesn't open 500 handles at once.
  const CONCURRENCY = 8
  const results: TrackProbe[] = new Array(paths.length)
  let next = 0
  async function worker(): Promise<void> {
    while (next < paths.length) {
      const i = next++
      results[i] = await probeFile(paths[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, paths.length) }, worker))
  return results
}
