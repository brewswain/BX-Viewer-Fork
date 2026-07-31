import { guard } from '@/lib/manager/endpoints'
import { createVideo } from '@/lib/manager/packages'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Uploads are streamed to disk part-by-part, so the body must not be buffered.
export const maxDuration = 3600

export async function POST(request: Request) {
  return guard(() => createVideo(request))
}
