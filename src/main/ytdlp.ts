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

/** The copy shipped inside the app (read-only). Used to seed the writable
 *  userData copy on first run so no download is needed. */
function bundledYtDlpPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'bin', 'yt-dlp.exe')
    : join(app.getAppPath(), 'build', 'bin', 'yt-dlp.exe')
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

  // Prefer the bundled copy — instant, offline, no download.
  const bundled = bundledYtDlpPath()
  try {
    await fsp.access(bundled)
    await fsp.copyFile(bundled, dest)
    onProgress?.(100)
    return dest
  } catch {
    /* not bundled (e.g. dev build without a fetch) — download instead */
  }

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

// Forcing the android player client dodges YouTube's web PO-token / SABR wall
// (the "Requested format is not available" failures) and most bot checks,
// without cookies. Kept as a fallback rather than the default because the
// normal client is faster and works for the majority.
const ANDROID_CLIENT = ['--extractor-args', 'youtube:player_client=default,android']

/** Ordered arg-prefixes to try when a YouTube extraction fails, most-specific
 *  first. Cookies help age/region-locked videos but can trigger SABR-only
 *  responses that break format selection; the android client sidesteps the
 *  PO-token/bot wall. A video that fails every tier is genuinely unavailable
 *  (real DRM, private, region-blocked) — no client can fetch those. */
async function ytFallbackPrefixes(): Promise<string[][]> {
  const cookies = await cookieArgs()
  const prefixes: string[][] = []
  // Android client first. `player_client=default,android` already tries the web
  // client and falls through to android in a SINGLE spawn, and android succeeds
  // on VEVO / official-music videos where the web client now returns "not
  // available" (PO-token / SABR wall). Trying a web-only pass first wasted ~2.5s
  // per switch on those before falling through to android anyway — the main cause
  // of the slow video switch. This one prefix covers the common case in one go.
  prefixes.push(ANDROID_CLIENT)
  if (cookies.length) prefixes.push(cookies) // signed-in: age/region-locked
  prefixes.push([]) // cookieless web client — last resort
  return prefixes
}

function runYtDlpOnce(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      ['--no-warnings', '--no-playlist', ...args],
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message).trim().split('\n').slice(-3).join(' ').slice(-400)))
        else resolve(stdout)
      }
    )
  })
}

async function runYtDlp(args: string[], timeoutMs = 60000): Promise<string> {
  const bin = await ensureYtDlp()
  const prefixes = await ytFallbackPrefixes()
  let lastErr: Error | undefined
  for (const pre of prefixes) {
    try {
      return await runYtDlpOnce(bin, [...pre, ...args], timeoutMs)
    } catch (err) {
      lastErr = err as Error
    }
  }
  throw lastErr ?? new Error('yt-dlp failed')
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

/** Run at app startup. If yt-dlp is already available (installed or bundled),
 *  make sure the writable copy exists and check for updates at most once a day.
 *  Does NOT trigger a download for users who've never used YouTube. */
export async function initYtDlpAtStartup(): Promise<void> {
  try {
    if (!(await isInstalled())) {
      // Only seed if we actually ship a bundled copy (no network otherwise).
      await fsp.access(bundledYtDlpPath())
      await ensureYtDlp()
    }
    const age = Date.now() - (await fsp.stat(ytdlpPath())).mtimeMs
    if (age > 24 * 60 * 60 * 1000) void updateYtDlp() // stay current, throttled daily
  } catch {
    /* not installed and not bundled — downloads on first YouTube use */
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
  await fsp.mkdir(downloadsDir(), { recursive: true })
  const ffDir = dirname(ffmpegPath())
  const outTemplate = join(downloadsDir(), '%(title).150B [%(id)s].%(ext)s')

  const buildArgs = (prefix: string[]): string[] => {
    const args = [
      '--no-warnings',
      '--no-playlist',
      '--newline', // progress on its own lines (stderr)
      // ASCII-only filenames. yt-dlp otherwise substitutes fullwidth look-alikes
      // for Windows-illegal chars (" → ＂, / → ⧸); those non-ASCII chars get
      // mangled when yt-dlp prints the final path back on stdout (Python's
      // errors='replace' → '?'), so the path we store no longer matches the file
      // on disk and the track shows as "missing". ASCII names round-trip cleanly
      // and are easier to find in Explorer.
      '--restrict-filenames',
      '--ffmpeg-location',
      ffDir,
      ...prefix
    ]
    if (kind === 'audio') {
      args.push('-f', 'bestaudio[ext=m4a]/bestaudio/best', '-x', '--audio-format', 'm4a')
    } else if (kind === 'video') {
      args.push('-f', 'bestvideo[ext=mp4]/bestvideo/best')
    } else {
      args.push('-f', 'bestvideo*+bestaudio/best', '--merge-output-format', 'mp4')
    }
    // --print after_move:filepath → the final path on stdout (progress on stderr)
    args.push('-o', outTemplate, '--no-simulate', '--print', 'after_move:filepath', url)
    return args
  }

  const attempt = (args: string[]): Promise<string> =>
    new Promise((resolve, reject) => {
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
            // Guard against a mangled path (see --restrict-filenames note): only
            // hand back a path that actually exists, so we never add a phantom
            // "missing" track to the playlist.
            fsp
              .access(path)
              .then(() => {
                onProgress?.(100, 'done')
                resolve(path)
              })
              .catch(() =>
                reject(new Error(`download finished but the file wasn't found at the reported path: ${path}`))
              )
          } else reject(new Error('download finished but no output path was reported'))
        } else {
          reject(new Error(errTail.trim().split('\n').slice(-3).join(' ').slice(-400)))
        }
      })
    })

  let lastErr: Error | undefined
  for (const pre of await ytFallbackPrefixes()) {
    try {
      return await attempt(buildArgs(pre))
    } catch (err) {
      lastErr = err as Error
    }
  }
  throw lastErr ?? new Error('download failed')
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

async function runPlaylistDump(url: string, max: number): Promise<string> {
  const bin = await ensureYtDlp()
  const once = (extra: string[]): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile(
        bin,
        ['--no-warnings', '--yes-playlist', '--flat-playlist', '-J', '-I', `1:${max}`, ...extra, url],
        { timeout: 90000, maxBuffer: 128 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => {
          if (err) reject(new Error((stderr || err.message).trim().split('\n').slice(-3).join(' ').slice(-400)))
          else resolve(stdout)
        }
      )
    })
  let lastErr: Error | undefined
  for (const pre of await ytFallbackPrefixes()) {
    try {
      return await once(pre)
    } catch (err) {
      lastErr = err as Error
    }
  }
  throw lastErr ?? new Error('playlist expand failed')
}

function parsePlaylistEntries(out: string): YtSearchResult[] {
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
  return (j.entries || [])
    .filter((e) => e.id || e.url)
    .map((e) => ({
      url: e.url || `https://www.youtube.com/watch?v=${e.id}`,
      title: e.title || '(untitled)',
      durationSec: Math.round(e.duration || 0),
      uploader: e.uploader || e.channel || '',
      thumbnail: e.thumbnails?.[0]?.url || ''
    }))
}

/** A radio/mix (`list=RD…`) is "unviewable" unless the URL also carries the seed
 *  video. The seed's video id is embedded right after the RD(…) prefix — pull it
 *  out and add it as `v=` so yt-dlp can enumerate the mix. Returns null if the
 *  URL already has a video or the list isn't a seed-style radio. */
function withRadioSeed(url: string): string | null {
  try {
    const u = new URL(url)
    const list = u.searchParams.get('list')
    if (!list || u.searchParams.get('v')) return null
    const m = /^RD(?:AMVM|MM|GMEM)?([A-Za-z0-9_-]{11})/.exec(list)
    if (!m) return null
    u.searchParams.set('v', m[1])
    return u.toString()
  } catch {
    return null
  }
}

/** Expand a playlist/mix/radio URL into its entries (flat = fast, no per-video
 *  extract). Capped so an endless radio can't add thousands of tracks. Uses
 *  --yes-playlist to override the global --no-playlist used elsewhere. Radio
 *  mixes without a seed video are retried with the seed reconstructed. */
export async function expandPlaylist(url: string, max = 100): Promise<YtSearchResult[]> {
  try {
    return parsePlaylistEntries(await runPlaylistDump(url, max))
  } catch (err) {
    const seeded = withRadioSeed(url)
    if (seeded) {
      try {
        return parsePlaylistEntries(await runPlaylistDump(seeded, max))
      } catch {
        /* fall through to the original error */
      }
    }
    throw err
  }
}
