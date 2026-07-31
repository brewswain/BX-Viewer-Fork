import { VIDEO_BASE, safeJoin } from '@/lib/paths'
import { serveFile } from '@/lib/serveFile'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ path: string[] }> }

async function handle(request: Request, { params }: Ctx) {
  const { path: segments } = await params
  const target = safeJoin(VIDEO_BASE, segments.map(decodeURIComponent))
  if (!target) return new Response('Forbidden', { status: 403 })
  return serveFile(target, request)
}

export const GET = handle
export const HEAD = handle
