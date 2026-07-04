import { spawn } from 'child_process'
import { promises as fsp } from 'fs'
import { extOf } from '../../shared/formats'
import { ffmpegPath } from './paths'

// Convert-to-cache pipeline. Audio goes to FLAC (compression_level 0 encodes
// at hundreds-of-x realtime); video goes to MP4 via the cheapest plan that
// yields a Chromium-playable file (see ffmpeg/probe.ts). After conversion,
// seeking/duration are native Chromium behavior — no streaming hacks.
// Writes <dest>.part, renames on success.

export interface MediaJobOptions {
  src: string
  dest: string
  /** ffmpeg output args placed between `-i src` and the destination. */
  outputArgs: string[]
  /** Known duration (for progress %); null disables percentage. */
  durationSec: number | null
  onProgress?: (percent: number) => void
}

export interface TranscodeOptions {
  src: string
  dest: string
  durationSec: number | null
  onProgress?: (percent: number) => void
}

interface ActiveJob {
  promise: Promise<void>
  cancel: () => void
}

/** One in-flight job per destination — a preload and a play of the same
 *  track share the same conversion instead of racing. */
const activeJobs = new Map<string, ActiveJob>()

/** Audio → cached FLAC. */
export function transcodeToFlac(opts: TranscodeOptions): { promise: Promise<void>; cancel: () => void } {
  const ext = extOf(opts.src)
  const outputArgs = ['-vn', '-map_metadata', '-1']
  // DSD can't hit its native rate in FLAC; 88.2 kHz is the conventional target.
  if (ext === 'dsf' || ext === 'dff') outputArgs.push('-ar', '88200')
  outputArgs.push('-c:a', 'flac', '-compression_level', '0', '-f', 'flac')
  return runFfmpegJob({ ...opts, outputArgs })
}

/** Any ffmpeg file→file conversion with progress, dedup, and cancellation. */
export function runFfmpegJob(opts: MediaJobOptions): { promise: Promise<void>; cancel: () => void } {
  const existing = activeJobs.get(opts.dest)
  if (existing) return existing

  let proc: ReturnType<typeof spawn> | null = null
  let cancelled = false

  const promise = (async () => {
    const part = `${opts.dest}.part`
    const args = [
      '-v', 'error', '-nostdin', '-y',
      '-i', opts.src,
      ...opts.outputArgs,
      '-progress', 'pipe:1',
      part
    ]

    try {
      await new Promise<void>((resolve, reject) => {
        proc = spawn(ffmpegPath(), args, { windowsHide: true })
        let stderrTail = ''

        proc.stdout!.on('data', (chunk: Buffer) => {
          if (!opts.onProgress || !opts.durationSec) return
          const m = /out_time_us=(\d+)/.exec(chunk.toString())
          if (m) {
            const percent = Math.min(99, (Number(m[1]) / 1e6 / opts.durationSec) * 100)
            opts.onProgress(percent)
          }
        })
        proc.stderr!.on('data', (chunk: Buffer) => {
          stderrTail = (stderrTail + chunk.toString()).slice(-2000)
        })
        proc.on('error', reject)
        proc.on('close', (code) => {
          if (cancelled) reject(new Error('transcode cancelled'))
          else if (code === 0) resolve()
          else reject(new Error(`ffmpeg exited ${code}: ${stderrTail.trim().slice(-500)}`))
        })
      })
      await fsp.rename(part, opts.dest)
      opts.onProgress?.(100)
    } catch (err) {
      await fsp.unlink(part).catch(() => {})
      throw err
    } finally {
      activeJobs.delete(opts.dest)
    }
  })()

  const job: ActiveJob = {
    promise,
    cancel: () => {
      cancelled = true
      proc?.kill()
    }
  }
  activeJobs.set(opts.dest, job)
  return job
}

/** Cancel the in-flight transcode writing to `dest`, if any. */
export function cancelTranscode(dest: string): void {
  activeJobs.get(dest)?.cancel()
}
