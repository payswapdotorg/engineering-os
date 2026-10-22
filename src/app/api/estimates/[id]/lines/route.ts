import { z } from "zod"

import { LedgerError, estimateLineTotal } from "@/core"
import { recordEvent } from "@/lib/audit"
import { jsonOk, ERR, parseBody } from "@/lib/api-utils"
import { db } from "@/lib/db"
import { newId } from "@/lib/ids"

import { handler } from "../../../_lib/route-helpers"
import { estimateRounding, serializeEstimate } from "../../../_lib/ledger-rows"
import {
  buildLineBreakdown,
  currencyMismatchMessage,
  missingRatesMessage,
  rateIdsForComponents,
  ratesByKey,
  resolveRates,
  type AssemblyComponent,
} from "../../../_lib/estimate-pricing"

export const dynamic = "force-dynamic"

const addLineSchema = z.object({
  quantityId: z.string().min(1, "quantityId is required"),
  assemblyId: z.string().min(1, "assemblyId is required"),
})

// Pricing helpers (resolveRates, breakdown mirror, pinned 422 message
// builders) moved VERBATIM into ../../_lib/estimate-pricing.ts so the Phase-5
// recompute route reuses them without forking the math — HTTP behavior here is
// byte-stable (same functions, same strings, same preference order).

/** POST /api/estimates/[id]/lines — price quantity × assembly into the estimate. */
export const POST = handler<{ id: string }>(async (req, ctx) => {
  const { id } = await ctx.params

  const estimate = await db.estimate.findUnique({ where: { id }, include: { lines: true } })
  if (!estimate) return ERR.notFound("Estimate")

  // Approved (or superseded) estimates are immutable — mutating lines would
  // silently change approved totals (honesty red line: approved rows are
  // never overwritten). There is no un-approve transition by design.
  if (estimate.status === "approved" || estimate.status === "superseded") {
    return ERR.invalid(`estimate is ${estimate.status} — its lines are frozen; duplicate the estimate to change it`)
  }

  const parsed = await parseBody(req, addLineSchema)
  if (!parsed.ok) return parsed.response
  const { quantityId, assemblyId } = parsed.data

  // Quantity must exist in this estimate's project and not be superseded.
  const quantity = await db.quantityRecord.findUnique({ where: { id: quantityId } })
  if (!quantity || quantity.projectId !== estimate.projectId) {
    return ERR.invalid(`quantityId: must reference a quantity of this estimate's project (got ${quantityId})`)
  }
  if (quantity.status === "superseded") {
    return ERR.invalid(`quantityId: quantity ${quantityId} is superseded and can no longer be priced into an estimate`)
  }

  const assembly = await db.tradeAssembly.findUnique({ where: { id: assemblyId } })
  if (!assembly || assembly.projectId !== estimate.projectId) {
    return ERR.invalid(`assemblyId: must reference an assembly of this estimate's project (got ${assemblyId})`)
  }
  const components = JSON.parse(assembly.components) as AssemblyComponent[]

  const rounding = estimateRounding(estimate)
  const now = new Date()
  const { resolved, missing } = await resolveRates(estimate.projectId, components, now)
  if (missing.length > 0) {
    return ERR.invalid(missingRatesMessage(missing))
  }

  // All resolved rate currencies must equal the estimate currency (a mixed
  // line is a modeling error, not a number — mirrored by estimateLineTotal).
  const currencyMismatches = components.filter(
    (c) => resolved.get(c.id)?.currency !== estimate.currency,
  )
  if (currencyMismatches.length > 0) {
    return ERR.invalid(
      currencyMismatchMessage(currencyMismatches, resolved, estimate.name, estimate.currency),
    )
  }

  const ratesByKeyMap = ratesByKey(components, resolved)

  // lineTotal via src/core (authoritative); the breakdown below mirrors the
  // SAME documented arithmetic so per-component evidence always adds up.
  let lineTotal: number
  try {
    lineTotal = estimateLineTotal(
      { value: quantity.value },
      { id: assembly.id, name: assembly.name, components },
      ratesByKeyMap,
      rounding,
    )
  } catch (err) {
    if (err instanceof LedgerError) {
      console.error("[api] stored assembly failed line arithmetic:", err.message)
      return ERR.invalid(err.message)
    }
    throw err
  }

  const breakdown = buildLineBreakdown(quantity.value, components, resolved, rounding)

  const lineId = newId("lin")
  await db.estimateLine.create({
    data: {
      id: lineId,
      estimateId: estimate.id,
      quantityId: quantity.id,
      assemblyId: assembly.id,
      currency: estimate.currency,
      lineTotal,
      rateIds: JSON.stringify(rateIdsForComponents(components, resolved)),
      breakdown: JSON.stringify(breakdown),
    },
  })

  await recordEvent({
    projectId: estimate.projectId,
    action: "estimate.line_added",
    entityType: "estimate",
    entityId: estimate.id,
    detail: {
      lineId,
      quantityId: quantity.id,
      assemblyId: assembly.id,
      currency: estimate.currency,
      lineTotal,
    },
  })

  const fresh = await db.estimate.findUnique({ where: { id }, include: { lines: true } })
  return jsonOk({ estimate: serializeEstimate(fresh!, fresh!.lines) }, { status: 201 })
})
