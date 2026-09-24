import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

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

/** `bytes=start-end`, `bytes=start-`, `bytes=-suffix`. Multi-range is not supported. */
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

const CHUNK = 512 * 1024

/**
 * Bytes `start..end` (inclusive) of a file, read only when the consumer pulls.
 *
 * A seek abandons the request in flight, so on a scrubbed video these are
 * cancelled far more often than they are read to the end. This used to be
 * `Readable.toWeb(fs.createReadStream())`, whose adapter pushes data as the
 * node stream produces it; a chunk landing after the client hung up hit an
 * already-closed controller and surfaced as an uncaught
 * "Invalid state: Controller is already closed", once per abandoned seek.
 * Pull-based, nothing is enqueued unless the stream asked for it, and an
 * enqueue that loses the race with a cancel throws inside `pull`, where the
 * stream swallows it. `request.signal` closes the handle when the client goes,
 * so an abandoned seek does not hold a multi-GB file open.
 */
function fileStream(
  filePath: string,
  start: number,
  end: number,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  let handle: fsp.FileHandle | null = null
  let pos = start
  const release = () => {
    const h = handle
    handle = null
    void h?.close().catch(() => {})
  }

  return new ReadableStream<Uint8Array>(
    {
      async start() {
        if (signal.aborted) return
        handle = await fsp.open(filePath, 'r')
        signal.addEventListener('abort', release, { once: true })
      },
      async pull(controller) {
        const h = handle
        const want = Math.min(CHUNK, end - pos + 1)
        if (!h || want <= 0) {
          release()
          controller.close()
          return
        }
        const buf = new Uint8Array(want)
        const { bytesRead } = await h.read(buf, 0, want, pos)
        if (bytesRead === 0) {
          release()
          controller.close()
          return
        }
        pos += bytesRead
        controller.enqueue(bytesRead === want ? buf : buf.subarray(0, bytesRead))
      },
      cancel: release,
    },
    // One chunk of read-ahead, so the disk read overlaps the socket write.
    { highWaterMark: 1 },
  )
}

/**
 * Range-aware static file responder. Range support is what makes multi-GB
 * videos scrubbable, so the 206 path must stay byte-exact.
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
  /**
   * Size + mtime is enough to tell one version of a path from the next, which
   * is all a validator has to do here: the manager replaces files wholesale,
   * it never edits one in place at a fixed length.
   */
  const etag = `"${size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`
  const lastModified = stat.mtime.toUTCString()
  const base: Record<string, string> = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    /**
     * `no-cache` means "revalidate before reuse", not "do not store", and the
     * distinction matters a lot for video. Under `no-store` a browser may keep
     * nothing, so every byte it re-reads (a backwards seek, a block its media
     * cache evicted) has to come off the network again. On a multi-GB file
     * that is what exhausts Firefox's fixed-size media cache; see
     * `PLAYBACK-TUNING.md`.
     */
    'Cache-Control': 'no-cache',
    ETag: etag,
    'Last-Modified': lastModified,
  }

  const rangeHeader = request.headers.get('range')
  const isHead = request.method === 'HEAD'

  // The revalidation `no-cache` asks for, answered without resending the body.
  if (!rangeHeader && request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: base })
  }

  /**
   * A byte range only composes with the representation it was measured
   * against. If the file changed under a partially fetched stream, serving the
   * range anyway lets the client stitch two versions into one file, so a stale
   * `If-Range` falls back to sending it whole.
   */
  const ifRange = request.headers.get('if-range')
  const rangeUsable = !ifRange || ifRange === etag || ifRange === lastModified

  if (rangeHeader && rangeUsable) {
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
    return new Response(fileStream(filePath, start, end, request.signal), {
      status: 206,
      headers,
    })
  }

  const headers = { ...base, 'Content-Length': String(size) }
  if (isHead) return new Response(null, { status: 200, headers })
  return new Response(fileStream(filePath, 0, size - 1, request.signal), {
    status: 200,
    headers,
  })
}
