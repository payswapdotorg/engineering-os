/**
 * Engineering OS — deterministic vector-takeoff PDF fixtures (Lane 16-V, Slice 15).
 *
 * The build-sheet-pdf.ts pattern, applied twice: DEPENDENCY-FREE, BYTE-
 * DETERMINISTIC PDF 1.4 writers built from strings with programmatically
 * counted byte offsets. No clock, no random, no locale; `fmt()` prints
 * numbers as toFixed(4) (exactly specified by ECMA-262); every structural
 * string is validated ASCII at assembly time; object order, indentation and
 * LF-only line endings are fixed constants. No /Info dictionary (it would
 * only invite timestamps). Re-running the generator reproduces the committed
 * fixtures byte-for-byte (verify with sha256; the harness pins them).
 *
 * Fixtures (the sheet_takeoff.py corpus):
 *
 *  1. sheet-curve-arc.pdf — ONE page, A3 MediaBox `0 0 1191 842`, with
 *     exactly TWO path entities and NO text:
 *       - ONE cubic bezier drawing the standard kappa quarter-arc: circle
 *         radius r = 100 pt centred (100, 200), from the bottom point
 *         (100, 100) to the right point (200, 200). Canonical kappa control
 *         points: P1 = P0 + k*r*(1,0) = (155.228475, 100) and
 *         P2 = P3 - k*r*(0,1) = (200, 144.771525) with the standard quarter-
 *         arc kappa 0.5522847498 (fmt prints 155.2285 / 144.7715).
 *         ANALYTIC quarter-arc length = 100 * pi/2 = 157.0796327 pt (the
 *         kappa-approximated bezier runs ~+4e-5 relative long: N=32
 *         flattening measures 157.0858868 — pinned at rel 1e-3 in the
 *         harness). NOTE (recorded honestly): the lane brief's literal
 *         ctrl2 (200, 155.228475) is NOT the canonical kappa construction —
 *         it mirrors P1's offset instead of subtracting it from the end
 *         point, cuts INSIDE the circle, and measures ~154.91 pt = rel
 *         -1.4e-2 from the analytic arc, outside the brief's own rel 1e-3
 *         pin; the builder draws the canonical construction the brief
 *         names ("the standard quarter-arc kappa") and which the research
 *         transcript's numbers (314.20 at r=200) confirm.
 *       - ONE stroked rectangle `10 10 50 30 re S` — width 50, height 30:
 *         perimeter 160 pt, area 1500 pt (EXACT — integers on the wire).
 *     This is the CURVE control-point-capture fixture: pdfplumber's default
 *     curve objects carry endpoints only (naive chord 282.84-style reads,
 *     ~10% low); the adapter's paint_path pass must capture the full cubic
 *     control points and flatten at the pinned rate to measure 157.086.
 *
 *  2. sheet-scan-like.pdf — ONE page, A3 MediaBox `0 0 1191 842`, with ONLY
 *     a text draw ("scanned page - no vector operators", Helvetica 12) and
 *     ZERO path operators — the raster-only honest-refusal case: the sheet
 *     adapter must exit 1 with the pinned verbatim message instead of
 *     fabricating geometry.
 *
 * Regenerate (the integrity-measure-contract §2.2 convention — pure module,
 * no filesystem access inside; write from a one-liner):
 *
 *   bun -e 'const {buildCurveArcPdf, buildScanLikePdf} = await import(
 *     "./tests/fixtures/build-curve-pdf.ts"); const {writeFileSync} = await
 *     import("node:fs"); const {createHash} = await import("node:crypto");
 *     for (const [bytes, name] of [[buildCurveArcPdf(), "sheet-curve-arc.pdf"],
 *     [buildScanLikePdf(), "sheet-scan-like.pdf"]]) {
 *     writeFileSync("tests/fixtures/" + name, bytes);
 *     console.log(name, createHash("sha256").update(bytes).digest("hex")); }'
 *
 * The printed sha256s are the harness pins (fixtureSha256 in the corpus
 * manifest) — if a regeneration ever prints a different digest, stop and
 * reconcile the manifest together with the change.
 */

/** A point in PDF-page space (matches `Pt` in src/core/measure.ts). */
export interface CurveSheetPt {
  x: number
  y: number
}

/** Page: A3 landscape rounded to whole points (same constants as build-sheet-pdf.ts). */
const PAGE_W_PT = 1191
const PAGE_H_PT = 842

/** The standard quarter-arc kappa (cubic-bezier circular approximation). */
export const QUARTER_ARC_KAPPA = 0.5522847498

/** Curve fixture: radius and endpoints of the pinned quarter arc (pt). */
export const CURVE_R_PT = 100
export const CURVE_START: CurveSheetPt = { x: 100, y: 100 }
export const CURVE_END: CurveSheetPt = { x: 200, y: 200 }
/** Circle centre of the pinned quarter arc: (100, 200), r = 100. */
export const CURVE_CENTER: CurveSheetPt = { x: 100, y: 200 }
/** Canonical kappa control points (full-precision; fmt prints 4 decimals). */
export const CURVE_CTRL1: CurveSheetPt = { x: 100 + QUARTER_ARC_KAPPA * CURVE_R_PT, y: 100 }
export const CURVE_CTRL2: CurveSheetPt = { x: 200, y: 200 - QUARTER_ARC_KAPPA * CURVE_R_PT }
/** Analytic quarter-arc length = r * pi/2 (the harness reference value). */
export const QUARTER_ARC_LENGTH_PT = (Math.PI / 2) * CURVE_R_PT

/** Rect fixture: `10 10 50 30 re S` — perimeter 160 pt, area 1500 pt² (exact). */
export const CURVE_SHEET_RECT = { x0: 10, y0: 10, width: 50, height: 30 } as const
export const CURVE_SHEET_RECT_PERIMETER_PT = 2 * (CURVE_SHEET_RECT.width + CURVE_SHEET_RECT.height)
export const CURVE_SHEET_RECT_AREA_PT2 = CURVE_SHEET_RECT.width * CURVE_SHEET_RECT.height

/** Scan-like fixture: the only draw is this text (Helvetica 12 at (72, 770)). */
export const SCAN_LIKE_TEXT = "scanned page - no vector operators"
export const SCAN_LIKE_TEXT_AT: CurveSheetPt = { x: 72, y: 770 }

// ---------------------------------------------------------------------------
// Deterministic primitives (the build-sheet-pdf.ts machinery, verbatim style)
// ---------------------------------------------------------------------------

/**
 * Deterministic coordinate printing: at most 4 decimals, trailing zeros and a
 * trailing dot trimmed, "0" for a value that rounds away entirely. toFixed is
 * exactly specified by ECMA-262, so the output is byte-identical on every
 * engine.
 */
function fmt(n: number): string {
  const trimmed = n
    .toFixed(4)
    .replace(/0+$/, "")
    .replace(/\.$/, "")
  return trimmed === "" ? "0" : trimmed
}

/**
 * Validates that a structural string is pure ASCII and returns its bytes.
 * PDF byte offsets are counted in octets; a stray non-ASCII character would
 * desynchronize every offset in the cross-reference table, so it fails loudly
 * here instead.
 */
function ascii(s: string): Uint8Array {
  const bytes = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code > 127) {
      throw new Error(
        `build-curve-pdf: non-ASCII byte ${code} at index ${i} would corrupt xref offsets`,
      )
    }
    bytes[i] = code
  }
  return bytes
}

// ---------------------------------------------------------------------------
// Content streams (the pinned drawings)
// ---------------------------------------------------------------------------

function buildCurveArcContentStream(): string {
  const lines: string[] = [
    "% EOS vector-takeoff curve fixture - kappa quarter-arc bezier + one rect",
    "% quarter arc: r=100 pt centred (100,200), start (100,100) end (200,200),",
    "% kappa 0.5522847498 -> canonical ctrl (155.2285,100) (200,144.7715)",
    "% analytic arc length 100*pi/2 = 157.0796327 pt",
    `${fmt(CURVE_START.x)} ${fmt(CURVE_START.y)} m ${fmt(CURVE_CTRL1.x)} ${fmt(CURVE_CTRL1.y)} ${fmt(CURVE_CTRL2.x)} ${fmt(CURVE_CTRL2.y)} ${fmt(CURVE_END.x)} ${fmt(CURVE_END.y)} c S`,
    "% rect: 50 x 30 pt at (10,10) - perimeter 160 pt, area 1500 pt2 (exact)",
    `${fmt(CURVE_SHEET_RECT.x0)} ${fmt(CURVE_SHEET_RECT.y0)} ${fmt(CURVE_SHEET_RECT.width)} ${fmt(CURVE_SHEET_RECT.height)} re S`,
  ]
  return lines.join("\n")
}

function buildScanLikeContentStream(): string {
  return [
    "% EOS scan-like fixture - text ONLY, zero path operators (raster refusal case)",
    `BT /F1 12 Tf ${fmt(SCAN_LIKE_TEXT_AT.x)} ${fmt(SCAN_LIKE_TEXT_AT.y)} Td (${SCAN_LIKE_TEXT}) Tj ET`,
  ].join("\n")
}

// ---------------------------------------------------------------------------
// PDF 1.4 assembly — objects, xref, trailer (offsets counted in bytes)
// ---------------------------------------------------------------------------

/**
 * Assemble a minimal one-page PDF 1.4 from a content stream: correct xref
 * offsets, exact /Length on the uncompressed content stream, and /Resources
 * carrying the Helvetica font only when the page draws text. Object layout
 * (fixed order, fixed numbering — part of the determinism):
 *   1 0 obj  Catalog          -> /Pages 2 0 R
 *   2 0 obj  Pages            -> /Kids [3 0 R] /Count 1
 *   3 0 obj  Page             -> /MediaBox [0 0 1191 842] /Resources /Contents
 *   4 0 obj  Content stream   -> /Length <exact byte count> (uncompressed)
 *   5 0 obj  Font (text pages only) -> Type1 Helvetica WinAnsiEncoding
 * No /Info dictionary on purpose — the file carries no date, so regeneration
 * is byte-identical.
 */
function assembleOnePagePdf(contentStream: string, withFont: boolean): Uint8Array {
  const content = ascii(contentStream)
  const resources = withFont ? "<< /Font << /F1 5 0 R >> >>" : "<< >>"
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(PAGE_W_PT)} ${fmt(PAGE_H_PT)}] /Resources ${resources} /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${contentStream}\nendstream`,
  ]
  if (withFont) {
    objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
  }

  const chunks: Uint8Array[] = []
  let cursor = 0
  const offsets: number[] = []
  const emit = (chunk: Uint8Array): void => {
    chunks.push(chunk)
    cursor += chunk.length
  }

  // Header (ISO 32000-1 §7.5.2): version line + the recommended binary comment.
  emit(ascii("%PDF-1.4\n"))
  emit(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]))

  objects.forEach((body, index) => {
    offsets.push(cursor)
    emit(ascii(`${index + 1} 0 obj\n${body}\nendobj\n`))
  })

  const xrefOffset = cursor
  let table = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) {
    table += `${String(offset).padStart(10, "0")} 00000 n \n`
  }
  emit(ascii(table))

  emit(
    ascii(
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
    ),
  )

  const pdf = new Uint8Array(cursor)
  let position = 0
  for (const chunk of chunks) {
    pdf.set(chunk, position)
    position += chunk.length
  }
  return pdf
}

/** The committed fixture `tests/fixtures/sheet-curve-arc.pdf`. */
export function buildCurveArcPdf(): Uint8Array {
  return assembleOnePagePdf(buildCurveArcContentStream(), false)
}

/** The committed fixture `tests/fixtures/sheet-scan-like.pdf`. */
export function buildScanLikePdf(): Uint8Array {
  return assembleOnePagePdf(buildScanLikeContentStream(), true)
}
