/**
 * Slice 13 — persistent sheet-markup core tests.
 *
 * Pins the deterministic semantics of src/core/markup.ts: closed kind
 * vocabulary, per-kind point counts, the kind→unit mapping, and the strict
 * value/geometry consistency rules (a stored count can never disagree with
 * its clicked points). All expectations are hand-written rule checks, not
 * engineering claims.
 */

/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test"
import {
  makeSheetMarkup,
  markupUnitFor,
  MARKUP_KINDS,
  MarkupError,
  requiredPointsFor,
  type SheetMarkupInput,
} from "./markup"

const baseInput: SheetMarkupInput = {
  id: "mkp_00000000-0000-4000-8000-000000000001",
  projectId: "prj_00000000-0000-4000-8000-000000000002",
  revisionId: "rev_00000000-0000-4000-8000-000000000003",
  page: 1,
  kind: "length",
  points: [
    { x: 60, y: 120 },
    { x: 343.4646, y: 120 },
  ],
  label: "room perimeter segment A",
  value: 8.0,
  unit: "m",
  scale: "calibrated 2-pt, 10 m ↔ 283.46 pt — 8.80 mm/pt",
  quantityId: "qty_00000000-0000-4000-8000-000000000004",
  createdBy: "mem_00000000-0000-4000-8000-000000000005",
  createdAt: "2026-01-01T00:00:00.000Z",
}

const make = (over: Partial<SheetMarkupInput>): ReturnType<typeof makeSheetMarkup> =>
  makeSheetMarkup({ ...baseInput, ...over })

const expectMarkupError = (input: Partial<SheetMarkupInput>, messagePart: string) => {
  try {
    make(input)
    expect.unreachable("makeSheetMarkup should have thrown")
  } catch (err) {
    expect(err).toBeInstanceOf(MarkupError)
    const msg = (err as MarkupError).message
    expect(msg).toContain(messagePart)
  }
}

describe("MARKUP_KINDS + per-kind vocabulary", () => {
  test("closed kind list is exactly the six frozen kinds (Slice 16-B adds text-hits)", () => {
    expect([...MARKUP_KINDS]).toEqual(["length", "area", "count", "symbol-hits", "text-hits", "calibration"])
  })

  test("kind→unit mapping is the closed ledger vocabulary", () => {
    expect(markupUnitFor("length")).toBe("m")
    expect(markupUnitFor("area")).toBe("m²")
    expect(markupUnitFor("count")).toBe("each")
    expect(markupUnitFor("symbol-hits")).toBe("each")
    expect(markupUnitFor("calibration")).toBe("mm/pt")
  })

  test("point-count requirements per kind (frozen table)", () => {
    expect(requiredPointsFor("length")).toEqual({ min: 2, exact: null })
    expect(requiredPointsFor("area")).toEqual({ min: 3, exact: null })
    expect(requiredPointsFor("count")).toEqual({ min: 1, exact: null })
    expect(requiredPointsFor("symbol-hits")).toEqual({ min: 2, exact: null })
    expect(requiredPointsFor("calibration")).toEqual({ min: 2, exact: 2 })
  })
})

describe("makeSheetMarkup — valid records per kind", () => {
  test("valid length markup passes and round-trips every field", () => {
    const rec = make({})
    expect(rec.kind).toBe("length")
    expect(rec.points).toEqual([
      { x: 60, y: 120 },
      { x: 343.4646, y: 120 },
    ])
    expect(rec.unit).toBe("m")
    expect(rec.label).toBe("room perimeter segment A")
    expect(rec.scale).toBe("calibrated 2-pt, 10 m ↔ 283.46 pt — 8.80 mm/pt")
    expect(rec.quantityId).toBe("qty_00000000-0000-4000-8000-000000000004")
    expect(rec.createdBy).toBe("mem_00000000-0000-4000-8000-000000000005")
  })

  test("valid area markup (4 corners) passes", () => {
    const rec = make({
      kind: "area",
      unit: "m²",
      value: 40.085,
      points: [
        { x: 500, y: 400 },
        { x: 726.77, y: 400 },
        { x: 726.77, y: 541.73 },
        { x: 500, y: 541.73 },
      ],
    })
    expect(rec.kind).toBe("area")
    expect(rec.unit).toBe("m²")
  })

  test("valid count markup passes with value === clicked points", () => {
    const rec = make({
      kind: "count",
      unit: "each",
      value: 3,
      points: [
        { x: 10, y: 10 },
        { x: 20, y: 10 },
        { x: 30, y: 10 },
      ],
    })
    expect(rec.value).toBe(3)
    expect(rec.points.length).toBe(3)
  })

  test("valid symbol-hits markup: 2 pairs → value 2", () => {
    const rec = make({
      kind: "symbol-hits",
      unit: "each",
      value: 2,
      points: [
        { x: 100, y: 200 },
        { x: 128, y: 228 },
        { x: 300, y: 200 },
        { x: 328, y: 228 },
      ],
    })
    expect(rec.value).toBe(2)
    expect(rec.points.length).toBe(4)
  })

  test("valid calibration markup: exactly 2 picks, mm/pt factor, no quantity link", () => {
    const rec = make({
      kind: "calibration",
      unit: "mm/pt",
      value: 8.8,
      points: [
        { x: 60, y: 120 },
        { x: 343.4646, y: 120 },
      ],
      label: "scale bar 10 m",
      quantityId: undefined,
    })
    expect(rec.kind).toBe("calibration")
    expect(rec.quantityId).toBeNull()
  })

  test("a calibration with a slipped-in quantityId is REFUSED, not silently rewritten", () => {
    expectMarkupError(
      {
        kind: "calibration",
        unit: "mm/pt",
        value: 8.8,
        points: [
          { x: 60, y: 120 },
          { x: 343.4646, y: 120 },
        ],
        quantityId: "qty_00000000-0000-4000-8000-000000000004",
      },
      "a calibration markup is not a ledger row — quantityId must be omitted",
    )
  })

  test("whitespace-only label and scale normalize to null", () => {
    const rec = make({ label: "   ", scale: "  " })
    expect(rec.label).toBeNull()
    expect(rec.scale).toBeNull()
  })

  test("omitted label/scale/quantityId are null, createdAt defaults to now", () => {
    const rec = make({ label: undefined, scale: undefined, quantityId: undefined, createdAt: undefined })
    expect(rec.label).toBeNull()
    expect(rec.scale).toBeNull()
    expect(rec.quantityId).toBeNull()
    expect(Number.isNaN(Date.parse(rec.createdAt))).toBe(false)
  })
})

describe("makeSheetMarkup — shape validation (MarkupError, honest messages)", () => {
  test("empty identity fields are refused", () => {
    expectMarkupError({ id: "" }, "id")
    expectMarkupError({ projectId: "  " }, "projectId")
    expectMarkupError({ revisionId: "" }, "revisionId")
    expectMarkupError({ createdBy: "" }, "createdBy")
  })

  test("page must be a whole number >= 1", () => {
    expectMarkupError({ page: 0 }, "page")
    expectMarkupError({ page: -1 }, "page")
    expectMarkupError({ page: 1.5 }, "whole number")
  })

  test("unknown kind is refused with the closed vocabulary in the message", () => {
    expectMarkupError(
      { kind: "volume" as never },
      "kind must be one of: length, area, count, symbol-hits, text-hits, calibration",
    )
  })

  test("non-finite point coordinates are refused (never NaN)", () => {
    expectMarkupError(
      { points: [{ x: Number.NaN, y: 10 }, { x: 20, y: 10 }] },
      "point.x must be a number",
    )
    expectMarkupError(
      { points: [{ x: 10, y: Number.POSITIVE_INFINITY }] },
      "point.y must be a number",
    )
  })

  test("non-finite value is refused", () => {
    expectMarkupError({ value: Number.NaN }, "value must be a number")
  })
})

describe("makeSheetMarkup — per-kind semantics", () => {
  test("length needs >= 2 points", () => {
    expectMarkupError(
      { kind: "length", points: [{ x: 1, y: 1 }] },
      "length markups need at least 2 points (got 1)",
    )
  })

  test("area needs >= 3 points", () => {
    expectMarkupError(
      { kind: "area", unit: "m²", points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] },
      "area markups need at least 3 points (got 2)",
    )
  })

  test("calibration needs EXACTLY 2 points", () => {
    expectMarkupError(
      {
        kind: "calibration",
        unit: "mm/pt",
        value: 8.8,
        points: [
          { x: 1, y: 1 },
          { x: 2, y: 2 },
          { x: 3, y: 3 },
        ],
      },
      "calibration markups need exactly 2 points (got 3)",
    )
  })

  test("symbol-hits must store pairs (even point count)", () => {
    expectMarkupError(
      {
        kind: "symbol-hits",
        unit: "each",
        value: 2,
        points: [
          { x: 1, y: 1 },
          { x: 2, y: 2 },
          { x: 3, y: 3 },
        ],
      },
      "points count must be even (got 3)",
    )
  })

  test("unit must match the kind's closed unit", () => {
    expectMarkupError(
      { kind: "length", unit: "mm" },
      'unit for a length markup must be "m" (got "mm")',
    )
    expectMarkupError(
      { kind: "count", unit: "m" },
      'unit for a count markup must be "each" (got "m")',
    )
  })

  test("count value must equal the clicked points (geometry/number consistency)", () => {
    expectMarkupError(
      {
        kind: "count",
        unit: "each",
        value: 3,
        points: [
          { x: 1, y: 1 },
          { x: 2, y: 2 },
        ],
      },
      "value must equal its clicked points (2), got 3",
    )
    expectMarkupError(
      { kind: "count", unit: "each", value: 0, points: [] },
      "points must not be empty",
    )
  })

  test("symbol-hits value must equal the hit-box count", () => {
    expectMarkupError(
      {
        kind: "symbol-hits",
        unit: "each",
        value: 3,
        points: [
          { x: 1, y: 1 },
          { x: 2, y: 2 },
        ],
      },
      "value must equal its hit-box count (1), got 3",
    )
  })

  test("length/area/calibration values must be finite > 0", () => {
    expectMarkupError({ value: 0 }, "value must be a finite number > 0 (got 0)")
    expectMarkupError(
      {
        kind: "area",
        unit: "m²",
        value: -5,
        points: [
          { x: 500, y: 400 },
          { x: 726.77, y: 400 },
          { x: 726.77, y: 541.73 },
        ],
      },
      "value must be a finite number > 0 (got -5)",
    )
    expectMarkupError(
      { kind: "calibration", unit: "mm/pt", value: 0, points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] },
      "value (mm/pt factor) must be a finite number > 0 (got 0)",
    )
  })
})

// ---------------------------------------------------------------------------
// Slice 16-B — text-hits (accepted OCR word boxes)
// ---------------------------------------------------------------------------

describe("text-hits markups (Slice 16-B sheet-text OCR)", () => {
  const wordBoxes = [
    { x: 100, y: 500 },
    { x: 140, y: 480 },
    { x: 200, y: 500 },
    { x: 260, y: 480 },
  ] // two [tl, br] pairs, image order

  test("a valid text-hits markup: unit each, value === pair count", () => {
    const record = make({
      kind: "text-hits",
      unit: "each",
      value: 2,
      points: wordBoxes,
      quantityId: undefined,
      scale: undefined,
      label: "OCR transcript (2 words)",
    })
    expect(record.kind).toBe("text-hits")
    expect(record.unit).toBe("each")
    expect(record.value).toBe(2)
    expect(record.points).toEqual(wordBoxes)
  })

  test("an odd point count refuses (pairs only)", () => {
    expectMarkupError(
      {
        kind: "text-hits",
        unit: "each",
        value: 1,
        points: wordBoxes.slice(0, 3),
      },
      "text-hits markups store [topLeft, bottomRight] pairs per accepted OCR word, so the points count must be even (got 3)",
    )
  })

  test("value must equal the word-box count (the strict consistency rule)", () => {
    expectMarkupError(
      {
        kind: "text-hits",
        unit: "each",
        value: 3,
        points: wordBoxes,
      },
      "a text-hits markup's value must equal its hit-box count (2), got 3",
    )
  })

  test("unit must be each (closed vocabulary)", () => {
    expectMarkupError(
      {
        kind: "text-hits",
        unit: "m",
        value: 2,
        points: wordBoxes,
      },
      'unit for a text-hits markup must be "each" (got "m")',
    )
  })

  test("requiredPointsFor: min 2, no exact count (N pairs)", () => {
    expect(requiredPointsFor("text-hits")).toEqual({ min: 2, exact: null })
  })
})

// ---------------------------------------------------------------------------
// Slice 18 — region cutouts (kind "area" + the cutouts payload structure)
// ---------------------------------------------------------------------------

/** The analytic cutouts fixture: 100×50 pt region, mmPerPt 20 (§2.2 battery). */
const CUTOUTS_REGION = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 50 },
  { x: 0, y: 50 },
]
const CUTOUT_RING = [
  { x: 10, y: 10 },
  { x: 20, y: 10 },
  { x: 20, y: 15 },
  { x: 10, y: 15 },
]
/** gross 2.0 m² · cutout 0.02 m² · net 1.98 m² (all exact — integer arithmetic). */
const CUTOUTS_INPUT = {
  rings: [CUTOUT_RING],
  mmPerPt: 20,
  grossValue: 2,
  cutoutValue: 0.02,
  netValue: 1.98,
}

const makeAreaWithCutouts = (over: Record<string, unknown>) =>
  make({
    kind: "area",
    points: CUTOUTS_REGION,
    value: 1.98,
    unit: "m²",
    cutouts: CUTOUTS_INPUT,
    ...over,
  })

describe("makeSheetMarkup — region cutouts (Slice 18)", () => {
  test("a valid area-with-cutouts record echoes the validated structure", () => {
    const record = makeAreaWithCutouts({})
    expect(record.kind).toBe("area")
    expect(record.value).toBe(1.98)
    expect(record.cutouts).not.toBeNull()
    expect(record.cutouts?.rings).toHaveLength(1)
    expect(record.cutouts?.mmPerPt).toBe(20)
    expect(record.cutouts?.netValue).toBe(1.98)
  })

  test("a plain area carries cutouts: null (no payload, backward compatible)", () => {
    const record = make({ kind: "area", points: CUTOUTS_REGION, value: 2, unit: "m²" })
    expect(record.cutouts).toBeNull()
  })

  test("cutouts on a non-area kind are refused (length)", () => {
    expectMarkupError(
      { kind: "length", value: 8, unit: "m", cutouts: CUTOUTS_INPUT },
      'cutouts are only accepted for kind "area" markups (kind length carries none)',
    )
  })

  test("value disagreeing with the recomputed NET area is refused with both numbers", () => {
    expectMarkupError(
      { kind: "area", points: CUTOUTS_REGION, value: 1.5, unit: "m²", cutouts: CUTOUTS_INPUT },
      "value (1.5) disagrees with the recomputed NET area (1.98)",
    )
  })

  test("a tampered grossValue in the breakdown is refused", () => {
    expectMarkupError(
      {
        kind: "area",
        points: CUTOUTS_REGION,
        value: 1.98,
        unit: "m²",
        cutouts: { ...CUTOUTS_INPUT, grossValue: 3 },
      },
      "cutouts.grossValue (3) disagrees with the recomputed gross area (2)",
    )
  })

  test("a tampered cutoutValue in the breakdown is refused", () => {
    expectMarkupError(
      {
        kind: "area",
        points: CUTOUTS_REGION,
        value: 1.98,
        unit: "m²",
        cutouts: { ...CUTOUTS_INPUT, cutoutValue: 0.5 },
      },
      "cutouts.cutoutValue (0.5) disagrees with the recomputed cutout area (0.02)",
    )
  })

  test("geometry violations surface the §2.2 core messages verbatim (cutout outside)", () => {
    expectMarkupError(
      {
        kind: "area",
        points: CUTOUTS_REGION,
        value: 1.98,
        unit: "m²",
        cutouts: {
          ...CUTOUTS_INPUT,
          rings: [[{ x: 150, y: 10 }, { x: 160, y: 10 }, { x: 160, y: 15 }, { x: 150, y: 15 }]],
        },
      },
      "areaWithCutouts: cutouts[0].points[0] is not strictly inside the region",
    )
  })

  test("overlapping cutouts surface the double-subtract refusal verbatim", () => {
    expectMarkupError(
      {
        kind: "area",
        points: CUTOUTS_REGION,
        value: 1.98,
        unit: "m²",
        cutouts: {
          ...CUTOUTS_INPUT,
          rings: [
            [{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 20 }, { x: 10, y: 20 }],
            [{ x: 15, y: 15 }, { x: 25, y: 15 }, { x: 25, y: 25 }, { x: 15, y: 25 }],
          ],
        },
      },
      "overlapping cutouts would double-subtract the same area",
    )
  })

  test("an empty rings array is refused (plain areas send no cutouts at all)", () => {
    expectMarkupError(
      { kind: "area", points: CUTOUTS_REGION, value: 2, unit: "m²", cutouts: { ...CUTOUTS_INPUT, rings: [] } },
      "cutouts.rings must contain at least one cutout ring",
    )
  })

  test("the record round-trips a two-cutout net exactly", () => {
    const secondRing = [
      { x: 30, y: 10 },
      { x: 40, y: 10 },
      { x: 40, y: 15 },
      { x: 30, y: 15 },
    ]
    const record = make({
      kind: "area",
      points: CUTOUTS_REGION,
      value: 1.96,
      unit: "m²",
      cutouts: { rings: [CUTOUT_RING, secondRing], mmPerPt: 20, grossValue: 2, cutoutValue: 0.04, netValue: 1.96 },
    })
    expect(record.value).toBe(1.96)
    expect(record.cutouts?.rings).toHaveLength(2)
  })
})
