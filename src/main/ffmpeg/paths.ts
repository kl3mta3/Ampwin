import { app } from 'electron'
import { existsSync, promises as fsp } from 'fs'
import { join } from 'path'

// We do NOT import ffmpeg-static/ffprobe-static as modules: they compute
// their binary path from __dirname, which breaks once electron-vite bundles
// them. Instead the binaries are resolved from node_modules in dev and from
// extraResources/bin in the packaged app (see electron-builder.yml).
//
// PORTABLE-BUILD CAVEAT: the portable target extracts to a shared %TEMP% dir
// that its stub deletes on exit. If a second instance exits (or antivirus
// interferes), resources\bin can vanish out from under a still-running app.
// So at startup we seed the binaries to userData\bin and fall back there
// whenever the extraction copy is missing.

function userBinDir(): string {
  return join(app.getPath('userData'), 'bin')
}

function resolveBin(devRelative: string, packagedName: string): string {
  if (!app.isPackaged) {
    return join(app.getAppPath(), 'node_modules', devRelative)
  }
  const bundled = join(process.resourcesPath, 'bin', packagedName)
  if (existsSync(bundled)) return bundled
  return join(userBinDir(), packagedName)
}

export function ffmpegPath(): string {
  return resolveBin('ffmpeg-static/ffmpeg.exe', 'ffmpeg.exe')
}

export function ffprobePath(): string {
  return resolveBin('ffprobe-static/bin/win32/x64/ffprobe.exe', 'ffprobe.exe')
}

/** Copy ffmpeg/ffprobe from the (possibly volatile) extraction dir into
 *  userData\bin so they survive the portable temp dir being cleaned up.
 *  Cheap after the first run (size check → skip). Call once at startup. */
export async function seedFfmpegToUserData(): Promise<void> {
  if (!app.isPackaged) return
  try {
    await fsp.mkdir(userBinDir(), { recursive: true })
    for (const name of ['ffmpeg.exe', 'ffprobe.exe']) {
      const src = join(process.resourcesPath, 'bin', name)
      const dst = join(userBinDir(), name)
      if (!existsSync(src)) continue
      const srcSize = (await fsp.stat(src)).size
      const dstSize = existsSync(dst) ? (await fsp.stat(dst)).size : -1
      if (dstSize === srcSize) continue
      await fsp.copyFile(src, dst)
    }
  } catch {
    // Best-effort: without the seed we still run fine from resources\bin.
  }
}

export function assertFfmpegAvailable(): void {
  const p = ffmpegPath()
  if (!existsSync(p)) {
    // Both the extraction dir and the userData seed are gone — antivirus
    // quarantine or a first run that never completed seeding.
    throw new Error(
      'the bundled ffmpeg is missing — restart Ampwin to restore it. ' +
        `(looked for ${p})`
    )
  }
}
