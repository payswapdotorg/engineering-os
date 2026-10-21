import { z } from "zod"

import { type QuantityStatus } from "@/core"
import { recordEvent } from "@/lib/audit"
import { jsonOk, ERR, parseBody } from "@/lib/api-utils"
import { db } from "@/lib/db"

import { handler } from "../../../_lib/route-helpers"
import { serializeQuantityRows } from "../../../_lib/ledger-rows"

export const dynamic = "force-dynamic"

type QuantityAction = "submit" | "approve" | "reject" | "supersede"

/**
 * Pinned quantity transition map (worklog "TL-pinned contracts", AC-P3-03):
 *   submit    draft → in_review
 *   approve   in_review → approved   (approval is NEVER implied from draft)
 *   reject    in_review → draft
 *   supersede any active (draft|in_review|approved) → superseded
 * Everything else is invalid → 422.
 */
const QUANTITY_TRANSITIONS: Record<QuantityStatus, Partial<Record<QuantityAction, QuantityStatus>>> = {
  draft: { submit: "in_review", supersede: "superseded" },
  in_review: { approve: "approved", reject: "draft", supersede: "superseded" },
  approved: { supersede: "superseded" },
  superseded: {},
}

const transitionSchema = z.object({
  action: z.enum(["submit", "approve", "reject", "supersede"]),
})

/** POST /api/quantities/[id]/transition — submit|approve|reject|supersede. */
export const POST = handler<{ id: string }>(async (req, ctx) => {
  const { id } = await ctx.params

  const row = await db.quantityRecord.findUnique({ where: { id } })
  if (!row) return ERR.notFound("Quantity")

  const parsed = await parseBody(req, transitionSchema)
  if (!parsed.ok) return parsed.response
  const action = parsed.data.action

  const from = row.status as QuantityStatus
  const to = QUANTITY_TRANSITIONS[from][action]
  if (!to) {
    const hint =
      action === "approve" && from === "draft"
        ? ' — approve requires in_review (submit it first; no direct draft→approved)'
        : ""
    return ERR.invalid(`cannot ${action} a quantity in status "${from}"${hint}`)
  }

  // Approve records WHO and WHEN (never implied, never accepted from the body).
  const approval =
    action === "approve"
      ? JSON.stringify({ approvedBy: "local-operator", approvedAt: new Date().toISOString() })
      : row.approval

  const updated = await db.quantityRecord.update({
    where: { id },
    data: { status: to, approval },
  })

  await recordEvent({
    projectId: row.projectId,
    action: "quantity.updated",
    entityType: "quantity",
    entityId: id,
    detail: { action, from, to },
  })

  const [quantity] = await serializeQuantityRows([updated])
  return jsonOk({ quantity })
})
