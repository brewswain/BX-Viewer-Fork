import { CONFIG_PATH } from '@/lib/paths'
import { jsonResponse, readJson } from '@/lib/json'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Kept at its original URL so ported client code needs no edits. Under the
 * single-port Next server the port fields are vestigial, but they're still
 * served verbatim rather than synthesised.
 */
export async function GET() {
  const config = await readJson<Record<string, unknown>>(CONFIG_PATH, {
    httpPort: 8000,
    managerPort: 8001,
  })
  return jsonResponse(config)
}
