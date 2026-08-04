import { jsonError, jsonResponse } from '@/lib/json'
import { guard } from '@/lib/manager/endpoints'
import { buildPlan, isLoopbackRequest, OssmRequestError, parseOssmRequest } from '@/lib/ossm/bundle'
import { installFiles } from '@/lib/ossm/storage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Copy the paths into `Paths/` and write the `.bxpl`, never overwriting. */
export async function POST(request: Request) {
  return guard(async () => {
    const parsed = parseOssmRequest(await request.text())
    if (!parsed.ok) return jsonError(parsed.error, 400)

    const canInstall = isLoopbackRequest(request)
    if (!canInstall) {
      return jsonError(
        'Install only works from the machine running the viewer — from here it would write to the Documents folder on that machine, not this one. Use Download instead.',
        403,
      )
    }

    // Re-planned here rather than accepted from the client: the plan carries the
    // absolute source paths and the final names, so it is not the client's to
    // supply.
    try {
      const plan = await buildPlan(parsed.request, canInstall)
      if (!plan.target.dir) {
        return jsonError(
          'Could not find an OSSM Sauce folder. Set "ossmSauceDir" in config.json or the OSSM_SAUCE_DIR environment variable to the OSSM Sauce folder inside your Documents.',
          400,
        )
      }

      const result = await installFiles(plan.target, plan.files, plan.playlist)
      return jsonResponse({ ...result, warnings: [...plan.warnings, ...result.warnings] })
    } catch (e) {
      if (e instanceof OssmRequestError) return jsonError(e.message, 400)
      throw e
    }
  })
}
