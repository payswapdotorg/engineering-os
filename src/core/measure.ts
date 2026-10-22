/**
 * Engineering OS — deterministic drawing-measurement core (Lane 8-c, Slice 8).
 *
 * Implements the FROZEN API of docs/00-architecture/integrity-measure-contract.md
 * §2.1 (frozen 2026-10-22; changes escalate to the TL — lane 8-b's Sheet Measure
 * tab codes against these exact signatures right now). PURE TypeScript: no DB,
 * no network, no filesystem, no DOM, no pdfjs (ADR-0002) and no zod either — the
 * API surface is small enough that hand-rolled fail-loudly guards are clearer,
 * same precedent as cpm.ts. No LLM arithmetic (ADR-0006): every number this
 * module produces is computed by deterministic, re-runnable code — the same
 * inputs always produce the same outputs, and out-of-domain input throws
 * `MeasureError`; nothing ever silently becomes NaN, Infinity or a guessed
 * substitute value.
 *
 * Coordinate space: every `Pt` is a PDF point (1/72 inch) in unrotated page
 * space — the same space pdf.js reports page coordinates in. The caller (lane
 * 8-b) converts browser canvas clicks back to points by dividing out the render
 * scale BEFORE calling anything here; this module never sees pixels.
 *
 * Pinned semantics (documented so the parallel UI lane and the TL browser
 * journey can rely on them byte-for-byte):
 *
 *  - calibrate(points, realLength, realUnit) → real-millimetres-per-point:
 *
 *        realMm   = realLength × { m: 1000, mm: 1, ft: 304.8 }
 *        mmPerPt  = realMm / distance(points[0], points[1])
 *
 *    1 ft = 304.8 mm is the exact international definition of the foot (1959).
 *    Throws on: non-array or <2 points, non-finite coordinates, coincident
 *    points (a zero span cannot determine a scale), non-finite or non-positive
 *    realLength, unknown realUnit. If more than two points are handed in at
 *    runtime the first two are used (the tuple is the pin; extras are ignored,
 *    never silently reinterpreted).
 *
 *  - polylineLength: per-segment scaling — each segment's point-space length ×
 *    mmPerPt, summed left-to-right in input order. This matches the live
 *    running total a UI shows segment by segment, and it means two points
 *    measure ONE segment: there is NO implicit ring closure here (use
 *    polygonArea for closed shapes). Adjacent duplicate points contribute
 *    exactly zero and are allowed on purpose — a "finish on double-click" UI
 *    must not explode on its own closing click.
 *
 *  - polygonArea: shoelace formula with implicit ring closure (the ring closes
 *    from the last vertex back to the first, so the caller may pass the corners
 *    with or without an explicitly repeated first vertex — the repeated vertex
 *    contributes exactly zero):
 *
 *        areaPt2 = |Σ (xᵢ·yᵢ₊₁ − xᵢ₊₁·yᵢ)| / 2        (indices mod n)
 *        areaMm2 = areaPt2 × (mmPerPt)²                 (scale squared once)
 *
 *    A degenerate (collinear) polygon returns an honest 0 — the ledger layer's
 *    value > 0 rule rejects it downstream; this layer never invents a floor.
 *
 *  - distance: Math.sqrt(dx·dx + dy·dy) on purpose, NOT Math.hypot: every
 *    operation here is exactly-specified IEEE-754 arithmetic, so results are
 *    bit-identical across JS engines, while ECMA-262 permits Math.hypot to be
 *    implementation-approximated in the last ulp. Sub-µm spans (|d| below
 *    ~7e-162) underflow d² to 0 and are reported as 0 — deterministic, and
 *    calibrate treats such a span as coincident (honest, never NaN).
 *
 *  - toLedgerQuantity: length → metres (rawMm/1000, unit "m"), area → square
 *    metres (rawMm²/1e6, unit "m²"), count → the provided tally with unit
 *    "each" (rawMm is IGNORED for counts — a tally has no length). The returned
 *    `value` is the HONEST unrounded measurement; `display` is a 3-decimal
 *    presentation string only (toFixed(3) is locale-independent, so it is
 *    deterministic). A zero/negative/NaN raw length or a missing/invalid count
 *    is refused — a ledger record of 0 is an absence of record, and a count
 *    must be a positive integer.
 *
 * Verification pins (contract §2.2, exercised live in the 8-c worklog harness
 * against tests/fixtures/sheet-a102-plan.pdf geometry): calibrating the sheet's
 * 100-paper-mm scale bar with 10 m → mmPerPt = 10000 mm / (100 × 72/25.4 pt) =
 * 254000/7200 = 635/18 = 35.2777̄ mm/pt (= 100 × PT_MM, exactly the 1:100
 * factor); the 80×50-paper-mm room → perimeter 26000 mm, area 40000000 mm²;
 * the 30-paper-mm interior wall → 3000 mm.
 */

// ---------------------------------------------------------------------------
// Vocabulary — frozen by contract §2.1
// ---------------------------------------------------------------------------

/** Thrown by every measure function on out-of-domain input (never NaN, never a guess). */
export class MeasureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MeasureError"
  }
}

/** PostScript point → millimetres (exact): 1 pt = 25.4/72 mm. */
export const PT_MM = 25.4 / 72

export interface Pt {
  x: number
  y: number
}

/**
 * Real-world unit a calibration distance can be entered in. Additive
 * convenience alias (NOT part of the frozen §2.1 export list) for the union
 * `"m" | "mm" | "ft"` pinned in the frozen `calibrate` signature — identical
 * type, just nameable by lane 8-b.
 */
export type RealUnit = "m" | "mm" | "ft"

/** Exact millimetres per unit: 1 m = 1000 mm; 1 ft = 304.8 mm (1959 definition). */
const UNIT_MM: Record<RealUnit, number> = { m: 1000, mm: 1, ft: 304.8 }

// ---------------------------------------------------------------------------
// Runtime honesty guards (JS callers are not bound by the TypeScript types)
// ---------------------------------------------------------------------------

/** Renders a value for an error message without inventing content (cpm.ts style). */
function describe(value: unknown): string {
  if (typeof value === "string") return `"${value}"`
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value)
  if (typeof value === "undefined") return "undefined"
  if (Array.isArray(value)) return `an array of ${value.length}`
  if (typeof value === "object") return "an object"
  return typeof value
}

/**
 * Accepts only objects with finite numeric x and y. Returns the point as-is
 * (no copy, no normalization — the caller's coordinates are the measurement).
 */
function requirePt(point: unknown, where: string): Pt {
  if (typeof point === "object" && point !== null) {
    const candidate = point as { x?: unknown; y?: unknown }
    if (
      typeof candidate.x === "number" &&
      typeof candidate.y === "number" &&
      Number.isFinite(candidate.x) &&
      Number.isFinite(candidate.y)
    ) {
      return candidate as Pt
    }
    throw new MeasureError(
      `${where} must have finite x and y (got x=${String(candidate.x)}, y=${String(candidate.y)})`,
    )
  }
  throw new MeasureError(`${where} must be an object with numeric x and y (got ${describe(point)})`)
}

/** Accepts only arrays of valid points with at least `minimum` entries. */
function requirePoints(points: unknown, minimum: number, where: string): Pt[] {
  if (!Array.isArray(points)) {
    throw new MeasureError(
      `${where}: points must be an array of {x, y} objects (got ${describe(points)})`,
    )
  }
  if (points.length < minimum) {
    throw new MeasureError(`${where}: needs at least ${minimum} points, got ${points.length}`)
  }
  return points.map((point, index) => requirePt(point, `${where}: points[${index}]`))
}

/** The calibration factor is a length-per-point — degenerate factors are refused. */
function requireMmPerPt(mmPerPt: number, where: string): void {
  if (typeof mmPerPt !== "number" || !Number.isFinite(mmPerPt) || mmPerPt <= 0) {
    throw new MeasureError(`${where}: mmPerPt must be a finite number > 0 (got ${String(mmPerPt)})`)
  }
}

// ---------------------------------------------------------------------------
// Frozen API — contract §2.1
// ---------------------------------------------------------------------------

/**
 * Calibration: `points` are two canvas/pdf-page-space picks (in PDF points),
 * `realLength` the real-world distance the user says they span, `realUnit`
 * one of "m" | "mm" | "ft". Returns the real-millimetres-per-point factor.
 * Throws MeasureError on <2 points, coincident points, non-finite, or
 * non-positive length.
 */
export function calibrate(points: [Pt, Pt], realLength: number, realUnit: "m" | "mm" | "ft"): number {
  const pair = requirePoints(points, 2, "calibrate")
  if (typeof realLength !== "number" || !Number.isFinite(realLength) || realLength <= 0) {
    throw new MeasureError(
      `calibrate: realLength must be a finite number > 0 (got ${String(realLength)})`,
    )
  }
  if (typeof realUnit !== "string" || !(realUnit in UNIT_MM)) {
    throw new MeasureError(
      `calibrate: realUnit must be one of "m", "mm", "ft" (got ${describe(realUnit)})`,
    )
  }
  const unitMm = UNIT_MM[realUnit]
  const span = distance(pair[0], pair[1])
  if (span === 0) {
    throw new MeasureError(
      "calibrate: the two calibration points coincide — a zero span cannot determine a scale",
    )
  }
  return (realLength * unitMm) / span
}

/** Real-world polyline length (mm) in the calibrated space; >=2 points. */
export function polylineLength(points: Pt[], mmPerPt: number): number {
  const path = requirePoints(points, 2, "polylineLength")
  requireMmPerPt(mmPerPt, "polylineLength")
  let total = 0
  for (let i = 1; i < path.length; i++) {
    total += distance(path[i - 1], path[i]) * mmPerPt
  }
  return total
}

/** Real-world polygon area (mm²) via the shoelace formula; >=3 points. */
export function polygonArea(points: Pt[], mmPerPt: number): number {
  const ring = requirePoints(points, 3, "polygonArea")
  requireMmPerPt(mmPerPt, "polygonArea")
  let sum = 0
  for (let i = 0; i < ring.length; i++) {
    const current = ring[i]
    const next = ring[(i + 1) % ring.length]
    sum += current.x * next.y - next.x * current.y
  }
  return (Math.abs(sum) / 2) * (mmPerPt * mmPerPt)
}

/** Segment distance between two points in PDF-point space. */
export function distance(a: Pt, b: Pt): number {
  const pa = requirePt(a, "distance: a")
  const pb = requirePt(b, "distance: b")
  const dx = pa.x - pb.x
  const dy = pa.y - pb.y
  return Math.sqrt(dx * dx + dy * dy)
}

/**
 * Human-facing value+unit for a ledger row from raw millimetres:
 * length → metres (m), area → square metres (m²), count → "each".
 * Values are NOT rounded for storage — the returned `value` is the honest
 * measured number; `display` is a 3-decimal formatting string only.
 */
export function toLedgerQuantity(
  rawMm: number,
  type: "length" | "area" | "count",
  count?: number,
): { value: number; unit: "m" | "m²" | "each"; display: string } {
  if (type === "count") {
    if (count === undefined) {
      throw new MeasureError(
        'toLedgerQuantity: type "count" requires a positive integer count (missing — pass the tally)',
      )
    }
    if (typeof count !== "number" || !Number.isInteger(count) || count <= 0) {
      throw new MeasureError(
        `toLedgerQuantity: type "count" requires a positive integer count (got ${String(count)})`,
      )
    }
    // Pinned key order (value → unit → display) keeps JSON serialization
    // deterministic; rawMm is deliberately unused for counts (see header).
    return { value: count, unit: "each", display: `${count.toFixed(3)} each` }
  }
  if (type !== "length" && type !== "area") {
    throw new MeasureError(
      `toLedgerQuantity: type must be "length", "area" or "count" (got ${describe(type)})`,
    )
  }
  if (typeof rawMm !== "number" || !Number.isFinite(rawMm) || rawMm <= 0) {
    throw new MeasureError(
      `toLedgerQuantity: rawMm must be a finite number > 0 for type "${type}" (got ${String(rawMm)})`,
    )
  }
  const value = type === "length" ? rawMm / 1000 : rawMm / 1e6
  const unit = type === "length" ? "m" : "m²"
  return { value, unit, display: `${value.toFixed(3)} ${unit}` }
}
