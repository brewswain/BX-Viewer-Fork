import { decodeSegment, guard, handleDelete } from '@/lib/manager/endpoints'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

/** manager.py `api_delete_playlist`. */
export async function DELETE(_request: Request, { params }: Ctx) {
  const { id } = await params
  return guard(() => handleDelete('playlists', decodeSegment(id)))
}
