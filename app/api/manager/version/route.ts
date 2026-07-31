import { jsonResponse } from '@/lib/json'
import { getVersion } from '@/lib/version'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Change counter the manager and browse pages poll to detect writes. */
export async function GET() {
  return jsonResponse({ version: getVersion() })
}
