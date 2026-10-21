import { z } from "zod"

import {
  LedgerError,
  estimateLineTotal,
  roundTo,
  type EstimateComponent,
  type Rate,
  type RateSource,
} from "@/core"
import { recordEvent } from "@/lib/audit"
import { jsonOk, ERR, parseBody } from "@/lib/api-utils"
import { db } from "@/lib/db"
import { newId } from "@/lib/ids"

import { handler } from "../../../_lib/route-helpers"
import { estimateRounding, serializeEstimate } from "../../../_lib/ledger-rows"

export const dynamic = "force-dynamic"

const addLineSchema = z.object({
  quantityId: z.string().min(1, "quantityId is required"),
  assemblyId: z.string().min(1, "assemblyId is required"),
})

/** Stored assembly component: core EstimateComponent + the required name. */
type AssemblyComponent = EstimateComponent & { name: string }

/** Component cost evidence stored per line (mirrors estimateLineTotal's math). */
interface LineBreakdownEntry {
  componentId: string
  kind: string
  name: string
  amount: number
  unit: string
  unitPrice: number
  cost: number
}

/**
 * Resolve the LATEST rate per assembly component (createdAt desc; prefer
 * effectiveFrom ≤ now). Deterministic preference order: among the component's
 * rates, already-effective (or undated) ones win over future-dated ones, then
 * the newest createdAt wins. Returns the missing components alongside.
 */
async function resolveRates(
  projectId: string,
  components: AssemblyComponent[],
  now: Date,
): Promise<{ resolved: Map<string, { id: string; currency: string; unitPrice: number; source: RateSource }>; missing: AssemblyComponent[] }> {
  const componentIds = [...new Set(components.map((c) => c.id))]
  const rates = componentIds.length
    ? await db.rate.findMany({
        where: { projectId, componentId: { in: componentIds } },
        orderBy: { createdAt: "desc" },
      })
    : []
  const byComponent = new Map<string, typeof rates>()
  for (const rate of rates) {
    const list = byComponent.get(rate.componentId)
    if (list) list.push(rate)
    else byComponent.set(rate.componentId, [rate])
  }

  const resolved = new Map<string, { id: string; currency: string; unitPrice: number; source: RateSource }>()
  const missing: AssemblyComponent[] = []
  for (const component of components) {
    const candidates = byComponent.get(component.id) ?? []
    if (candidates.length === 0) {
      missing.push(component)
      continue
    }
    // candidates are createdAt-desc; the first already-effective one is the
    // LATEST effective rate. Future-dated rates are a fallback (never silent:
    // an engineer can see which rate id was used via rateIds).
    const effective = candidates.find((r) => r.effectiveFrom === null || r.effectiveFrom <= now)
    const chosen = effective ?? candidates[0]
    resolved.set(component.id, {
      id: chosen.id,
      currency: chosen.currency,
      unitPrice: chosen.unitPrice,
      // DB invariant: rate POST validates source against RATE_SOURCES
      source: chosen.source as RateSource,
    })
  }
  return { resolved, missing }
}

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
    return ERR.invalid(
      missing
        .map((c) => `missing rate for component ${c.id} (${c.name})`)
        .join("; "),
    )
  }

  // All resolved rate currencies must equal the estimate currency (a mixed
  // line is a modeling error, not a number — mirrored by estimateLineTotal).
  const currencyMismatches = components.filter(
    (c) => resolved.get(c.id)?.currency !== estimate.currency,
  )
  if (currencyMismatches.length > 0) {
    return ERR.invalid(
      currencyMismatches
        .map(
          (c) =>
            `component ${c.id} (${c.name}) is rated in ${resolved.get(c.id)?.currency} but estimate "${estimate.name}" is in ${estimate.currency}`,
        )
        .join("; "),
    )
  }

  const ratesByKey: Record<string, Rate> = Object.fromEntries(
    components.map((c) => {
      const rate = resolved.get(c.id)!
      return [
        c.id,
        { id: rate.id, currency: rate.currency, unitPrice: rate.unitPrice, source: rate.source },
      ]
    }),
  )

  // lineTotal via src/core (authoritative); the breakdown below mirrors the
  // SAME documented arithmetic so per-component evidence always adds up.
  let lineTotal: number
  try {
    lineTotal = estimateLineTotal(
      { value: quantity.value },
      { id: assembly.id, name: assembly.name, components },
      ratesByKey,
      rounding,
    )
  } catch (err) {
    if (err instanceof LedgerError) {
      console.error("[api] stored assembly failed line arithmetic:", err.message)
      return ERR.invalid(err.message)
    }
    throw err
  }

  const breakdown: LineBreakdownEntry[] = components.map((component) => {
    const rate = resolved.get(component.id)!
    const wasteMultiplier = 1 + (component.wastePct ?? 0) / 100
    const productivityDivisor = component.productivityFactor ?? 1
    const amount = (quantity.value * component.quantityPerUnit * wasteMultiplier) / productivityDivisor
    const cost = roundTo(amount * rate.unitPrice, rounding)
    return {
      componentId: component.id,
      kind: component.kind,
      name: component.name,
      amount,
      unit: component.unit,
      unitPrice: rate.unitPrice,
      cost,
    }
  })

  const lineId = newId("lin")
  await db.estimateLine.create({
    data: {
      id: lineId,
      estimateId: estimate.id,
      quantityId: quantity.id,
      assemblyId: assembly.id,
      currency: estimate.currency,
      lineTotal,
      rateIds: JSON.stringify(components.map((c) => resolved.get(c.id)!.id)),
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
