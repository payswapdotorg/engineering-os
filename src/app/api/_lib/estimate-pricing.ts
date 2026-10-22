/**
 * Shared estimate line-building & pricing helpers (W3-f lane, Phase 5).
 * Private folder: Next.js never maps `_*` folders to routes.
 *
 * `resolveRates`, the breakdown mirror and the pinned message builders were
 * extracted VERBATIM from POST /api/estimates/[id]/lines (Phase-3 route) so the
 * Phase-5 recompute route (contract §9) can rebuild lines WITHOUT forking the
 * pricing math — one implementation, byte-identical messages, same
 * deterministic preference order (already-effective rates win over
 * future-dated ones, then newest createdAt).
 *
 * The lines route keeps its exact control flow and HTTP behavior; only the
 * helpers moved here (byte-stable refactor — the strings below are pinned by
 * scripts/e2e-takeoff.sh).
 */

import {
  roundTo,
  type EstimateComponent,
  type Rate,
  type RateSource,
  type RoundingRule,
} from "@/core"
import { db } from "@/lib/db"

/** Stored assembly component: core EstimateComponent + the required name. */
export type AssemblyComponent = EstimateComponent & { name: string }

/** Component cost evidence stored per line (mirrors estimateLineTotal's math).
 * `futureDatedRate: true` appears ONLY on components priced by a rate whose
 * effectiveFrom is in the future (Phase-6 known-limitation #9 — additive key,
 * never present on already-effective rates). */
export interface LineBreakdownEntry {
  componentId: string
  kind: string
  name: string
  amount: number
  unit: string
  unitPrice: number
  cost: number
  futureDatedRate?: true
}

export interface ResolvedRate {
  id: string
  currency: string
  unitPrice: number
  source: RateSource
  /** Set when this rate was chosen from the future-dated fallback branch. */
  futureDatedRate?: true
}

export type ResolvedRates = Map<string, ResolvedRate>

/**
 * Resolve the LATEST rate per assembly component (createdAt desc; prefer
 * effectiveFrom ≤ now). Deterministic preference order: among the component's
 * rates, already-effective (or undated) ones win over future-dated ones, then
 * the newest createdAt wins. Returns the missing components alongside.
 */
export async function resolveRates(
  projectId: string,
  components: AssemblyComponent[],
  now: Date,
): Promise<{ resolved: ResolvedRates; missing: AssemblyComponent[] }> {
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

  const resolved = new Map<string, ResolvedRate>()
  const missing: AssemblyComponent[] = []
  for (const component of components) {
    const candidates = byComponent.get(component.id) ?? []
    if (candidates.length === 0) {
      missing.push(component)
      continue
    }
    // candidates are createdAt-desc; the first already-effective one is the
    // LATEST effective rate. Future-dated rates are a fallback (never silent:
    // an engineer can see which rate id was used via rateIds, and the line
    // breakdown carries the additive `futureDatedRate: true` marker —
    // Phase-6 known-limitation #9, contract §1.7).
    const effective = candidates.find((r) => r.effectiveFrom === null || r.effectiveFrom <= now)
    const chosen = effective ?? candidates[0]
    const futureDated = !effective && (chosen.effectiveFrom?.getTime() ?? 0) > now.getTime()
    resolved.set(component.id, {
      id: chosen.id,
      currency: chosen.currency,
      unitPrice: chosen.unitPrice,
      // DB invariant: rate POST validates source against RATE_SOURCES
      source: chosen.source as RateSource,
      ...(futureDated ? { futureDatedRate: true } : {}),
    })
  }
  return { resolved, missing }
}

/** Pinned 422 message when components have no rate (verbatim from the lines route). */
export function missingRatesMessage(missing: AssemblyComponent[]): string {
  return missing.map((c) => `missing rate for component ${c.id} (${c.name})`).join("; ")
}

/** Pinned 422 message for rate/estimate currency mismatches (verbatim). */
export function currencyMismatchMessage(
  mismatches: AssemblyComponent[],
  resolved: ResolvedRates,
  estimateName: string,
  estimateCurrency: string,
): string {
  return mismatches
    .map(
      (c) =>
        `component ${c.id} (${c.name}) is rated in ${resolved.get(c.id)?.currency} but estimate "${estimateName}" is in ${estimateCurrency}`,
    )
    .join("; ")
}

/** Core `Rate` map keyed by component id (estimateLineTotal's input shape). */
export function ratesByKey(components: AssemblyComponent[], resolved: ResolvedRates): Record<string, Rate> {
  return Object.fromEntries(
    components.map((c) => {
      const rate = resolved.get(c.id)!
      return [
        c.id,
        { id: rate.id, currency: rate.currency, unitPrice: rate.unitPrice, source: rate.source },
      ] as const
    }),
  )
}

/** Chosen rate ids in assembly component order (stored per line as JSON). */
export function rateIdsForComponents(components: AssemblyComponent[], resolved: ResolvedRates): string[] {
  return components.map((c) => resolved.get(c.id)!.id)
}

/**
 * Component cost evidence per line — mirrors estimateLineTotal's documented
 * arithmetic (amount = value × quantityPerUnit × waste ÷ productivity, cost =
 * roundTo(amount × unitPrice)) so per-component figures always add up.
 */
export function buildLineBreakdown(
  quantityValue: number,
  components: AssemblyComponent[],
  resolved: ResolvedRates,
  rounding: RoundingRule,
): LineBreakdownEntry[] {
  return components.map((component) => {
    const rate = resolved.get(component.id)!
    const wasteMultiplier = 1 + (component.wastePct ?? 0) / 100
    const productivityDivisor = component.productivityFactor ?? 1
    const amount = (quantityValue * component.quantityPerUnit * wasteMultiplier) / productivityDivisor
    const cost = roundTo(amount * rate.unitPrice, rounding)
    return {
      componentId: component.id,
      kind: component.kind,
      name: component.name,
      amount,
      unit: component.unit,
      unitPrice: rate.unitPrice,
      cost,
      ...(rate.futureDatedRate ? { futureDatedRate: true } : {}),
    }
  })
}
