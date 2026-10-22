import { recordEvent } from "@/lib/audit"
import { jsonOk, ERR } from "@/lib/api-utils"
import { db } from "@/lib/db"

import { handler, requireEntityProject } from "../../../../_lib/route-helpers"
import { serializeEstimate } from "../../../../_lib/ledger-rows"

export const dynamic = "force-dynamic"

/** DELETE /api/estimates/[id]/lines/[lineId] — remove one priced line. */
export const DELETE = handler<{ id: string; lineId: string }>(async (_req, ctx) => {
  const { id, lineId } = await ctx.params

  const estimate = await db.estimate.findUnique({
    where: { id },
    select: { id: true, projectId: true, status: true },
  })
  if (!estimate) return ERR.notFound("Estimate")

  // Slice 10: project isolation (contract §4)
  const access = await requireEntityProject(estimate, "Estimate", "write")
  if (!access.ok) return access.response

  // Approved (or superseded) estimates are immutable — removing a line would
  // silently change approved totals (honesty red line: approved rows are
  // never overwritten). There is no un-approve transition by design.
  if (estimate.status === "approved" || estimate.status === "superseded") {
    return ERR.invalid(`estimate is ${estimate.status} — its lines are frozen; duplicate the estimate to change it`)
  }

  const line = await db.estimateLine.findFirst({ where: { id: lineId, estimateId: id } })
  if (!line) return ERR.notFound("Estimate line")

  await db.estimateLine.delete({ where: { id: line.id } })

  await recordEvent({
    projectId: estimate.projectId,
    action: "estimate.line_removed",
    entityType: "estimate",
    entityId: id,
    detail: { lineId: line.id, quantityId: line.quantityId, assemblyId: line.assemblyId },
  })

  const fresh = await db.estimate.findUnique({ where: { id }, include: { lines: true } })
  return jsonOk({ estimate: serializeEstimate(fresh!, fresh!.lines) })
})
