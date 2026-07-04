import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'

// We do NOT import ffmpeg-static/ffprobe-static as modules: they compute
// their binary path from __dirname, which breaks once electron-vite bundles
// them. Instead the binaries are resolved from node_modules in dev and from
// extraResources/bin in the packaged app (see electron-builder.yml).

function resolveBin(devRelative: string, packagedName: string): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'bin', packagedName)
  }
  return join(app.getAppPath(), 'node_modules', devRelative)
}

export function ffmpegPath(): string {
  return resolveBin('ffmpeg-static/ffmpeg.exe', 'ffmpeg.exe')
}

export function ffprobePath(): string {
  return resolveBin('ffprobe-static/bin/win32/x64/ffprobe.exe', 'ffprobe.exe')
}

export function assertFfmpegAvailable(): void {
  const p = ffmpegPath()
  if (!existsSync(p)) {
    throw new Error(`ffmpeg binary not found at ${p}`)
  }
}
