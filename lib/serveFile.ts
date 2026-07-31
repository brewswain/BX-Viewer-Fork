import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.json': 'application/json',
  '.bx': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.vtt': 'text/vtt',
  '.srt': 'application/x-subrip',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
}

export function contentTypeFor(filePath: string): string {
  return MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

/** `bytes=start-end`, `bytes=start-`, `bytes=-suffix`. Multi-range is not supported (nor was it in server.py). */
function parseRange(header: string, size: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null
  const [, rawStart, rawEnd] = m
  if (rawStart === '' && rawEnd === '') return null

  let start: number
  let end: number
  if (rawStart === '') {
    // suffix range: last N bytes
    const suffix = Number(rawEnd)
    if (suffix <= 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (start > end || start >= size) return null
  return { start, end }
}

function toWebStream(nodeStream: fs.ReadStream): ReadableStream<Uint8Array> {
  return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>
}

/**
 * Range-aware static file responder — the replacement for server.py's
 * do_GET. Range support is what makes multi-GB videos scrubbable, so the
 * 206 path must stay byte-exact.
 */
export async function serveFile(filePath: string, request: Request): Promise<Response> {
  let stat: fs.Stats
  try {
    stat = await fsp.stat(filePath)
  } catch {
    return new Response('Not Found', { status: 404 })
  }
  if (!stat.isFile()) return new Response('Not Found', { status: 404 })

  const size = stat.size
  const type = contentTypeFor(filePath)
  const base: Record<string, string> = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Last-Modified': stat.mtime.toUTCString(),
  }

  const rangeHeader = request.headers.get('range')
  const isHead = request.method === 'HEAD'

  if (rangeHeader) {
    const range = parseRange(rangeHeader, size)
    if (!range) {
      return new Response(null, {
        status: 416,
        headers: { ...base, 'Content-Range': `bytes */${size}` },
      })
    }
    const { start, end } = range
    const length = end - start + 1
    const headers = {
      ...base,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(length),
    }
    if (isHead) return new Response(null, { status: 206, headers })
    return new Response(toWebStream(fs.createReadStream(filePath, { start, end })), {
      status: 206,
      headers,
    })
  }

  const headers = { ...base, 'Content-Length': String(size) }
  if (isHead) return new Response(null, { status: 200, headers })
  return new Response(toWebStream(fs.createReadStream(filePath)), { status: 200, headers })
}
