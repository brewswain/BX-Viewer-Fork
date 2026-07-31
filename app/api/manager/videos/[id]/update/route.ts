import { decodeSegment, guard } from '@/lib/manager/endpoints'
import { updateVideo } from '@/lib/manager/packages'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 3600

type Ctx = { params: Promise<{ id: string }> }

export async function POST(request: Request, { params }: Ctx) {
  const { id } = await params
  return guard(() => updateVideo(request, decodeSegment(id)))
}
