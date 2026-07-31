import { guard } from '@/lib/manager/endpoints'
import { createPlaylist } from '@/lib/manager/packages'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 3600

export async function POST(request: Request) {
  return guard(() => createPlaylist(request))
}
