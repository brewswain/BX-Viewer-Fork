import { jsonResponse, readJson } from '@/lib/json'
import { CONFIG_PATH } from '@/lib/paths'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface AppConfig {
  httpPort?: number
  managerPort?: number
}

/**
 * manager.py `GET /manager-api/config`. Both servers now live on one port, but
 * the manager page still reads this, so the shape is preserved verbatim.
 */
export async function GET() {
  const config = await readJson<AppConfig>(CONFIG_PATH, {})
  return jsonResponse({ httpPort: config.httpPort, managerPort: config.managerPort })
}
