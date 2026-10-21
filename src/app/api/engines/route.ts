import { engineRegistry } from "@/engines"
import { jsonOk } from "@/lib/api-utils"
import { db } from "@/lib/db"

import { handler } from "../_lib/route-helpers"

export const dynamic = "force-dynamic"

/**
 * GET /api/engines — source-verified registry + the latest real probe result
 * per engine key. `probes` is a map keyed by engineKey; absent key = never probed.
 */
export const GET = handler(async () => {
  const probes = await db.engineProbeResult.findMany()

  return jsonOk({
    registry: engineRegistry,
    probes: Object.fromEntries(probes.map((p) => [p.engineKey, p])),
  })
})
