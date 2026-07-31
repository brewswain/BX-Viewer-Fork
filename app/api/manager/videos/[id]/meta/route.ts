import { decodeSegment, guard, handleReadMeta, handleWriteMeta } from '@/lib/manager/endpoints'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

export async function GET(_request: Request, { params }: Ctx) {
  const { id } = await params
  return guard(() => handleReadMeta('videos', decodeSegment(id)))
}

export async function POST(request: Request, { params }: Ctx) {
  const { id } = await params
  return guard(() => handleWriteMeta(request, 'videos', decodeSegment(id)))
}
