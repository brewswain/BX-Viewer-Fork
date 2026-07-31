import { jsonResponse } from '@/lib/json'
import { guard } from '@/lib/manager/endpoints'
import { manifestExists } from '@/lib/manager/manifest'
import { listPlaylists } from '@/lib/manager/meta'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return guard(async () => {
    // No manifest means no library yet — see the videos route.
    if (!(await manifestExists('playlists'))) return jsonResponse([])
    return jsonResponse(await listPlaylists())
  })
}
