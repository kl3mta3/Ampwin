// yt-dlp manager: downloaded on first use to userData/bin, self-updating when
// a resolve fails (YouTube breaks old versions periodically). Used to resolve
// site links (YouTube etc.) to a direct, Chromium/ffmpeg-playable stream URL,
// and to search. Cookies from the sign-in window (yt-cookies.txt) are passed
// through for age/region/rate-limited videos.

import { app, net } from 'electron'
import { execFile, spawn } from 'child_process'
import { createWriteStream, promises as fsp } from 'fs'
import { dirname, join } from 'path'
import type { LinkProbe, YtSearchResult } from '../shared/types'
import { extOf, isVideoPath } from '../shared/formats'
import { ffmpegPath } from './ffmpeg/paths'

const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'

function ytdlpPath(): string {
  return join(app.getPath('userData'), 'bin', 'yt-dlp.exe')
}

export function cookiesPath(): string {
  return join(app.getPath('userData'), 'yt-cookies.txt')
}

export async function isInstalled(): Promise<boolean> {
  try {
    await fsp.access(ytdlpPath())
    return true
  } catch {
    return false
  }
}

let ensurePromise: Promise<string> | null = null

/** Download yt-dlp if missing. Concurrent callers share one download. */
export function ensureYtDlp(onProgress?: (pct: number) => void): Promise<string> {
  if (!ensurePromise) {
    ensurePromise = doEnsure(onProgress).catch((err) => {
      ensurePromise = null // allow retry
      throw err
    })
  }
  return ensurePromise
}

async function doEnsure(onProgress?: (pct: number) => void): Promise<string> {
  const dest = ytdlpPath()
  if (await isInstalled()) return dest

  await fsp.mkdir(dirname(dest), { recursive: true })
  const res = await net.fetch(YTDLP_URL) // follows GitHub's cross-host redirect
  if (!res.ok || !res.body) throw new Error(`yt-dlp download failed (HTTP ${res.status})`)

  const total = Number(res.headers.get('content-length')) || 0
  let received = 0
  const tmp = `${dest}.part`
  const out = createWriteStream(tmp)
  const reader = res.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.length
      if (!out.write(Buffer.from(value))) {
        await new Promise<void>((r) => out.once('drain', r))
      }
      if (total > 0) onProgress?.(Math.round((received / total) * 100))
    }
    await new Promise<void>((resolve, reject) => out.end((e?: Error) => (e ? reject(e) : resolve())))
  } catch (err) {
    out.destroy()
    await fsp.unlink(tmp).catch(() => {})
    throw err
  }
  await fsp.rename(tmp, dest)
  onProgress?.(100)
  return dest
}

async function cookieArgs(): Promise<string[]> {
  try {
    await fsp.access(cookiesPath())
    return ['--cookies', cookiesPath()]
  } catch {
    return []
  }
}

async function runYtDlp(args: string[], timeoutMs = 60000): Promise<string> {
  const bin = await ensureYtDlp()
  const cookies = await cookieArgs()
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      ['--no-warnings', '--no-playlist', ...cookies, ...args],
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message).trim().split('\n').slice(-3).join(' ').slice(-400)))
        else resolve(stdout)
      }
    )
  })
}

/** Best-effort background self-update; ignored on failure. */
export async function updateYtDlp(): Promise<void> {
  try {
    const bin = await ensureYtDlp()
    await new Promise<void>((resolve) => {
      execFile(bin, ['-U'], { timeout: 60000, windowsHide: true }, () => resolve())
    })
  } catch {
    /* offline / locked — not fatal */
  }
}

// ---- URL classification ----------------------------------------------------

/** A direct media URL (…/song.mp3) plays without yt-dlp; anything else (a
 *  youtube.com/watch page, etc.) needs yt-dlp to extract a stream. */
export function isDirectMediaUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    const ext = extOf(u.pathname)
    return ext.length > 0 && (isVideoPath(u.pathname) || AUDIO_URL_EXTS.includes(ext) || ext === 'm3u8')
  } catch {
    return false
  }
}

const AUDIO_URL_EXTS = ['mp3', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus', 'wav', 'weba']

// ---- probe (add-time) + resolve (play-time) --------------------------------

export async function probeLink(url: string, audioOnly: boolean): Promise<LinkProbe> {
  if (isDirectMediaUrl(url)) {
    let name = 'link'
    try {
      name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'link') || 'link'
    } catch {
      /* keep default */
    }
    return {
      ok: true,
      title: name.replace(/\.[^.]+$/, ''),
      durationSec: 0,
      isVideo: !audioOnly && isVideoPath(url),
      needsYtDlp: false
    }
  }
  try {
    const out = await runYtDlp(['-J', url])
    const j = JSON.parse(out) as {
      title?: string
      duration?: number
      uploader?: string
      channel?: string
      _type?: string
    }
    return {
      ok: true,
      title: j.title || url,
      durationSec: Math.round(j.duration || 0),
      isVideo: !audioOnly,
      uploader: j.uploader || j.channel,
      needsYtDlp: true
    }
  } catch (err) {
    return {
      ok: false,
      error: (err as Error).message,
      title: url,
      durationSec: 0,
      isVideo: !audioOnly,
      needsYtDlp: true
    }
  }
}

const AUDIO_FMT = 'bestaudio[ext=m4a]/bestaudio/best'
// Progressive (single URL) so a plain <video>/ffmpeg input works — caps ~720p
// on YouTube; higher needs DASH muxing (a later upgrade).
const VIDEO_FMT = 'best[ext=mp4]/best'

export async function resolveStream(
  url: string,
  audioOnly: boolean
): Promise<{ streamUrl: string; isVideo: boolean }> {
  if (isDirectMediaUrl(url)) {
    return { streamUrl: url, isVideo: !audioOnly && isVideoPath(url) }
  }
  const doResolve = async (): Promise<string> => {
    const out = await runYtDlp(['-g', '-f', audioOnly ? AUDIO_FMT : VIDEO_FMT, url])
    const first = out.trim().split('\n').filter(Boolean)[0]
    if (!first) throw new Error('yt-dlp returned no stream URL')
    return first
  }
  try {
    return { streamUrl: await doResolve(), isVideo: !audioOnly }
  } catch (err) {
    // A common failure is a stale yt-dlp; update once and retry.
    await updateYtDlp()
    try {
      return { streamUrl: await doResolve(), isVideo: !audioOnly }
    } catch {
      throw err
    }
  }
}

// ---- download (right-click ▸ Download) -------------------------------------

export type DownloadKind = 'audio' | 'video' | 'both'

export function downloadsDir(): string {
  return join(app.getPath('userData'), 'downloads')
}

/** Download a URL to the downloads folder. Uses our bundled ffmpeg for
 *  merging (best video+audio → full quality, beyond the 720p stream cap) and
 *  audio extraction. Returns the final file path. */
export async function downloadLink(
  url: string,
  kind: DownloadKind,
  onProgress?: (percent: number, phase: string) => void
): Promise<string> {
  const bin = await ensureYtDlp()
  const cookies = await cookieArgs()
  await fsp.mkdir(downloadsDir(), { recursive: true })
  const ffDir = dirname(ffmpegPath())
  const outTemplate = join(downloadsDir(), '%(title).150B [%(id)s].%(ext)s')

  const args = [
    '--no-warnings',
    '--no-playlist',
    '--newline', // progress on its own lines (stderr)
    '--ffmpeg-location',
    ffDir,
    ...cookies
  ]
  if (kind === 'audio') {
    args.push('-f', 'bestaudio[ext=m4a]/bestaudio/best', '-x', '--audio-format', 'm4a')
  } else if (kind === 'video') {
    args.push('-f', 'bestvideo[ext=mp4]/bestvideo/best')
  } else {
    args.push('-f', 'bestvideo*+bestaudio/best', '--merge-output-format', 'mp4')
  }
  // --print after_move:filepath → the final path on stdout (progress is on stderr)
  args.push('-o', outTemplate, '--no-simulate', '--print', 'after_move:filepath', url)

  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { windowsHide: true })
    let stdout = ''
    let errTail = ''
    proc.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    proc.stderr.on('data', (d: Buffer) => {
      const s = d.toString()
      errTail = (errTail + s).slice(-3000)
      const m = /\[download\]\s+([\d.]+)%/.exec(s)
      if (m) onProgress?.(parseFloat(m[1]), 'downloading')
      else if (/\[Merger\]/.test(s)) onProgress?.(99, 'merging')
      else if (/\[ExtractAudio\]/.test(s)) onProgress?.(99, 'extracting audio')
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) {
        const path = stdout.trim().split(/\r?\n/).filter(Boolean).pop() || ''
        if (path) {
          onProgress?.(100, 'done')
          resolve(path)
        } else reject(new Error('download finished but no output path was reported'))
      } else {
        reject(new Error(errTail.trim().split('\n').slice(-3).join(' ').slice(-400)))
      }
    })
  })
}

export async function searchYouTube(query: string, count = 15): Promise<YtSearchResult[]> {
  const out = await runYtDlp(['-J', '--flat-playlist', `ytsearch${count}:${query}`], 45000)
  const j = JSON.parse(out) as {
    entries?: {
      id?: string
      url?: string
      title?: string
      duration?: number
      uploader?: string
      channel?: string
      thumbnails?: { url: string }[]
    }[]
  }
  return (j.entries || []).map((e) => ({
    url: e.url || `https://www.youtube.com/watch?v=${e.id}`,
    title: e.title || '(untitled)',
    durationSec: Math.round(e.duration || 0),
    uploader: e.uploader || e.channel || '',
    thumbnail: e.thumbnails?.[0]?.url || ''
  }))
}
