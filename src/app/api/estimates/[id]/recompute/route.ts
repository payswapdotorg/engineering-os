import { recordEvent } from "@/lib/audit"
import { jsonOk, ERR } from "@/lib/api-utils"
import { db } from "@/lib/db"
import { newId } from "@/lib/ids"
import { LedgerError, estimateLineTotal } from "@/core"

import { handler, requireEntityProject } from "../../../_lib/route-helpers"
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

/**
 * POST /api/estimates/[id]/recompute — the known-limitation-#7 closure
 * (contract §9). A POST carries an empty body (the route ignores it, like the
 * derive routes do); the request itself is the recompute command.
 *
 * Gates, in order:
 *  1. unknown estimate → 404;
 *  2. only `approved` estimates recompute, else 422 verbatim
 *     `only approved estimates can be recomputed into a revised draft (this
 *     estimate is "<status>")`;
 *  3. staleness gate: at least one source artifact behind the estimate's
 *     quantity rows must be stale, else 422 verbatim `nothing to recompute: no
 *     quantity source behind this estimate is stale`. "Stale" reuses the
 *     Journey-G machinery exactly as the mesh route computes live staleness
 *     (mesh-meta computeStaleSource's two clauses, applied per cited source
 *     revision): the cited revision's own staleness mark left "current" (the
 *     existing cascade marked it because the source artifact is itself
 *     downstream of a change) OR the cited revision is no longer the source
 *     artifact's latest revision (the model moved on — the "new takeoff"
 *     story). Zero new graph code.
 *
 * Effect — create a NEW draft estimate (all-or-nothing; nothing is written
 * unless every line rebuilds):
 *  - title `<original> — revised draft`, same project, pricing config copied
 *    (currency, percentages, rounding);
 *  - ONE line per original line, in original line order: the line's QUANTITY is
 *    re-resolved to the CURRENT row of its takeoff slot (same source artifact,
 *    same method, elementRef, sheetRef and quantityType — ids like IFC GUIDs and
 *    sheet refs are stable across revisions of one artifact — choosing the
 *    latest non-superseded row of that slot: the original row itself when
 *    nothing newer exists, the re-derived row when a new takeoff ran), and it
 *    is priced at CURRENTLY-effective rates via the SHARED pricing helpers of
 *    the estimate-creation flow (resolveRates + estimateLineTotal + the
 *    breakdown mirror — the math is not forked; chosen rate ids are stored per
 *    line);
 *  - the original estimate is untouched (stays approved, its lines frozen);
 *  - totals via the existing estimateTotals core (recomputed on every read by
 *    serializeEstimate, never stored).
 *
 * The recomputed draft flows through the EXISTING estimate machinery
 * (in_review → approve → export). Exactly ONE `estimate.recomputed
 * {action:"recompute", fromEstimateId, staleSourceArtifactIds, newDraftId}`
 * audit event; the from→new link lives in the audit trail + title convention
 * (no estimate-model schema change — contract-ratified).
 */
export const POST = handler<{ id: string }>(async (_req, ctx) => {
  const { id } = await ctx.params

  const estimate = await db.estimate.findUnique({ where: { id }, include: { lines: true } })
  if (!estimate) return ERR.notFound("Estimate")

  // Slice 10: project isolation (contract §4)
  const access = await requireEntityProject(estimate, "Estimate", "write")
  if (!access.ok) return access.response

  if (estimate.status !== "approved") {
    return ERR.invalid(
      `only approved estimates can be recomputed into a revised draft (this estimate is "${estimate.status}")`,
    )
  }

  // Deterministic original-line order (serializeEstimate's order: createdAt).
  const sortedLines = [...estimate.lines].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )

  // ---- Staleness gate: the Journey-G marks, per cited source revision ------
  const quantityIds = [...new Set(sortedLines.map((line) => line.quantityId))]
  const quantities = quantityIds.length
    ? await db.quantityRecord.findMany({ where: { id: { in: quantityIds } } })
    : []
  const quantityById = new Map(quantities.map((row) => [row.id, row]))

  const citedRevisionIds = [...new Set(quantities.map((row) => row.sourceArtifactRevisionId))]
  const citedRevisions = citedRevisionIds.length
    ? await db.artifactRevision.findMany({
        where: { id: { in: citedRevisionIds } },
        select: {
          id: true,
          staleness: true,
          artifactId: true,
          artifact: { select: { id: true, latestRevisionId: true } },
        },
      })
    : []
  const revisionById = new Map(citedRevisions.map((rev) => [rev.id, rev]))

  const staleSourceArtifactIds: string[] = []
  const seenStaleArtifacts = new Set<string>()
  const seenCitations = new Set<string>()
  for (const line of sortedLines) {
    const quantity = quantityById.get(line.quantityId)
    if (!quantity) continue // the rebuild below refuses honestly on missing rows
    const revision = revisionById.get(quantity.sourceArtifactRevisionId)
    if (!revision || seenCitations.has(revision.id)) continue
    seenCitations.add(revision.id)
    // computeStaleSource's clauses: the cited revision's own mark, or the
    // source artifact has moved on to a newer revision since the takeoff.
    const stale =
      revision.staleness !== "current" || revision.id !== revision.artifact.latestRevisionId
    if (stale && !seenStaleArtifacts.has(revision.artifactId)) {
      seenStaleArtifacts.add(revision.artifactId)
      staleSourceArtifactIds.push(revision.artifactId)
    }
  }

  if (staleSourceArtifactIds.length === 0) {
    return ERR.invalid("nothing to recompute: no quantity source behind this estimate is stale")
  }

  // ---- Rebuild: CURRENT quantity rows, CURRENTLY-effective rates -----------
  const projectId = estimate.projectId
  const rounding = estimateRounding(estimate)
  const now = new Date()

  // All revisions of every cited source artifact (the successor pool per slot).
  const sourceArtifactIds = [...new Set(citedRevisions.map((rev) => rev.artifactId))]
  const artifactRevisions = sourceArtifactIds.length
    ? await db.artifactRevision.findMany({
        where: { artifactId: { in: sourceArtifactIds } },
        select: { artifactId: true, id: true },
      })
    : []
  const revisionsByArtifact = new Map<string, string[]>()
  for (const rev of artifactRevisions) {
    const list = revisionsByArtifact.get(rev.artifactId)
    if (list) list.push(rev.id)
    else revisionsByArtifact.set(rev.artifactId, [rev.id])
  }

  interface RebuiltLine {
    quantityId: string
    assemblyId: string
    lineTotal: number
    rateIds: string[]
    breakdown: ReturnType<typeof buildLineBreakdown>
  }
  const rebuilt: RebuiltLine[] = []

  for (const line of sortedLines) {
    const original = quantityById.get(line.quantityId)
    if (!original) {
      return ERR.invalid(
        `line "${line.id}" cannot be rebuilt: quantity "${line.quantityId}" is missing from the ledger`,
      )
    }
    const cited = revisionById.get(original.sourceArtifactRevisionId)
    if (!cited) {
      return ERR.invalid(
        `line "${line.id}" cannot be rebuilt: the source revision behind quantity "${original.id}" is missing`,
      )
    }

    // The CURRENT row of this line's takeoff slot: rows of the SAME source
    // artifact with the same (method, elementRef, sheetRef, quantityType),
    // not superseded — latest createdAt wins, id breaks ties. The original
    // row itself is the degenerate successor when nothing newer exists.
    const pool = revisionsByArtifact.get(cited.artifactId) ?? []
    const candidates = pool.length
      ? await db.quantityRecord.findMany({
          where: {
            projectId,
            sourceArtifactRevisionId: { in: pool },
            method: original.method,
            elementRef: original.elementRef,
            sheetRef: original.sheetRef,
            quantityType: original.quantityType,
            status: { not: "superseded" },
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        })
      : []
    const current = candidates[0]
    if (!current) {
      return ERR.invalid(
        `line "${line.id}" cannot be rebuilt: no current ledger row for the takeoff slot of quantity "${original.id}"`,
      )
    }

    const assembly = await db.tradeAssembly.findUnique({ where: { id: line.assemblyId } })
    if (!assembly || assembly.projectId !== projectId) {
      return ERR.invalid(
        `line "${line.id}" cannot be rebuilt: assembly "${line.assemblyId}" is missing from this project`,
      )
    }
    const components = JSON.parse(assembly.components) as AssemblyComponent[]

    // SAME pricing path as the estimate-creation flow (shared _lib helpers —
    // the math is not forked): resolve CURRENTLY-effective rates, refuse
    // missing rates and currency mismatches with the pinned line messages.
    const { resolved, missing } = await resolveRates(projectId, components, now)
    if (missing.length > 0) {
      return ERR.invalid(missingRatesMessage(missing))
    }
    const currencyMismatches = components.filter(
      (c) => resolved.get(c.id)?.currency !== estimate.currency,
    )
    if (currencyMismatches.length > 0) {
      return ERR.invalid(
        currencyMismatchMessage(currencyMismatches, resolved, estimate.name, estimate.currency),
      )
    }

    let lineTotal: number
    try {
      lineTotal = estimateLineTotal(
        { value: current.value },
        { id: assembly.id, name: assembly.name, components },
        ratesByKey(components, resolved),
        rounding,
      )
    } catch (err) {
      if (err instanceof LedgerError) {
        console.error("[api] recompute failed line arithmetic:", err.message)
        return ERR.invalid(err.message)
      }
      throw err
    }

    rebuilt.push({
      quantityId: current.id,
      assemblyId: assembly.id,
      lineTotal,
      rateIds: rateIdsForComponents(components, resolved),
      breakdown: buildLineBreakdown(current.value, components, resolved, rounding),
    })
  }

  // ---- Create the revised draft (all-or-nothing) ---------------------------
  const newDraftId = newId("est")
  await db.$transaction(async (tx) => {
    await tx.estimate.create({
      data: {
        id: newDraftId,
        projectId,
        name: `${estimate.name} — revised draft`,
        currency: estimate.currency,
        overheadPct: estimate.overheadPct,
        profitPct: estimate.profitPct,
        taxPct: estimate.taxPct,
        roundingMode: estimate.roundingMode,
        roundingDecimals: estimate.roundingDecimals,
        status: "draft",
        createdBy: "local-operator",
      },
    })
    for (const line of rebuilt) {
      await tx.estimateLine.create({
        data: {
          id: newId("lin"),
          estimateId: newDraftId,
          quantityId: line.quantityId,
          assemblyId: line.assemblyId,
          currency: estimate.currency,
          lineTotal: line.lineTotal,
          rateIds: JSON.stringify(line.rateIds),
          breakdown: JSON.stringify(line.breakdown),
        },
      })
    }
  })

  // Exactly ONE audit event — the from→new link lives here + in the title.
  await recordEvent({
    projectId,
    action: "estimate.recomputed",
    entityType: "estimate",
    entityId: newDraftId,
    detail: {
      action: "recompute",
      fromEstimateId: estimate.id,
      staleSourceArtifactIds,
      newDraftId,
    },
  })

  const fresh = await db.estimate.findUnique({ where: { id: newDraftId }, include: { lines: true } })
  return jsonOk({ estimate: serializeEstimate(fresh!, fresh!.lines) }, { status: 201 })
})
