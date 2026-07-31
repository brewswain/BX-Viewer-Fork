import { jsonResponse } from '@/lib/json'
import { guard } from '@/lib/manager/endpoints'
import { manifestExists } from '@/lib/manager/manifest'
import { listVideos } from '@/lib/manager/meta'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return guard(async () => {
    // No manifest means no library yet, not a fault — it is written on the
    // first import rather than shipped with the repo.
    if (!(await manifestExists('videos'))) return jsonResponse([])
    return jsonResponse(await listVideos())
  })
}
