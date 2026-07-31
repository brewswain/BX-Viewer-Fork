import { jsonError, jsonResponse } from '@/lib/json'
import { guard } from '@/lib/manager/endpoints'
import { manifestExists } from '@/lib/manager/manifest'
import { listPlaylists } from '@/lib/manager/meta'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** manager.py `api_playlists`. */
export async function GET() {
  return guard(async () => {
    if (!(await manifestExists('playlists'))) {
      return jsonError('playlists/manifest.json not found', 404)
    }
    return jsonResponse(await listPlaylists())
  })
}
