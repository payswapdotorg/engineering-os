/**
 * Engineering OS — the page-rotation battery (the limitation-#17 lane).
 *
 * Pins the four-quadrant math of src/core/page-rotation.ts EXACTLY against
 * the EMPIRICAL probe of pdfjs-dist@4.10.38's own getViewport/
 * convertToViewportPoint (run 2026-10-29 on the rebuilt fixture's /Rotate 90
 * page 4, forced through all four rotations at scale 1 and 2) — every
 * expectation below is a probed number, not a derivation from memory
 * (the first draft's memory-derived table had 90/270 swapped; the probe
 * caught it before it could ship a wrong fix). Cross-layer alignment:
 * pdfplumber's displayed-space extraction of the same fixture agrees
 * byte-for-byte (socket at PDF (200..210, 350..360) → x0=350, top=200),
 * so the UI frame and the server's vector-takeoff frame are THE SAME space.
 *
 * The A3 fixture numbers (W = 1191, H = 842) are the committed sheet
 * fixture's MediaBox — the same numbers the browser journey and the e2e
 * lane use, so the layers cannot drift apart.
 */
import { describe, expect, test } from "bun:test"

import {
  PDF_ROTATIONS,
  RotationFrameError,
  assertRotationFrame,
  cssPxFromPdfPoint,
  pdfPointFromCssPx,
  viewportSize,
  type RotationFrame,
} from "./page-rotation"

const W = 1191 // the A3-landscape fixture's unrotated width (pt)
const H = 842 // the A3-landscape fixture's unrotated height (pt)

const frame = (rotation: number, scale = 1): RotationFrame =>
  ({ wPt: W, hPt: H, rotation: rotation as RotationFrame["rotation"], scale })

describe("viewportSize — the canvas extent per quadrant (pdf.js mirrored)", () => {
  test("upright quadrants are W·s × H·s", () => {
    expect(viewportSize(frame(0, 2))).toEqual({ width: 2382, height: 1684 })
    expect(viewportSize(frame(180, 1.5))).toEqual({ width: 1786.5, height: 1263 })
  })

  test("sideways quadrants swap the extents: H·s × W·s", () => {
    expect(viewportSize(frame(90, 2))).toEqual({ width: 1684, height: 2382 })
    expect(viewportSize(frame(270, 1.5))).toEqual({ width: 1263, height: 1786.5 })
  })
})

describe("cssPxFromPdfPoint — the exact probed table (pdfjs-dist@4.10.38)", () => {
  test("R=0 keeps the Slice-8 formula byte-identically: (x·s, (H−y)·s)", () => {
    // probed: 0,0 -> 0,842 ; 1191,0 -> 1191,842 ; 0,842 -> 0,0 ; 200,500 -> 200,342
    expect(cssPxFromPdfPoint(0, 0, frame(0))).toEqual({ x: 0, y: 842 })
    expect(cssPxFromPdfPoint(1191, 0, frame(0))).toEqual({ x: 1191, y: 842 })
    expect(cssPxFromPdfPoint(0, 842, frame(0))).toEqual({ x: 0, y: 0 })
    expect(cssPxFromPdfPoint(200, 500, frame(0))).toEqual({ x: 200, y: 342 })
    expect(cssPxFromPdfPoint(200, 500, frame(0, 2))).toEqual({ x: 400, y: 684 })
  })

  test("R=90 (the fixture page-4 quadrant): u=y·s, v=x·s — probed", () => {
    // probed: 0,0 -> 0,0 ; 1191,0 -> 0,1191 ; 0,842 -> 842,0 ; 1191,842 -> 842,1191
    expect(cssPxFromPdfPoint(0, 0, frame(90))).toEqual({ x: 0, y: 0 })
    expect(cssPxFromPdfPoint(1191, 0, frame(90))).toEqual({ x: 0, y: 1191 })
    expect(cssPxFromPdfPoint(0, 842, frame(90))).toEqual({ x: 842, y: 0 })
    expect(cssPxFromPdfPoint(1191, 842, frame(90))).toEqual({ x: 842, y: 1191 })
    // probed at scale 2: 200,500 -> 1000,400 ; 0,842 -> 1684,0
    expect(cssPxFromPdfPoint(200, 500, frame(90, 2))).toEqual({ x: 1000, y: 400 })
    expect(cssPxFromPdfPoint(0, 842, frame(90, 2))).toEqual({ x: 1684, y: 0 })
  })

  test("R=180: both axes mirror — probed", () => {
    expect(cssPxFromPdfPoint(0, 0, frame(180))).toEqual({ x: 1191, y: 0 })
    expect(cssPxFromPdfPoint(1191, 842, frame(180))).toEqual({ x: 0, y: 842 })
    expect(cssPxFromPdfPoint(200, 500, frame(180))).toEqual({ x: 991, y: 500 })
    expect(cssPxFromPdfPoint(200, 500, frame(180, 2))).toEqual({ x: 1982, y: 1000 })
  })

  test("R=270: u=(H−y)·s, v=(W−x)·s — probed", () => {
    expect(cssPxFromPdfPoint(0, 0, frame(270))).toEqual({ x: 842, y: 1191 })
    expect(cssPxFromPdfPoint(1191, 0, frame(270))).toEqual({ x: 842, y: 0 })
    expect(cssPxFromPdfPoint(0, 842, frame(270))).toEqual({ x: 0, y: 1191 })
    expect(cssPxFromPdfPoint(1191, 842, frame(270))).toEqual({ x: 0, y: 0 })
    expect(cssPxFromPdfPoint(200, 500, frame(270))).toEqual({ x: 342, y: 991 })
    expect(cssPxFromPdfPoint(200, 500, frame(270, 2))).toEqual({ x: 684, y: 1982 })
  })
})

describe("pdfPointFromCssPx — the click path, the probed inverse table", () => {
  test("R=0 keeps the Slice-8 click formula byte-identically", () => {
    expect(pdfPointFromCssPx(200, 342, frame(0))).toEqual({ x: 200, y: 500 })
    expect(pdfPointFromCssPx(400, 684, frame(0, 2))).toEqual({ x: 200, y: 500 })
  })

  test("R=90 — THE limitation-#17 scenario: what the eye sees vs what gets stored", () => {
    // On a /Rotate 90 sheet the canvas TOP-LEFT shows the unrotated page's
    // BOTTOM-LEFT corner — the pick must store (0, 0). The pre-fix
    // rotation-0 formula would have returned { 0, 842 } here (the unrotated
    // TOP-LEFT) — THAT is the limitation: the eye and the ledger disagreed.
    expect(pdfPointFromCssPx(0, 0, frame(90))).toEqual({ x: 0, y: 0 })
    // the canvas TOP-RIGHT shows the unrotated page's TOP-LEFT (0, 842).
    expect(pdfPointFromCssPx(842, 0, frame(90))).toEqual({ x: 0, y: 842 })
    // the fixture's socket: displayed around (350..360, 200..210); its
    // center (355, 205) must map to the pinned PDF center (205, 355).
    expect(pdfPointFromCssPx(355, 205, frame(90))).toEqual({ x: 205, y: 355 })
    // probed pairs: 500,200 -> 200,500 ; 1000,400 @s=2 -> 200,500 ; 842,1191 -> 1191,842
    expect(pdfPointFromCssPx(500, 200, frame(90))).toEqual({ x: 200, y: 500 })
    expect(pdfPointFromCssPx(1000, 400, frame(90, 2))).toEqual({ x: 200, y: 500 })
    expect(pdfPointFromCssPx(842, 1191, frame(90))).toEqual({ x: 1191, y: 842 })
  })

  test("R=180 and R=270 inverse tables — probed", () => {
    expect(pdfPointFromCssPx(1191, 0, frame(180))).toEqual({ x: 0, y: 0 })
    expect(pdfPointFromCssPx(991, 500, frame(180))).toEqual({ x: 200, y: 500 })
    expect(pdfPointFromCssPx(1982, 1000, frame(180, 2))).toEqual({ x: 200, y: 500 })
    expect(pdfPointFromCssPx(0, 0, frame(270))).toEqual({ x: 1191, y: 842 })
    expect(pdfPointFromCssPx(342, 991, frame(270))).toEqual({ x: 200, y: 500 })
    expect(pdfPointFromCssPx(684, 1982, frame(270, 2))).toEqual({ x: 200, y: 500 })
  })
})

describe("round-trip — every quadrant, corners + interior, both directions", () => {
  const pts: Array<[number, number]> = [
    [0, 0],
    [W, 0],
    [0, H],
    [W, H],
    [595.5, 421],
    [100, 200],
  ]
  const scales = [1, 2, 0.5, 1.7]

  for (const r of PDF_ROTATIONS) {
    for (const s of scales) {
      for (const [px, py] of pts) {
        test(`pt→px→pt is the identity at R=${r} s=${s} (${px},${py})`, () => {
          const f = frame(r, s)
          const a = cssPxFromPdfPoint(px, py, f)
          const back = pdfPointFromCssPx(a.x, a.y, f)
          expect(back.x).toBeCloseTo(px, 9)
          expect(back.y).toBeCloseTo(py, 9)
        })
      }
    }
  }

  test("cross-quadrant composition is pinned honestly: R=90 forward then R=270 inverse = the 180° point reflection", () => {
    // Derivation: u=y·s, v=x·s (R=90 fwd) fed into x'=W−v/s, y'=H−u/s (R=270
    // inv) gives x'=W−x, y'=H−y — the 180° reflection about the page center,
    // NOT the identity (the first draft of this test guessed identity and
    // the honest fix is to pin what the algebra actually says).
    const f90 = frame(90, 1.3)
    const f270 = frame(270, 1.3)
    const img = cssPxFromPdfPoint(331, 470, f90)
    const back = pdfPointFromCssPx(img.x, img.y, f270)
    expect(back.x).toBeCloseTo(W - 331, 9)
    expect(back.y).toBeCloseTo(H - 470, 9)
  })
})

describe("refusals — out-of-domain input throws, never guesses", () => {
  test("rotation off the spec set is refused (45, −90, 360, NaN)", () => {
    expect(() => viewportSize(frame(45))).toThrow(RotationFrameError)
    expect(() => viewportSize(frame(-90))).toThrow(RotationFrameError)
    expect(() => viewportSize(frame(360))).toThrow(RotationFrameError)
    expect(() => viewportSize(frame(Number.NaN))).toThrow(RotationFrameError)
    expect(() => cssPxFromPdfPoint(0, 0, frame(45))).toThrow(RotationFrameError)
    expect(() => pdfPointFromCssPx(0, 0, frame(45))).toThrow(RotationFrameError)
  })

  test("non-positive or non-finite dimensions/scale are refused", () => {
    expect(() => assertRotationFrame({ wPt: 0, hPt: 100, rotation: 0, scale: 1 })).toThrow(RotationFrameError)
    expect(() => assertRotationFrame({ wPt: -5, hPt: 100, rotation: 0, scale: 1 })).toThrow(RotationFrameError)
    expect(() => assertRotationFrame({ wPt: 100, hPt: Number.POSITIVE_INFINITY, rotation: 0, scale: 1 })).toThrow(RotationFrameError)
    expect(() => assertRotationFrame({ wPt: 100, hPt: 100, rotation: 0, scale: 0 })).toThrow(RotationFrameError)
    expect(() => assertRotationFrame({ wPt: 100, hPt: 100, rotation: 0, scale: -2 })).toThrow(RotationFrameError)
    expect(() => assertRotationFrame({ wPt: 100, hPt: 100, rotation: 0, scale: Number.NaN })).toThrow(RotationFrameError)
  })

  test("non-finite point coordinates are refused on both directions", () => {
    expect(() => cssPxFromPdfPoint(Number.NaN, 0, frame(90))).toThrow(RotationFrameError)
    expect(() => cssPxFromPdfPoint(0, Number.POSITIVE_INFINITY, frame(0))).toThrow(RotationFrameError)
    expect(() => pdfPointFromCssPx(Number.NaN, 0, frame(270))).toThrow(RotationFrameError)
    expect(() => pdfPointFromCssPx(0, Number.NEGATIVE_INFINITY, frame(180))).toThrow(RotationFrameError)
  })

  test("the four spec rotations are all accepted (a null frame is not)", () => {
    for (const r of PDF_ROTATIONS) {
      expect(() => assertRotationFrame(frame(r))).not.toThrow()
    }
    // biome-ignore lint/suspicious/noExplicitAny: asserting the null guard honestly
    expect(() => assertRotationFrame(null as any)).toThrow(RotationFrameError)
  })
})
