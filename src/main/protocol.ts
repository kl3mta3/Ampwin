import { protocol } from 'electron'
import { createReadStream, promises as fsp } from 'fs'
import { Readable } from 'stream'
import { extOf } from '../shared/formats'
import { resolveSkinAsset } from './skins'
import { extractArtwork } from './metadata'

// ampwin:// routes:
//   ampwin://media/<base64url(absolutePath)>   media bytes (Range-capable)
//   ampwin://skin/<skinId>/<relPath>           skin assets (wired in M3)
//   ampwin://art/<trackKey>                    embedded album art (wired in M2+)

/** Only paths registered via media:prepare this session are servable — a
 *  rogue skin cannot read arbitrary disk paths through the protocol. */
const allowedMediaPaths = new Set<string>()

export function allowMediaPath(absPath: string): void {
  allowedMediaPaths.add(absPath)
}

export function mediaUrlFor(absPath: string): string {
  return 'ampwin://media/' + Buffer.from(absPath, 'utf8').toString('base64url')
}

/** Must run before app.whenReady(). */
export function registerAmpwinScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'ampwin',
      privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true }
    }
  ])
}

/** Call from app.whenReady(). */
export function installAmpwinProtocol(): void {
  protocol.handle('ampwin', (request) => {
    const url = new URL(request.url)
    switch (url.host) {
      case 'media':
        return handleMedia(url, request)
      case 'skin':
        return handleSkinAsset(url)
      case 'art':
        return handleArt(url)
      default:
        return textResponse(404, `unknown ampwin route: ${url.host}`)
    }
  })
}

async function handleMedia(url: URL, request: Request): Promise<Response> {
  let filePath: string
  try {
    filePath = Buffer.from(url.pathname.slice(1), 'base64url').toString('utf8')
  } catch {
    return textResponse(400, 'bad media token')
  }
  if (!allowedMediaPaths.has(filePath)) {
    return textResponse(403, 'path not registered for playback')
  }
  try {
    return await serveFileWithRanges(filePath, request)
  } catch (err) {
    return textResponse(500, `read failed: ${(err as Error).message}`)
  }
}

/** ampwin://skin/<skinId>/<relPath> — assets jailed to the skin folder. */
async function handleSkinAsset(url: URL): Promise<Response> {
  const [, skinId, ...rest] = url.pathname.split('/')
  if (!skinId || rest.length === 0) return textResponse(400, 'bad skin asset url')
  const abs = await resolveSkinAsset(skinId, decodeURIComponent(rest.join('/')))
  if (!abs) return textResponse(403, 'skin asset outside skin folder')
  try {
    const data = await fsp.readFile(abs)
    return new Response(new Uint8Array(data), {
      status: 200,
      headers: { 'Content-Type': mimeFor(abs) }
    })
  } catch {
    return textResponse(404, 'skin asset not found')
  }
}

/** ampwin://art/<base64url(absolutePath)> — embedded album art. */
async function handleArt(url: URL): Promise<Response> {
  let filePath: string
  try {
    filePath = Buffer.from(url.pathname.slice(1), 'base64url').toString('utf8')
  } catch {
    return textResponse(400, 'bad art token')
  }
  if (!allowedMediaPaths.has(filePath)) return textResponse(403, 'path not registered')
  const art = await extractArtwork(filePath)
  if (!art) return textResponse(404, 'no embedded artwork')
  return new Response(new Uint8Array(art.data), {
    status: 200,
    headers: { 'Content-Type': art.mime, 'Cache-Control': 'max-age=3600' }
  })
}

export function artUrlFor(absPath: string): string {
  return 'ampwin://art/' + Buffer.from(absPath, 'utf8').toString('base64url')
}

const MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  weba: 'audio/webm',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  css: 'text/css',
  js: 'text/javascript',
  html: 'text/html',
  json: 'application/json'
}

function mimeFor(path: string): string {
  return MIME[extOf(path)] ?? 'application/octet-stream'
}

/** Manual Range responder: deterministic 206 handling regardless of how the
 *  Electron version treats Range on net.fetch(file://). Seeking depends on it. */
async function serveFileWithRanges(filePath: string, request: Request): Promise<Response> {
  const stat = await fsp.stat(filePath)
  const total = stat.size
  const mime = mimeFor(filePath)
  const rangeHeader = request.headers.get('range')

  if (rangeHeader) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
    if (m && (m[1] !== '' || m[2] !== '')) {
      let start: number
      let end: number
      if (m[1] === '') {
        // suffix range: last N bytes
        const suffix = parseInt(m[2], 10)
        start = Math.max(0, total - suffix)
        end = total - 1
      } else {
        start = parseInt(m[1], 10)
        end = m[2] === '' ? total - 1 : Math.min(parseInt(m[2], 10), total - 1)
      }
      if (start >= total || start > end) {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${total}` }
        })
      }
      return new Response(nodeStreamToWeb(createReadStream(filePath, { start, end })), {
        status: 206,
        headers: {
          'Content-Type': mime,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Accept-Ranges': 'bytes'
        }
      })
    }
  }

  return new Response(nodeStreamToWeb(createReadStream(filePath)), {
    status: 200,
    headers: {
      'Content-Type': mime,
      'Content-Length': String(total),
      'Accept-Ranges': 'bytes'
    }
  })
}

function nodeStreamToWeb(stream: Readable): ReadableStream {
  return Readable.toWeb(stream) as unknown as ReadableStream
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain' } })
}
