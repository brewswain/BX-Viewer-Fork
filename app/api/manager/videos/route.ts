import { jsonError, jsonResponse } from '@/lib/json'
import { guard } from '@/lib/manager/endpoints'
import { manifestExists } from '@/lib/manager/manifest'
import { listVideos } from '@/lib/manager/meta'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return guard(async () => {
    if (!(await manifestExists('videos'))) {
      return jsonError('videos/manifest.json not found', 404)
    }
    return jsonResponse(await listVideos())
  })
}
