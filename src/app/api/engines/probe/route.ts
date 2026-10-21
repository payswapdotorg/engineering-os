import { detectEngines } from "@/engines"
import { recordEvent } from "@/lib/audit"
import { jsonOk } from "@/lib/api-utils"
import { db } from "@/lib/db"
import { newId } from "@/lib/ids"

import { handler } from "../../_lib/route-helpers"

export const dynamic = "force-dynamic"

/** POST /api/engines/probe — run real detection; "not installed" is a state, not an error. */
export const POST = handler(async () => {
  const results = await detectEngines()

  for (const result of results) {
    await db.engineProbeResult.upsert({
      where: { engineKey: result.key },
      create: {
        id: newId("eng"),
        engineKey: result.key,
        state: result.state,
        version: result.version,
        executablePath: result.executablePath,
        probeOutput: result.probeOutput,
        probedAt: new Date(result.probedAt),
      },
      update: {
        state: result.state,
        version: result.version,
        executablePath: result.executablePath,
        probeOutput: result.probeOutput,
        probedAt: new Date(result.probedAt),
      },
    })
  }

  const installed = results.filter((r) => r.state === "installed").length
  await recordEvent({
    actorType: "system",
    action: "engine.probe",
    entityType: "engine",
    entityId: "registry",
    detail: { installed, total: results.length },
  })

  return jsonOk({ results, installed, total: results.length })
})
