import { Readable } from 'node:stream'
import { jsonError } from '@/lib/json'
import { consumeExportToken } from '@/lib/manager/exportTokens'
import { buildExportArchive, sanitizeExportFilename } from '@/lib/manager/zip'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 3600

/**
 * manager.py `api_export_download`: consume the token and stream the zip
 * straight to the browser. Nothing is staged on disk or held in memory —
 * archiver reads each file as the client drains the response.
 */
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get('token')
  if (!token) return jsonError('Missing token', 400)

  const job = consumeExportToken(token)
  if (!job) return jsonError('Invalid or expired token', 404)

  const filename = sanitizeExportFilename(job.filename)
  const archive = buildExportArchive(job.videos, job.playlists)
  const body = Readable.toWeb(archive) as unknown as ReadableStream<Uint8Array>

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  })
}
