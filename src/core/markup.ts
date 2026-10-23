/**
 * Engineering OS — persistent sheet-markup core (Slice 13, limitation #5).
 *
 * A sheet markup is the PROVENANCE GEOMETRY of a drawing-measured quantity:
 * the points (in PDF-page space, PDF points, y-up) that produced a ledger row
 * — plus standalone calibration markups that make a sheet's scale record
 * durable. The quantity ledger stays the source of truth for VALUES
 * (docs/03-data/artifact-graph-schema.md); markups answer "WHERE on the sheet
 * did this number come from", which a reviewer needs to trust or challenge a
 * takeoff row.
 *
 * Discipline (mirrors src/core/ledger.ts):
 *  - pure TypeScript, no DB / network / filesystem (ADR-0002);
 *  - every rule enforced here, at the boundary, ONCE — the API route parses
 *    the body with zod for SHAPE, then funnels through `makeSheetMarkup` for
 *    domain semantics (the makeQuantityRecord precedent);
 *  - degenerate or inconsistent input throws `MarkupError` whose message the
 *    API returns verbatim as a 422 (never a silent NaN, never a guess);
 *  - the value/geometry CONSISTENCY rule is intentional and strict: a count
 *    markup's value must equal its clicked points, and a symbol-hits markup's
 *    value must equal its hit-box count — the geometry and the number can
 *    never disagree in storage.
 *
 * Kinds and their point semantics (frozen):
 *  - "length"       ≥ 2 points  — polyline vertices; unit "m";   value > 0
 *  - "area"         ≥ 3 points  — polygon vertices (open ring, the
 *                                 renderer closes it visually); unit "m²"; value > 0
 *  - "count"        ≥ 1 point   — one click per counted item; unit "each";
 *                                 value === points.length
 *  - "symbol-hits"  ≥ 2, EVEN   — N pairs [topLeft, bottomRight] of accepted
 *                    template-match boxes, in IMAGE order; unit "each";
 *                                 value === points.length / 2
 *  - "calibration"  EXACTLY 2   — the two scale-bar picks; unit "mm/pt";
 *                                 value = the calibrated mm-per-point factor > 0
 */

import { z } from "zod"

/** Closed kind vocabulary (storage strings, src/core normative). */
export const MARKUP_KINDS = [
  "length",
  "area",
  "count",
  "symbol-hits",
  "calibration",
] as const
export type MarkupKind = (typeof MARKUP_KINDS)[number]

/** Thrown by makeSheetMarkup on out-of-domain input (never NaN, never a guess). */
export class MarkupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MarkupError"
  }
}

/** A point in PDF-page space (matches `Pt` in src/core/measure.ts; y grows up). */
export interface MarkupPoint {
  x: number
  y: number
}

/** The closed kind→unit mapping: every markup originates from the Sheet
 *  Measure surface, whose ledger mapping is length→m, area→m², count→each
 *  (toLedgerQuantity), plus the calibration factor's own unit. */
export function markupUnitFor(kind: MarkupKind): "m" | "m²" | "each" | "mm/pt" {
  switch (kind) {
    case "length":
      return "m"
    case "area":
      return "m²"
    case "count":
    case "symbol-hits":
      return "each"
    case "calibration":
      return "mm/pt"
  }
}

/** Minimum/required point counts per kind (frozen semantics above). */
export function requiredPointsFor(kind: MarkupKind): { min: number; exact: number | null } {
  switch (kind) {
    case "length":
      return { min: 2, exact: null }
    case "area":
      return { min: 3, exact: null }
    case "count":
      return { min: 1, exact: null }
    case "symbol-hits":
      return { min: 2, exact: null } // N pairs → even count ≥ 2 (checked modulo below)
    case "calibration":
      return { min: 2, exact: 2 }
  }
}

/** A validated markup as the API stores and returns it. */
export interface SheetMarkupRecord {
  id: string
  projectId: string
  /** the artifact revision the geometry is drawn on (immutable, like ledger rows) */
  revisionId: string
  /** 1-based PDF page number */
  page: number
  kind: MarkupKind
  points: MarkupPoint[]
  label: string | null
  value: number
  unit: string
  /** the calibration scale record the measurement was taken under (verbatim) */
  scale: string | null
  /** → QuantityRecord.id when the markup produced a ledger row (null for calibration) */
  quantityId: string | null
  createdBy: string
  createdAt: string
}

/** Input accepted by `makeSheetMarkup` (id/projectId supplied by the caller). */
export interface SheetMarkupInput {
  id: string
  projectId: string
  revisionId: string
  page: number
  kind: MarkupKind
  points: MarkupPoint[]
  label?: string
  value: number
  unit: string
  scale?: string
  quantityId?: string
  createdBy: string
  createdAt?: string
}

const nonEmpty = z.string().trim().min(1)

const pointSchema = z.object({
  x: z.number({ message: "point.x must be a number" }).finite(),
  y: z.number({ message: "point.y must be a number" }).finite(),
})

const inputSchema = z.object({
  id: nonEmpty,
  projectId: nonEmpty,
  revisionId: nonEmpty,
  page: z
    .number({ message: "page must be a number" })
    .int("page must be a whole number (1-based)")
    .min(1, "page must be >= 1"),
  kind: z.enum(MARKUP_KINDS, { message: `kind must be one of: ${MARKUP_KINDS.join(", ")}` }),
  points: z.array(pointSchema, { message: "points must be an array of {x, y}" }).min(1, {
    message: "points must not be empty",
  }),
  label: z.string().optional(),
  value: z.number({ message: "value must be a number" }).finite(),
  unit: nonEmpty,
  scale: z.string().optional(),
  quantityId: z.string().optional(),
  createdBy: nonEmpty,
  createdAt: z.string().optional(),
})

/** Finite helper with a name for error messages (the ledger requireFinite pattern). */
function requireFinitePositive(name: string, v: number, where: string): void {
  if (!Number.isFinite(v) || v <= 0) {
    throw new MarkupError(`${where}: ${name} must be a finite number > 0 (got ${v})`)
  }
}

/**
 * Validates and normalizes a sheet markup. Throws `MarkupError` (message is
 * the honest, field-specific reason) on any rule violation — the API maps it
 * to a 422 verbatim. Consistency rules beyond zod shape:
 *  - point count per kind (frozen table above; symbol-hits must be PAIRS);
 *  - unit must equal `markupUnitFor(kind)` (closed vocabulary);
 *  - count: value === points.length; symbol-hits: value === pairs;
 *  - length/area/calibration: value > 0;
 *  - calibration carries NO quantityId (it is not a ledger row);
 *  - label/scale are trimmed; whitespace-only label → null.
 */
export function makeSheetMarkup(input: SheetMarkupInput): SheetMarkupRecord {
  const parsed = inputSchema.safeParse(input)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => {
        const at = issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""
        return `${at}${issue.message}`
      })
      .join("; ")
    throw new MarkupError(`invalid SheetMarkup: ${issues}`)
  }
  const v = parsed.data
  const kind = v.kind as MarkupKind
  const where = "invalid SheetMarkup"

  // -- point-count semantics per kind --------------------------------------
  const { min, exact } = requiredPointsFor(kind)
  if (exact !== null && v.points.length !== exact) {
    throw new MarkupError(
      `${where}: ${kind} markups need exactly ${exact} points (got ${v.points.length})`,
    )
  }
  if (v.points.length < min) {
    throw new MarkupError(
      `${where}: ${kind} markups need at least ${min} points (got ${v.points.length})`,
    )
  }
  if (kind === "symbol-hits" && v.points.length % 2 !== 0) {
    throw new MarkupError(
      `${where}: symbol-hits markups store [topLeft, bottomRight] pairs per hit, so the points count must be even (got ${v.points.length})`,
    )
  }

  // -- unit: the closed kind→unit vocabulary --------------------------------
  const expectedUnit = markupUnitFor(kind)
  if (v.unit !== expectedUnit) {
    throw new MarkupError(`${where}: unit for a ${kind} markup must be "${expectedUnit}" (got "${v.unit}")`)
  }

  // -- value semantics per kind ---------------------------------------------
  if (kind === "count") {
    if (!Number.isInteger(v.value) || v.value < 1) {
      throw new MarkupError(
        `${where}: a count markup's value must be a whole number >= 1 (got ${v.value})`,
      )
    }
    if (v.value !== v.points.length) {
      throw new MarkupError(
        `${where}: a count markup's value must equal its clicked points (${v.points.length}), got ${v.value}`,
      )
    }
  } else if (kind === "symbol-hits") {
    const hits = v.points.length / 2
    if (!Number.isInteger(v.value) || v.value < 1) {
      throw new MarkupError(
        `${where}: a symbol-hits markup's value must be a whole number >= 1 (got ${v.value})`,
      )
    }
    if (v.value !== hits) {
      throw new MarkupError(
        `${where}: a symbol-hits markup's value must equal its hit-box count (${hits}), got ${v.value}`,
      )
    }
  } else if (kind === "length" || kind === "area") {
    requireFinitePositive("value", v.value, where)
  } else {
    // calibration: the mm-per-point factor
    requireFinitePositive("value (mm/pt factor)", v.value, where)
    if (v.quantityId !== undefined && v.quantityId.trim() !== "") {
      throw new MarkupError(
        `${where}: a calibration markup is not a ledger row — quantityId must be omitted`,
      )
    }
  }

  const label = (v.label ?? "").trim()
  const scale = (v.scale ?? "").trim()

  return {
    id: v.id,
    projectId: v.projectId,
    revisionId: v.revisionId,
    page: v.page,
    kind,
    points: v.points,
    label: label.length > 0 ? label : null,
    value: v.value,
    unit: expectedUnit,
    scale: scale.length > 0 ? scale : null,
    quantityId:
      kind === "calibration"
        ? null
        : v.quantityId !== undefined && v.quantityId.trim() !== ""
          ? v.quantityId.trim()
          : null,
    createdBy: v.createdBy,
    createdAt: v.createdAt ?? new Date().toISOString(),
  }
}
