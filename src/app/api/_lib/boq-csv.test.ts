/**
 * Worker 3 lane — BOQ CSV builder tests (pure, byte-for-byte).
 *
 * Every expected string below is a HAND-WRITTEN pin of the layout in the
 * worklog "Contract B" (LF endings, every field quoted, UTF-8, no BOM,
 * trailing LF). The numeric fixtures mirror the 3-b ledger smoke and are
 * hand-computed test data (documented inline), not engineering claims:
 *   9260.75 + 2614.8 = 11875.55 (subtotal, half-up@2)
 *   11875.55 × 10% = 1187.555 → 1187.56 (overhead)
 *   (11875.55 + 1187.56) × 5% = 653.1555 → 653.16 (profit)
 *   tax 0 · grand 11875.55 + 1187.56 + 653.16 + 0 = 13716.27
 */

/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test"

import { buildBoqCsv, type BoqCsvInput } from "./boq-csv"

const EM = "—" // U+2014 em dash — the pinned separator, never a hyphen

const twoLineInput: BoqCsvInput = {
  projectName: "Harbour View Extension",
  estimateName: "Preliminary BOQ, rev 2",
  currency: "GHS",
  overheadPct: 10,
  profitPct: 5,
  taxPct: 0,
  totals: { subtotal: 11875.55, overhead: 1187.56, profit: 653.16, tax: 0, grandTotal: 13716.27 },
  roundingMode: "half-up",
  roundingDecimals: 2,
  generatedAt: "2026-03-27T12:00:00.000Z",
  lines: [
    {
      seq: 1,
      // comma inside assembly + artifact names; ref falls back to sheetRef A-101
      description: `Slab, C25 ${EM} Site plan, rev 1 (A-101)`,
      quantityValue: 42.5,
      quantityUnit: "m²",
      assemblyName: "Slab, C25",
      lineTotal: 9260.75,
    },
    {
      seq: 2,
      // embedded double-quotes must be doubled per CSV convention
      description: `Wall "B" ${EM} Levels (B-2)`,
      quantityValue: 12,
      quantityUnit: "m²",
      assemblyName: `Wall "B"`,
      lineTotal: 2614.8,
    },
  ],
}

describe("buildBoqCsv — pinned byte-for-byte layout", () => {
  test("two-line estimate renders the exact pinned CSV (commas, quotes, totals)", () => {
    const csv = buildBoqCsv(twoLineInput)
    const expected = [
      `"Engineering OS ${EM} Bill of Quantities"`,
      `"Project","Harbour View Extension"`,
      `"Estimate","Preliminary BOQ, rev 2"`,
      `"Status","approved"`,
      `"Currency","GHS"`,
      `"Generated","2026-03-27T12:00:00.000Z"`,
      `""`,
      `"Item","Description","Quantity","Unit","Line total","GHS"`,
      `"1","Slab, C25 ${EM} Site plan, rev 1 (A-101)","42.5","m²","9260.75","GHS"`,
      `"2","Wall ""B"" ${EM} Levels (B-2)","12","m²","2614.8","GHS"`,
      `""`,
      `"Subtotal","11875.55"`,
      `"Overhead (10%)","1187.56"`,
      `"Profit (5%)","653.16"`,
      `"Tax (0%)","0"`,
      `"Grand total","13716.27"`,
      `"Note","Totals recomputed at export time via half-up@2; deterministic"`,
    ].join("\n") + "\n"
    expect(csv).toBe(expected)
  })

  test("empty-lines estimate: header + zero item rows + totals of 0", () => {
    const csv = buildBoqCsv({
      projectName: "Empty",
      estimateName: "Zero lines",
      currency: "GHS",
      overheadPct: 10,
      profitPct: 5,
      taxPct: 0,
      totals: { subtotal: 0, overhead: 0, profit: 0, tax: 0, grandTotal: 0 },
      roundingMode: "half-up",
      roundingDecimals: 2,
      generatedAt: "2026-05-01T00:00:00.000Z",
      lines: [],
    })
    const expected = [
      `"Engineering OS ${EM} Bill of Quantities"`,
      `"Project","Empty"`,
      `"Estimate","Zero lines"`,
      `"Status","approved"`,
      `"Currency","GHS"`,
      `"Generated","2026-05-01T00:00:00.000Z"`,
      `""`,
      `"Item","Description","Quantity","Unit","Line total","GHS"`,
      `""`,
      `"Subtotal","0"`,
      `"Overhead (10%)","0"`,
      `"Profit (5%)","0"`,
      `"Tax (0%)","0"`,
      `"Grand total","0"`,
      `"Note","Totals recomputed at export time via half-up@2; deterministic"`,
    ].join("\n") + "\n"
    expect(csv).toBe(expected)
  })

  test("rounding note renders <roundingMode>@<decimals> and percentages plainly", () => {
    const csv = buildBoqCsv({
      projectName: "P",
      estimateName: "E",
      currency: "EUR",
      overheadPct: 2.5,
      profitPct: 7.5,
      taxPct: 20,
      totals: { subtotal: 100, overhead: 2.5, profit: 7.69, tax: 22.04, grandTotal: 132.23 },
      roundingMode: "half-even",
      roundingDecimals: 3,
      generatedAt: "2026-06-01T00:00:00.000Z",
      lines: [],
    })
    // percentages via String(): 2.5 stays "2.5", 20 stays "20" (never 20.0)
    expect(csv).toContain('"Overhead (2.5%)","2.5"')
    expect(csv).toContain('"Profit (7.5%)","7.69"')
    expect(csv).toContain('"Tax (20%)","22.04"')
    // the pinned rounding-note row, generatedAt in its slot
    expect(csv).toContain('"Note","Totals recomputed at export time via half-even@3; deterministic"')
    expect(csv).toContain('"Generated","2026-06-01T00:00:00.000Z"')
    expect(csv).toContain('"Line total","EUR"')
  })

  test("unresolvable quantity joins render honest \"unknown\" — never a fabricated 0", () => {
    const csv = buildBoqCsv({
      projectName: "P",
      estimateName: "E",
      currency: "GHS",
      overheadPct: 0,
      profitPct: 0,
      taxPct: 0,
      totals: { subtotal: 100, overhead: 0, profit: 0, tax: 0, grandTotal: 100 },
      roundingMode: "half-up",
      roundingDecimals: 2,
      generatedAt: "2026-07-01T00:00:00.000Z",
      lines: [
        {
          seq: 1,
          description: `unknown ${EM} unknown (unknown)`,
          quantityValue: null,
          quantityUnit: null,
          assemblyName: "unknown",
          lineTotal: 100,
        },
      ],
    })
    expect(csv).toContain(
      `"1","unknown ${EM} unknown (unknown)","unknown","unknown","100","GHS"`,
    )
  })
})

describe("buildBoqCsv — structural invariants", () => {
  test("no BOM, LF-only endings, trailing LF", () => {
    const csv = buildBoqCsv(twoLineInput)
    expect(csv.startsWith("\uFEFF")).toBe(false)
    expect(csv.includes("\r")).toBe(false)
    expect(csv.endsWith("\n")).toBe(true)
  })

  test("deterministic: identical input → byte-identical output", () => {
    expect(buildBoqCsv(twoLineInput)).toBe(buildBoqCsv(twoLineInput))
  })

  test("every row is fully quoted (no bare fields)", () => {
    const csv = buildBoqCsv(twoLineInput)
    for (const line of csv.split("\n").filter((l) => l !== "")) {
      expect(line.startsWith('"')).toBe(true)
      expect(line.endsWith('"')).toBe(true)
    }
  })
})
