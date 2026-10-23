/**
 * Slice 13 — symbol template matching (NCC) tests.
 *
 * Pins the deterministic semantics of src/core/symbol-match.ts on SYNTHETIC
 * rasters built in-test (no image files, no canvas): exact-copy detection,
 * blank-window pruning, non-maximum suppression, option validation and the
 * flat-template refusal. All fixtures are hand-drawn pixel patterns with the
 * expected counts computed inline.
 */

/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test"
import {
  DEFAULT_SCAN_OPTIONS,
  extractTemplate,
  nccScan,
  SymbolMatchError,
  toGray,
  type GrayImage,
} from "./symbol-match"

// ---------------------------------------------------------------------------
// Synthetic raster helpers — everything hand-computed
// ---------------------------------------------------------------------------

/** A blank (white 255) raster. */
function blank(width: number, height: number): GrayImage {
  const data = new Float32Array(width * height).fill(255)
  return { width, height, data }
}

function put(img: GrayImage, x: number, y: number, v: number): void {
  img.data[y * img.width + x] = v
}

/** Draws the test glyph — a 12x12 "double square" (outline + center dot),
 *  the same topological shape as the fixture sheet's socket symbol:
 *   - 10x10 stroke outline around (x+1 .. x+10)
 *   - 4x4 filled inner square centered in it. */
function drawGlyph(img: GrayImage, ox: number, oy: number): void {
  for (let i = 0; i < 10; i += 1) {
    put(img, ox + 1 + i, oy + 1, 0) // top edge
    put(img, ox + 1 + i, oy + 10, 0) // bottom edge
    put(img, ox + 1, oy + 1 + i, 0) // left edge
    put(img, ox + 10, oy + 1 + i, 0) // right edge
  }
  for (let dy = 0; dy < 4; dy += 1) {
    for (let dx = 0; dx < 4; dx += 1) {
      put(img, ox + 4 + dx, oy + 4 + dy, 0)
    }
  }
}

/** A decoy glyph: same bounding box, DIFFERENT content (X diagonal). */
function drawDecoy(img: GrayImage, ox: number, oy: number): void {
  for (let i = 0; i < 12; i += 1) {
    put(img, ox + i, oy + i, 0)
    put(img, ox + i, oy + (11 - i), 0)
  }
}

/** 180x120 page with six glyphs at pinned spots + one decoy in clear space. */
function sixGlyphPage(): GrayImage {
  const img = blank(180, 120)
  const spots: Array<[number, number]> = [
    [10, 10],
    [60, 10],
    [110, 10],
    [10, 60],
    [60, 60],
    [110, 60],
  ]
  for (const [x, y] of spots) drawGlyph(img, x, y)
  // decoy in CLEAR space (150,60) — far from every real glyph so it can never
  // corrupt one; the (50,60) spot would collide with the glyph at (60,60).
  drawDecoy(img, 150, 60)
  return img
}

/** Extracts the template around the glyph at (10,10) — 12x12 box at (10,10). */
function glyphTemplate(img: GrayImage): GrayImage {
  return extractTemplate(img, { x: 10, y: 10, width: 12, height: 12 })
}

const expectMatchError = (fn: () => unknown, messagePart: string) => {
  try {
    fn()
    expect.unreachable("expected a SymbolMatchError")
  } catch (err) {
    expect(err).toBeInstanceOf(SymbolMatchError)
    expect((err as SymbolMatchError).message).toContain(messagePart)
  }
}

// ---------------------------------------------------------------------------
// toGray + extractTemplate
// ---------------------------------------------------------------------------

describe("toGray — RGBA → luminance (Rec.601), exact arithmetic", () => {
  test("pure black / white / gray / primary pixels convert exactly", () => {
    // 1x4 image: black(0,0,0) white(255,255,255) mid-gray(128,128,128) red(255,0,0)
    const rgba = new Uint8Array([
      0, 0, 0, 255,
      255, 255, 255, 255,
      128, 128, 128, 255,
      255, 0, 0, 255,
    ])
    const g = toGray(rgba, 1, 4)
    expect(g.width).toBe(1)
    expect(g.height).toBe(4)
    // Float32 storage rounds at ~1e-5 relative — precision 4 is exact here.
    expect(g.data[0]).toBe(0)
    expect(g.data[1]).toBeCloseTo(255, 4)
    expect(g.data[2]).toBeCloseTo(0.299 * 128 + 0.587 * 128 + 0.114 * 128, 4)
    expect(g.data[3]).toBeCloseTo(0.299 * 255, 4)
  })

  test("buffer length mismatch is refused, not read past the end", () => {
    expectMatchError(() => toGray(new Uint8Array(16), 2, 4), "does not match")
  })

  test("zero-dimension rasters are refused", () => {
    expectMatchError(() => toGray(new Uint8Array(0), 0, 4), "whole numbers >= 1")
  })
})

describe("extractTemplate — cropping with shared bounds rules", () => {
  test("crops the exact pixels (row-major copy)", () => {
    const img = blank(10, 10)
    for (let i = 0; i < 10; i += 1) put(img, i, 4, 100 + i)
    const t = extractTemplate(img, { x: 2, y: 4, width: 4, height: 1 + 1 })
    expect(t.width).toBe(4)
    expect(t.height).toBe(2)
    expect(Array.from(t.data)).toEqual([102, 103, 104, 105, 255, 255, 255, 255])
  })

  test("out-of-bounds / tiny / non-integer rects are refused with the region in the message", () => {
    const img = blank(50, 50)
    expectMatchError(
      () => extractTemplate(img, { x: 40, y: 0, width: 12, height: 12 }),
      "falls outside the 50x50 raster",
    )
    expectMatchError(() => extractTemplate(img, { x: 0, y: 0, width: 1, height: 12 }), "at least 2x2")
    expectMatchError(() => extractTemplate(img, { x: 0.5, y: 0, width: 12, height: 12 }), "whole numbers")
  })
})

// ---------------------------------------------------------------------------
// nccScan — the matcher
// ---------------------------------------------------------------------------

describe("nccScan — exact-copy detection on the six-glyph page", () => {
  test("finds EXACTLY the 6 glyph copies (stride 1), scores >= 0.99, positions at the pinned spots", () => {
    const page = sixGlyphPage()
    const hits = nccScan(page, glyphTemplate(page), { stride: 1 })
    expect(hits.length).toBe(6)
    const spots = [
      { x: 10, y: 10 },
      { x: 60, y: 10 },
      { x: 110, y: 10 },
      { x: 10, y: 60 },
      { x: 60, y: 60 },
      { x: 110, y: 60 },
    ]
    const got = new Set(hits.map((h) => `${h.x},${h.y}`))
    for (const s of spots) expect(got.has(`${s.x},${s.y}`)).toBe(true)
    for (const h of hits) expect(h.score).toBeGreaterThanOrEqual(0.99)
    for (const h of hits) {
      expect(h.width).toBe(12)
      expect(h.height).toBe(12)
    }
  })

  test("stride 2 (a coarse-probe option) still finds all 6 at even positions", () => {
    const page = sixGlyphPage()
    const hits = nccScan(page, glyphTemplate(page), { stride: 2 })
    expect(hits.length).toBe(6)
  })

  test("REGRESSION (Slice-13 browser journey): a template at an ODD raster offset is still found — stride 2 missed it, the exhaustive default must not", () => {
    const page = sixGlyphPage()
    // Shift the whole glyph field by 1 px (odd top-left) — the live journey's
    // exact failure mode: template top-left at an odd row/column.
    const shifted = blank(180, 120)
    for (let y = 0; y < 120; y += 1) {
      for (let x = 0; x < 180; x += 1) {
        const sx = x - 1
        const sy = y - 1
        if (sx >= 0 && sy >= 0) shifted.data[y * 180 + x] = page.data[sy * 180 + sx]
      }
    }
    const tpl = extractTemplate(shifted, { x: 11, y: 11, width: 12, height: 12 }) // odd top-left
    const exhaustive = nccScan(shifted, tpl) // DEFAULT stride 1
    expect(exhaustive.length).toBe(6)
    const coarse = nccScan(shifted, tpl, { stride: 2 })
    // the coarse cadence is exactly what the journey caught missing hits
    expect(coarse.length).toBe(0)
  })

  test("the decoy (X glyph) is NOT matched above 0.85 — different symbol, no false positive", () => {
    const page = sixGlyphPage()
    const hits = nccScan(page, glyphTemplate(page))
    expect(hits.every((h) => h.x !== 150 || h.y !== 60)).toBe(true)
  })

  test("deterministic ORDER: score desc, then y asc, then x asc", () => {
    const page = sixGlyphPage()
    const hits = nccScan(page, glyphTemplate(page), { stride: 1 })
    for (let i = 1; i < hits.length; i += 1) {
      const a = hits[i - 1]
      const b = hits[i]
      expect(
        a.score > b.score || (a.score === b.score && (a.y < b.y || (a.y === b.y && a.x < b.x))),
      ).toBe(true)
    }
  })

  test("raising minScore to 0.9999 keeps only near-perfect copies (still 6 on clean pixels)", () => {
    const page = sixGlyphPage()
    const hits = nccScan(page, glyphTemplate(page), { stride: 1, minScore: 0.9999 })
    expect(hits.length).toBe(6)
  })

  test("noisy copies (±12 luminance levels) still match at the 0.85 default", () => {
    const page = sixGlyphPage()
    // Deterministic noise on the top-right glyph (110,10): lighten its bottom
    // edge by 12 levels — the NCC denominator absorbs the variance shift.
    for (let i = 0; i < 10; i += 1) {
      const x = 110 + 1 + i
      const y = 10 + 10
      page.data[y * page.width + x] = 12
    }
    const hits = nccScan(page, glyphTemplate(page))
    expect(hits.some((h) => h.x === 110 && h.y === 10)).toBe(true)
    expect(hits.length).toBe(6)
  })
})

describe("nccScan — non-maximum suppression + caps", () => {
  test("two copies 4 px apart merge into ONE hit (same instance rule)", () => {
    const page = blank(100, 40)
    drawGlyph(page, 10, 10)
    drawGlyph(page, 14, 10) // 4 px offset — well inside max(12,12)/2 = 6
    const hits = nccScan(page, glyphTemplate(page), { stride: 1 })
    expect(hits.length).toBe(1)
  })

  test("copies 20 px apart are two distinct hits", () => {
    const page = blank(100, 40)
    drawGlyph(page, 10, 10)
    drawGlyph(page, 30, 10)
    const hits = nccScan(page, glyphTemplate(page), { stride: 1 })
    expect(hits.length).toBe(2)
  })

  test("maxHits caps the returned list, highest score first", () => {
    const page = sixGlyphPage()
    const hits = nccScan(page, glyphTemplate(page), { stride: 1, maxHits: 3 })
    expect(hits.length).toBe(3)
    // the capped list is a prefix of the full deterministic order
    const full = nccScan(page, glyphTemplate(page), { stride: 1 })
    expect(hits.map((h) => `${h.x},${h.y}`)).toEqual(full.slice(0, 3).map((h) => `${h.x},${h.y}`))
  })
})

describe("nccScan — honest refusals (never NaN, never a silent empty result)", () => {
  test("a flat template (blank paper) is refused", () => {
    const page = sixGlyphPage()
    const flat = extractTemplate(page, { x: 150, y: 10, width: 12, height: 12 }) // blank area
    expectMatchError(() => nccScan(page, flat), "no contrast — pick a region that contains the drawn symbol")
  })

  test("option validation: stride / minScore / maxHits / template size", () => {
    const page = sixGlyphPage()
    const tpl = glyphTemplate(page)
    expectMatchError(() => nccScan(page, tpl, { stride: 0 }), "stride must be a whole number >= 1")
    expectMatchError(() => nccScan(page, tpl, { stride: 1.5 }), "stride must be a whole number >= 1")
    expectMatchError(() => nccScan(page, tpl, { minScore: 0 }), "minScore must be in (0, 1]")
    expectMatchError(() => nccScan(page, tpl, { minScore: 1.2 }), "minScore must be in (0, 1]")
    expectMatchError(() => nccScan(page, tpl, { maxHits: 0 }), "maxHits must be a whole number >= 1")
    expectMatchError(
      () => nccScan(page, { width: 1, height: 1, data: new Float32Array(1) }),
      "at least 2x2 pixels",
    )
    expectMatchError(
      () =>
        nccScan(page, { width: 200, height: 200, data: new Float32Array(200 * 200).fill(128).map((v, i) => (i % 7 === 0 ? 0 : v)) }),
      "larger than the page raster",
    )
  })

  test("a page with NO copies returns an honest empty list (not an error)", () => {
    const page = blank(100, 60)
    drawDecoy(page, 40, 20)
    const glyphs = sixGlyphPage()
    const hits = nccScan(page, glyphTemplate(glyphs))
    expect(hits).toEqual([])
  })
})

describe("DEFAULT_SCAN_OPTIONS — the shipped UI cadence", () => {
  test("stride 1 (exhaustive), minScore 0.85, maxHits 500 (the documented defaults)", () => {
    expect(DEFAULT_SCAN_OPTIONS).toEqual({ stride: 1, minScore: 0.85, maxHits: 500 })
  })
})
