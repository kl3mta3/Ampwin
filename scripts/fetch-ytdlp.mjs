// Build-time fetch of yt-dlp.exe into build/bin/, so release packages ship it
// (electron-builder copies build/bin/ -> resources/bin/). Best-effort: if the
// download fails (offline), the build still succeeds and the app falls back to
// downloading yt-dlp at runtime on first YouTube use.

import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DL_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'build', 'bin')
const outFile = join(outDir, 'yt-dlp.exe')

mkdirSync(outDir, { recursive: true })

// Re-use a recent copy so every build doesn't re-download ~17 MB.
const ONE_WEEK = 7 * 24 * 60 * 60 * 1000
if (existsSync(outFile) && Date.now() - statSync(outFile).mtimeMs < ONE_WEEK) {
  console.log('[fetch-ytdlp] recent yt-dlp.exe already present — skipping download')
  process.exit(0)
}

try {
  console.log('[fetch-ytdlp] downloading latest yt-dlp.exe …')
  const res = await fetch(DL_URL, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(`${outFile}.part`))
  renameSync(`${outFile}.part`, outFile)
  console.log('[fetch-ytdlp] bundled:', outFile, `(${(statSync(outFile).size / 1048576).toFixed(1)} MB)`)
} catch (err) {
  console.warn('[fetch-ytdlp] could NOT download yt-dlp (app will fetch it at runtime instead):', err.message)
  process.exit(0) // never fail the build
}
