import { jsonOk, ERR } from "@/lib/api-utils"
import { db } from "@/lib/db"

import { handler } from "../../../_lib/route-helpers"
import { buildBoqCsv, type BoqLineInput } from "../../../_lib/boq-csv"
import {
  estimateRounding,
  findEstimateWithLines,
  serializeEstimate,
  sourceArtifactsByRevision,
} from "../../../_lib/ledger-rows"

export const dynamic = "force-dynamic"

const BOQ_FORMATS = ["csv", "json"] as const

/** Totals exactly as serializeEstimate computes them (single source of truth). */
interface SerializedTotals {
  linesSubtotal: number
  overhead: number
  profit: number
  tax: number
  grandTotal: number
  currency: string
}

/**
 * GET /api/estimates/[id]/export?format=csv|json — BOQ export.
 *
 * READ-ONLY (no audit event, consistent with every other read route). Only
 * approved estimates can be exported; `format` is required. All joins happen
 * here (the builder in _lib/boq-csv.ts stays pure); every join that no longer
 * resolves degrades to an honest "unknown" instead of a fabricated value.
 */
export const GET = handler<{ id: string }>(async (req, ctx) => {
  const { id } = await ctx.params

  const estimate = await findEstimateWithLines(id)
  if (!estimate) return ERR.notFound("Estimate")

  const format = new URL(req.url).searchParams.get("format")
  if (format === null || format === "") {
    return ERR.invalid("format is required (must be one of: csv, json)")
  }
  if (!(BOQ_FORMATS as readonly string[]).includes(format)) {
    return ERR.invalid(`format must be one of: ${BOQ_FORMATS.join(", ")} (got "${format}")`)
  }

  if (estimate.status !== "approved") {
    return ERR.invalid(
      `only approved estimates can be exported as a BOQ (this estimate is "${estimate.status}")`,
    )
  }

  // Lines in createdAt order (same comparator as serializeEstimate) — the
  // export rows keep the estimate's own ordering, seq = 1..N.
  const lines = [...estimate.lines].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  )

  // --- joins (route lane; never in the pure builder) -------------------------
  const quantityIds = [...new Set(lines.map((l) => l.quantityId))]
  const quantities = quantityIds.length
    ? await db.quantityRecord.findMany({ where: { id: { in: quantityIds } } })
    : []
  const quantityById = new Map(quantities.map((q) => [q.id, q]))

  const assemblyIds = [...new Set(lines.map((l) => l.assemblyId))]
  const assemblies = assemblyIds.length
    ? await db.tradeAssembly.findMany({ where: { id: { in: assemblyIds } } })
    : []
  const assemblyById = new Map(assemblies.map((a) => [a.id, a]))

  const artifactByRevision = await sourceArtifactsByRevision(
    quantities.map((q) => q.sourceArtifactRevisionId),
  )

  const rows: BoqLineInput[] = lines.map((line, index) => {
    const quantity = quantityById.get(line.quantityId) ?? null
    const assembly = assemblyById.get(line.assemblyId) ?? null
    const artifact = quantity
      ? artifactByRevision.get(quantity.sourceArtifactRevisionId) ?? null
      : null

    const assemblyName = assembly?.name ?? "unknown"
    const artifactName = artifact?.name ?? "unknown"
    const ref =
      quantity?.elementRef ?? quantity?.sheetRef ?? quantity?.quantityType ?? "unknown"
    const description = `${assemblyName} — ${artifactName} (${ref})`

    return {
      seq: index + 1,
      description,
      quantityValue: quantity?.value ?? null,
      quantityUnit: quantity?.unit ?? null,
      assemblyName,
      lineTotal: line.lineTotal,
    }
  })

  // Totals: reuse serializeEstimate's recomputation verbatim (never a second
  // implementation of the pinned formula).
  const serialized = serializeEstimate(estimate, estimate.lines)
  const totals = serialized.totals as SerializedTotals

  const generatedAt = new Date().toISOString()
  const project = await db.project.findUnique({
    where: { id: estimate.projectId },
    select: { id: true, name: true },
  })

  if (format === "csv") {
    const csv = buildBoqCsv({
      projectName: project?.name ?? "unknown",
      estimateName: estimate.name,
      currency: estimate.currency,
      overheadPct: estimate.overheadPct,
      profitPct: estimate.profitPct,
      taxPct: estimate.taxPct,
      totals: {
        subtotal: totals.linesSubtotal,
        overhead: totals.overhead,
        profit: totals.profit,
        tax: totals.tax,
        grandTotal: totals.grandTotal,
      },
      roundingMode: estimate.roundingMode,
      roundingDecimals: estimate.roundingDecimals,
      generatedAt,
      lines: rows,
    })
    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="boq-${estimate.id}.csv"`,
      },
    })
  }

  return jsonOk({
    boq: { project: { id: project?.id ?? "unknown", name: project?.name ?? "unknown" } },
    estimate: {
      id: estimate.id,
      name: estimate.name,
      status: estimate.status,
      currency: estimate.currency,
      rounding: estimateRounding(estimate),
    },
    lines: rows,
    totals,
    generatedAt,
  })
})
