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
  DEFAULT_SCALE_LADDER,
  DEFAULT_SCAN_OPTIONS,
  extractTemplate,
  nccScan,
  nccScanMultiScale,
  resampleTemplate,
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

// ---------------------------------------------------------------------------
// Slice 20 — resampleTemplate (the deterministic area-weighted resampler)
// ---------------------------------------------------------------------------

describe("resampleTemplate — area-weighted resampling, hand-computed", () => {
  test("integer 0.5x downscale = exact 2x2 block averages", () => {
    // 4x4 quadrant raster → 2x2: each dest pixel averages its 2x2 block.
    const t: GrayImage = {
      width: 4,
      height: 4,
      data: new Float32Array([
        0, 0, 255, 255,
        0, 0, 255, 255,
        255, 255, 0, 0,
        255, 255, 0, 0,
      ]),
    }
    const r = resampleTemplate(t, 0.5)
    expect(r.width).toBe(2)
    expect(r.height).toBe(2)
    expect(Array.from(r.data)).toEqual([0, 255, 255, 0])
  })

  test("bilinear upscale: 2x2 -> 3x3 pinned values (the same overlap integral)", () => {
    const t: GrayImage = {
      width: 2,
      height: 2,
      data: new Float32Array([0, 100, 200, 255]),
    }
    const r = resampleTemplate(t, 1.5) // round(2*1.5)=3
    expect(r.width).toBe(3)
    expect(r.height).toBe(3)
    // corners carry the corner pixels; edges/center are the fractional blends
    // (e.g. center = (0+100+200+255)/4 = 138.75 — bilinear at the half-pixel).
    expect(r.data[0]).toBeCloseTo(0, 4)
    expect(r.data[2]).toBeCloseTo(100, 4)
    expect(r.data[6]).toBeCloseTo(200, 4)
    expect(r.data[8]).toBeCloseTo(255, 4)
    expect(r.data[1]).toBeCloseTo(50, 4)
    expect(r.data[3]).toBeCloseTo(100, 4)
    expect(r.data[5]).toBeCloseTo(177.5, 4)
    expect(r.data[7]).toBeCloseTo(227.5, 4)
    expect(r.data[4]).toBeCloseTo(138.75, 4)
  })

  test("scale 1.0 reproduces the template BIT-IDENTICALLY", () => {
    const page = sixGlyphPage()
    const tpl = glyphTemplate(page)
    const r = resampleTemplate(tpl, 1)
    expect(r.width).toBe(tpl.width)
    expect(r.height).toBe(tpl.height)
    for (let i = 0; i < tpl.data.length; i += 1) {
      expect(r.data[i]).toBe(tpl.data[i])
    }
  })

  test("non-integer targets round: 12x12 at 1.35 -> 16x16", () => {
    const page = sixGlyphPage()
    const r = resampleTemplate(glyphTemplate(page), 1.35)
    expect(r.width).toBe(16)
    expect(r.height).toBe(16)
  })

  test("a rung below the 2x2 floor is refused with the scale in the message", () => {
    const small: GrayImage = { width: 3, height: 3, data: new Float32Array(9).fill(128).map((v, i) => (i % 2 ? 0 : v)) }
    // round(3*0.5)=2 does NOT violate the floor (JS rounds .5 up) — 0.4 does.
    expectMatchError(() => resampleTemplate(small, 0.4), "would shrink the 3x3 template below the 2x2 pixel floor")
  })

  test("non-finite / non-positive scales and sub-2x2 templates are refused", () => {
    const page = sixGlyphPage()
    const tpl = glyphTemplate(page)
    expectMatchError(() => resampleTemplate(tpl, 0), "scale must be a finite number > 0")
    expectMatchError(() => resampleTemplate(tpl, Number.POSITIVE_INFINITY), "scale must be a finite number > 0")
    expectMatchError(() => resampleTemplate(tpl, -1), "scale must be a finite number > 0")
    expectMatchError(
      () => resampleTemplate({ width: 1, height: 1, data: new Float32Array(1) }, 2),
      "at least 2x2 pixels",
    )
  })
})

// ---------------------------------------------------------------------------
// Slice 20 — nccScanMultiScale (the pinned-ladder scale-invariant lane)
// ---------------------------------------------------------------------------

/** Pastes a raster INTO a page at (ox, oy) — used to place RESAMPLED instances
 *  so the rung match is EXACT (score 1.0), independent of hand-drawing dust. */
function paste(img: GrayImage, ox: number, oy: number, src: GrayImage): void {
  for (let dy = 0; dy < src.height; dy += 1) {
    for (let dx = 0; dx < src.width; dx += 1) {
      img.data[(oy + dy) * img.width + ox + dx] = src.data[dy * src.width + dx]
    }
  }
}

/** A hand-drawn 18x18 sibling of the 12x12 glyph: 15x15 outline (1px strokes)
 *  + 6x6 inner square — same topology, DIFFERENT rasterization (the honest
 *  degradation case: real renders do not resample the picked pixels). */
function drawGlyph18(img: GrayImage, ox: number, oy: number): void {
  for (let i = 0; i < 15; i += 1) {
    put(img, ox + 2 + i, oy + 2, 0)
    put(img, ox + 2 + i, oy + 16, 0)
    put(img, ox + 2, oy + 2 + i, 0)
    put(img, ox + 16, oy + 2 + i, 0)
  }
  for (let dy = 0; dy < 6; dy += 1) {
    for (let dx = 0; dx < 6; dx += 1) {
      put(img, ox + 6 + dx, oy + 6 + dy, 0)
    }
  }
}

describe("nccScanMultiScale — the two-size page (exact rung pins)", () => {
  /** The fixture topology: three 12x12 glyphs + three resample-pasted 18x18
   *  instances (the 1.5-rung resample of the 12x12 template itself). */
  function twoSizePage() {
    const page = blank(220, 80)
    for (const [x, y] of [
      [10, 10],
      [60, 10],
      [110, 10],
    ] as Array<[number, number]>) {
      drawGlyph(page, x, y)
    }
    const tpl = extractTemplate(page, { x: 10, y: 10, width: 12, height: 12 })
    const big = resampleTemplate(tpl, 1.5)
    for (const [x, y] of [
      [10, 50],
      [60, 50],
      [110, 50],
    ] as Array<[number, number]>) {
      paste(page, x, y, big)
    }
    return { page, tpl }
  }

  test("one scan finds BOTH sizes: 3 hits at scale 1 (score 1.0) + 3 at scale 1.5 (score 1.0)", () => {
    const { page, tpl } = twoSizePage()
    const hits = nccScanMultiScale(page, tpl, { scales: [1, 1.5] })
    expect(hits.length).toBe(6)
    const at1 = hits.filter((h) => h.scale === 1)
    const at15 = hits.filter((h) => h.scale === 1.5)
    expect(at1.length).toBe(3)
    expect(at15.length).toBe(3)
    for (const h of at1) {
      expect(h.score).toBe(1)
      expect(h.width).toBe(12)
      expect(h.height).toBe(12)
    }
    for (const h of at15) {
      expect(h.score).toBe(1)
      expect(h.width).toBe(18)
      expect(h.height).toBe(18)
    }
    const spots15 = new Set(at15.map((h) => `${h.x},${h.y}`))
    for (const [x, y] of [
      [10, 50],
      [60, 50],
      [110, 50],
    ]) {
      expect(spots15.has(`${x},${y}`)).toBe(true)
    }
  })

  test("the v1 core alone (scale-naive) finds ONLY the 3 template-size instances — the recorded limitation, made measurable", () => {
    const { page, tpl } = twoSizePage()
    expect(nccScan(page, tpl).length).toBe(3)
  })

  test("noisy scaled copies (bottom edge lightened by 12 levels) still match at the 0.85 default", () => {
    const { page, tpl } = twoSizePage()
    // noise the 1.5x instance at (10,50): its outline bottom edge row
    for (let dx = 0; dx < 18; dx += 1) {
      const v = page.data[50 * page.width + 10 + dx]
      if (v === 0) page.data[50 * page.width + 10 + dx] = 12
    }
    const hits = nccScanMultiScale(page, tpl, { scales: [1, 1.5] })
    expect(hits.length).toBe(6)
    expect(hits.some((h) => h.x === 10 && h.y === 50 && h.scale === 1.5)).toBe(true)
  })

  test("HONEST DEGRADATION: a hand-drawn 18x18 sibling correlates at ~0.70 — BELOW the default threshold (the docstring bound, measured)", () => {
    const page = blank(200, 60)
    drawGlyph(page, 10, 10)
    drawGlyph18(page, 60, 10)
    const tpl = extractTemplate(page, { x: 10, y: 10, width: 12, height: 12 })
    // At the 0.85 default the sibling is NOT matched — the honest bound.
    expect(nccScanMultiScale(page, tpl, { scales: [1, 1.5] }).length).toBe(1)
    // Measured at a lowered threshold: the real NCC value is ~0.70 — recorded
    // here so the bound is a number, not a hand-wave.
    const honest = nccScanMultiScale(page, tpl, { scales: [1, 1.5], minScore: 0.6 })
    expect(honest.length).toBe(2)
    const sibling = honest.find((h) => h.x === 60 && h.y === 10)
    expect(sibling).toBeDefined()
    expect(sibling!.score).toBeGreaterThan(0.65)
    expect(sibling!.score).toBeLessThan(0.85)
    expect(sibling!.scale).toBe(1.5)
  })
})

describe("nccScanMultiScale — the v1 lane stays bit-identical (the frozen-core guarantee)", () => {
  test("a [1] ladder returns nccScan's boxes byte-for-byte with scale: 1 added", () => {
    const page = sixGlyphPage()
    const tpl = glyphTemplate(page)
    const v1 = nccScan(page, tpl)
    const lane = nccScanMultiScale(page, tpl, { scales: [1] })
    expect(lane.length).toBe(v1.length)
    for (let i = 0; i < v1.length; i += 1) {
      expect(lane[i].x).toBe(v1[i].x)
      expect(lane[i].y).toBe(v1[i].y)
      expect(lane[i].width).toBe(v1[i].width)
      expect(lane[i].height).toBe(v1[i].height)
      expect(lane[i].score).toBe(v1[i].score)
      expect(lane[i].scale).toBe(1)
    }
  })

  test("every Slice-13 six-glyph pin rides unchanged through the [1] ladder (6 hits, decoy excluded)", () => {
    const page = sixGlyphPage()
    const hits = nccScanMultiScale(page, glyphTemplate(page), { scales: [1] })
    expect(hits.length).toBe(6)
    expect(hits.every((h) => h.x !== 150 || h.y !== 60)).toBe(true)
  })
})

describe("nccScanMultiScale — cross-scale NMS + determinism + caps", () => {
  test("the SAME instance found at two rungs merges into ONE hit — the exact-size rung (score 1.0) outranks the degraded one", () => {
    const page = sixGlyphPage()
    const tpl = glyphTemplate(page)
    // Ladder [1, 1.1]: the 1.1 rung's 13x13 resample still correlates with the
    // 12px glyphs (same instance, degraded score) — every glyph is found by
    // BOTH rungs; the merged list keeps ONE hit per instance at scale 1.
    const hits = nccScanMultiScale(page, tpl, { scales: [1, 1.1] })
    expect(hits.length).toBe(6)
    for (const h of hits) expect(h.scale).toBe(1)
  })

  test("deterministic ORDER: score desc, then scale asc, then y asc, then x asc", () => {
    const page = blank(220, 80)
    drawGlyph(page, 10, 10)
    drawGlyph(page, 60, 10)
    const tpl = extractTemplate(page, { x: 10, y: 10, width: 12, height: 12 })
    paste(page, 10, 50, resampleTemplate(tpl, 1.5))
    const hits = nccScanMultiScale(page, tpl, { scales: [1, 1.5] })
    expect(hits.length).toBe(3)
    for (let i = 1; i < hits.length; i += 1) {
      const a = hits[i - 1]
      const b = hits[i]
      expect(
        a.score > b.score ||
          (a.score === b.score &&
            (a.scale < b.scale || (a.scale === b.scale && (a.y < b.y || (a.y === b.y && a.x < b.x))))),
      ).toBe(true)
    }
  })

  test("maxHits caps the merged list (applies per rung AND to the walk)", () => {
    const page = sixGlyphPage()
    const hits = nccScanMultiScale(page, glyphTemplate(page), { scales: [1], maxHits: 3 })
    expect(hits.length).toBe(3)
  })

  test("a blank page returns an honest empty list (never an error, never invented hits)", () => {
    const glyphs = sixGlyphPage()
    const empty = blank(100, 60)
    expect(nccScanMultiScale(empty, glyphTemplate(glyphs), { scales: [0.5, 1, 1.5] })).toEqual([])
  })
})

describe("nccScanMultiScale — honest refusals (the ladder is validated like every option)", () => {
  test("empty / non-array ladders are refused", () => {
    const page = sixGlyphPage()
    const tpl = glyphTemplate(page)
    expectMatchError(() => nccScanMultiScale(page, tpl, { scales: [] }), "non-empty array of scale factors")
  })

  test("non-finite / non-positive entries are refused with the index in the message", () => {
    const page = sixGlyphPage()
    const tpl = glyphTemplate(page)
    expectMatchError(() => nccScanMultiScale(page, tpl, { scales: [0.5, 0, 1] }), "finite number > 0 (got 0 at index 1)")
    expectMatchError(
      () => nccScanMultiScale(page, tpl, { scales: [0.5, Number.NaN, 1] }),
      "finite number > 0",
    )
  })

  test("unsorted / duplicate rungs are refused (the ladder is a discipline, not a bag)", () => {
    const page = sixGlyphPage()
    const tpl = glyphTemplate(page)
    expectMatchError(() => nccScanMultiScale(page, tpl, { scales: [1, 0.5] }), "strictly ascending")
    expectMatchError(() => nccScanMultiScale(page, tpl, { scales: [0.5, 0.5, 1] }), "strictly ascending")
  })

  test("a rung growing the template beyond the page raster is refused with the scale + sizes in the message", () => {
    const page = sixGlyphPage()
    const tpl = glyphTemplate(page) // 12x12 on a 180x120 page
    expectMatchError(
      () => nccScanMultiScale(page, tpl, { scales: [1, 12] }),
      "scale 12 grows the template to 144x144, larger than the 180x120 page raster",
    )
  })

  test("a rung below the 2x2 floor is refused via resampleTemplate (message names the scale)", () => {
    const page = sixGlyphPage()
    const small = extractTemplate(page, { x: 150, y: 10, width: 3, height: 3 }) // blank 3x3 — flat, but the floor fires first
    // round(3*0.4)=1 < 2 — the floor refusal names the rung (0.5 would round UP to 2).
    expectMatchError(() => nccScanMultiScale(page, small, { scales: [0.4] }), "below the 2x2 pixel floor")
  })

  test("a flat template is refused by the frozen core on the first rung (resampling preserves flatness)", () => {
    const page = sixGlyphPage()
    const flat = extractTemplate(page, { x: 150, y: 10, width: 12, height: 12 })
    expectMatchError(() => nccScanMultiScale(page, flat, { scales: [0.5, 1] }), "no contrast")
  })
})

describe("DEFAULT_SCALE_LADDER — the shipped 12-rung ladder", () => {
  test("12 rungs, 0.5 -> 2.0, strictly ascending, 1.0 and 1.5 members (the fixture's two sizes hit exact rungs)", () => {
    expect(DEFAULT_SCALE_LADDER.length).toBe(12)
    expect(DEFAULT_SCALE_LADDER[0]).toBe(0.5)
    expect(DEFAULT_SCALE_LADDER[DEFAULT_SCALE_LADDER.length - 1]).toBe(2)
    for (let i = 1; i < DEFAULT_SCALE_LADDER.length; i += 1) {
      expect(DEFAULT_SCALE_LADDER[i]).toBeGreaterThan(DEFAULT_SCALE_LADDER[i - 1])
    }
    expect(DEFAULT_SCALE_LADDER).toContain(1)
    expect(DEFAULT_SCALE_LADDER).toContain(1.5)
  })
})
