// Online synced lyrics via LRCLIB (lrclib.net) — free, no API key, returns
// standard LRC. This is the RELIABLE path: for any released song, fetch
// human-made time-synced lyrics instead of transcribing audio (Whisper is the
// fallback for tracks not in any database).
//
// Runs in the main process (the renderer/addon CSP blocks lrclib.net). Positive
// results cache to userData/lyrics-cache (never touches the user's music
// folders); misses are remembered in-memory for the session only.

import { app } from 'electron'
import { existsSync, promises as fsp } from 'fs'
import { get as httpsGet } from 'https'
import { join } from 'path'
import { createHash } from 'crypto'
import type { Lyrics } from '../../shared/types'
import { lyricsFromText } from './lrc'

const UA = 'Ampwin/0.1.0 (https://github.com/kl3mta3/Ampwin)'
const BASE = 'https://lrclib.net/api'

export interface LyricQuery {
  artist?: string
  title: string
  album?: string
  durationSec?: number
}

interface LrclibRecord {
  trackName?: string
  artistName?: string
  duration?: number
  plainLyrics?: string
  syncedLyrics?: string
}

// Songs LRCLIB had nothing for — don't re-hit within a session.
const missCache = new Set<string>()

function cacheDir(): string {
  return join(app.getPath('userData'), 'lyrics-cache')
}
function keyFor(q: LyricQuery): string {
  // Cache by artist+title only (normalized) — NOT duration — so the main app's
  // auto-fetch and karaokefy (which may see a slightly different duration for the
  // same song) share one cache entry and karaokefy hits it instantly.
  const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim()
  return createHash('sha1').update(`${norm(q.artist ?? '')}|${norm(q.title)}`).digest('hex')
}
function cacheFile(key: string): string {
  return join(cacheDir(), key + '.lrc')
}

// Node https.get, NOT Electron net.fetch. net.fetch has no real timeout, routes
// through the system proxy, and its AbortSignal doesn't reliably tear down a
// stuck socket — which hung the lyrics lookup for minutes. req.setTimeout +
// req.destroy() is a true cancel on a fresh direct socket, so this always
// settles quickly.
function getJson(url: string, timeoutMs = 6000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = httpsGet(url, { headers: { 'User-Agent': UA } }, (res) => {
      const status = res.statusCode ?? 0
      if (status === 404) {
        res.resume()
        resolve(null)
        return
      }
      if (status < 200 || status >= 300) {
        res.resume()
        reject(new Error(`HTTP ${status}`))
        return
      }
      const chunks: Buffer[] = []
      let n = 0
      res.on('data', (c: Buffer) => {
        n += c.length
        if (n > 5_000_000) req.destroy(new Error('response too large'))
        else chunks.push(c)
      })
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (e) {
          reject(e as Error)
        }
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => req.destroy(new Error('lyrics lookup timed out')))
  })
}

function pickBest(list: LrclibRecord[], durationSec?: number): LrclibRecord | null {
  const synced = list.filter((r) => r && typeof r.syncedLyrics === 'string' && r.syncedLyrics.trim())
  const pool = synced.length ? synced : list.filter((r) => r && typeof r.plainLyrics === 'string' && r.plainLyrics.trim())
  if (!pool.length) return null
  if (durationSec && durationSec > 0) {
    pool.sort((a, b) => Math.abs((a.duration ?? 0) - durationSec) - Math.abs((b.duration ?? 0) - durationSec))
  }
  return pool[0]
}

/** Fetch synced (or plain) lyrics for a track from LRCLIB. Returns null on any
 *  miss/error. Positive synced results are cached to userData. */
export async function fetchOnlineLyrics(q: LyricQuery): Promise<Lyrics | null> {
  if (!q.title || !q.title.trim()) return null
  const key = keyFor(q)

  // Positive disk cache.
  try {
    if (existsSync(cacheFile(key))) {
      const text = await fsp.readFile(cacheFile(key), 'utf8')
      return lyricsFromText(text, 'lrc')
    }
  } catch {
    /* ignore, fall through to network */
  }
  if (missCache.has(key)) return null

  let record: LrclibRecord | null = null
  try {
    // Exact lookup first (needs artist + duration; strict duration match).
    if (q.artist && q.durationSec && q.durationSec > 0) {
      const url =
        `${BASE}/get?artist_name=${encodeURIComponent(q.artist)}` +
        `&track_name=${encodeURIComponent(q.title)}` +
        `&album_name=${encodeURIComponent(q.album ?? '')}` +
        `&duration=${Math.round(q.durationSec)}`
      const got = (await getJson(url)) as LrclibRecord | null
      if (got && (got.syncedLyrics || got.plainLyrics)) record = got
    }
    // Fuzzy search fallback.
    if (!record || !record.syncedLyrics) {
      const qStr = `${q.title} ${q.artist ?? ''}`.trim()
      const list = (await getJson(`${BASE}/search?q=${encodeURIComponent(qStr)}`)) as LrclibRecord[] | null
      if (Array.isArray(list) && list.length) record = pickBest(list, q.durationSec) ?? record
    }
  } catch {
    return null // transient network error — don't remember as a miss
  }

  if (record && record.syncedLyrics && record.syncedLyrics.trim()) {
    const lyr = lyricsFromText(record.syncedLyrics, 'lrc')
    if (lyr && lyr.synced) {
      await fsp.mkdir(cacheDir(), { recursive: true }).catch(() => {})
      await fsp.writeFile(cacheFile(key), record.syncedLyrics, 'utf8').catch(() => {})
      return lyr
    }
  }
  if (record && record.plainLyrics && record.plainLyrics.trim()) {
    // Unsynced block — shown but not highlighted; not cached (low value).
    return lyricsFromText(record.plainLyrics, 'lrc')
  }

  missCache.add(key)
  return null
}
