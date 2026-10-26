/**
 * Engineering OS — unit battery for the measurement core (Slice 18 + the
 * Slice-19 v2 evolution).
 *
 * The §2.1 functions were previously covered indirectly (markup.test.ts +
 * the e2e golden path); this file pins them for arithmetic sanity AND owns
 * the full region-cutout battery: analytic ground truths on integer
 * coordinates (every float operation below is exact — integers < 2^53) and
 * the verbatim refusal matrix. Slice 19 (§2.4) evolves three of the §2.3
 * refusal pins — a boundary-touching cutout on a CONVEX region is now
 * ACCEPTED (the clipped-intersection lane), the disjoint cutout and the
 * concave-region cases get their new honest messages — and makes the
 * net-area-0 refusal REACHABLE (a crossing cutout whose intersection is the
 * whole region), so it is pinned, no longer a documented backstop only.
 */
import { describe, expect, test } from "bun:test"

import {
  areaWithCutouts,
  calibrate,
  clipToConvexRegion,
  distance,
  isConvexRing,
  MeasureError,
  pointStrictlyInsidePolygon,
  polygonArea,
  polylineLength,
  ringsTouchOrCross,
  toLedgerQuantity,
  type Pt,
} from "./measure"

const pt = (x: number, y: number): Pt => ({ x, y })

/** 100×50 pt region — the analytic fixture for the whole §2.2 battery. */
const REGION: Pt[] = [pt(0, 0), pt(100, 0), pt(100, 50), pt(0, 50)]
/** mmPerPt 20 → 100×50 pt = 2000×1000 mm = 2.000000 m² gross (exact). */
const MM = 20

/** The L-shape for the concave cases: base bar + left bar, inner corner (10,10). */
const L_REGION: Pt[] = [pt(0, 0), pt(100, 0), pt(100, 10), pt(10, 10), pt(10, 50), pt(0, 50)]

describe("measure §2.1 sanity (arithmetic the §2.2 core must agree with)", () => {
  test("calibrate: 100 pt spanning 1 m → 10 mm/pt exactly", () => {
    expect(calibrate([pt(0, 0), pt(100, 0)], 1, "m")).toBe(10)
  })

  test("polygonArea: 100×50 pt at 20 mm/pt → 2,000,000 mm² exactly", () => {
    expect(polygonArea(REGION, MM)).toBe(2_000_000)
  })

  test("polylineLength: no implicit ring closure (two points = one segment)", () => {
    expect(polylineLength([pt(0, 0), pt(50, 0)], MM)).toBe(1000)
  })

  test("toLedgerQuantity: 1,980,000 mm² → 1.98 m² with the 3-decimal display", () => {
    expect(toLedgerQuantity(1_980_000, "area")).toEqual({
      value: 1.98,
      unit: "m²",
      display: "1.980 m²",
    })
  })

  test("distance: exact on integer coordinates", () => {
    expect(distance(pt(0, 0), pt(3, 4))).toBe(5)
  })
})

describe("measure §2.2 pointStrictlyInsidePolygon", () => {
  test("strictly inside a convex ring", () => {
    expect(pointStrictlyInsidePolygon(pt(50, 25), REGION)).toBe(true)
  })

  test("outside", () => {
    expect(pointStrictlyInsidePolygon(pt(150, 25), REGION)).toBe(false)
  })

  test("ON an edge is NOT strictly inside", () => {
    expect(pointStrictlyInsidePolygon(pt(50, 0), REGION)).toBe(false)
  })

  test("ON a vertex is NOT strictly inside", () => {
    expect(pointStrictlyInsidePolygon(pt(0, 0), REGION)).toBe(false)
  })

  test("concave ring: in the notch is outside, past it is inside", () => {
    // x=50,y=25 sits in the L's notch (x>10 AND y>10) — outside.
    expect(pointStrictlyInsidePolygon(pt(50, 25), L_REGION)).toBe(false)
    // x=5,y=25 sits in the left bar — inside.
    expect(pointStrictlyInsidePolygon(pt(5, 25), L_REGION)).toBe(true)
    // x=50,y=5 sits in the base bar — inside.
    expect(pointStrictlyInsidePolygon(pt(50, 5), L_REGION)).toBe(true)
  })
})

describe("measure §2.2 ringsTouchOrCross", () => {
  const rectA: Pt[] = [pt(10, 10), pt(20, 10), pt(20, 20), pt(10, 20)]

  test("disjoint rings → false", () => {
    const rectB: Pt[] = [pt(30, 10), pt(40, 10), pt(40, 20), pt(30, 20)]
    expect(ringsTouchOrCross(rectA, rectB)).toBe(false)
  })

  test("shared vertex → true (any contact counts)", () => {
    const touching: Pt[] = [pt(20, 20), pt(30, 20), pt(30, 30), pt(20, 30)]
    expect(ringsTouchOrCross(rectA, touching)).toBe(true)
  })

  test("proper edge crossing → true", () => {
    const crossing: Pt[] = [pt(15, 5), pt(15, 25), pt(16, 25), pt(16, 5)]
    expect(ringsTouchOrCross(rectA, crossing)).toBe(true)
  })

  test("collinear edge overlap → true", () => {
    const overlap: Pt[] = [pt(15, 10), pt(25, 10), pt(25, 5), pt(15, 5)]
    expect(ringsTouchOrCross(rectA, overlap)).toBe(true)
  })

  test("near miss (1 pt away) → false", () => {
    const near: Pt[] = [pt(21, 10), pt(30, 10), pt(30, 20), pt(21, 20)]
    expect(ringsTouchOrCross(rectA, near)).toBe(false)
  })
})

describe("measure §2.2 areaWithCutouts — analytic ground truths", () => {
  test("one cutout: 2 m² gross − 0.02 m² cutout = 1.98 m² net, exact", () => {
    const cutout: Pt[] = [pt(10, 10), pt(20, 10), pt(20, 15), pt(10, 15)] // 10×5 pt = 50 pt²
    const result = areaWithCutouts(REGION, [cutout], MM)
    expect(result.grossMm2).toBe(2_000_000)
    expect(result.cutoutMm2).toEqual([20_000])
    expect(result.cutoutsMm2).toBe(20_000)
    expect(result.netMm2).toBe(1_980_000)
    expect(toLedgerQuantity(result.netMm2, "area").value).toBe(1.98)
  })

  test("gross is bit-identical to polygonArea on the same ring (the UI never disagrees)", () => {
    const cutout: Pt[] = [pt(10, 10), pt(20, 10), pt(20, 15), pt(10, 15)]
    const result = areaWithCutouts(REGION, [cutout], MM)
    expect(result.grossMm2).toBe(polygonArea(REGION, MM))
  })

  test("two cutouts subtract independently, in input order", () => {
    const a: Pt[] = [pt(10, 10), pt(20, 10), pt(20, 15), pt(10, 15)] // 20,000 mm²
    const b: Pt[] = [pt(30, 10), pt(40, 10), pt(40, 15), pt(30, 15)] // 20,000 mm²
    const result = areaWithCutouts(REGION, [a, b], MM)
    expect(result.cutoutMm2).toEqual([20_000, 20_000])
    expect(result.cutoutsMm2).toBe(40_000)
    expect(result.netMm2).toBe(1_960_000)
  })

  test("a concave (L-shaped) region measures by the same shoelace arithmetic", () => {
    // L area: base 100×10 + left 10×40 = 1000 + 400 = 1400 pt² → 560,000 mm².
    const cutout: Pt[] = [pt(2, 2), pt(8, 2), pt(8, 8), pt(2, 8)] // 36 pt² → 14,400 mm²
    const result = areaWithCutouts(L_REGION, [cutout], MM)
    expect(result.grossMm2).toBe(560_000)
    expect(result.netMm2).toBe(545_600)
  })

  test("a triangular cutout inside a triangular region (non-axis-aligned pins)", () => {
    // Region: right triangle (0,0),(60,0),(0,40) → 1200 pt² → 480,000 mm².
    const tri: Pt[] = [pt(0, 0), pt(60, 0), pt(0, 40)]
    // Cutout: midpoints triangle (2,2),(30,2),(2,20) → 0.5·28·18=252 pt² → 100,800 mm².
    const cutout: Pt[] = [pt(2, 2), pt(30, 2), pt(2, 20)]
    const result = areaWithCutouts(tri, [cutout], MM)
    expect(result.grossMm2).toBe(480_000)
    expect(result.cutoutsMm2).toBe(100_800)
    expect(result.netMm2).toBe(379_200)
  })
})

describe("measure §2.2 areaWithCutouts — the verbatim refusal matrix", () => {
  const inside = (): Pt[] => [pt(10, 10), pt(20, 10), pt(20, 15), pt(10, 15)]

  // Slice 19 (§2.4): the three former v1 refusals below evolved — a
  // boundary-touching cutout on a CONVEX region is ACCEPTED (see the §2.4
  // battery), and the disjoint / concave cases now carry their own honest
  // messages. The rest of the matrix is byte-identical to Slice 18.

  test("cutout vertex OUTSIDE the region (disjoint — v2 honest message)", () => {
    const outside: Pt[] = [pt(150, 10), pt(160, 10), pt(160, 15), pt(150, 15)]
    try {
      areaWithCutouts(REGION, [outside], MM)
      throw new Error("expected MeasureError")
    } catch (err) {
      expect(err).toBeInstanceOf(MeasureError)
      expect((err as MeasureError).message).toBe(
        "areaWithCutouts: cutouts[0] lies entirely outside the region — it would subtract nothing; draw it inside the area or crossing its boundary",
      )
    }
  })

  test("cutout edge crossing a concave region's inner corner (all vertices strictly inside)", () => {
    // Both endpoints sit strictly inside the L, but the (5,16)→(16,5) edge
    // cuts across the notch — the boundary-contact net catches it, and the
    // concave REGION is refused for the crossing (§2.4: the clip lane is
    // convex-region-only; concave regions keep the fully-inside rule).
    const chord: Pt[] = [pt(5, 16), pt(16, 5), pt(6, 6)]
    try {
      areaWithCutouts(L_REGION, [chord], MM)
      throw new Error("expected MeasureError")
    } catch (err) {
      expect(err).toBeInstanceOf(MeasureError)
      expect((err as MeasureError).message).toBe(
        "areaWithCutouts: cutouts[0] touches or crosses the region boundary — v2 boundary-crossing cutouts need a CONVEX region; a concave region accepts only cutouts drawn fully inside",
      )
    }
  })

  test("two cutouts whose boundaries cross", () => {
    const a: Pt[] = [pt(10, 10), pt(20, 10), pt(20, 20), pt(10, 20)]
    const b: Pt[] = [pt(15, 15), pt(25, 15), pt(25, 25), pt(15, 25)]
    try {
      areaWithCutouts(REGION, [a, b], MM)
      throw new Error("expected MeasureError")
    } catch (err) {
      expect(err).toBeInstanceOf(MeasureError)
      expect((err as MeasureError).message).toBe(
        "areaWithCutouts: cutouts[0] and cutouts[1] overlap (their boundaries touch or cross) — overlapping cutouts would double-subtract the same area",
      )
    }
  })

  test("two cutouts where one lies inside the other (no boundary contact)", () => {
    const outer: Pt[] = [pt(10, 10), pt(40, 10), pt(40, 40), pt(10, 40)]
    const inner: Pt[] = [pt(20, 20), pt(30, 20), pt(30, 30), pt(20, 30)]
    try {
      areaWithCutouts(REGION, [outer, inner], MM)
      throw new Error("expected MeasureError")
    } catch (err) {
      expect(err).toBeInstanceOf(MeasureError)
      expect((err as MeasureError).message).toBe(
        "areaWithCutouts: cutouts[0] and cutouts[1] overlap (one lies inside the other) — overlapping cutouts would double-subtract the same area",
      )
    }
  })

  test("degenerate (collinear) cutout ring", () => {
    const collinear: Pt[] = [pt(10, 10), pt(20, 10), pt(30, 10)]
    try {
      areaWithCutouts(REGION, [collinear], MM)
      throw new Error("expected MeasureError")
    } catch (err) {
      expect(err).toBeInstanceOf(MeasureError)
      expect((err as MeasureError).message).toBe(
        "areaWithCutouts: cutouts[0] must enclose a positive area (a degenerate or collinear ring cannot subtract anything)",
      )
    }
  })

  test("degenerate (collinear) region ring", () => {
    try {
      areaWithCutouts([pt(0, 0), pt(10, 0), pt(20, 0)], [inside()], MM)
      throw new Error("expected MeasureError")
    } catch (err) {
      expect(err).toBeInstanceOf(MeasureError)
      expect((err as MeasureError).message).toBe(
        "areaWithCutouts: the region ring must enclose a positive area (a degenerate or collinear ring measures 0 — draw an area first)",
      )
    }
  })

  test("cutout ring with fewer than 3 points", () => {
    try {
      areaWithCutouts(REGION, [[pt(10, 10), pt(20, 10)]], MM)
      throw new Error("expected MeasureError")
    } catch (err) {
      expect(err).toBeInstanceOf(MeasureError)
      expect((err as MeasureError).message).toBe(
        "areaWithCutouts: cutouts[0]: needs at least 3 points, got 2",
      )
    }
  })

  test("empty cutouts array", () => {
    try {
      areaWithCutouts(REGION, [], MM)
      throw new Error("expected MeasureError")
    } catch (err) {
      expect(err).toBeInstanceOf(MeasureError)
      expect((err as MeasureError).message).toBe(
        "areaWithCutouts: cutouts must be a non-empty array of rings (got an array of 0)",
      )
    }
  })

  test("non-finite cutout vertex", () => {
    const bad: Pt[] = [pt(10, 10), pt(20, 10), pt(20, Number.NaN)]
    try {
      areaWithCutouts(REGION, [bad], MM)
      throw new Error("expected MeasureError")
    } catch (err) {
      expect(err).toBeInstanceOf(MeasureError)
      expect((err as MeasureError).message).toBe(
        "areaWithCutouts: cutouts[0]: points[2] must have finite x and y (got x=20, y=NaN)",
      )
    }
  })

  test("non-positive calibration factor", () => {
    try {
      areaWithCutouts(REGION, [inside()], 0)
      throw new Error("expected MeasureError")
    } catch (err) {
      expect(err).toBeInstanceOf(MeasureError)
      expect((err as MeasureError).message).toBe(
        "areaWithCutouts: mmPerPt must be a finite number > 0 (got 0)",
      )
    }
  })

  test("cutouts touching each other at exactly one shared vertex", () => {
    const a: Pt[] = [pt(10, 10), pt(20, 10), pt(20, 20), pt(10, 20)]
    const b: Pt[] = [pt(20, 20), pt(30, 20), pt(30, 30), pt(20, 30)]
    try {
      areaWithCutouts(REGION, [a, b], MM)
      throw new Error("expected MeasureError")
    } catch (err) {
      expect(err).toBeInstanceOf(MeasureError)
      expect((err as MeasureError).message).toBe(
        "areaWithCutouts: cutouts[0] and cutouts[1] overlap (their boundaries touch or cross) — overlapping cutouts would double-subtract the same area",
      )
    }
  })

  // NOTE: through the §2.3 (strictly-inside) rules the "cutouts cancel the
  // region exactly (net area 0)" refusal was a defensive backstop — provably
  // unreachable (a ring strictly inside another always has strictly smaller
  // shoelace area). The §2.4 v2 lane makes it REACHABLE (a crossing cutout
  // whose intersection is the whole region), so it is now pinned below.
})

describe("measure §2.4 isConvexRing + clipToConvexRegion (the v2 primitives)", () => {
  test("isConvexRing: the 100×50 rect is convex", () => {
    expect(isConvexRing(REGION)).toBe(true)
  })

  test("isConvexRing: the L-shape is concave", () => {
    expect(isConvexRing(L_REGION)).toBe(false)
  })

  test("isConvexRing: a triangle is convex", () => {
    expect(isConvexRing([pt(0, 0), pt(60, 0), pt(0, 40)])).toBe(true)
  })

  test("isConvexRing: a bowtie (self-crossing quad) is refused as non-convex", () => {
    expect(isConvexRing([pt(0, 0), pt(40, 40), pt(40, 0), pt(0, 40)])).toBe(false)
  })

  test("isConvexRing: collinear vertices on a convex ring stay convex", () => {
    // (0,0),(10,0),(20,0) collinear along the bottom edge — still convex.
    const ring: Pt[] = [pt(0, 0), pt(10, 0), pt(20, 0), pt(20, 20), pt(0, 20)]
    expect(isConvexRing(ring)).toBe(true)
  })

  test("clip: a fully-inside subject comes back VERTEX-FOR-VERTEX (bit-identity with its own shoelace)", () => {
    const subject: Pt[] = [pt(10, 10), pt(20, 10), pt(20, 15), pt(10, 15)]
    const clipped = clipToConvexRegion(subject, REGION)
    expect(clipped).toEqual(subject)
    expect(polygonArea(clipped, MM)).toBe(polygonArea(subject, MM))
  })

  test("clip: a crossing rect keeps only the inside part, exact on integer crossings", () => {
    // (90..110)×(10..15) crossing x=100: the inside part is 90..100 — the
    // two crossing points land ON integer coordinates (u = 500/1000 = 0.5
    // exact), so the clipped area is the exact 50 pt².
    const subject: Pt[] = [pt(90, 10), pt(110, 10), pt(110, 15), pt(90, 15)]
    const clipped = clipToConvexRegion(subject, REGION)
    expect(clipped.length).toBeGreaterThan(2)
    expect(polygonArea(clipped, 1)).toBe(50) // pt², exact
  })

  test("clip: a subject containing the whole region clips to the region", () => {
    const subject: Pt[] = [pt(-10, -10), pt(110, -10), pt(110, 60), pt(-10, 60)]
    const clipped = clipToConvexRegion(subject, REGION)
    expect(polygonArea(clipped, 1)).toBe(polygonArea(REGION, 1)) // 5000 pt²
  })

  test("clip: a disjoint subject clips to empty", () => {
    const subject: Pt[] = [pt(150, 10), pt(160, 10), pt(160, 15), pt(150, 15)]
    expect(clipToConvexRegion(subject, REGION)).toEqual([])
  })

  test("clip: a concave (L-shaped) SUBJECT crossing the boundary clips by area (bridge edges contribute 0)", () => {
    // L-subject whose left bar pokes out over the top edge y=50: the inside
    // part is the base (0..40)×(20..50) = 1200 pt²; the piece's shoelace is
    // exact despite any degenerate bridges the clip leaves behind.
    const subject: Pt[] = [
      pt(0, 20), pt(40, 20), pt(40, 70), pt(10, 70), pt(10, 50), pt(0, 50),
    ]
    const clipped = clipToConvexRegion(subject, REGION)
    expect(polygonArea(clipped, 1)).toBe(1200)
  })

  test("clip: a rect sharing an edge with the region keeps the boundary (kept-plane semantics)", () => {
    // (100..110)×(10..15) is entirely outside except its LEFT edge which
    // lies ON x=100 — the clip keeps the zero-width boundary piece and the
    // area honestly measures 0 (an outside cutout touching the wall).
    const subject: Pt[] = [pt(100, 10), pt(110, 10), pt(110, 15), pt(100, 15)]
    const clipped = clipToConvexRegion(subject, REGION)
    expect(polygonArea(clipped, 1)).toBe(0)
  })

  test("clip: a CW-oriented region ring works identically (orientation-aware)", () => {
    const cwRegion: Pt[] = [pt(0, 50), pt(100, 50), pt(100, 0), pt(0, 0)]
    const subject: Pt[] = [pt(90, 10), pt(110, 10), pt(110, 15), pt(90, 15)]
    expect(polygonArea(clipToConvexRegion(subject, cwRegion), 1)).toBe(50)
  })
})

describe("measure §2.4 areaWithCutouts v2 — boundary-crossing cutouts (the clipped lane)", () => {
  test("v1 regression: strictly-inside cutouts keep the EXACT Slice-18 numbers and the v1 lane", () => {
    const cutout: Pt[] = [pt(10, 10), pt(20, 10), pt(20, 15), pt(10, 15)]
    const result = areaWithCutouts(REGION, [cutout], MM)
    expect(result.grossMm2).toBe(2_000_000)
    expect(result.cutoutMm2).toEqual([20_000])
    expect(result.cutoutsMm2).toBe(20_000)
    expect(result.netMm2).toBe(1_980_000)
    expect(result.clipped).toEqual([false])
  })

  test("a cutout vertex ON the boundary is accepted on a convex region (the v1 refusal, evolved)", () => {
    // The former §2.3 refusal — (0,10) sits ON the left edge. v2: the clip
    // keeps the boundary, the intersection IS the ring, so the subtracted
    // area is the full 20×5 pt ring = 100 pt² = 0.04 m² and the net is
    // 1.96 m², exact.
    const onEdge: Pt[] = [pt(0, 10), pt(20, 10), pt(20, 15), pt(0, 15)]
    const result = areaWithCutouts(REGION, [onEdge], MM)
    expect(result.cutoutMm2).toEqual([40_000])
    expect(result.netMm2).toBe(1_960_000)
    expect(result.clipped).toEqual([true])
  })

  test("a boundary-crossing rect subtracts only its inside part (integer crossings, exact)", () => {
    // (90..110)×(10..15) crossing x=100 → subtract 90..100 × 10..15 = 50 pt²
    // → 0.02 m²; gross 2 m² − net 1.98 m², every step exact IEEE-754.
    const crossing: Pt[] = [pt(90, 10), pt(110, 10), pt(110, 15), pt(90, 15)]
    const result = areaWithCutouts(REGION, [crossing], MM)
    expect(result.cutoutMm2).toEqual([20_000])
    expect(result.cutoutsMm2).toBe(20_000)
    expect(result.netMm2).toBe(1_980_000)
    expect(toLedgerQuantity(result.netMm2, "area").value).toBe(1.98)
    expect(result.clipped).toEqual([true])
  })

  test("a cutout crossing a corner subtracts the quarter still inside (split-piece bridges exact)", () => {
    // (80..120)×(0..60) overlaps the whole right side: inside part = the
    // strip x 80..100 = 20×50 = 1000 pt² → 0.4 m²; net = 1.6 m² exact.
    const corner: Pt[] = [pt(80, 0), pt(120, 0), pt(120, 60), pt(80, 60)]
    const result = areaWithCutouts(REGION, [corner], MM)
    expect(result.cutoutMm2).toEqual([400_000])
    expect(result.netMm2).toBe(1_600_000)
  })

  test("mixed lanes: one strictly-inside + one crossing, subtracted independently", () => {
    const inside: Pt[] = [pt(10, 10), pt(20, 10), pt(20, 15), pt(10, 15)] // 50 pt²
    const crossing: Pt[] = [pt(90, 10), pt(110, 10), pt(110, 15), pt(90, 15)] // inside part 50 pt²
    const result = areaWithCutouts(REGION, [inside, crossing], MM)
    expect(result.cutoutMm2).toEqual([20_000, 20_000])
    expect(result.netMm2).toBe(1_960_000)
    expect(result.clipped).toEqual([false, true])
  })

  test("a cutout containing the whole region is refused: net area 0 (the now-reachable backstop)", () => {
    const swallower: Pt[] = [pt(-10, -10), pt(110, -10), pt(110, 60), pt(-10, 60)]
    try {
      areaWithCutouts(REGION, [swallower], MM)
      throw new Error("expected MeasureError")
    } catch (err) {
      expect(err).toBeInstanceOf(MeasureError)
      expect((err as MeasureError).message).toBe(
        "areaWithCutouts: the cutouts cancel the region exactly (net area 0) — nothing measurable remains",
      )
    }
  })

  test("a boundary-crossing cutout on a CONCAVE region is refused verbatim (the convex gate)", () => {
    // The L's notch edge y=10 (x 10..100) is crossed by this rect.
    const crossing: Pt[] = [pt(40, 5), pt(60, 5), pt(60, 15), pt(40, 15)]
    try {
      areaWithCutouts(L_REGION, [crossing], MM)
      throw new Error("expected MeasureError")
    } catch (err) {
      expect(err).toBeInstanceOf(MeasureError)
      expect((err as MeasureError).message).toBe(
        "areaWithCutouts: cutouts[0] touches or crosses the region boundary — v2 boundary-crossing cutouts need a CONVEX region; a concave region accepts only cutouts drawn fully inside",
      )
    }
  })

  test("two crossing cutouts may not touch each other even OUTSIDE the region (the conservative pairwise bound)", () => {
    // Both cross x=100; a is y 10..30, b is y 15..25 — b lies inside a's
    // outside part too; the pairwise rule fires on the ORIGINAL rings.
    const a: Pt[] = [pt(90, 10), pt(110, 10), pt(110, 30), pt(90, 30)]
    const b: Pt[] = [pt(95, 15), pt(115, 15), pt(115, 25), pt(95, 25)]
    try {
      areaWithCutouts(REGION, [a, b], MM)
      throw new Error("expected MeasureError")
    } catch (err) {
      expect(err).toBeInstanceOf(MeasureError)
      expect((err as MeasureError).message).toBe(
        "areaWithCutouts: cutouts[0] and cutouts[1] overlap (their boundaries touch or cross) — overlapping cutouts would double-subtract the same area",
      )
    }
  })

  test("an outside cutout sharing only the boundary wall is refused (it would subtract nothing)", () => {
    // Entirely right of x=100 except its left edge lying ON the wall.
    const touching: Pt[] = [pt(100, 10), pt(110, 10), pt(110, 15), pt(100, 15)]
    try {
      areaWithCutouts(REGION, [touching], MM)
      throw new Error("expected MeasureError")
    } catch (err) {
      expect(err).toBeInstanceOf(MeasureError)
      expect((err as MeasureError).message).toBe(
        "areaWithCutouts: cutouts[0] lies entirely outside the region — it would subtract nothing; draw it inside the area or crossing its boundary",
      )
    }
  })

  test("gross stays bit-identical to polygonArea with a crossing cutout present", () => {
    const crossing: Pt[] = [pt(90, 10), pt(110, 10), pt(110, 15), pt(90, 15)]
    const result = areaWithCutouts(REGION, [crossing], MM)
    expect(result.grossMm2).toBe(polygonArea(REGION, MM))
  })
})
