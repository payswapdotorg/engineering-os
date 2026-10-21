import { jsonOk, ERR } from "@/lib/api-utils"
import { db } from "@/lib/db"

import { handler } from "../../_lib/route-helpers"
import { serializeEstimate } from "../../_lib/ledger-rows"

export const dynamic = "force-dynamic"

/** GET /api/estimates/[id] — estimate with lines + recomputed totals. */
export const GET = handler<{ id: string }>(async (_req, ctx) => {
  const { id } = await ctx.params

  const estimate = await db.estimate.findUnique({ where: { id }, include: { lines: true } })
  if (!estimate) return ERR.notFound("Estimate")

  return jsonOk({ estimate: serializeEstimate(estimate, estimate.lines) })
})
