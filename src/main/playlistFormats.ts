// M3U / M3U8 / PLS parsing and serialization. Pure functions (no fs, no
// Electron) so vitest covers them directly; the IPC layer handles file IO
// and encoding sniffing.

import { dirname, isAbsolute, relative, resolve } from 'path'

export interface ParsedEntry {
  /** Absolute path (resolved against the playlist file's directory). */
  path: string
  title?: string
  durationSec?: number
}

export interface ParsedPlaylist {
  entries: ParsedEntry[]
  /** http(s) lines — internet radio is phase 2, so these are surfaced, not silently dropped. */
  skippedUrls: string[]
}

function isUrl(line: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(line)
}

function resolveEntry(raw: string, baseDir: string): string {
  const normalized = raw.trim().replace(/\//g, '\\')
  return isAbsolute(normalized) ? normalized : resolve(baseDir, normalized)
}

export function parseM3u(text: string, baseDir: string): ParsedPlaylist {
  const entries: ParsedEntry[] = []
  const skippedUrls: string[] = []
  let pending: { title?: string; durationSec?: number } = {}

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue

    if (line.startsWith('#')) {
      const ext = /^#EXTINF:\s*(-?\d+(?:\.\d+)?)\s*(?:[^,]*)?,(.*)$/.exec(line)
      if (ext) {
        const dur = parseFloat(ext[1])
        pending = {
          durationSec: dur > 0 ? dur : undefined,
          title: ext[2].trim() || undefined
        }
      }
      continue // all other directives (#EXTM3U, #EXTGRP, ...) ignored
    }

    if (isUrl(line)) {
      skippedUrls.push(line)
      pending = {}
      continue
    }

    entries.push({ path: resolveEntry(line, baseDir), ...pending })
    pending = {}
  }

  return { entries, skippedUrls }
}

export function parsePls(text: string, baseDir: string): ParsedPlaylist {
  const files = new Map<number, string>()
  const titles = new Map<number, string>()
  const lengths = new Map<number, number>()
  const skippedUrls: string[] = []

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    const m = /^(File|Title|Length)(\d+)\s*=\s*(.*)$/i.exec(line)
    if (!m) continue
    const n = parseInt(m[2], 10)
    const value = m[3].trim()
    switch (m[1].toLowerCase()) {
      case 'file':
        if (isUrl(value)) skippedUrls.push(value)
        else files.set(n, value)
        break
      case 'title':
        titles.set(n, value)
        break
      case 'length': {
        const len = parseFloat(value)
        if (len > 0) lengths.set(n, len)
        break
      }
    }
  }

  const entries: ParsedEntry[] = [...files.keys()]
    .sort((a, b) => a - b)
    .map((n) => ({
      path: resolveEntry(files.get(n)!, baseDir),
      title: titles.get(n),
      durationSec: lengths.get(n)
    }))

  return { entries, skippedUrls }
}

export interface ExportTrack {
  path: string
  title: string
  artist: string
  durationSec: number
}

/** Extended M3U (works for both .m3u and .m3u8 — encoding is the writer's
 *  concern). Set relativeTo to the playlist file's own path to emit paths
 *  relative to it (falls back to absolute across drive letters). */
export function serializeM3u(tracks: ExportTrack[], opts: { relativeTo?: string } = {}): string {
  const lines = ['#EXTM3U']
  const baseDir = opts.relativeTo ? dirname(opts.relativeTo) : null
  for (const t of tracks) {
    const label = t.artist ? `${t.artist} - ${t.title}` : t.title
    lines.push(`#EXTINF:${Math.round(t.durationSec)},${label}`)
    let out = t.path
    if (baseDir) {
      const rel = relative(baseDir, t.path)
      // Different drive → relative() returns an absolute path; keep it.
      out = rel
    }
    lines.push(out)
  }
  return lines.join('\r\n') + '\r\n'
}
