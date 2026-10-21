import { z } from "zod"

import { recordEvent } from "@/lib/audit"
import { jsonOk, ERR, parseBody } from "@/lib/api-utils"
import { db } from "@/lib/db"

import { handler } from "../../../_lib/route-helpers"
import { serializeEstimate } from "../../../_lib/ledger-rows"

export const dynamic = "force-dynamic"

type EstimateAction = "submit" | "approve" | "reject" | "supersede"

/**
 * Pinned estimate transition map (worklog "TL-pinned contracts"):
 *   submit    draft → in_review · approve in_review → approved (gated) ·
 *   reject    in_review → draft ·
 *   supersede draft|in_review|approved → superseded.
 * From "superseded" nothing is allowed — superseding again 422s with the
 * pinned message `cannot supersede an estimate in status "superseded"`
 * (produced verbatim by the generic error path below). Supersede KEEPS the
 * approval payload untouched (audit trail preserved); lines stay frozen via
 * the existing add/delete guards (honesty: approved rows never overwritten).
 */
const ESTIMATE_TRANSITIONS: Record<string, Partial<Record<EstimateAction, string>>> = {
  draft: { submit: "in_review", supersede: "superseded" },
  in_review: { approve: "approved", reject: "draft", supersede: "superseded" },
  approved: { supersede: "superseded" },
  superseded: {},
}

const transitionSchema = z.object({
  action: z.enum(["submit", "approve", "reject", "supersede"]),
})

/**
 * POST /api/estimates/[id]/transition — submit|approve|reject|supersede.
 *
 * APPROVE GATE: every line's quantity must be status "approved" AND every line
 * currency must equal the estimate currency, else 422 with an explicit blocker
 * list (quantity ids + labels; currency mismatches per line).
 */
export const POST = handler<{ id: string }>(async (req, ctx) => {
  const { id } = await ctx.params

  const estimate = await db.estimate.findUnique({ where: { id }, include: { lines: true } })
  if (!estimate) return ERR.notFound("Estimate")

  const parsed = await parseBody(req, transitionSchema)
  if (!parsed.ok) return parsed.response
  const action = parsed.data.action

  const from = estimate.status
  const to = ESTIMATE_TRANSITIONS[from]?.[action]
  if (!to) {
    const hint =
      action === "approve" && from === "draft"
        ? ' — approve requires in_review (submit it first)'
        : ""
    return ERR.invalid(`cannot ${action} an estimate in status "${from}"${hint}`)
  }

  if (action === "approve") {
    const lines = await db.estimateLine.findMany({ where: { estimateId: id } })
    const quantityIds = [...new Set(lines.map((l) => l.quantityId))]
    const quantities = quantityIds.length
      ? await db.quantityRecord.findMany({ where: { id: { in: quantityIds } } })
      : []
    const quantityById = new Map(quantities.map((q) => [q.id, q]))

    const blockers: string[] = []
    for (const line of lines) {
      const quantity = quantityById.get(line.quantityId)
      if (!quantity || quantity.status !== "approved") {
        const label =
          quantity?.sheetRef ?? quantity?.elementRef ?? `${quantity?.quantityType ?? "unknown"} ${quantity?.value ?? ""}${quantity?.unit ?? ""}`
        blockers.push(
          `quantity ${line.quantityId} (${label}) is ${quantity ? `"${quantity.status}"` : "missing from the ledger"}`,
        )
      }
      if (line.currency !== estimate.currency) {
        blockers.push(
          `line ${line.id} is in ${line.currency} but the estimate is in ${estimate.currency}`,
        )
      }
    }
    if (blockers.length > 0) {
      return ERR.invalid(
        `estimate approve blocked (${blockers.length} blocker${blockers.length === 1 ? "" : "s"}): ${blockers.join("; ")}`,
      )
    }
  }

  const approval =
    action === "approve"
      ? JSON.stringify({ approvedBy: "local-operator", approvedAt: new Date().toISOString() })
      : estimate.approval

  const updated = await db.estimate.update({
    where: { id },
    data: { status: to, approval },
    include: { lines: true },
  })

  await recordEvent({
    projectId: estimate.projectId,
    action: "estimate.updated",
    entityType: "estimate",
    entityId: id,
    detail: { action, from, to },
  })

  return jsonOk({ estimate: serializeEstimate(updated, updated.lines) })
})
