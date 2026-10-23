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
