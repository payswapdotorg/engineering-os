/**
 * Engineering OS — unit battery for the measurement core (Slice 18).
 *
 * The §2.1 functions were previously covered indirectly (markup.test.ts +
 * the e2e golden path); this file pins them for arithmetic sanity AND owns
 * the full §2.2 region-cutout battery: analytic ground truths on integer
 * coordinates (every float operation below is exact — integers < 2^53) and
 * the verbatim refusal matrix. The one §2.2 refusal that is provably
 * unreachable through valid rings (net area exactly 0 with strictly-inside
 * cutouts) is documented as a defensive backstop rather than pinned.
 */
import { describe, expect, test } from "bun:test"

import {
  areaWithCutouts,
  calibrate,
  distance,
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

  test("cutout vertex ON the region boundary", () => {
    const onEdge: Pt[] = [pt(0, 10), pt(20, 10), pt(20, 15), pt(0, 15)]
    try {
      areaWithCutouts(REGION, [onEdge], MM)
      throw new Error("expected MeasureError")
    } catch (err) {
      expect(err).toBeInstanceOf(MeasureError)
      expect((err as MeasureError).message).toBe(
        "areaWithCutouts: cutouts[0].points[0] is not strictly inside the region (on the boundary or outside) — v1 cutouts must be drawn fully inside the area",
      )
    }
  })

  test("cutout vertex OUTSIDE the region", () => {
    const outside: Pt[] = [pt(150, 10), pt(160, 10), pt(160, 15), pt(150, 15)]
    try {
      areaWithCutouts(REGION, [outside], MM)
      throw new Error("expected MeasureError")
    } catch (err) {
      expect(err).toBeInstanceOf(MeasureError)
      expect((err as MeasureError).message).toBe(
        "areaWithCutouts: cutouts[0].points[0] is not strictly inside the region (on the boundary or outside) — v1 cutouts must be drawn fully inside the area",
      )
    }
  })

  test("cutout edge crossing a concave region's inner corner (all vertices strictly inside)", () => {
    // Both endpoints sit strictly inside the L, but the (5,16)→(16,5) edge
    // cuts across the notch — the boundary-contact net catches it.
    const chord: Pt[] = [pt(5, 16), pt(16, 5), pt(6, 6)]
    try {
      areaWithCutouts(L_REGION, [chord], MM)
      throw new Error("expected MeasureError")
    } catch (err) {
      expect(err).toBeInstanceOf(MeasureError)
      expect((err as MeasureError).message).toBe(
        "areaWithCutouts: cutouts[0] boundary touches or crosses the region boundary — v1 cutouts must be drawn fully inside the area",
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

  // NOTE: the "cutouts cancel the region exactly (net area 0)" refusal is a
  // DEFENSIVE BACKSTOP, provably unreachable through the strict-inside rules
  // (a ring strictly inside another always has strictly smaller shoelace
  // area, so gross − Σcutouts > 0 whenever every check above passes). It is
  // documented here rather than pinned — a test could only reach it by
  // bypassing the guards it protects.
})
