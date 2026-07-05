// Progressive video streaming: ffmpeg converts on the fly to fragmented MP4
// on stdout, chunks relay to the renderer (which feeds MSE), and pipe
// backpressure paces the encoder — pause the pipe and ffmpeg blocks, so it
// never races more than the renderer's buffer target ahead of the playhead.
//
// -copyts keeps original media timestamps in the fragments, so after a seek
// restart (-ss T) the buffered range lands at the true media time and MSE
// decodes from the preceding keyframe while presenting from T — no
// timestampOffset bookkeeping, exact seeks even with -c:v copy.

import { spawn, type ChildProcessByStdio } from 'child_process'
import type { Readable } from 'stream'
import type { WebContents } from 'electron'
import { ffmpegPath } from './ffmpeg/paths'
import { videoPlanFor } from './ffmpeg/probe'

interface StreamSession {
  id: number
  proc: ChildProcessByStdio<null, Readable, Readable>
  sender: WebContents
  killed: boolean
  flushTimer: NodeJS.Timeout | null
  pending: Buffer[]
  pendingBytes: number
}

let nextSessionId = 1
const sessions = new Map<number, StreamSession>()

// Kept small so the first (tiny) fragment reaches the renderer's MSE buffer
// promptly instead of waiting to accumulate half a MB — this is startup latency,
// not steady-state throughput (which is bounded by the renderer's look-ahead).
const CHUNK_FLUSH_BYTES = 128 * 1024
const CHUNK_FLUSH_MS = 80

// Fragment duration for the fragmented-MP4 output. The first playable moof isn't
// emitted until this much video is muxed, so it's the dominant startup delay:
// 0.5 s means the picture appears ~4× sooner than the old 2 s. Fragmentation is
// container-level, so this does not affect encode quality.
const FRAG_DURATION_US = 500000

export async function startVideoStream(
  sender: WebContents,
  path: string,
  startSec: number
): Promise<{ sessionId: number; mime: string; durationSec: number }> {
  // One video at a time per window; a seek is stop+start anyway.
  for (const s of [...sessions.values()]) {
    if (s.sender === sender) stopVideoStream(s.id)
  }

  const plan = await videoPlanFor(path)
  if (!plan) throw new Error('unreadable video file (ffprobe failed)')

  const copyVideo = plan.streams.videoCodec === 'h264'
  const hasAudio = plan.streams.audioCodec !== null
  const copyAudio = plan.streams.audioCodec === 'aac'

  const args = ['-v', 'error', '-nostdin']
  if (startSec > 0.25) args.push('-ss', startSec.toFixed(3))
  args.push('-i', path, '-map', '0:v:0')
  if (hasAudio) args.push('-map', '0:a:0')
  args.push('-sn', '-dn')
  if (copyVideo) {
    args.push('-c:v', 'copy')
  } else {
    args.push(
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level:v', '4.1'
    )
  }
  if (hasAudio) {
    if (copyAudio) args.push('-c:a', 'copy')
    else args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2')
  }
  args.push(
    '-copyts', '-avoid_negative_ts', 'disabled',
    '-f', 'mp4',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-frag_duration', String(FRAG_DURATION_US),
    '-flush_packets', '1', // write each fragment to the pipe immediately (low startup latency)
    'pipe:1'
  )

  const proc = spawn(ffmpegPath(), args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  }) as ChildProcessByStdio<null, Readable, Readable>

  const id = nextSessionId++
  const session: StreamSession = {
    id,
    proc,
    sender,
    killed: false,
    flushTimer: null,
    pending: [],
    pendingBytes: 0
  }
  sessions.set(id, session)

  const flush = (): void => {
    if (session.flushTimer) {
      clearTimeout(session.flushTimer)
      session.flushTimer = null
    }
    if (session.pendingBytes === 0 || sender.isDestroyed()) return
    const chunk = Buffer.concat(session.pending, session.pendingBytes)
    session.pending = []
    session.pendingBytes = 0
    sender.send('evt:vstream-data', { sessionId: id, chunk })
  }

  let stderrTail = ''
  proc.stdout.on('data', (data: Buffer) => {
    session.pending.push(data)
    session.pendingBytes += data.length
    if (session.pendingBytes >= CHUNK_FLUSH_BYTES) flush()
    else if (!session.flushTimer) session.flushTimer = setTimeout(flush, CHUNK_FLUSH_MS)
  })
  proc.stderr.on('data', (data: Buffer) => {
    stderrTail = (stderrTail + data.toString()).slice(-2000)
  })
  proc.on('close', (code) => {
    flush()
    sessions.delete(id)
    if (sender.isDestroyed() || session.killed) return
    if (code === 0) {
      sender.send('evt:vstream-end', { sessionId: id })
    } else {
      sender.send('evt:vstream-error', {
        sessionId: id,
        message: `ffmpeg exited ${code}: ${stderrTail.trim().slice(-400)}`
      })
    }
  })
  proc.on('error', (err) => {
    sessions.delete(id)
    if (!sender.isDestroyed() && !session.killed) {
      sender.send('evt:vstream-error', { sessionId: id, message: err.message })
    }
  })

  sender.once('destroyed', () => stopVideoStream(id))

  // Generic codec strings: MSE only gates on the codec family; the init
  // segment carries the real profile/level.
  const mime = `video/mp4; codecs="${copyVideo ? 'avc1.64002A' : 'avc1.640029'}${hasAudio ? ', mp4a.40.2' : ''}"`
  return { sessionId: id, mime, durationSec: plan.streams.durationSec }
}

export function stopVideoStream(sessionId: number): void {
  const session = sessions.get(sessionId)
  if (!session) return
  session.killed = true
  sessions.delete(sessionId)
  if (session.flushTimer) clearTimeout(session.flushTimer)
  try {
    session.proc.kill()
  } catch {
    /* already gone */
  }
}

/** Backpressure from the renderer's buffer target: pausing stdout blocks
 *  ffmpeg's writes, which pauses the conversion itself. */
export function feedControl(sessionId: number, ctl: 'pause' | 'resume'): void {
  const session = sessions.get(sessionId)
  if (!session) return
  if (ctl === 'pause') session.proc.stdout.pause()
  else session.proc.stdout.resume()
}
