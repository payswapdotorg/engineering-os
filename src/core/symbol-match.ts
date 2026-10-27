/**
 * Engineering OS — deterministic symbol template matching (Slice 13,
 * limitation #5's auto-count half). Pure TypeScript, no DOM, no canvas, no
 * network (ADR-0002): the caller hands over a grayscale raster of the
 * rendered PDF page plus a template patch cropped around ONE picked symbol
 * instance, and gets back the accepted match boxes with their scores.
 *
 * Algorithm — normalized cross-correlation (NCC), the textbook zero-mean
 * template matcher (Lewis, "Fast Template Matching", CVPR 1995):
 *  - the template is reduced to zero-mean form; its contrast energy
 *    Σt'² is a loop constant;
 *  - two integral images (Σx, Σx²) give every candidate window's mean and
 *    variance in O(1), so blank windows (variance ≈ 0 — most of a drawing
 *    sheet) are rejected BEFORE the O(template) dot product runs;
 *  - score = Σ(window·t') / sqrt(varWindow · Σt'²) ∈ [-1, 1] — 1.0 is an
 *    exact copy of the picked instance (modulo the rendering's own
 *    anti-aliasing);
 *  - candidates ≥ minScore are then de-duplicated by non-maximum suppression
 *    (highest score first; later candidates within Chebyshev distance
 *    max(tw, th)/2 of an accepted hit are the SAME instance, rejected).
 *
 * Honesty rules this module follows:
 *  - no scores are invented, rounded up or clamped to pass a threshold —
 *    the raw NCC value is returned on every box and the UI displays it;
 *  - a flat template (blank paper) throws `SymbolMatchError` instead of
 *    "matching everything at score NaN";
 *  - stride/scan order are explicit, so the function is DETERMINISTIC:
 *    same raster + same template + same options → byte-identical output
 *    order (score desc, then y asc, then x asc) — pinned by unit tests;
 *  - the scan is scale-naive BY DESIGN and the UI says so: it matches
 *    instances the same rendered size as the picked one; catching other
 *    sizes means picking one of those and scanning again (recorded
 *    limitation, not hidden).
 *
 * Slice 20 (limitation #18's last drillable half — scale-invariant matching):
 * `nccScanMultiScale` above rides the FROZEN `nccScan` at a PINNED ladder of
 * template scales (default 12 rungs, 0.5×–2×) with deterministic
 * area-weighted template resampling (`resampleTemplate` — box average when
 * shrinking, bilinear when growing: the SAME fractional-overlap integral)
 * and cross-scale non-maximum suppression on box CENTERS. The honest bound,
 * recorded: matches are found at LADDER RUNG scales — a between-rung size
 * matches at its nearest rung with a degraded-but-real score (thin strokes
 * may fall below the threshold; the v1 remedy — pick that size and scan
 * again — still works). The v1 lane stays bit-identical: a [1] ladder
 * reproduces `nccScan` byte-for-byte plus `scale: 1` (pinned by unit test).
 */

/** Thrown on out-of-domain input (never NaN, never a silent empty result). */
export class SymbolMatchError extends Error {
  constructor(message: string) {
    super(message)
    this.message = message
    this.name = "SymbolMatchError"
  }
}

/** Row-major grayscale raster, one float per pixel, nominal range 0–255. */
export interface GrayImage {
  width: number
  height: number
  data: Float32Array
}

/** An accepted match: the box's top-left corner in the PAGE raster's pixels,
 *  the template's size, and the raw NCC score ([-1, 1]). */
export interface MatchBox {
  x: number
  y: number
  width: number
  height: number
  score: number
}

/** Scan tuning (all fields validated; DEFAULT_SCAN_OPTIONS is the UI default).
 *  Stride 1 (exhaustive) is the DEFAULT on purpose: a stride-2 cadence can
 *  systematically MISS exact matches whose top-left raster row/column is odd
 *  (a 1-px misalignment at a 2-px stroke already drops NCC below 0.85 — found
 *  live by the Slice-13 browser journey, not by the even-positioned unit
 *  fixtures). Callers may still pass a coarser stride for quick probes. */
export interface ScanOptions {
  /** candidate top-left positions step by this many pixels (1 = exhaustive) */
  stride: number
  /** minimum NCC score to become a candidate (0 < s <= 1) */
  minScore: number
  /** returned hits are capped at this count, highest score first */
  maxHits: number
}

export const DEFAULT_SCAN_OPTIONS: ScanOptions = { stride: 1, minScore: 0.85, maxHits: 500 }

/** Blank-window variance threshold: below this the window has no structure to
 *  correlate against (blank paper) — score 0 without the dot product. */
const VARIANCE_EPS = 1e-6

/**
 * RGBA (4 bytes/pixel, canvas ImageData layout) → grayscale luminance
 * (Rec.601: 0.299 R + 0.587 G + 0.114 B; alpha is ignored — the page render
 * is opaque white-backed). Throws on a length/bounds mismatch instead of
 * reading past the buffer.
 */
export function toGray(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): GrayImage {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new SymbolMatchError(`toGray: width and height must be whole numbers >= 1 (got ${width}x${height})`)
  }
  if (rgba.length !== width * height * 4) {
    throw new SymbolMatchError(
      `toGray: buffer length ${rgba.length} does not match ${width}x${height} RGBA (${width * height * 4} bytes)`,
    )
  }
  const data = new Float32Array(width * height)
  for (let i = 0, p = 0; i < data.length; i += 1, p += 4) {
    data[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]
  }
  return { width, height, data }
}

/** Validates a pixel rectangle against an image (integer, within bounds). */
function validateRect(
  img: GrayImage,
  rect: { x: number; y: number; width: number; height: number },
  what: string,
): void {
  if (
    !Number.isInteger(rect.x) ||
    !Number.isInteger(rect.y) ||
    !Number.isInteger(rect.width) ||
    !Number.isInteger(rect.height)
  ) {
    throw new SymbolMatchError(`${what}: x, y, width and height must be whole numbers`)
  }
  if (rect.width < 2 || rect.height < 2) {
    throw new SymbolMatchError(`${what}: the region must be at least 2x2 pixels (got ${rect.width}x${rect.height})`)
  }
  if (rect.x < 0 || rect.y < 0 || rect.x + rect.width > img.width || rect.y + rect.height > img.height) {
    throw new SymbolMatchError(
      `${what}: the region (${rect.x},${rect.y} ${rect.width}x${rect.height}) falls outside the ${img.width}x${img.height} raster`,
    )
  }
}

/**
 * Crops a template patch out of a grayscale raster (shared bounds rules with
 * nccScan — the caller validates once, the core re-validates because the API
 * surface is public).
 */
export function extractTemplate(
  img: GrayImage,
  rect: { x: number; y: number; width: number; height: number },
): GrayImage {
  validateRect(img, rect, "extractTemplate")
  const data = new Float32Array(rect.width * rect.height)
  for (let row = 0; row < rect.height; row += 1) {
    const src = (rect.y + row) * img.width + rect.x
    data.set(img.data.subarray(src, src + rect.width), row * rect.width)
  }
  return { width: rect.width, height: rect.height, data }
}

/** Integral images Σx and Σx² with a zero first row/column (O(1) windows). */
function integralImages(img: GrayImage): { sum: Float64Array; sumSq: Float64Array } {
  const { width, height, data } = img
  const sum = new Float64Array((width + 1) * (height + 1))
  const sumSq = new Float64Array((width + 1) * (height + 1))
  for (let y = 0; y < height; y += 1) {
    let rowSum = 0
    let rowSumSq = 0
    for (let x = 0; x < width; x += 1) {
      const v = data[y * width + x]
      rowSum += v
      rowSumSq += v * v
      // S(y+1, x+1) = S(y, x+1) + Σ row(0..x) — the row ABOVE at the same
      // column, plus the running row sum (the zero first row/column carries
      // the base case).
      const cur = (y + 1) * (width + 1) + (x + 1)
      const above = y * (width + 1) + (x + 1)
      sum[cur] = sum[above] + rowSum
      sumSq[cur] = sumSq[above] + rowSumSq
    }
  }
  return { sum, sumSq }
}

/**
 * Scans `page` for instances of `template`, returning accepted `MatchBox`es
 * (NMS-deduplicated, at most `options.maxHits`, deterministic order: score
 * desc, then y asc, then x asc). See the header for the algorithm and the
 * honesty rules; every option is validated with a specific message.
 */
export function nccScan(
  page: GrayImage,
  template: GrayImage,
  options?: Partial<ScanOptions>,
): MatchBox[] {
  const opts: ScanOptions = { ...DEFAULT_SCAN_OPTIONS, ...options }
  if (!Number.isInteger(opts.stride) || opts.stride < 1) {
    throw new SymbolMatchError(`nccScan: stride must be a whole number >= 1 (got ${opts.stride})`)
  }
  if (!(opts.minScore > 0 && opts.minScore <= 1)) {
    throw new SymbolMatchError(`nccScan: minScore must be in (0, 1] (got ${opts.minScore})`)
  }
  if (!Number.isInteger(opts.maxHits) || opts.maxHits < 1) {
    throw new SymbolMatchError(`nccScan: maxHits must be a whole number >= 1 (got ${opts.maxHits})`)
  }
  if (template.width < 2 || template.height < 2) {
    throw new SymbolMatchError(
      `nccScan: the template must be at least 2x2 pixels (got ${template.width}x${template.height})`,
    )
  }
  if (template.width > page.width || template.height > page.height) {
    throw new SymbolMatchError(
      `nccScan: the template (${template.width}x${template.height}) is larger than the page raster (${page.width}x${page.height})`,
    )
  }

  // Template statistics: mean, then the zero-mean form. A flat template has
  // nothing to correlate — refuse it (matching "everything" is a lie).
  const t = template.data
  const n = t.length
  let tSum = 0
  for (let i = 0; i < n; i += 1) tSum += t[i]
  const tMean = tSum / n
  const tZero = new Float32Array(n)
  let tEnergy = 0
  for (let i = 0; i < n; i += 1) {
    const d = t[i] - tMean
    tZero[i] = d
    tEnergy += d * d
  }
  if (tEnergy < VARIANCE_EPS * n) {
    throw new SymbolMatchError(
      "nccScan: the template has no contrast — pick a region that contains the drawn symbol, not blank paper",
    )
  }

  const { sum, sumSq } = integralImages(page)
  const pageStrideW = page.width + 1
  const tw = template.width
  const th = template.height

  interface Candidate {
    x: number
    y: number
    score: number
  }
  const candidates: Candidate[] = []

  const maxX = page.width - tw
  const maxY = page.height - th
  for (let y = 0; y <= maxY; y += opts.stride) {
    for (let x = 0; x <= maxX; x += opts.stride) {
      // Window mean and Σ(w−μw)² in O(1) via the integral corners
      // (bottom-right − top-right − bottom-left + top-left; tw/th on
      // purpose — width/height of the template window, NOT interchangeable).
      const tl = y * pageStrideW + x
      const tr = y * pageStrideW + x + tw
      const bl = (y + th) * pageStrideW + x
      const br = (y + th) * pageStrideW + x + tw
      const s1 = sum[br] - sum[tr] - sum[bl] + sum[tl]
      const s2 = sumSq[br] - sumSq[tr] - sumSq[bl] + sumSq[tl]
      // Σ(w−μw)² = Σw² − (Σw)²/n — the window's squared deviation SUM, the
      // same scale as tEnergy = Σ(t−μt)² (NOT the variance: dividing by n here
      // would inflate every score by √n).
      const ssDev = s2 - (s1 * s1) / n
      if (ssDev < VARIANCE_EPS) continue // blank window — no structure
      const denom = Math.sqrt(ssDev * tEnergy)
      if (denom <= 0) continue

      // Σ(window · tZero) — the O(template) inner product.
      let dot = 0
      for (let ty = 0; ty < th; ty += 1) {
        const tRow = ty * tw
        const pRow = (y + ty) * page.width + x
        for (let tx = 0; tx < tw; tx += 1) {
          dot += page.data[pRow + tx] * tZero[tRow + tx]
        }
      }
      const score = dot / denom
      // NCC is mathematically in [-1, 1]; the clamp only absorbs FP dust.
      const clamped = Math.max(-1, Math.min(1, score))
      if (clamped >= opts.minScore) {
        candidates.push({ x, y, score: clamped })
      }
    }
  }

  // Non-maximum suppression: strongest first; a candidate within Chebyshev
  // distance max(tw, th)/2 of an accepted hit is the same instance.
  candidates.sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x)
  const nmsRadius = Math.floor(Math.max(tw, th) / 2)
  const accepted: Candidate[] = []
  for (const c of candidates) {
    if (accepted.length >= opts.maxHits) break
    let duplicate = false
    for (const a of accepted) {
      if (Math.max(Math.abs(a.x - c.x), Math.abs(a.y - c.y)) <= nmsRadius) {
        duplicate = true
        break
      }
    }
    if (!duplicate) accepted.push(c)
  }

  return accepted.map((c) => ({ x: c.x, y: c.y, width: tw, height: th, score: c.score }))
}

// ---------------------------------------------------------------------------
// Slice 20 — the multi-scale ladder (limitation #18's scale-invariant half).
// nccScan above is FROZEN: every function in this section RIDES it, never
// forks it (the cutout v1/v2 lane pattern — the v1 pins stay green untouched).
// ---------------------------------------------------------------------------

/** A multi-scale hit: the v1 box + the ladder rung that produced it
 *  (1 = the picked template's own size). */
export interface ScaledMatchBox extends MatchBox {
  scale: number
}

/** Multi-scale scan tuning: the v1 options + the scale ladder. */
export interface MultiScaleOptions extends ScanOptions {
  /** the ladder rungs — finite, > 0, strictly ascending. The scan resamples
   *  the template to each rung and scans at every one. Default:
   *  DEFAULT_SCALE_LADDER (12 rungs, 0.5×–2×). */
  scales?: number[]
}

/** The pinned default ladder: 12 rungs from 0.5× to 2×. Rung gaps stay ≤ ~1.2
 *  so a between-rung instance still correlates at its NEAREST rung (the NCC
 *  denominator absorbs small scale error; the honest bound is the docstring).
 *  1.0 and 1.5 are members ON PURPOSE: the fixture's two sizes (page 3, 10 pt
 *  and 15 pt symbols) hit exact rungs — the e2e and journeys pin exact
 *  numbers, not lucky ones. */
export const DEFAULT_SCALE_LADDER: readonly number[] = [
  0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.35, 1.5, 1.75, 2.0,
]

/**
 * Deterministically resamples a template to `scale` × its size with the
 * fractional-overlap integral: every destination pixel is the AREA-WEIGHTED
 * average of the source pixels its unit square covers. Shrinking = box
 * averaging (aliasing-safe — thin strokes blur instead of vanishing);
 * growing = bilinear point sampling (the same integral, each destination
 * window spanning at most two source pixels per axis); scale 1 reproduces
 * the source BIT-IDENTICALLY (each window covers exactly one pixel with
 * weight 1). Pure IEEE-754 arithmetic in a fixed loop order: deterministic
 * on every engine. Refuses a result below the core's 2×2 floor, naming the
 * scale in the message.
 */
export function resampleTemplate(template: GrayImage, scale: number): GrayImage {
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new SymbolMatchError(
      `resampleTemplate: scale must be a finite number > 0 (got ${scale})`,
    )
  }
  if (template.width < 2 || template.height < 2) {
    throw new SymbolMatchError(
      `resampleTemplate: the template must be at least 2x2 pixels (got ${template.width}x${template.height})`,
    )
  }
  const dw = Math.round(template.width * scale)
  const dh = Math.round(template.height * scale)
  if (dw < 2 || dh < 2) {
    throw new SymbolMatchError(
      `resampleTemplate: scale ${scale} would shrink the ${template.width}x${template.height} template below the 2x2 pixel floor (${dw}x${dh}) — pick a larger box or drop that ladder rung`,
    )
  }
  const sw = template.width
  const sh = template.height
  const src = template.data
  const out = new Float32Array(dw * dh)
  // Destination pixel (dx, dy) covers source rectangle
  // [dx·sw/dw, (dx+1)·sw/dw) × [dy·sh/dh, (dy+1)·sh/dh); a source pixel
  // (sx, sy) contributes with weight = its exact area overlap.
  const rx = sw / dw
  const ry = sh / dh
  for (let dy = 0; dy < dh; dy += 1) {
    const y1 = dy * ry
    const y2 = y1 + ry
    const iyLo = Math.floor(y1)
    const iyHi = Math.min(sh, Math.ceil(y2))
    for (let dx = 0; dx < dw; dx += 1) {
      const x1 = dx * rx
      const x2 = x1 + rx
      const ixLo = Math.floor(x1)
      const ixHi = Math.min(sw, Math.ceil(x2))
      let acc = 0
      let wSum = 0
      for (let sy = iyLo; sy < iyHi; sy += 1) {
        const wy = Math.min(y2, sy + 1) - Math.max(y1, sy)
        if (wy <= 0) continue
        const row = sy * sw
        for (let sx = ixLo; sx < ixHi; sx += 1) {
          const wx = Math.min(x2, sx + 1) - Math.max(x1, sx)
          if (wx <= 0) continue
          const w = wx * wy
          acc += w * src[row + sx]
          wSum += w
        }
      }
      // wSum is rx·ry (the full window area) up to float dust; the guard
      // keeps NaN out of the raster, never invents a value.
      out[dy * dw + dx] = wSum > 0 ? acc / wSum : 255
    }
  }
  return { width: dw, height: dh, data: out }
}

/**
 * Scans `page` for instances of `template` at EVERY rung of the scale ladder,
 * riding the frozen `nccScan` per rung (same stride/minScore/maxHits for
 * every rung), then de-duplicates across scales: hits whose box CENTERS sit
 * within Chebyshev distance floor(max(w_a, h_a, w_c, h_c)/2) of an accepted
 * hit are the SAME instance (the v1 rule generalized to differing box sizes;
 * for same-size boxes it is exactly v1's radius). Deterministic order: score
 * desc, then scale asc (an exact-size match outranks a degraded scaled one),
 * then y asc, then x asc. The v1 lane is bit-identical: a [1] ladder returns
 * `nccScan`'s boxes with `scale: 1` added.
 *
 * Honest refusals, each naming the offending rung: a rung that would shrink
 * the template below the 2×2 floor, or grow it beyond the page raster. A flat
 * template is refused by the FIRST rung's `nccScan` call (resampling preserves
 * flatness — a constant image resamples to the same constant).
 */
export function nccScanMultiScale(
  page: GrayImage,
  template: GrayImage,
  options?: Partial<MultiScaleOptions>,
): ScaledMatchBox[] {
  const { scales: ladderArg, ...scanOpts } = options ?? {}
  const ladder = ladderArg ?? DEFAULT_SCALE_LADDER
  if (!Array.isArray(ladder) || ladder.length === 0) {
    throw new SymbolMatchError(
      "nccScanMultiScale: scales must be a non-empty array of scale factors (got an empty ladder)",
    )
  }
  for (let i = 0; i < ladder.length; i += 1) {
    const s = ladder[i]
    if (typeof s !== "number" || !Number.isFinite(s) || s <= 0) {
      throw new SymbolMatchError(
        `nccScanMultiScale: every scale must be a finite number > 0 (got ${s} at index ${i})`,
      )
    }
    if (i > 0 && s <= ladder[i - 1]) {
      throw new SymbolMatchError(
        `nccScanMultiScale: scales must be strictly ascending (${ladder[i - 1]} at index ${i - 1} is not < ${s} at index ${i})`,
      )
    }
  }
  // maxHits rides the per-rung scan AND caps the merged list (the walk below
  // stops at the same bound the v1 walk does).
  const opts: ScanOptions = { ...DEFAULT_SCAN_OPTIONS, ...scanOpts }

  interface ScaledCandidate {
    x: number
    y: number
    width: number
    height: number
    scale: number
    score: number
  }
  const candidates: ScaledCandidate[] = []

  for (const scale of ladder) {
    const scaled = resampleTemplate(template, scale)
    if (scaled.width > page.width || scaled.height > page.height) {
      throw new SymbolMatchError(
        `nccScanMultiScale: scale ${scale} grows the template to ${scaled.width}x${scaled.height}, larger than the ${page.width}x${page.height} page raster — pick a smaller box or drop that ladder rung`,
      )
    }
    // The frozen core, verbatim options — every v1 rule (flat-template
    // refusal, blank-window pruning, per-rung NMS, stride/minScore) rides.
    const boxes = nccScan(page, scaled, scanOpts)
    for (const b of boxes) {
      candidates.push({ x: b.x, y: b.y, width: b.width, height: b.height, scale, score: b.score })
    }
  }

  candidates.sort(
    (a, b) => b.score - a.score || a.scale - b.scale || a.y - b.y || a.x - b.x,
  )
  const accepted: ScaledCandidate[] = []
  for (const c of candidates) {
    if (accepted.length >= opts.maxHits) break
    const cx = c.x + c.width / 2
    const cy = c.y + c.height / 2
    let duplicate = false
    for (const a of accepted) {
      const radius = Math.floor(Math.max(a.width, a.height, c.width, c.height) / 2)
      const ax = a.x + a.width / 2
      const ay = a.y + a.height / 2
      if (Math.max(Math.abs(ax - cx), Math.abs(ay - cy)) <= radius) {
        duplicate = true
        break
      }
    }
    if (!duplicate) accepted.push(c)
  }

  return accepted.map((c) => ({
    x: c.x,
    y: c.y,
    width: c.width,
    height: c.height,
    score: c.score,
    scale: c.scale,
  }))
}
