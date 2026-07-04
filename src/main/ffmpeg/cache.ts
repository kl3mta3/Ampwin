import { app } from 'electron'
import { createHash } from 'crypto'
import { promises as fsp } from 'fs'
import { join } from 'path'

// Conversion cache: <userData>/transcode-cache/<sha1(path|mtime|size)>.<ext>
// (.flac for audio, .mp4 for video). Content-stable keys invalidate
// automatically when the source file changes. LRU eviction uses the cache
// files' own mtime, which we touch on every hit (atime is unreliable on
// Windows).

export function cacheDir(): string {
  return join(app.getPath('userData'), 'transcode-cache')
}

export function cacheKey(srcPath: string, mtimeMs: number, size: number): string {
  return createHash('sha1').update(`${srcPath}|${mtimeMs}|${size}`).digest('hex')
}

export function cachedFlacPath(key: string): string {
  return join(cacheDir(), `${key}.flac`)
}

export function cachedMp4Path(key: string): string {
  return join(cacheDir(), `${key}.mp4`)
}

/** Returns the cached file path on hit (and refreshes its LRU stamp). */
export async function cacheLookup(key: string, ext: 'flac' | 'mp4' = 'flac'): Promise<string | null> {
  const path = join(cacheDir(), `${key}.${ext}`)
  try {
    await fsp.access(path)
    const now = new Date()
    await fsp.utimes(path, now, now).catch(() => {})
    return path
  } catch {
    return null
  }
}

/** Startup sweep: remove orphaned .part files, evict LRU past the size cap. */
export async function sweepCache(maxBytes: number): Promise<void> {
  let entries: string[]
  try {
    entries = await fsp.readdir(cacheDir())
  } catch {
    return
  }

  const files: { path: string; size: number; mtimeMs: number }[] = []
  for (const name of entries) {
    const full = join(cacheDir(), name)
    if (name.endsWith('.part')) {
      await fsp.unlink(full).catch(() => {})
      continue
    }
    try {
      const stat = await fsp.stat(full)
      files.push({ path: full, size: stat.size, mtimeMs: stat.mtimeMs })
    } catch {
      // vanished mid-sweep
    }
  }

  let total = files.reduce((sum, f) => sum + f.size, 0)
  if (total <= maxBytes) return

  // Never evict very recent conversions — a freshly remuxed movie shouldn't
  // vanish on the next launch just because it blew past the cap.
  const MIN_AGE_MS = 6 * 60 * 60 * 1000
  const now = Date.now()
  files.sort((a, b) => a.mtimeMs - b.mtimeMs) // oldest first
  for (const f of files) {
    if (total <= maxBytes) break
    if (now - f.mtimeMs < MIN_AGE_MS) continue
    await fsp.unlink(f.path).catch(() => {})
    total -= f.size
  }
}
