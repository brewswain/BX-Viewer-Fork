import { jsonError, jsonResponse } from '@/lib/json'
import { errorMessage, guard } from '@/lib/manager/endpoints'
import { createExportToken } from '@/lib/manager/exportTokens'
import { isValidId } from '@/lib/paths'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/**
 * manager.py `api_export_token`: stash the selection and hand back a one-use
 * token. Splitting it from the download lets the browser's native download
 * manager fetch the (potentially huge) archive over a plain GET.
 */
export async function POST(request: Request) {
  return guard(async () => {
    const raw = await request.text()
    if (raw.length === 0) return jsonError('Empty request body', 400)

    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch (e) {
      return jsonError(`Invalid JSON: ${errorMessage(e)}`, 400)
    }

    const payload = (body ?? {}) as Record<string, unknown>
    const videos = stringList(payload.videos)
    const playlists = stringList(payload.playlists)

    if (videos.length === 0 && playlists.length === 0) {
      return jsonError('No videos or playlists selected', 400)
    }
    for (const vid of videos) {
      if (!isValidId(vid)) return jsonError(`Invalid video id: ${vid}`, 400)
    }
    for (const pid of playlists) {
      if (!isValidId(pid)) return jsonError(`Invalid playlist id: ${pid}`, 400)
    }

    const token = createExportToken({
      videos,
      playlists,
      filename: typeof payload.filename === 'string' ? payload.filename : 'package',
    })
    return jsonResponse({ token })
  })
}
