import { jsonError, jsonResponse } from '@/lib/json'
import { guard } from '@/lib/manager/endpoints'
import {
  buildPlan,
  isLoopbackRequest,
  OssmRequestError,
  parseOssmRequest,
  toWirePlan,
} from '@/lib/ossm/bundle'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Dry-run an OSSM Sauce export: where it would go, what each file would do
 * there, and the `.bxpl` it would write. Read-only — nothing is created, so the
 * UI can call this on every selection change.
 */
export async function POST(request: Request) {
  return guard(async () => {
    const parsed = parseOssmRequest(await request.text())
    if (!parsed.ok) return jsonError(parsed.error, 400)

    try {
      const plan = await buildPlan(parsed.request, isLoopbackRequest(request))
      return jsonResponse(toWirePlan(plan))
    } catch (e) {
      if (e instanceof OssmRequestError) return jsonError(e.message, 400)
      throw e
    }
  })
}
