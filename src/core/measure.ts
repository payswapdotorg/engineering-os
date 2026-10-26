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

// ---------------------------------------------------------------------------
// Region cutouts — contract §2.3 (Slice 18) and §2.4 (Slice 19, v2)
//
// ADDITIVE to the frozen §2.1 export list: the §2.1 signatures are untouched
// (byte-for-byte); this section adds the area-with-cutouts core used by the
// Sheet Measure cutout flow and the markups route's payload consistency gate.
// Pinned semantics (v1, contract §2.3 → v2 evolution, contract §2.4):
//
//  - a cutout drawn STRICTLY INSIDE the region (every vertex strictly inside,
//    zero boundary contact) rides the v1 lane: its subtracted area is its own
//    shoelace area — the arithmetic is BIT-IDENTICAL to the Slice-18 core,
//    no clipping is involved, and every v1 pin stays green untouched;
//  - a cutout that TOUCHES or CROSSES the region boundary (or contains the
//    region entirely) rides the v2 lane: the region must be CONVEX (the
//    honest v2 bound — Sutherland–Hodgman is exact for a convex clip window;
//    a concave region is refused with a message that says exactly that), and
//    the subtracted area is the CLIPPED INTERSECTION area — the part of the
//    cutout actually inside the region, so a boundary-crossing opening
//    subtracts only the square millimetres it really covers;
//  - a cutout entirely OUTSIDE the region (disjoint boundaries, no vertex of
//    either ring inside the other) is refused: it would subtract nothing;
//  - cutout rings must be pairwise NON-OVERLAPPING (no boundary contact, no
//    nesting, conservative even outside the region — recorded §2.4 bound):
//    overlapping cutouts would double-subtract the same square millimetre;
//  - net = gross − Σ subtracted, all by the same shoelace arithmetic as
//    polygonArea (deterministic, exactly-specified IEEE-754);
//  - net must be > 0 (cutouts that cancel the region exactly leave nothing
//    measurable — refused, never a silent 0; the v2 lane makes this
//    REACHABLE — a crossing cutout whose intersection is the whole region —
//    and it is pinned by test, no longer a defensive backstop only).
//
// Boundary-contact detection is exact-arithmetic on the given doubles
// (orientation products with === 0): coordinates from hand clicks are PDF
// points with two decimals; the e2e fixtures pin integer coordinates, so the
// exact test is deterministic where it is used. A pair of rings that share a
// boundary point only in the last ulp of a float product is treated as
// NOT touching — the strictly-inside vertex test (a separate, sign-based
// check) is the gate that matters; contact detection is the second, stronger
// net for hand-drawn geometry.
// ---------------------------------------------------------------------------

/** Signed area ×2 of a ring (shoelace, no abs) — the orientation primitive. */
function ringCrossedArea(ring: Pt[]): number {
  let twice = 0
  const n = ring.length
  for (let i = 0; i < n; i += 1) {
    const a = ring[i]
    const b = ring[(i + 1) % n]
    twice += a.x * b.y - b.x * a.y
  }
  return twice
}

/** |shoelace|/2 in point² — the same arithmetic polygonArea uses. */
function ringAreaPt2(ring: Pt[]): number {
  return Math.abs(ringCrossedArea(ring)) / 2
}

/** z-component of the cross product (b−a)×(c−a): >0 left, <0 right, 0 collinear. */
function cross(o: Pt, a: Pt, b: Pt): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
}

/** True when p lies ON the closed segment a→b (collinear + within the bbox). */
function pointOnSegment(p: Pt, a: Pt, b: Pt): boolean {
  if (cross(a, b, p) !== 0) return false
  const minX = Math.min(a.x, b.x)
  const maxX = Math.max(a.x, b.x)
  const minY = Math.min(a.y, b.y)
  const maxY = Math.max(a.y, b.y)
  return p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY
}

/**
 * Strict point-in-polygon: true only when p is INSIDE the ring, never on its
 * boundary. Even-odd ray cast (half-open edge rule) + an explicit on-edge
 * exclusion, so a vertex exactly on the boundary is honestly "not strictly
 * inside" — the cutout gate depends on that strictness.
 */
export function pointStrictlyInsidePolygon(p: Pt, ring: Pt[]): boolean {
  const n = ring.length
  let inside = false
  for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
    const a = ring[j]
    const b = ring[i]
    if (pointOnSegment(p, a, b)) return false // on the boundary — not strict
    const straddles =
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
    if (straddles) inside = !inside
  }
  return inside
}

/**
 * Any-contact segment intersection (proper crossing, endpoint touch, or
 * collinear overlap). Used ONLY to detect boundary CONTACT between rings —
 * for the cutout rules any contact is a refusal, so there is no need to
 * distinguish the kinds.
 */
function segmentsContact(a1: Pt, a2: Pt, b1: Pt, b2: Pt): boolean {
  const d1 = cross(b1, b2, a1)
  const d2 = cross(b1, b2, a2)
  const d3 = cross(a1, a2, b1)
  const d4 = cross(a1, a2, b2)
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true // proper crossing
  }
  if (d1 === 0 && pointOnSegment(a1, b1, b2)) return true
  if (d2 === 0 && pointOnSegment(a2, b1, b2)) return true
  if (d3 === 0 && pointOnSegment(b1, a1, a2)) return true
  if (d4 === 0 && pointOnSegment(b2, a1, a2)) return true
  return false
}

/**
 * True when the two closed rings' boundaries touch or cross anywhere (any
 * edge pair in contact, or any vertex of one lying on the other's boundary).
 * Rings whose boundaries are completely disjoint return false.
 */
export function ringsTouchOrCross(a: Pt[], b: Pt[]): boolean {
  const an = a.length
  const bn = b.length
  for (let i = 0; i < an; i += 1) {
    const a1 = a[i]
    const a2 = a[(i + 1) % an]
    for (let j = 0; j < bn; j += 1) {
      const b1 = b[j]
      const b2 = b[(j + 1) % bn]
      if (segmentsContact(a1, a2, b1, b2)) return true
    }
  }
  return false
}

/** The area-with-cutouts result: every number the UI and the route re-derive. */
export interface AreaWithCutouts {
  /** gross region area in mm² (shoelace × mmPerPt²) */
  grossMm2: number
  /** each cutout's SUBTRACTED area in mm², in input order (the clipped intersection area when the cutout crosses the boundary — contract §2.4) */
  cutoutMm2: number[]
  /** sum of the subtracted cutout areas in mm² */
  cutoutsMm2: number
  /** gross − cutouts in mm²; always > 0 (a net of 0 is refused) */
  netMm2: number
  /** per cutout, in input order: true when the ring touches/crosses the region boundary (the v2 lane — its subtracted area is the clipped intersection) */
  clipped: boolean[]
}

/**
 * True when the ring is CONVEX: every consecutive turn is the same sign or
 * collinear (exact-arithmetic cross products, === 0 collinear). A ring with
 * mixed signs is concave; the v2 boundary-crossing lane refuses concave
 * REGIONS (the clip window), not concave cutouts (a concave subject clips
 * fine — Sutherland–Hodgman only needs the window convex). Degenerate
 * all-collinear rings return true here but are refused upstream by the
 * positive-area rule.
 */
export function isConvexRing(ring: Pt[]): boolean {
  const r = requirePoints(ring, 3, "isConvexRing")
  let positive = false
  let negative = false
  for (let i = 0; i < r.length; i += 1) {
    const z = cross(r[i], r[(i + 1) % r.length], r[(i + 2) % r.length])
    if (z > 0) positive = true
    else if (z < 0) negative = true
    if (positive && negative) return false
  }
  return true
}

/**
 * Sutherland–Hodgman clip of `subject` against the CONVEX ring `region`
 * (contract §2.4): each region edge's inside half-plane is applied in ring
 * order, orientation-aware (the sign of `ringCrossedArea(region)`), with
 * points ON a plane kept (they are inside the closed region). The output may
 * carry degenerate bridges/duplicates when the subject splits into pieces or
 * runs along the boundary — they contribute exactly 0 to the shoelace, so
 * the AREA of the result is the true intersection area (the classical
 * Sutherland–Hodgman property for area; the polygon SHAPE at the bridges is
 * degenerate on purpose and never stored — the caller only measures it).
 * An empty result (subject fully outside) returns [].
 */
export function clipToConvexRegion(subject: Pt[], region: Pt[]): Pt[] {
  const reg = requirePoints(region, 3, "clipToConvexRegion: region")
  let polygon = requirePoints(subject, 3, "clipToConvexRegion: subject")
  const ccw = ringCrossedArea(reg) >= 0

  for (let i = 0; i < reg.length && polygon.length > 0; i += 1) {
    const a = reg[i]
    const b = reg[(i + 1) % reg.length]
    // Signed side of the plane through a→b (>= 0 is inside for the ring's
    // orientation): the boundary is kept, so touching rings clip to the
    // touching piece exactly.
    const side = (p: Pt): number => (ccw ? cross(a, b, p) : -cross(a, b, p))
    const next: Pt[] = []
    for (let j = 0; j < polygon.length; j += 1) {
      const s = polygon[(j + polygon.length - 1) % polygon.length] // previous
      const t = polygon[j] // current
      const fs = side(s)
      const ft = side(t)
      const sIn = fs >= 0
      const tIn = ft >= 0
      if (tIn) {
        // entering or staying: emit the crossing point first when the
        // previous vertex was outside, then the inside vertex
        if (!sIn) next.push(intersectWithPlane(s, t, fs, ft))
        next.push(t)
      } else if (sIn) {
        // leaving: emit only the crossing point
        next.push(intersectWithPlane(s, t, fs, ft))
      }
    }
    polygon = next
  }
  return polygon
}

/**
 * Intersection of segment s→t with the line through the clip edge, given the
 * two endpoints' signed sides. Called only when one endpoint is strictly
 * outside and the other is inside-or-on, so fs − ft is never 0: u = fs/(fs−ft)
 * lies in [0,1), and the point is computed in the plane's exact line space
 * (on integer fixtures whose crossings land on integer coordinates — the
 * pinned class — every product and the division are exact IEEE-754).
 */
function intersectWithPlane(s: Pt, t: Pt, fs: number, ft: number): Pt {
  const u = fs / (fs - ft)
  return { x: s.x + u * (t.x - s.x), y: s.y + u * (t.y - s.y) }
}

/**
 * Area of a region ring minus cutout rings — the Slice-18 core, evolved to
 * v2 (contract §2.4): cutouts drawn fully inside ride the v1 lane (arithmetic
 * bit-identical to Slice 18); cutouts touching/crossing the boundary — or
 * containing the region — require a CONVEX region and subtract their clipped
 * intersection area. Every rule violation throws a MeasureError whose
 * message the API returns verbatim as a 422 (the house discipline: geometry
 * and number can never disagree in storage):
 *  - region: ≥3 finite points enclosing a positive area;
 *  - cutouts: a non-empty array of rings, each ≥3 finite points with
 *    positive area;
 *  - per cutout, ONE of:
 *      v1 lane: every vertex strictly inside + zero boundary contact;
 *      v2 lane: boundary contact, or containment — needs a CONVEX region
 *               and a positive clipped intersection (a disjoint cutout is
 *               refused: it would subtract nothing);
 *  - cutouts pairwise non-overlapping (no boundary contact; no nesting —
 *    conservative even outside the region, recorded §2.4);
 *  - net > 0 after subtraction (reachable through v2: a crossing cutout
 *    whose intersection is the whole region);
 *  - mmPerPt finite > 0 (the §2.1 calibration factor).
 */
export function areaWithCutouts(region: Pt[], cutouts: Pt[][], mmPerPt: number): AreaWithCutouts {
  const where = "areaWithCutouts"
  requireMmPerPt(mmPerPt, where)

  const ring = requirePoints(region, 3, `${where}: region`)
  const grossPt2 = ringAreaPt2(ring)
  if (!(grossPt2 > 0)) {
    throw new MeasureError(
      `${where}: the region ring must enclose a positive area (a degenerate or collinear ring measures 0 — draw an area first)`,
    )
  }

  if (!Array.isArray(cutouts) || cutouts.length === 0) {
    throw new MeasureError(
      `${where}: cutouts must be a non-empty array of rings (got ${describe(cutouts)})`,
    )
  }

  const rings: Pt[][] = cutouts.map((cutout, index) => {
    const r = requirePoints(cutout, 3, `${where}: cutouts[${index}]`)
    if (!(ringAreaPt2(r) > 0)) {
      throw new MeasureError(
        `${where}: cutouts[${index}] must enclose a positive area (a degenerate or collinear ring cannot subtract anything)`,
      )
    }
    return r
  })

  // Per-cutout lane classification (§2.4). `pieces[i]` holds the clipped
  // intersection ring for a v2-lane cutout, null for a v1-lane cutout — the
  // v1 lane keeps the exact Slice-18 arithmetic path (no clip ever runs).
  const pieces: (Pt[] | null)[] = new Array(rings.length).fill(null)
  for (let i = 0; i < rings.length; i += 1) {
    const r = rings[i]
    const contact = ringsTouchOrCross(r, ring)

    // v1 lane: zero boundary contact AND every vertex strictly inside.
    if (!contact) {
      let allStrictlyInside = true
      for (let j = 0; j < r.length; j += 1) {
        if (!pointStrictlyInsidePolygon(r[j], ring)) {
          allStrictlyInside = false
          break
        }
      }
      if (allStrictlyInside) continue // pieces[i] stays null — the v1 lane
    }

    // v2 lane. Refusals first, both geometry-only and honest:
    if (!contact) {
      // No boundary contact but not fully inside: the rings are either
      // disjoint (the cutout lies entirely outside — it would subtract
      // nothing) or the cutout contains the region whole (the clip below
      // then measures gross − gross = net 0, refused by the net rule).
      const containsRegion = pointStrictlyInsidePolygon(ring[0], r)
      let anyVertexInside = false
      for (let j = 0; j < r.length; j += 1) {
        if (pointStrictlyInsidePolygon(r[j], ring)) {
          anyVertexInside = true
          break
        }
      }
      if (!containsRegion && !anyVertexInside) {
        throw new MeasureError(
          `${where}: cutouts[${i}] lies entirely outside the region — it would subtract nothing; draw it inside the area or crossing its boundary`,
        )
      }
      if (!containsRegion) {
        // No contact, some vertices inside, some not — impossible for a
        // simple ring (the boundary would have been crossed and `contact`
        // true). Honest refusal rather than a guess: the ring is not simple.
        throw new MeasureError(
          `${where}: cutouts[${i}] is not a simple ring (vertices both inside and outside the region without crossing its boundary) — a self-crossing ring has no unambiguous subtracted area`,
        )
      }
    }
    if (!isConvexRing(ring)) {
      throw new MeasureError(
        `${where}: cutouts[${i}] touches or crosses the region boundary — v2 boundary-crossing cutouts need a CONVEX region; a concave region accepts only cutouts drawn fully inside`,
      )
    }
    const piece = clipToConvexRegion(r, ring)
    const pieceArea = piece.length >= 3 ? ringAreaPt2(piece) : 0
    if (!(pieceArea > 0)) {
      // The clip measured nothing inside (a sliver/boundary-only touch on a
      // convex region) — the same honest refusal as the disjoint case.
      throw new MeasureError(
        `${where}: cutouts[${i}] lies entirely outside the region — it would subtract nothing; draw it inside the area or crossing its boundary`,
      )
    }
    pieces[i] = piece
  }

  // Cutouts pairwise non-overlapping: boundary contact first (crossing or
  // touching), then containment (one ring nested inside the other with no
  // contact — it would double-subtract the same area silently). The §2.4
  // conservative bound: this runs on the ORIGINAL rings, so two crossing
  // cutouts may not touch even in the part outside the region.
  for (let i = 0; i < rings.length; i += 1) {
    for (let j = i + 1; j < rings.length; j += 1) {
      if (ringsTouchOrCross(rings[i], rings[j])) {
        throw new MeasureError(
          `${where}: cutouts[${i}] and cutouts[${j}] overlap (their boundaries touch or cross) — overlapping cutouts would double-subtract the same area`,
        )
      }
      if (
        pointStrictlyInsidePolygon(rings[i][0], rings[j]) ||
        pointStrictlyInsidePolygon(rings[j][0], rings[i])
      ) {
        throw new MeasureError(
          `${where}: cutouts[${i}] and cutouts[${j}] overlap (one lies inside the other) — overlapping cutouts would double-subtract the same area`,
        )
      }
    }
  }

  const cutoutMm2 = rings.map((r, i) => {
    // v1 lane: the ring's own shoelace (the Slice-18 path, bit-identical);
    // v2 lane: the clipped intersection's shoelace.
    const areaPt2 = pieces[i] !== null ? ringAreaPt2(pieces[i] as Pt[]) : ringAreaPt2(r)
    return areaPt2 * mmPerPt * mmPerPt
  })
  const grossMm2 = grossPt2 * mmPerPt * mmPerPt
  const cutoutsMm2 = cutoutMm2.reduce((sum, area) => sum + area, 0)
  const netMm2 = grossMm2 - cutoutsMm2
  if (!(netMm2 > 0)) {
    throw new MeasureError(
      `${where}: the cutouts cancel the region exactly (net area 0) — nothing measurable remains`,
    )
  }
  return {
    grossMm2,
    cutoutMm2,
    cutoutsMm2,
    netMm2,
    clipped: pieces.map((piece) => piece !== null),
  }
}
