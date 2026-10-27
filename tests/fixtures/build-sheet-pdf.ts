/**
 * Engineering OS — deterministic A-102 demo sheet generator (Lane 8-c, Slice 8).
 *
 * Implements docs/00-architecture/integrity-measure-contract.md §2.2: exports
 * `buildSheetPdf(): Uint8Array`, a DEPENDENCY-FREE, BYTE-DETERMINISTIC PDF 1.4
 * writer. The objects, streams, cross-reference table and trailer are built as
 * strings, byte offsets are computed programmatically, and the pinned geometry
 * below is mirrored in the contract — no external libraries, no pdfjs, no
 * filesystem access inside this module (pure: build → bytes, nothing else).
 *
 * BYTE-DETERMINISM, by construction:
 *  - no clock, no random, no locale: no Date/now/random anywhere;
 *  - every structural string is validated ASCII at assembly time (a non-ASCII
 *    byte fails loudly instead of corrupting offsets);
 *  - numbers are printed by `fmt()` below = toFixed(4) + trailing-zero trim —
 *    toFixed is exactly specified by ECMA-262, so every engine prints the same
 *    characters, and all remaining arithmetic is exactly-specified IEEE-754;
 *  - object order, indentation and line endings are fixed constants of the
 *    code (LF only). The only non-ASCII bytes in the file are the 4 high-bit
 *    bytes of the binary comment line the PDF spec recommends after the header
 *    (ISO 32000-1 §7.5.2), emitted as a fixed byte sequence.
 *  Re-running the generator reproduces the committed fixture byte-for-byte;
 *  the lane verification re-checks this with sha256.
 *
 * PINNED GEOMETRY (contract §2.2 — "MUST be exact"; Slice 13 addendum for
 * page 2 marked [S13]):
 *  - TWO pages, both MediaBox `0 0 1191 842` (A3 landscape, 420 x 297 mm
 *    paper; exact 1190.55 x 841.89 rounded to whole points per the contract);
 *    [S20] THREE pages — page 3 is the two-size panel-schedule fixture;
 *  - page 1 (unchanged from Slice 8): stroke-only ops: border rectangle;
 *    title text "EOS DEMO SHEET A-102 — FLOOR PLAN @ 1:100" (Helvetica,
 *    WinAnsiEncoding; the em dash is the WinAnsi byte 0x97, written as the
 *    octal escape \227);
 *  - SCALE BAR (BOTH pages): one horizontal line spanning exactly 100
 *    paper-mm (= 10.000 m real @ 1:100) with end ticks + a mid tick and
 *    0 / 5 / 10 m tick labels — page 2 is self-contained for calibration;
 *  - ROOM outline rectangle 80 x 50 paper-mm (→ real 8.000 x 5.000 m:
 *    perimeter 26.000 m, area 40.000 m² @ 1:100) — page 1;
 *  - INTERIOR WALL segment 30 paper-mm (→ 3.000 m real), anchored on the
 *    room's bottom edge. Lines only — no arcs; every drawn value is
 *    hand-verifiable;
 *  - [S13] page 2 "LIGHTING LAYOUT": SIX identical socket symbols — a
 *    10 x 10 pt stroked outer square with a concentric 4 x 4 pt filled
 *    inner square — at pinned centers (205,505) (325,505) (445,505)
 *    (205,355) (325,355) (445,355), the auto-count fixture (symbol-hits
 *    takeoff, limitation #5). Pure re/f ops: deterministic, hand-verifiable,
 *    and each instance rasterizes identically.
 *  - [S20] page 3 "PANEL SCHEDULE": the TWO-SIZE field — six 10 pt sockets
 *    at (205..805, 560) plus four 15 pt sockets (outer 15 pt @ 1.5 w,
 *    inner 6 pt) at (205..565, 360), the scale-invariant auto-count fixture
 *    (limitation #18): the 15 pt row is the 10 pt symbol scaled UNIFORMLY
 *    ×1.5 including the pen, the exact 1.5 rung of the default ladder.
 *
 * EXACT vs DRAWN precision (documented honestly): the named constants below
 * are the FULL-PRECISION doubles of paper-mm x 72/25.4, because the pinned
 * harness checks (bar 10000 mm, perimeter 26000 mm, area 40000000 mm², wall
 * 3000 mm, each ±1e-6) only hold on the exact pt↔mm conversion. The emitted
 * content stream prints those constants with `fmt()` (≤4 decimals), so the
 * DRAWN ops read exactly as the human pin list: bar "60 → 343.4646" (= 283.4646
 * pt), room "500 400 226.7717 141.7323", wall "613.3858 400 → 485.0394" (=
 * 85.0394 pt). The presentation rounding shifts drawn geometry by < 5e-5 pt
 * (≈ 0.016 µm on paper) — five orders of magnitude below the click tolerance of
 * the §3.4 browser journey (±0.3 m on 26 m ≈ ±0.94 pt), and `SHEET_GEOMETRY`
 * below re-exports the full-precision endpoints so the math harness and the
 * fixture can never disagree about which numbers are the truth.
 */

/** A point in PDF-page space (matches `Pt` in src/core/measure.ts). */
export interface SheetPt {
  x: number
  y: number
}

export interface SheetGeometry {
  /** MediaBox of the single page, whole PDF points (A3 landscape). */
  mediaBox: { width: number; height: number }
  /** Scale-bar main-line endpoints; span = exactly 100 paper-mm (10.000 m @ 1:100). */
  scaleBar: { a: SheetPt; b: SheetPt }
  /** Room-outline corners, counter-clockwise from bottom-left; 80 x 50 paper-mm. */
  room: { corners: [SheetPt, SheetPt, SheetPt, SheetPt] }
  /** Interior-wall endpoints; 30 paper-mm, rising from the room's bottom edge. */
  wall: { a: SheetPt; b: SheetPt }
  /** Paper-millimetre pins + sheet scale, for documentation and harnesses. */
  paperMm: { scaleBar: 100; roomWidth: 80; roomHeight: 50; wall: 30; realScale: 100 }
}

// ---------------------------------------------------------------------------
// Pinned geometry — full-precision doubles (4-decimal forms are the human pins)
// ---------------------------------------------------------------------------

/** PDF points per paper-millimetre (exact): 1 mm = 72/25.4 pt = 2.8346456692913387… pt. */
const MM_PT = 72 / 25.4

/** Page: A3 landscape rounded to whole points (exact 1190.55 x 841.89 — contract §2.2). */
const PAGE_W_PT = 1191
const PAGE_H_PT = 842

/** Scale bar: 100 paper-mm = 100 × 72/25.4 = 283.46456692913387 pt (prints 283.4646). */
const BAR_LEN_PT = 283.46456692913387
/** Room width: 80 paper-mm = 226.7716535433071 pt (prints 226.7717). */
const ROOM_W_PT = 226.7716535433071
/** Room height: 50 paper-mm = 141.73228346456693 pt (prints 141.7323). */
const ROOM_H_PT = 141.73228346456693
/** Interior wall: 30 paper-mm = 85.03937007874016 pt (prints 85.0394). */
const WALL_LEN_PT = 85.03937007874016

// ---------------------------------------------------------------------------
// Sheet furniture layout (lane 8-c's choice — every value hand-verifiable)
// ---------------------------------------------------------------------------

/** Border rectangle: 24 pt inset on all sides → 1143 × 794 pt inside 1191 × 842. */
const BORDER_X0_PT = 24
const BORDER_Y0_PT = 24
/** Title: Helvetica 14 at (40, 790) — inside the border, top-left. */
const TITLE_X_PT = 40
const TITLE_Y_PT = 790
/** Scale bar baseline y; ticks reach ±6 pt about it (114 … 126). */
const BAR_X0_PT = 60
const BAR_Y_PT = 120
const TICK_HALF_PT = 6
/** Tick labels: Helvetica 8, baseline 100 (below the bar). */
const LABEL_Y_PT = 100
const LABEL_0_X_PT = 57.5 // digit width ≈ 4.44 pt at 8 pt → centred under x = 60
const LABEL_5_X_PT = 199.5 // centred under the mid tick x = 201.7323
const LABEL_10_X_PT = 334 // "10 m" ≈ 17.8 pt wide → ends beside x = 343.4646
/** Room outline: bottom-left corner (500, 400). */
const ROOM_X0_PT = 500
const ROOM_Y0_PT = 400
/** Interior wall rises from the room's bottom edge, 40 paper-mm in from the left. */
const WALL_X_PT = ROOM_X0_PT + 40 * MM_PT // 500 + 113.38582677165354 = 613.3858267716535

// ---------------------------------------------------------------------------
// [S13] Page 2 — the symbol field (auto-count fixture, limitation #5)
// ---------------------------------------------------------------------------

/** Socket symbol: outer square 10 pt (stroked), concentric inner square 4 pt
 *  (filled) — the SAME double-square topology the symbol-match unit tests
 *  pin. Centers are pinned; squares are derived from them. */
const SYMBOL_OUTER_PT = 10
const SYMBOL_INNER_PT = 4
/** Pinned symbol centers (PDF pt, y-up): 3 x 2 grid, 120 pt pitch in x,
 *  150 pt in y — clear of the border, title, and scale bar. */
const SYMBOL_CENTERS: [number, number][] = [
  [205, 505],
  [325, 505],
  [445, 505],
  [205, 355],
  [325, 355],
  [445, 355],
]

/** Page-2 title (fits the 14 pt Helvetica at x=40, y=790). */
const P2_TITLE = "EOS DEMO SHEET A-102 P2 \\227 LIGHTING LAYOUT @ 1:100"

// ---------------------------------------------------------------------------
// [S20] Page 3 — the two-size panel schedule (scale-invariant auto-count
// fixture, limitation #18): SIX 10 pt sockets (the page-2 size, default 1 pt
// pen) + FOUR 15 pt sockets — the SAME symbol UNIFORMLY scaled ×1.5 including
// the pen (outer 15 pt @ 1.5 w, inner 6 pt filled), the way an annotation
// block scales every stroke. The 1.5 rung of DEFAULT_SCALE_LADDER hits the
// large size EXACTLY; the multi-scale scan finds all TEN in one pass.
// ---------------------------------------------------------------------------

/** The 10 pt row: 6 instances, 120 pt pitch, on the y=560 line. */
const P3_SMALL_CENTERS: [number, number][] = [
  [205, 560],
  [325, 560],
  [445, 560],
  [565, 560],
  [685, 560],
  [805, 560],
]
/** The 15 pt row: 4 instances on the y=360 line — the ×1.5 devices. */
const P3_LARGE_CENTERS: [number, number][] = [
  [205, 360],
  [325, 360],
  [445, 360],
  [565, 360],
]
const P3_LARGE_OUTER_PT = 15
const P3_LARGE_INNER_PT = 6
const P3_LARGE_STROKE_PT = 1.5

/** Page-3 title. */
const P3_TITLE = "EOS DEMO SHEET A-102 P3 \\227 PANEL SCHEDULE @ 1:100"

/**
 * The full-precision truth about this sheet, exported so harnesses (and the
 * TL's journey) measure against the same numbers the stream is drawn from.
 */
export const SHEET_GEOMETRY: SheetGeometry = {
  mediaBox: { width: PAGE_W_PT, height: PAGE_H_PT },
  scaleBar: {
    a: { x: BAR_X0_PT, y: BAR_Y_PT },
    b: { x: BAR_X0_PT + BAR_LEN_PT, y: BAR_Y_PT },
  },
  room: {
    corners: [
      { x: ROOM_X0_PT, y: ROOM_Y0_PT },
      { x: ROOM_X0_PT + ROOM_W_PT, y: ROOM_Y0_PT },
      { x: ROOM_X0_PT + ROOM_W_PT, y: ROOM_Y0_PT + ROOM_H_PT },
      { x: ROOM_X0_PT, y: ROOM_Y0_PT + ROOM_H_PT },
    ],
  },
  wall: {
    a: { x: WALL_X_PT, y: ROOM_Y0_PT },
    b: { x: WALL_X_PT, y: ROOM_Y0_PT + WALL_LEN_PT },
  },
  paperMm: { scaleBar: 100, roomWidth: 80, roomHeight: 50, wall: 30, realScale: 100 },
}

/** [S13] The page-2 symbol field's pinned truth (auto-count fixture). */
export interface SheetSymbolField {
  /** symbol CENTERS in PDF-page space, draw order (the fixture's 6 instances) */
  centers: SheetPt[]
  /** outer stroked square side (pt) */
  outerPt: number
  /** inner filled square side (pt) */
  innerPt: number
  /** the page the field lives on (2-based 1-indexed: page 2) */
  page: number
}

export const SHEET_SYMBOLS: SheetSymbolField = {
  centers: SYMBOL_CENTERS.map(([x, y]) => ({ x, y })),
  outerPt: SYMBOL_OUTER_PT,
  innerPt: SYMBOL_INNER_PT,
  page: 2,
}

/** [S20] The page-3 two-size field's pinned truth (the multi-scale fixture).
 *  `small` mirrors page 2's 10 pt sockets; `large` is the same symbol ×1.5
 *  INCLUDING the pen — the exact 1.5 rung of the default scale ladder. */
export interface TwoSizeSymbolField {
  small: SheetSymbolField
  large: SheetSymbolField & { strokePt: number }
  page: number
}

export const SHEET_SYMBOLS_P3: TwoSizeSymbolField = {
  small: {
    centers: P3_SMALL_CENTERS.map(([x, y]) => ({ x, y })),
    outerPt: SYMBOL_OUTER_PT,
    innerPt: SYMBOL_INNER_PT,
    page: 3,
  },
  large: {
    centers: P3_LARGE_CENTERS.map(([x, y]) => ({ x, y })),
    outerPt: P3_LARGE_OUTER_PT,
    innerPt: P3_LARGE_INNER_PT,
    strokePt: P3_LARGE_STROKE_PT,
    page: 3,
  },
  page: 3,
}

// ---------------------------------------------------------------------------
// Deterministic primitives
// ---------------------------------------------------------------------------

/**
 * Deterministic coordinate printing: at most 4 decimals, trailing zeros and a
 * trailing dot trimmed, "0" for a value that rounds away entirely. toFixed is
 * exactly specified by ECMA-262, so the output is byte-identical on every
 * engine (see header: this is what makes the drawn ops hand-verifiable —
 * they read exactly like the contract's 4-decimal pin list).
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
 * here instead. (The one non-ASCII sequence in the file — the binary comment
 * line after the header — is emitted as raw bytes below, never as a string.)
 */
function ascii(s: string): Uint8Array {
  const bytes = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code > 127) {
      throw new Error(
        `build-sheet-pdf: non-ASCII byte ${code} at index ${i} would corrupt xref offsets`,
      )
    }
    bytes[i] = code
  }
  return bytes
}

// ---------------------------------------------------------------------------
// Content stream — stroke-only ops + text (the pinned drawing)
// ---------------------------------------------------------------------------

/** Shared sheet furniture. Split so page 1 can reproduce the Slice-8 op
 *  order BYTE-EXACTLY (border → title → scale bar): border first, then the
 *  scale bar + tick labels (BOTH pages — page 2 is self-contained for
 *  calibration). */
function borderOps(): string[] {
  return [
    "% border rectangle (paper frame): 24 24 1143 794",
    `${fmt(BORDER_X0_PT)} ${fmt(BORDER_Y0_PT)} ${fmt(PAGE_W_PT - 2 * BORDER_X0_PT)} ${fmt(PAGE_H_PT - 2 * BORDER_Y0_PT)} re S`,
  ]
}

function scaleBarOps(): string[] {
  const barX1 = BAR_X0_PT + BAR_LEN_PT // 343.46456692913387 → prints 343.4646
  const midTickX = BAR_X0_PT + BAR_LEN_PT / 2 // 201.73228346456693 → prints 201.7323
  return [
    "% scale bar: 100 paper-mm = 10.000 m real @ 1:100 (drawn span 343.4646 - 60 = 283.4646 pt)",
    `${fmt(BAR_X0_PT)} ${fmt(BAR_Y_PT)} m ${fmt(barX1)} ${fmt(BAR_Y_PT)} l S`,
    "% end ticks (12 pt tall) and mid tick at 5 m",
    `${fmt(BAR_X0_PT)} ${fmt(BAR_Y_PT - TICK_HALF_PT)} m ${fmt(BAR_X0_PT)} ${fmt(BAR_Y_PT + TICK_HALF_PT)} l S`,
    `${fmt(barX1)} ${fmt(BAR_Y_PT - TICK_HALF_PT)} m ${fmt(barX1)} ${fmt(BAR_Y_PT + TICK_HALF_PT)} l S`,
    `${fmt(midTickX)} ${fmt(BAR_Y_PT - TICK_HALF_PT)} m ${fmt(midTickX)} ${fmt(BAR_Y_PT + TICK_HALF_PT)} l S`,
    "% tick labels 0 / 5 / 10 m: Helvetica 8 at baseline y=100",
    `BT /F1 8 Tf ${fmt(LABEL_0_X_PT)} ${fmt(LABEL_Y_PT)} Td (0) Tj ET`,
    `BT /F1 8 Tf ${fmt(LABEL_5_X_PT)} ${fmt(LABEL_Y_PT)} Td (5) Tj ET`,
    `BT /F1 8 Tf ${fmt(LABEL_10_X_PT)} ${fmt(LABEL_Y_PT)} Td (10 m) Tj ET`,
  ]
}

/** [S20] The page-3 content stream: furniture + P3 title + the two-size
 *  panel schedule. The 10 pt row rides the DEFAULT pen (1 pt — the same ops
 * as page 2); the 15 pt row sets `1.5 w` first so the stroke scales WITH the
 *  symbol (a uniform ×1.5, the annotation-block reality). */
function buildPanelScheduleContentStream(): string {
  const lines: string[] = [
    "% EOS demo sheet A-102 p3 - panel schedule @ 1:100 (Slice 20 two-size fixture)",
    ...borderOps(),
    `BT /F1 14 Tf ${fmt(TITLE_X_PT)} ${fmt(TITLE_Y_PT)} Td (${P3_TITLE}) Tj ET`,
    ...scaleBarOps(),
    "% six 10 pt sockets (the page-2 size, default 1 pt pen) at y=560",
  ]
  for (const [cx, cy] of P3_SMALL_CENTERS) {
    lines.push(
      `% socket symbol at (${fmt(cx)}, ${fmt(cy)})`,
      `${fmt(cx - SYMBOL_OUTER_PT / 2)} ${fmt(cy - SYMBOL_OUTER_PT / 2)} ${fmt(SYMBOL_OUTER_PT)} ${fmt(SYMBOL_OUTER_PT)} re S`,
      `${fmt(cx - SYMBOL_INNER_PT / 2)} ${fmt(cy - SYMBOL_INNER_PT / 2)} ${fmt(SYMBOL_INNER_PT)} ${fmt(SYMBOL_INNER_PT)} re f`,
    )
  }
  lines.push(
    "% four 15 pt sockets - the SAME symbol x1.5 including the pen (1.5 w):",
    "% the exact 1.5 rung of the default scale ladder (Slice 20)",
    `${fmt(P3_LARGE_STROKE_PT)} w`,
  )
  for (const [cx, cy] of P3_LARGE_CENTERS) {
    lines.push(
      `% large socket symbol at (${fmt(cx)}, ${fmt(cy)})`,
      `${fmt(cx - P3_LARGE_OUTER_PT / 2)} ${fmt(cy - P3_LARGE_OUTER_PT / 2)} ${fmt(P3_LARGE_OUTER_PT)} ${fmt(P3_LARGE_OUTER_PT)} re S`,
      `${fmt(cx - P3_LARGE_INNER_PT / 2)} ${fmt(cy - P3_LARGE_INNER_PT / 2)} ${fmt(P3_LARGE_INNER_PT)} ${fmt(P3_LARGE_INNER_PT)} re f`,
    )
  }
  return lines.join("\n")
}

/** The page-1 content stream: furniture + title + room + wall (Slice 8, unchanged). */
function buildContentStream(): string {
  const lines: string[] = [
    "% EOS demo sheet A-102 - floor plan @ 1:100 (pinned geometry, contract 2.2)",
    ...borderOps(),
    "% title: Helvetica 14, WinAnsiEncoding (\\227 = em dash U+2014, WinAnsi 0x97)",
    `BT /F1 14 Tf ${fmt(TITLE_X_PT)} ${fmt(TITLE_Y_PT)} Td (EOS DEMO SHEET A-102 \\227 FLOOR PLAN @ 1:100) Tj ET`,
    ...scaleBarOps(),
    "% room outline: 80 x 50 paper-mm -> 8.000 x 5.000 m real @ 1:100",
    "% (perimeter 26.000 m, area 40.000 m2 at 1:100)",
    `${fmt(ROOM_X0_PT)} ${fmt(ROOM_Y0_PT)} ${fmt(ROOM_W_PT)} ${fmt(ROOM_H_PT)} re S`,
    "% interior wall: 30 paper-mm -> 3.000 m real (anchored on the room bottom edge)",
    `${fmt(WALL_X_PT)} ${fmt(ROOM_Y0_PT)} m ${fmt(WALL_X_PT)} ${fmt(ROOM_Y0_PT + WALL_LEN_PT)} l S`,
  ]
  return lines.join("\n")
}

/** [S13] The page-2 content stream: furniture + P2 title + the 6 socket
 *  symbols (auto-count fixture). Each symbol: 10 pt outer square `re S`,
 *  concentric 4 pt inner square `re f`, derived from the pinned centers. */
function buildSymbolPageContentStream(): string {
  const lines: string[] = [
    "% EOS demo sheet A-102 p2 - lighting layout @ 1:100 (Slice 13 auto-count fixture)",
    ...borderOps(),
    `BT /F1 14 Tf ${fmt(TITLE_X_PT)} ${fmt(TITLE_Y_PT)} Td (${P2_TITLE}) Tj ET`,
    ...scaleBarOps(),
    "% six identical socket symbols: 10 pt stroked outer square + 4 pt filled inner",
    "% square, at the pinned centers (205/325/445 x 505/355) - the auto-count fixture",
  ]
  for (const [cx, cy] of SYMBOL_CENTERS) {
    lines.push(
      `% socket symbol at (${fmt(cx)}, ${fmt(cy)})`,
      `${fmt(cx - SYMBOL_OUTER_PT / 2)} ${fmt(cy - SYMBOL_OUTER_PT / 2)} ${fmt(SYMBOL_OUTER_PT)} ${fmt(SYMBOL_OUTER_PT)} re S`,
      `${fmt(cx - SYMBOL_INNER_PT / 2)} ${fmt(cy - SYMBOL_INNER_PT / 2)} ${fmt(SYMBOL_INNER_PT)} ${fmt(SYMBOL_INNER_PT)} re f`,
    )
  }
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// PDF 1.4 assembly — objects, xref, trailer (offsets counted in bytes)
// ---------------------------------------------------------------------------

/**
 * Builds the committed fixture `tests/fixtures/sheet-a102-plan.pdf` as a real,
 * valid, THREE-PAGE vector PDF 1.4 that pdf.js parses and renders: correct xref
 * offsets, exact /Length on the uncompressed content streams, /Resources with
 * a /Font (Helvetica, WinAnsiEncoding) for the text ops.
 *
 * Object layout (fixed order, fixed numbering — part of the determinism):
 *   1 0 obj  Catalog          → /Pages 2 0 R
 *   2 0 obj  Pages            → /Kids [3 0 R 6 0 R 8 0 R] /Count 3
 *   3 0 obj  Page 1           → /MediaBox [0 0 1191 842] /Resources /Contents
 *   4 0 obj  Content stream 1 → /Length <exact byte count> (uncompressed)
 *   5 0 obj  Font             → Type1 Helvetica WinAnsiEncoding
 *   6 0 obj  Page 2           → /MediaBox [0 0 1191 842] /Resources /Contents
 *   7 0 obj  Content stream 2 → /Length <exact byte count> (uncompressed)
 *   8 0 obj  Page 3 [S20]     → /MediaBox [0 0 1191 842] /Resources /Contents
 *   9 0 obj  Content stream 3 → /Length <exact byte count> (uncompressed)
 * No /Info dictionary on purpose — it would only invite timestamps; the file
 * carries no date, so regeneration is byte-identical. Pages 1–2's STREAMS are
 * byte-identical to the two-page Slice-13 fixture (the S20 addition is purely
 * additive — the established page-2 precedent: page 1's stream was
 * byte-identical to Slice 8's).
 */
export function buildSheetPdf(): Uint8Array {
  const content1 = ascii(buildContentStream())
  const content2 = ascii(buildSymbolPageContentStream())
  const content3 = ascii(buildPanelScheduleContentStream())

  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 6 0 R 8 0 R] /Count 3 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(PAGE_W_PT)} ${fmt(PAGE_H_PT)}] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${content1.length} >>\nstream\n${buildContentStream()}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(PAGE_W_PT)} ${fmt(PAGE_H_PT)}] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>`,
    `<< /Length ${content2.length} >>\nstream\n${buildSymbolPageContentStream()}\nendstream`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(PAGE_W_PT)} ${fmt(PAGE_H_PT)}] /Resources << /Font << /F1 5 0 R >> >> /Contents 9 0 R >>`,
    `<< /Length ${content3.length} >>\nstream\n${buildPanelScheduleContentStream()}\nendstream`,
  ]

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

  // Cross-reference table: every entry is exactly 20 bytes ("nnnnnnnnnn ggggg n \n").
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
