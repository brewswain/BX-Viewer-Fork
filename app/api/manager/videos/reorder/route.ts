import { guard, handleReorder } from '@/lib/manager/endpoints'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  return guard(() => handleReorder(request, 'videos'))
}
