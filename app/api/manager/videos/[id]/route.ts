import { decodeSegment, guard, handleDelete } from '@/lib/manager/endpoints'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

/** manager.py `api_delete_video`. */
export async function DELETE(_request: Request, { params }: Ctx) {
  const { id } = await params
  return guard(() => handleDelete('videos', decodeSegment(id)))
}
