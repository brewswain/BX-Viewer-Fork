import { jsonResponse, readJson } from '@/lib/json'
import { CONFIG_PATH } from '@/lib/paths'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface AppConfig {
  httpPort?: number
  managerPort?: number
}

/**
 * Everything now lives on one port, but the manager page still reads this, so
 * the two-port shape (`httpPort` + vestigial `managerPort`) is preserved.
 */
export async function GET() {
  const config = await readJson<AppConfig>(CONFIG_PATH, {})
  return jsonResponse({ httpPort: config.httpPort, managerPort: config.managerPort })
}
