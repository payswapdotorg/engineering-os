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
 *  - "text-hits"    ≥ 2, EVEN   — N pairs [topLeft, bottomRight] of accepted
 *                    OCR word boxes (Slice 16-B sheet-text OCR), in IMAGE
 *                    order; unit "each"; value === points.length / 2; the
 *                    transcript itself rides the row's payload JSON (route-
 *                    validated), never the points — geometry stays {x,y} only
 *  - "calibration"  EXACTLY 2   — the two scale-bar picks; unit "mm/pt";
 *                                 value = the calibrated mm-per-point factor > 0
 *
 * Slice 18 — region cutouts: a kind "area" markup may carry a `cutouts`
 * structure (the payload the API stores alongside the row). `points` stays
 * the REGION ring; `cutouts.rings` are the cutout rings drawn strictly
 * inside it (src/core/measure.ts §2.2 owns the geometry rules); `value` MUST
 * equal the recomputed NET area in m² — the server re-derives every number
 * from the geometry under `cutouts.mmPerPt`, so the geometry and the number
 * can never disagree in storage (the count/symbol-hits discipline, applied
 * to derived areas). The gross/cutout/net breakdown the client displays is
 * re-verified, not trusted.
 */

import { z } from "zod"

import { areaWithCutouts, type Pt } from "./measure"

/** Closed kind vocabulary (storage strings, src/core normative). */
export const MARKUP_KINDS = [
  "length",
  "area",
  "count",
  "symbol-hits",
  "text-hits",
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
    case "text-hits":
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
    case "text-hits":
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
  /** Slice 18: the validated cutouts structure (null unless kind "area" with cutouts) */
  cutouts: SheetMarkupCutouts | null
  createdBy: string
  createdAt: string
}

/**
 * The Slice 18 cutouts structure (kind "area" only): the rings, the
 * calibration factor the measurement was taken under, and the m² breakdown
 * the client computed. The core re-derives all three areas from the geometry
 * and refuses any disagreement (values are LEDGER units — m², the same
 * toLedgerQuantity arithmetic: mm² / 1e6).
 */
export interface SheetMarkupCutouts {
  rings: MarkupPoint[][]
  mmPerPt: number
  grossValue: number
  cutoutValue: number
  netValue: number
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
  /** Slice 18: present only for an area-with-cutouts markup. */
  cutouts?: SheetMarkupCutouts
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
  cutouts: z
    .object({
      rings: z.array(z.array(pointSchema, { message: "cutouts.rings[] must be an array of {x, y}" }).min(3, {
        message: "cutouts.rings[] must have at least 3 points",
      })),
      mmPerPt: z.number({ message: "cutouts.mmPerPt must be a number" }).finite(),
      grossValue: z.number({ message: "cutouts.grossValue must be a number" }).finite(),
      cutoutValue: z.number({ message: "cutouts.cutoutValue must be a number" }).finite(),
      netValue: z.number({ message: "cutouts.netValue must be a number" }).finite(),
    })
    .optional(),
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
 * Relative-equality gate for the cutouts breakdown (client display vs the
 * server's re-derivation — both run the same deterministic core, so a real
 * mismatch is always a client bug or a tampered body, never float noise;
 * the 1e-9 relative window absorbs only engine-level ulps). The message
 * pins BOTH numbers, the honest diff.
 */
function nearEqual(field: string, given: number, expected: number, what: string): void {
  const tol = 1e-9 * Math.max(Math.abs(given), Math.abs(expected), 1)
  if (Math.abs(given - expected) > tol) {
    throw new MarkupError(
      `${field} (${given}) disagrees with ${what} (${expected}) — the geometry and the number must agree`,
    )
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
  if (kind === "text-hits" && v.points.length % 2 !== 0) {
    throw new MarkupError(
      `${where}: text-hits markups store [topLeft, bottomRight] pairs per accepted OCR word, so the points count must be even (got ${v.points.length})`,
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
  } else if (kind === "symbol-hits" || kind === "text-hits") {
    const hits = v.points.length / 2
    if (!Number.isInteger(v.value) || v.value < 1) {
      throw new MarkupError(
        `${where}: a ${kind} markup's value must be a whole number >= 1 (got ${v.value})`,
      )
    }
    if (v.value !== hits) {
      throw new MarkupError(
        `${where}: a ${kind} markup's value must equal its hit-box count (${hits}), got ${v.value}`,
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

  // -- Slice 18: the cutouts structure — area-only, geometry-reverified ------
  let cutouts: SheetMarkupCutouts | null = null
  if (v.cutouts !== undefined) {
    if (kind !== "area") {
      throw new MarkupError(
        `${where}: cutouts are only accepted for kind "area" markups (kind ${kind} carries none)`,
      )
    }
    const rings = v.cutouts.rings as MarkupPoint[][]
    if (rings.length === 0) {
      throw new MarkupError(
        `${where}: cutouts.rings must contain at least one cutout ring — send no cutouts for a plain area`,
      )
    }
    let computed
    try {
      // The §2.2 core owns every geometry rule; its MeasureError messages
      // surface verbatim (same text, wrapped as the markup envelope error).
      computed = areaWithCutouts(v.points as Pt[], rings as Pt[][], v.cutouts.mmPerPt)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new MarkupError(`${where}: ${message}`)
    }
    const grossM2 = computed.grossMm2 / 1e6
    const cutoutM2 = computed.cutoutsMm2 / 1e6
    const netM2 = computed.netMm2 / 1e6
    nearEqual(`${where}: value`, v.value, netM2, "the recomputed NET area")
    nearEqual(`${where}: cutouts.grossValue`, v.cutouts.grossValue, grossM2, "the recomputed gross area")
    nearEqual(`${where}: cutouts.cutoutValue`, v.cutouts.cutoutValue, cutoutM2, "the recomputed cutout area")
    nearEqual(`${where}: cutouts.netValue`, v.cutouts.netValue, netM2, "the recomputed net area")
    cutouts = {
      rings,
      mmPerPt: v.cutouts.mmPerPt,
      grossValue: v.cutouts.grossValue,
      cutoutValue: v.cutouts.cutoutValue,
      netValue: v.cutouts.netValue,
    }
  }

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
    cutouts,
    createdBy: v.createdBy,
    createdAt: v.createdAt ?? new Date().toISOString(),
  }
}
