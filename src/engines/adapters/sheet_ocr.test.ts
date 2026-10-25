/**
 * Unit tests for the sheet-OCR adapter's PURE surfaces (Slice 16-B):
 *  - `parseTsvWords` — the tesseract TSV parse (level-5 rows, conf > 0,
 *    non-empty text; malformed geometry refuses, never guesses);
 *  - `normalizeDiameterToken` — the documented Ø normalization (16-R2:
 *    tesseract never reads the Ø glyph; the raw transcript is preserved).
 * The engine bridge itself is harness-validated (sheet-ocr-callout) — no
 * mocks here, only pure-string contracts.
 */
import { describe, expect, test } from "bun:test"

import { normalizeDiameterToken, parseTsvWords } from "./sheet_ocr"

const TSV_HEADER =
  "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext"

function tsvRow(
  level: number,
  left: number,
  top: number,
  width: number,
  height: number,
  conf: number,
  text: string,
): string {
  return [level, 1, 1, 1, 1, 1, left, top, width, height, conf, text].join("\t")
}

describe("parseTsvWords — the tesseract TSV parse (pure)", () => {
  test("level-5 rows with conf > 0 and non-empty text parse; others drop", () => {
    const tsv = [
      TSV_HEADER,
      tsvRow(1, 0, 0, 0, 0, -1, ""), // page block — dropped
      tsvRow(5, 10, 20, 100, 40, 96.7, "2400"), // kept
      tsvRow(5, 120, 20, 60, 40, 55.0, "@400"), // kept (conf > 0)
      tsvRow(5, 200, 20, 80, 40, -1, "dropped-conf"), // conf -1 → dropped
      tsvRow(5, 300, 20, 80, 40, 90.0, "   "), // blank text → dropped
    ].join("\n")
    const words = parseTsvWords(tsv)
    expect(words).toHaveLength(2)
    expect(words[0]).toEqual({ text: "2400", conf: 96.7, x: 10, y: 20, width: 100, height: 40 })
    expect(words[1]).toEqual({ text: "@400", conf: 55.0, x: 120, y: 20, width: 60, height: 40 })
  })

  test("empty/trailing-newline TSV parses to zero words", () => {
    expect(parseTsvWords("")).toEqual([])
    expect(parseTsvWords(`${TSV_HEADER}\n`)).toEqual([])
  })

  test("a missing pinned column refuses with the honest error", () => {
    const missing = "level\tpage_num\tleft\ttop\tconf\ttext\n5\t1\t10\t20\t90\tword"
    expect(() => parseTsvWords(missing)).toThrow(
      'tesseract TSV output is missing the "width" column',
    )
  })

  test("a non-numeric geometry row refuses (never a guessed box)", () => {
    const bad = [TSV_HEADER, "5\t1\t1\t1\t1\t1\tnan\t20\t100\t40\t90\tword"].join("\n")
    expect(() => parseTsvWords(bad)).toThrow(
      "tesseract TSV row 2 carries non-numeric geometry",
    )
  })

  test("a truncated trailing row is dropped, not a parse failure", () => {
    const tsv = [TSV_HEADER, tsvRow(5, 10, 20, 100, 40, 96.7, "2400"), "5\t1"].join("\n")
    const words = parseTsvWords(tsv)
    expect(words).toHaveLength(1)
    expect(words[0].text).toBe("2400")
  })
})

describe("normalizeDiameterToken — the documented Ø rule (16-R2, pure)", () => {
  test("the pinned research case: @400 → Ø400 with the raw preserved", () => {
    expect(normalizeDiameterToken("@400")).toEqual({
      raw: "@400",
      normalized: "Ø400",
      rule: "diameter-glyph",
    })
  })

  test("the O/0/Ø glyph variants normalize to the same diameter form", () => {
    expect(normalizeDiameterToken("O400")?.normalized).toBe("Ø400")
    expect(normalizeDiameterToken("0400")?.normalized).toBe("Ø400")
    expect(normalizeDiameterToken("Ø400")?.normalized).toBe("Ø400")
    expect(normalizeDiameterToken("Ø40")?.raw).toBe("Ø40")
  })

  test("a single digit after the glyph does not fire (≥ 2 digits required)", () => {
    expect(normalizeDiameterToken("@4")).toBeNull()
    expect(normalizeDiameterToken("O9")).toBeNull()
  })

  test("non-callout tokens are left alone (null — never a forced rewrite)", () => {
    expect(normalizeDiameterToken("2400")).toBeNull()
    expect(normalizeDiameterToken("LOADING")).toBeNull()
    expect(normalizeDiameterToken("GHS 225.00")).toBeNull()
    expect(normalizeDiameterToken("@400mm")).toBeNull()
    expect(normalizeDiameterToken("")).toBeNull()
    expect(normalizeDiameterToken("Ø")).toBeNull()
  })
})
