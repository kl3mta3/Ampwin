// LRC sidecar helpers + embedded-lyrics normalization.
//
// The renderer shows one shared `Lyrics` shape (synced lines with ms timestamps,
// or a plain block). Lyrics come from three places, all funnelled through here:
//   - a `<track>.lrc` sidecar next to the file (preferred; what karaokefy writes)
//   - embedded ID3/Vorbis lyrics parsed by music-metadata (`common.lyrics`)
//   - live transcription (Phase C) — formatted via formatLrc for saving
import { promises as fsp } from 'fs'
import { basename, dirname, join } from 'path'
import type { LyricLine, Lyrics } from '../../shared/types'

// One or more [mm:ss], [mm:ss.xx] or [mm:ss.xxx] tags may prefix a line.
const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g

/** Parse standard LRC text into time-sorted lines. Ignores id tags ([ar:…]) and
 *  any line without a numeric time tag. */
export function parseLrc(text: string): LyricLine[] {
  const out: LyricLine[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const stamps: number[] = []
    let m: RegExpExecArray | null
    TIME_TAG.lastIndex = 0
    let lastEnd = 0
    while ((m = TIME_TAG.exec(line))) {
      const min = parseInt(m[1], 10)
      const sec = parseInt(m[2], 10)
      const frac = m[3] ? parseInt(m[3].padEnd(3, '0').slice(0, 3), 10) : 0
      stamps.push((min * 60 + sec) * 1000 + frac)
      lastEnd = TIME_TAG.lastIndex
    }
    if (!stamps.length) continue // [ar:…]/[ti:…]/plain lines
    const content = line.slice(lastEnd).trim()
    for (const t of stamps) out.push({ timeMs: t, text: content })
  }
  out.sort((a, b) => (a.timeMs ?? 0) - (b.timeMs ?? 0))
  return out
}

/** Render lines to LRC text ([mm:ss.xx]…), used to save karaokefy/auto output. */
export function formatLrc(lines: LyricLine[]): string {
  return lines
    .filter((l) => typeof l?.text === 'string')
    .map((l) => {
      const ms = Math.max(0, Math.round(l.timeMs ?? 0))
      const totalSec = Math.floor(ms / 1000)
      const mm = Math.floor(totalSec / 60)
      const ss = totalSec % 60
      const cs = Math.floor((ms % 1000) / 10)
      const p2 = (n: number): string => String(n).padStart(2, '0')
      return `[${p2(mm)}:${p2(ss)}.${p2(cs)}]${l.text}`
    })
    .join('\n')
}

function blockToLines(block: string): LyricLine[] {
  return block
    .split(/\r?\n/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => ({ timeMs: null as number | null, text: t }))
}

/** Build Lyrics from raw text: try LRC (synced) first, else a plain block. */
export function lyricsFromText(text: string, source: Lyrics['source']): Lyrics | null {
  const lrc = parseLrc(text)
  if (lrc.length) return { synced: true, source, lines: lrc }
  const lines = blockToLines(text)
  return lines.length ? { synced: false, source, lines } : null
}

/** Normalize music-metadata `common.lyrics` (ILyricsTag[] | string[]) → Lyrics. */
export function lyricsFromCommonLyrics(raw: unknown): Lyrics | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  for (const tag of raw) {
    if (typeof tag === 'string') {
      const l = lyricsFromText(tag, 'embedded')
      if (l) return l
      continue
    }
    if (tag && typeof tag === 'object') {
      const sync = (tag as { syncText?: unknown }).syncText
      if (Array.isArray(sync) && sync.some((s) => typeof (s as { timestamp?: unknown })?.timestamp === 'number')) {
        const lines: LyricLine[] = sync
          .filter((s) => s && typeof (s as { text?: unknown }).text === 'string')
          .map((s) => {
            const st = s as { text: string; timestamp?: number }
            return { timeMs: typeof st.timestamp === 'number' ? st.timestamp : null, text: st.text.replace(/\r?\n/g, ' ').trim() }
          })
          .filter((l) => l.text.length > 0 || l.timeMs != null)
        if (lines.length) {
          lines.sort((a, b) => (a.timeMs ?? 0) - (b.timeMs ?? 0))
          return { synced: true, source: 'embedded', lines }
        }
      }
      const text = (tag as { text?: unknown }).text
      if (typeof text === 'string' && text.trim()) {
        const l = lyricsFromText(text, 'embedded')
        if (l) return l
      }
    }
  }
  return null
}

function sidecarPathFor(trackPath: string): string {
  const dir = dirname(trackPath)
  const base = basename(trackPath).replace(/\.[^.]+$/, '')
  return join(dir, base + '.lrc')
}

/** Read a `<track>.lrc` sidecar if present. */
export async function readLrcSidecar(trackPath: string): Promise<Lyrics | null> {
  try {
    const text = await fsp.readFile(sidecarPathFor(trackPath), 'utf8')
    return lyricsFromText(text, 'lrc')
  } catch {
    return null
  }
}

/** Write an `.lrc` sidecar next to a given AUDIO FILE (same basename), so the
 *  player reads it like any normal `.lrc`. Karaokefy calls this for the karaoke
 *  file it just exported into the app's own downloads folder — never the source. */
export async function writeLrcSidecar(filePath: string, lines: LyricLine[]): Promise<string> {
  const lrcPath = sidecarPathFor(filePath)
  await fsp.mkdir(dirname(lrcPath), { recursive: true })
  await fsp.writeFile(lrcPath, formatLrc(lines), 'utf8')
  return lrcPath
}
