/**
 * Shared row→JSON serializers for the Phase-3 quantity-ledger & estimating
 * routes (W3 lane). Private folder: Next.js never maps `_*` folders to routes.
 *
 * The DB stores nested objects (verification, approval, provenance, components,
 * breakdown, rateIds) as JSON text per the schema header convention; these
 * helpers parse them back and emit the EXACT contract shapes pinned in
 * worklog.md ("TL-pinned contracts"): QuantityRow, AssemblyRow, RateRow,
 * EstimateRow, EstimateLineRow. Totals are ALWAYS recomputed here from stored
 * lineTotals (never stored, never stale).
 */
import { estimateTotals, type RoundingMode, type RoundingRule } from "@/core"
import { db } from "@/lib/db"

// ---------------------------------------------------------------------------
// Structural DB-row shapes (kept local so this module compiles without the
// generated Prisma namespace; the generated rows are assignable to these)
// ---------------------------------------------------------------------------

export interface QuantityDbRow {
  id: string
  projectId: string
  sourceArtifactRevisionId: string
  sheetRef: string | null
  elementRef: string | null
  quantityType: string
  value: number
  unit: string
  method: string
  scale: string | null
  quantityMethod: string | null
  rulesetId: string
  rulesetVersion: string
  status: string
  tradeAssemblyId: string | null
  verification: string
  reviewer: string | null
  approval: string | null
  provenance: string
  createdAt: Date
}

export interface AssemblyDbRow {
  id: string
  projectId: string
  name: string
  trade: string
  components: string
  createdAt: Date
}

export interface RateDbRow {
  id: string
  projectId: string
  componentId: string
  currency: string
  unitPrice: number
  source: string
  effectiveFrom: Date | null
  createdBy: string
  createdAt: Date
}

export interface EstimateDbRow {
  id: string
  projectId: string
  name: string
  currency: string
  overheadPct: number
  profitPct: number
  taxPct: number
  roundingMode: string
  roundingDecimals: number
  status: string
  approval: string | null
  createdBy: string
  createdAt: Date
}

export interface EstimateLineDbRow {
  id: string
  estimateId: string
  quantityId: string
  assemblyId: string
  currency: string
  lineTotal: number
  rateIds: string
  breakdown: string
  createdAt: Date
}

// ---------------------------------------------------------------------------
// Quantities — QuantityRow = serialized QuantityRecord + sourceArtifact join
// ---------------------------------------------------------------------------

export interface SourceArtifactJoin {
  id: string
  name: string
  kind: string
  revNumber: number
}

/** Serialized `QuantityRecord` + joined sourceArtifact, exactly per contract. */
export function serializeQuantity(
  row: QuantityDbRow,
  sourceArtifact: SourceArtifactJoin | null,
): Record<string, unknown> {
  return {
    id: row.id,
    projectId: row.projectId,
    sourceArtifactRevisionId: row.sourceArtifactRevisionId,
    sheetRef: row.sheetRef ?? undefined,
    elementRef: row.elementRef ?? undefined,
    quantityType: row.quantityType,
    value: row.value,
    unit: row.unit,
    method: row.method,
    scale: row.scale ?? undefined,
    quantityMethod: row.quantityMethod ?? undefined,
    rulesetId: row.rulesetId,
    rulesetVersion: row.rulesetVersion,
    status: row.status,
    tradeAssemblyId: row.tradeAssemblyId ?? undefined,
    verification: JSON.parse(row.verification),
    reviewer: row.reviewer ?? undefined,
    approval: row.approval ? JSON.parse(row.approval) : undefined,
    provenance: JSON.parse(row.provenance),
    sourceArtifact,
  }
}

/**
 * sourceArtifact join: `{ id, name, kind, revNumber }` of the artifact the
 * source revision belongs to (ledger rows point at revisions, never at the
 * mutable artifact). Null when the revision no longer resolves.
 */
export async function sourceArtifactsByRevision(
  revisionIds: string[],
): Promise<Map<string, SourceArtifactJoin>> {
  const unique = [...new Set(revisionIds)]
  if (unique.length === 0) return new Map()
  const revisions = await db.artifactRevision.findMany({
    where: { id: { in: unique } },
    select: {
      id: true,
      revNumber: true,
      artifact: { select: { id: true, name: true, kind: true } },
    },
  })
  return new Map(
    revisions.map((rev) => [
      rev.id,
      {
        id: rev.artifact.id,
        name: rev.artifact.name,
        kind: rev.artifact.kind,
        revNumber: rev.revNumber,
      },
    ]),
  )
}

/** Serialize a batch of quantity rows with their sourceArtifact joins. */
export async function serializeQuantityRows(
  rows: QuantityDbRow[],
): Promise<Record<string, unknown>[]> {
  const joins = await sourceArtifactsByRevision(rows.map((r) => r.sourceArtifactRevisionId))
  return rows.map((row) => serializeQuantity(row, joins.get(row.sourceArtifactRevisionId) ?? null))
}

// ---------------------------------------------------------------------------
// Assemblies & rates — components stored as JSON text
// ---------------------------------------------------------------------------

export function serializeAssembly(row: AssemblyDbRow): Record<string, unknown> {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    trade: row.trade,
    components: JSON.parse(row.components),
    createdAt: row.createdAt.toISOString(),
  }
}

export function serializeRate(row: RateDbRow): Record<string, unknown> {
  return {
    id: row.id,
    projectId: row.projectId,
    componentId: row.componentId,
    currency: row.currency,
    unitPrice: row.unitPrice,
    source: row.source,
    effectiveFrom: row.effectiveFrom ? row.effectiveFrom.toISOString() : undefined,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Estimates — EstimateRow with ALWAYS-recomputed totals
// ---------------------------------------------------------------------------

export function estimateRounding(row: Pick<EstimateDbRow, "roundingMode" | "roundingDecimals">): RoundingRule {
  return { mode: row.roundingMode as RoundingMode, decimals: row.roundingDecimals }
}

/**
 * EstimateRow per contract: lines ordered by creation, totals recomputed from
 * stored lineTotals via the pinned `estimateTotals` formula. Nothing here is
 * cached — every read/mutation goes through this function.
 */
export function serializeEstimate(
  row: EstimateDbRow,
  lines: EstimateLineDbRow[],
): Record<string, unknown> {
  const sortedLines = [...lines].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  )
  const totals = estimateTotals(
    sortedLines.map((line) => line.lineTotal),
    { overheadPct: row.overheadPct, profitPct: row.profitPct, taxPct: row.taxPct },
    estimateRounding(row),
  )
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    currency: row.currency,
    overheadPct: row.overheadPct,
    profitPct: row.profitPct,
    taxPct: row.taxPct,
    rounding: estimateRounding(row),
    status: row.status,
    approval: row.approval ? JSON.parse(row.approval) : undefined,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    lines: sortedLines.map((line) => ({
      id: line.id,
      estimateId: line.estimateId,
      quantityId: line.quantityId,
      assemblyId: line.assemblyId,
      currency: line.currency,
      lineTotal: line.lineTotal,
      rateIds: JSON.parse(line.rateIds),
      breakdown: JSON.parse(line.breakdown),
      createdAt: line.createdAt.toISOString(),
    })),
    totals: { ...totals, currency: row.currency },
  }
}

/** Fetch an estimate with its lines (or null when missing). */
export async function findEstimateWithLines(estimateId: string) {
  return db.estimate.findUnique({
    where: { id: estimateId },
    include: { lines: true },
  })
}
