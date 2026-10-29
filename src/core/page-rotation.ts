/**
 * Engineering OS — rotated-page coordinate frame (the limitation-#17 closure,
 * the twenty-sixth-pass forward queue's named polish-class correctness lane).
 *
 * The problem it closes (recorded since Slice 8 as an honest limitation): the
 * Sheet Measure workspace rendered pages through pdf.js's viewport — which
 * APPLIES the page's /Rotate entry (a /Rotate 90 page renders upright) — but
 * converted clicks and markups with the rotation-0 formula
 * (x·s, (hPt−y)·s), so on a rotated page the PICTURE was upright while
 * every pick landed in unrotated coordinates: a click on what the eye sees
 * at the top-left of a /Rotate 90 sheet stored a PDF point from a DIFFERENT
 * corner of the unrotated page space, and saved markups painted back to the
 * wrong place. Slice 8 recorded it ("a rotated page renders upright but
 * picks would land in unrotated coordinates"); this module is the fix.
 *
 * PINNED MATH (each quadrant EMPIRICALLY PROBED against pdfjs-dist@4.10.38's
 * own getViewport/convertToViewportPoint — the exact engine the Sheet Measure
 * renders through — and cross-checked against pdfplumber's displayed-space
 * extraction on the rotated fixture page; the FIRST DRAFT of this table was
 * derived from memory of pdf.js's transform algebra and had the 90/270
 * quadrants SWAPPED — the probe caught it, the same lesson as the
 * probe-expr class defect: never trust remembered source, run the engine).
 *
 *   Let W = unrotated page width (pt), H = unrotated page height (pt),
 *   s = viewport scale (CSS px per pt). PDF y grows UP; viewport y grows
 *   DOWN (CSS). For a PDF point (x, y) and its viewport CSS-px image (u, v)
 *   — the ISO /Rotate semantics, clockwise, e.g. R=90 sends the unrotated
 *   LEFT edge to the top of the display:
 *
 *     R = 0:   u = x·s            v = (H − y)·s      canvas W·s × H·s
 *     R = 90:  u = y·s            v = x·s            canvas H·s × W·s
 *     R = 180: u = (W − x)·s      v = y·s            canvas W·s × H·s
 *     R = 270: u = (H − y)·s      v = (W − x)·s      canvas H·s × W·s
 *
 *   Inverses (what a click needs; each row is the algebraic inverse of the
 *   row above — solve each mapping for x and y):
 *
 *     R = 0:   x = u/s            y = H − v/s
 *     R = 90:  x = v/s            y = u/s
 *     R = 180: x = W − u/s        y = v/s
 *     R = 270: x = W − v/s        y = H − u/s
 *
 *   Corner check (R = 90, W = 1191, H = 842, s = 1): the unrotated
 *   origin (0,0) maps to (0,0) — the TOP-LEFT of the rotated canvas, and the
 *   unrotated top-left (0, H) maps to (842, 0) — the TOP-RIGHT, exactly where
 *   pdf.js paints it (probed 2026-10-29, transform [0,1,1,0,0,0]) and exactly
 *   where pdfplumber reports the same object (fixture page 4, socket at
 *   PDF (200..210, 350..360) extracts as x0=350, top=200 in the displayed
 *   space). Every quadrant round-trips.
 *
 * PURE TypeScript: no DB, no network, no filesystem, no DOM, no pdfjs.
 * Out-of-domain input throws `RotationFrameError` — nothing ever becomes
 * NaN, Infinity or a guessed substitute (the measure.ts discipline).
 * The module is deterministic by construction: same inputs, same outputs.
 */

export class RotationFrameError extends Error {
  constructor(message: string) {
    super(`page-rotation: ${message}`)
    this.name = "RotationFrameError"
  }
}

/** The only /Rotate values the PDF spec defines as meaningful for pages
 *  (ISO 32000-1 Table 30: 0, 90, 180, 270 clockwise). Anything else is a
 *  corrupt dictionary — refused, never guessed-normalized (a wrong guess
 *  would move every pick silently). */
export const PDF_ROTATIONS = [0, 90, 180, 270] as const
export type PdfPageRotation = (typeof PDF_ROTATIONS)[number]

/** An unrotated-page-space size + a viewport's rotation + its scale — the
 *  three numbers every conversion needs. wPt/hPt are the UNROTATED page
 *  dimensions (pdf.js viewport at scale 1 with rotation applied reports
 *  rotatedSize — pass the base viewport's width/height here, and use
 *  viewportSize() when you need the rotated canvas extent). */
export interface RotationFrame {
  wPt: number
  hPt: number
  rotation: PdfPageRotation
  scale: number
}

function assertFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RotationFrameError(`${label} must be a finite number (got ${String(value)})`)
  }
  return value
}

/** Fail-loudly validate a frame: both dimensions finite and positive, scale
 *  finite and positive, rotation one of the four spec values. */
export function assertRotationFrame(frame: RotationFrame): void {
  const wPt = assertFiniteNumber(frame?.wPt, "wPt")
  const hPt = assertFiniteNumber(frame?.hPt, "hPt")
  assertFiniteNumber(frame?.scale, "scale")
  if (wPt <= 0) throw new RotationFrameError(`wPt must be positive (got ${wPt})`)
  if (hPt <= 0) throw new RotationFrameError(`hPt must be positive (got ${hPt})`)
  if (frame.scale <= 0) throw new RotationFrameError(`scale must be positive (got ${frame.scale})`)
  if (!PDF_ROTATIONS.includes(frame.rotation as PdfPageRotation)) {
    throw new RotationFrameError(
      `rotation must be one of ${PDF_ROTATIONS.join("/")} (got ${String(frame.rotation)})`,
    )
  }
}

/** The viewport canvas extent in CSS px for a frame — W·s × H·s for the
 *  upright quadrants, H·s × W·s for the sideways ones. Mirrors pdf.js's
 *  getViewport width/height exactly (the caller may assert equality). */
export function viewportSize(frame: RotationFrame): { width: number; height: number } {
  assertRotationFrame(frame)
  const { wPt, hPt, rotation, scale } = frame
  if (rotation === 90 || rotation === 270) {
    return { width: hPt * scale, height: wPt * scale }
  }
  return { width: wPt * scale, height: hPt * scale }
}

/** PDF point (y-up, unrotated page space) → viewport CSS px (y-down). */
export function cssPxFromPdfPoint(
  x: number,
  y: number,
  frame: RotationFrame,
): { x: number; y: number } {
  assertRotationFrame(frame)
  const u = assertFiniteNumber(x, "x")
  const v = assertFiniteNumber(y, "y")
  const { wPt, hPt, rotation, scale } = frame
  switch (rotation) {
    case 0:
      return { x: u * scale, y: (hPt - v) * scale }
    case 90:
      return { x: v * scale, y: u * scale }
    case 180:
      return { x: (wPt - u) * scale, y: v * scale }
    case 270:
      return { x: (hPt - v) * scale, y: (wPt - u) * scale }
  }
}

/** Viewport CSS px (y-down) → PDF point (y-up, unrotated page space) — the
 *  click path. The algebraic inverse of cssPxFromPdfPoint per quadrant. */
export function pdfPointFromCssPx(
  x: number,
  y: number,
  frame: RotationFrame,
): { x: number; y: number } {
  assertRotationFrame(frame)
  const u = assertFiniteNumber(x, "x")
  const v = assertFiniteNumber(y, "y")
  const { wPt, hPt, rotation, scale } = frame
  switch (rotation) {
    case 0:
      return { x: u / scale, y: hPt - v / scale }
    case 90:
      return { x: v / scale, y: u / scale }
    case 180:
      return { x: wPt - u / scale, y: v / scale }
    case 270:
      return { x: wPt - v / scale, y: hPt - u / scale }
  }
}
