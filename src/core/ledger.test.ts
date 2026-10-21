/**
 * Worker 3 lane — quantity ledger & estimating tests.
 *
 * All numeric expectations below are HAND-COMPUTED test fixtures (arithmetic
 * documented inline); they are not engineering claims. They pin the
 * deterministic semantics of src/core/ledger.ts: same inputs → same outputs.
 */

/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test"
import {
  estimateLineTotal,
  estimateTotals,
  LedgerError,
  makeQuantityRecord,
  quantityRecordSchema,
  roundTo,
  type Assembly,
  type QuantityRecordInput,
  type QuantityRecord,
  type Rate,
  type RoundingRule,
} from "./ledger"

// ---------------------------------------------------------------------------
// QuantityRecord fixtures
// ---------------------------------------------------------------------------

const baseInput: QuantityRecordInput = {
  id: "qty_00000000-0000-4000-8000-000000000001",
  projectId: "prj_00000000-0000-4000-8000-000000000002",
  sourceArtifactRevisionId: "rev_00000000-0000-4000-8000-000000000003",
  quantityType: "volume",
  value: 42.5,
  unit: "m3",
  method: "drawing-measured",
  sheetRef: "A-101 / measurement region 3",
  rulesetId: "ruleset-takeoff",
  rulesetVersion: "1.0.0",
  createdBy: "mem_00000000-0000-4000-8000-000000000004",
}

const asRecord = (input: QuantityRecordInput): QuantityRecord =>
  makeQuantityRecord({ ...input, createdAt: "2026-01-01T00:00:00.000Z" })

describe("quantityRecordSchema — method-specific source references", () => {
  test("valid drawing-measured record passes (with sheetRef)", () => {
    const rec = asRecord(baseInput)
    expect(rec.method).toBe("drawing-measured")
    expect(rec.sheetRef).toBe("A-101 / measurement region 3")
    expect(rec.value).toBe(42.5)
  })

  test("drawing-measured without sheetRef fails with a clear message", () => {
    const { sheetRef, ...withoutSheet } = baseInput
    expect(() => asRecord(withoutSheet)).toThrow(LedgerError)
    expect(() => asRecord(withoutSheet)).toThrow(/sheetRef/)
    // direct schema check: issue is reported on the sheetRef path
    const parsed = quantityRecordSchema.safeParse({
      ...withoutSheet,
      status: "draft",
      verification: { status: "unverified" },
      provenance: {
        createdAt: "2026-01-01T00:00:00.000Z",
        createdBy: baseInput.createdBy,
        recomputeHistory: [],
      },
    })
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.path[0] === "sheetRef")).toBe(true)
    }
  })

  test("drawing-measured with whitespace-only sheetRef fails (non-empty means content)", () => {
    expect(() => asRecord({ ...baseInput, sheetRef: "   " })).toThrow(LedgerError)
  })

  test("model-derived passes with elementRef", () => {
    const rec = asRecord({
      ...baseInput,
      method: "model-derived",
      sheetRef: undefined,
      elementRef: "#IfcWall_2xO2Fr9v12CUv0GdWq0NrC",
      quantityMethod: "IfcOpenShell base quantities",
    })
    expect(rec.elementRef).toBe("#IfcWall_2xO2Fr9v12CUv0GdWq0NrC")
  })

  test("model-derived without elementRef fails", () => {
    expect(() =>
      asRecord({ ...baseInput, method: "model-derived", sheetRef: undefined }),
    ).toThrow(LedgerError)
    expect(() =>
      asRecord({ ...baseInput, method: "model-derived", sheetRef: undefined }),
    ).toThrow(/elementRef/)
  })
})

describe("quantityRecordSchema — value and string-field rules", () => {
  test("value 0, -5, NaN and Infinity are all invalid ledger records", () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => asRecord({ ...baseInput, value: bad })).toThrow(LedgerError)
      expect(() => asRecord({ ...baseInput, value: bad })).toThrow(/value/)
    }
  })

  test("tiny positive values are fine (value > 0, not value ≥ some threshold)", () => {
    expect(asRecord({ ...baseInput, value: 0.001 }).value).toBe(0.001)
  })

  test("empty unit, rulesetId and rulesetVersion are rejected", () => {
    expect(() => asRecord({ ...baseInput, unit: "" })).toThrow(LedgerError)
    expect(() => asRecord({ ...baseInput, rulesetId: "" })).toThrow(LedgerError)
    expect(() => asRecord({ ...baseInput, rulesetVersion: "" })).toThrow(LedgerError)
  })

  test("status approved without an approval record is rejected", () => {
    expect(() => asRecord({ ...baseInput, status: "approved" })).toThrow(LedgerError)
    expect(() => asRecord({ ...baseInput, status: "approved" })).toThrow(/approval/)
  })

  test("status approved with approval (approvedBy + approvedAt) passes", () => {
    const rec = asRecord({
      ...baseInput,
      status: "approved",
      reviewer: "mem_00000000-0000-4000-8000-000000000009",
      approval: { approvedBy: "mem_00000000-0000-4000-8000-000000000009", approvedAt: "2026-02-02T10:00:00.000Z" },
    })
    expect(rec.approval?.approvedBy).toBe("mem_00000000-0000-4000-8000-000000000009")
  })

  test("quantityType, method and status are closed enums (unknown values rejected)", () => {
    const badType = { ...baseInput, quantityType: "temperature" } as unknown as QuantityRecordInput
    const badStatus = { ...baseInput, status: "deleted" } as unknown as QuantityRecordInput
    expect(() => asRecord(badType)).toThrow()
    expect(() => asRecord(badStatus)).toThrow()
  })
})

describe("makeQuantityRecord — defaults and validation", () => {
  test("fills status draft, verification unverified, provenance now/creator", () => {
    const rec = makeQuantityRecord(baseInput)
    expect(rec.status).toBe("draft")
    expect(rec.verification).toEqual({ status: "unverified" })
    expect(rec.provenance.createdBy).toBe(baseInput.createdBy)
    expect(rec.provenance.recomputeHistory).toEqual([])
    // default createdAt is a parseable ISO timestamp ("now")
    expect(Number.isNaN(Date.parse(rec.provenance.createdAt))).toBe(false)
  })

  test("explicit createdAt, status, verification and history overrides are respected", () => {
    const rec = makeQuantityRecord({
      ...baseInput,
      createdAt: "2025-06-01T12:00:00.000Z",
      status: "in_review",
      verification: { status: "passed", checker: "harness-b", evidence: "bench 0.1%" },
      recomputeHistory: ["qty_prev_1"],
    })
    expect(rec.provenance.createdAt).toBe("2025-06-01T12:00:00.000Z")
    expect(rec.status).toBe("in_review")
    expect(rec.verification.checker).toBe("harness-b")
    expect(rec.provenance.recomputeHistory).toEqual(["qty_prev_1"])
  })

  test("throws LedgerError with a readable message on invalid input", () => {
    try {
      asRecord({ ...baseInput, value: 0 })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(LedgerError)
      expect((err as LedgerError).message).toContain("invalid QuantityRecord")
      expect((err as LedgerError).message).toContain("value")
    }
  })
})

// ---------------------------------------------------------------------------
// roundTo — explicit deterministic rounding
// ---------------------------------------------------------------------------

const halfUp2: RoundingRule = { mode: "half-up", decimals: 2 }

describe("roundTo", () => {
  test("half-up: 2.345 → 2.35, 2.344 → 2.34 (task fixtures)", () => {
    expect(roundTo(2.345, halfUp2)).toBe(2.35)
    expect(roundTo(2.344, halfUp2)).toBe(2.34)
  })

  test("half-up on binary-artifact cases: 1.005 → 1.01, 2.675 → 2.68", () => {
    // naive Math.round(2.675*100)/100 gives 2.67 because 2.675*100 === 267.49999999999997
    expect(roundTo(1.005, halfUp2)).toBe(1.01)
    expect(roundTo(2.675, halfUp2)).toBe(2.68)
  })

  test("half-up ties away from zero, also for negatives", () => {
    expect(roundTo(-2.345, halfUp2)).toBe(-2.35)
    expect(roundTo(2.5, { mode: "half-up", decimals: 0 })).toBe(3)
    expect(roundTo(-2.5, { mode: "half-up", decimals: 0 })).toBe(-3)
  })

  test("values already at/below target precision are returned unchanged", () => {
    expect(roundTo(2.3, halfUp2)).toBe(2.3)
    expect(roundTo(5, halfUp2)).toBe(5)
    expect(roundTo(0.125, { mode: "half-even", decimals: 3 })).toBe(0.125)
  })

  test("half-even: exact ties go to the even neighbour", () => {
    expect(roundTo(0.125, { mode: "half-even", decimals: 2 })).toBe(0.12)
    expect(roundTo(0.135, { mode: "half-even", decimals: 2 })).toBe(0.14)
    expect(roundTo(2.5, { mode: "half-even", decimals: 0 })).toBe(2)
    expect(roundTo(3.5, { mode: "half-even", decimals: 0 })).toBe(4)
  })

  test("floor rounds toward negative infinity", () => {
    expect(roundTo(2.341, { mode: "floor", decimals: 2 })).toBe(2.34)
    expect(roundTo(-2.341, { mode: "floor", decimals: 2 })).toBe(-2.35)
    expect(roundTo(2.34, { mode: "floor", decimals: 2 })).toBe(2.34)
  })

  test("ceil rounds toward positive infinity", () => {
    expect(roundTo(2.341, { mode: "ceil", decimals: 2 })).toBe(2.35)
    expect(roundTo(-2.341, { mode: "ceil", decimals: 2 })).toBe(-2.34)
    expect(roundTo(2.35, { mode: "ceil", decimals: 2 })).toBe(2.35)
  })

  test("very small and exponential inputs survive the decimal expansion", () => {
    expect(roundTo(0.0000001, halfUp2)).toBe(0) // 1e-7, String form "1e-7"
    expect(roundTo(1.5e-7, { mode: "half-up", decimals: 8 })).toBe(0.00000015)
  })

  test("non-finite values throw LedgerError (never NaN out the door)", () => {
    expect(() => roundTo(Number.NaN, halfUp2)).toThrow(LedgerError)
    expect(() => roundTo(Number.POSITIVE_INFINITY, halfUp2)).toThrow(LedgerError)
  })

  test("invalid decimals / unknown mode throw LedgerError", () => {
    expect(() => roundTo(1, { mode: "half-up", decimals: -1 })).toThrow(LedgerError)
    expect(() => roundTo(1, { mode: "half-up", decimals: 1.5 })).toThrow(LedgerError)
    const bogusMode = { mode: "bogus", decimals: 2 } as unknown as RoundingRule
    expect(() => roundTo(1, bogusMode)).toThrow(LedgerError)
  })
})

// ---------------------------------------------------------------------------
// estimateLineTotal — deterministic estimate arithmetic
// ---------------------------------------------------------------------------

// Fixture (test constants — not engineering claims):
//   quantity: 12.5 m³ of a concrete wall take-off
//   assembly "wall-cast":
//     - material "concrete": quantityPerUnit 1 (m³ per m³), wastePct 5
//     - labor "crew":       quantityPerUnit 0.8 (hours per m³), productivityFactor 1.25
//   rates (keyed by component id): concrete 120 /m³, crew 25 /h
//   rounding: half-up, 2 decimals
//
// Hand arithmetic:
//   material amount = 12.5 × 1 × (1 + 5/100)      = 13.125
//   material cost   = 13.125 × 120                = 1575.00
//   labor amount    = 12.5 × 0.8 / 1.25           = 8      (productivity DIVIDES)
//   labor cost      = 8 × 25                      = 200.00
//   line total      = roundTo(1575.00 + 200.00)   = 1775.00
// (module scope: shared with the estimateTotals composition block below)
const wallAssembly: Assembly = {
  id: "asm-wall-cast",
  name: "Cast-in-place concrete wall",
  components: [
    { id: "concrete", kind: "material", quantityPerUnit: 1, unit: "m3", wastePct: 5 },
    { id: "crew", kind: "labor", quantityPerUnit: 0.8, unit: "h", productivityFactor: 1.25 },
  ],
}
const wallRates: Record<string, Rate> = {
  concrete: { id: "rate-concrete", currency: "EUR", unitPrice: 120, source: "price-book" },
  crew: { id: "rate-crew", currency: "EUR", unitPrice: 25, source: "contract" },
}

describe("estimateLineTotal", () => {
  test("hand-computed concrete wall fixture totals 1775.00", () => {
    expect(estimateLineTotal({ value: 12.5 }, wallAssembly, wallRates, halfUp2)).toBe(1775)
  })

  test("same inputs → same outputs (deterministic, re-runnable)", () => {
    const first = estimateLineTotal({ value: 12.5 }, wallAssembly, wallRates, halfUp2)
    const second = estimateLineTotal({ value: 12.5 }, wallAssembly, wallRates, halfUp2)
    expect(first).toBe(second)
    expect(first).toBe(1775)
  })

  test("productivity factor DIVIDES: factor 2 halves the labor input", () => {
    // amount = 3 × 10 / 2 = 15; cost = 15 × 1 = 15 (multiplication would give 60)
    const assembly: Assembly = {
      id: "asm-prod",
      name: "Productivity direction probe",
      components: [{ id: "labor", kind: "labor", quantityPerUnit: 10, unit: "h", productivityFactor: 2 }],
    }
    const rates: Record<string, Rate> = {
      labor: { id: "rate-labor", currency: "EUR", unitPrice: 1, source: "quote" },
    }
    expect(estimateLineTotal({ value: 3 }, assembly, rates, halfUp2)).toBe(15)
  })

  test("waste percentage inflates the amount", () => {
    // amount = 20 × 1 × 1.05 = 21; cost = 21 × 10 = 210
    const assembly: Assembly = {
      id: "asm-waste",
      name: "Waste probe",
      components: [{ id: "mat", kind: "material", quantityPerUnit: 1, unit: "m3", wastePct: 5 }],
    }
    const rates: Record<string, Rate> = {
      mat: { id: "rate-mat", currency: "EUR", unitPrice: 10, source: "price-book" },
    }
    expect(estimateLineTotal({ value: 20 }, assembly, rates, halfUp2)).toBe(210)
  })

  test("each component cost is rounded BEFORE the sum (documented rounding order)", () => {
    // Two components each costing exactly 0.005 → each rounds half-up to 0.01,
    // sum = 0.02. (Sum-then-round-once would produce 0.01 — this pins the order.)
    const assembly: Assembly = {
      id: "asm-order",
      name: "Rounding order probe",
      components: [
        { id: "a", kind: "material", quantityPerUnit: 1, unit: "m3" },
        { id: "b", kind: "material", quantityPerUnit: 1, unit: "m3" },
      ],
    }
    const rates: Record<string, Rate> = {
      a: { id: "rate-a", currency: "EUR", unitPrice: 0.005, source: "quote" },
      b: { id: "rate-b", currency: "EUR", unitPrice: 0.005, source: "quote" },
    }
    expect(estimateLineTotal({ value: 1 }, assembly, rates, halfUp2)).toBe(0.02)
  })

  test("missing rate throws LedgerError naming the component", () => {
    expect(() =>
      estimateLineTotal({ value: 12.5 }, wallAssembly, { concrete: wallRates.concrete }, halfUp2),
    ).toThrow(LedgerError)
    expect(() =>
      estimateLineTotal({ value: 12.5 }, wallAssembly, { concrete: wallRates.concrete }, halfUp2),
    ).toThrow(/crew/)
  })

  test("non-positive or non-finite quantity throws LedgerError", () => {
    for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => estimateLineTotal({ value: bad }, wallAssembly, wallRates, halfUp2)).toThrow(
        LedgerError,
      )
    }
  })

  test("bad components (zero per-unit, negative waste, zero productivity) throw", () => {
    const rates: Record<string, Rate> = {
      m: { id: "rate-m", currency: "EUR", unitPrice: 1, source: "quote" },
    }
    expect(() =>
      estimateLineTotal(
        { value: 1 },
        { id: "a", name: "x", components: [{ id: "m", kind: "material", quantityPerUnit: 0, unit: "m3" }] },
        rates,
        halfUp2,
      ),
    ).toThrow(LedgerError)
    expect(() =>
      estimateLineTotal(
        { value: 1 },
        { id: "a", name: "x", components: [{ id: "m", kind: "material", quantityPerUnit: 1, unit: "m3", wastePct: -1 }] },
        rates,
        halfUp2,
      ),
    ).toThrow(LedgerError)
    expect(() =>
      estimateLineTotal(
        { value: 1 },
        { id: "a", name: "x", components: [{ id: "m", kind: "labor", quantityPerUnit: 1, unit: "h", productivityFactor: 0 }] },
        rates,
        halfUp2,
      ),
    ).toThrow(LedgerError)
  })

  test("mixed currencies in one line throw LedgerError (not a number)", () => {
    expect(() =>
      estimateLineTotal(
        { value: 12.5 },
        wallAssembly,
        {
          concrete: wallRates.concrete,
          crew: { id: "rate-crew-usd", currency: "USD", unitPrice: 25, source: "contract" },
        },
        halfUp2,
      ),
    ).toThrow(/mixed currencies/)
  })

  test("empty assembly throws LedgerError", () => {
    expect(() =>
      estimateLineTotal({ value: 12.5 }, { id: "asm-empty", name: "Empty", components: [] }, {}, halfUp2),
    ).toThrow(LedgerError)
  })
})

// ---------------------------------------------------------------------------
// estimateTotals — pinned estimate-total formula
// ---------------------------------------------------------------------------

describe("estimateTotals", () => {
  test("hand-computed case: [100, 50], 10% overhead, 5% profit, 0% tax, half-up 2 → 173.25", () => {
    // Hand arithmetic (task fixture, documented inline):
    //   linesSubtotal = 100 + 50                     = 150.00
    //   overhead      = roundTo(150 × 10/100)        = 15.00
    //   profit        = roundTo((150 + 15) × 5/100)  = roundTo(8.25) = 8.25
    //   tax           = roundTo(165 × 0/100)        = 0.00
    //   grandTotal    = roundTo(150 + 15 + 8.25 + 0) = 173.25
    const totals = estimateTotals([100, 50], { overheadPct: 10, profitPct: 5, taxPct: 0 }, halfUp2)
    expect(totals).toEqual({
      linesSubtotal: 150,
      overhead: 15,
      profit: 8.25,
      tax: 0,
      grandTotal: 173.25,
    })
  })

  test("compounding: tax is computed on subtotal + overhead + profit", () => {
    // [100], 10% / 5% / 8%:
    //   overhead = 10.00; profit = roundTo(110 × 5/100) = 5.50
    //   tax      = roundTo(115.5 × 8/100) = roundTo(9.24) = 9.24
    //   grand    = roundTo(100 + 10 + 5.5 + 9.24) = 124.74
    const totals = estimateTotals([100], { overheadPct: 10, profitPct: 5, taxPct: 8 }, halfUp2)
    expect(totals).toEqual({
      linesSubtotal: 100,
      overhead: 10,
      profit: 5.5,
      tax: 9.24,
      grandTotal: 124.74,
    })
  })

  test("each step is rounded to the estimate precision before the next compounds", () => {
    // Two lines of 0.005: subtotal = roundTo(0.01) = 0.01 (per-line rounding is
    // the line layer's job; here the SUM is rounded once). With 100% overhead,
    // overhead = roundTo(0.01 × 100/100) = 0.01 and grand = 0.02 — pinning that
    // the pinned formula rounds each step instead of carrying raw intermediates.
    const totals = estimateTotals([0.005, 0.005], { overheadPct: 100, profitPct: 0, taxPct: 0 }, halfUp2)
    expect(totals).toEqual({ linesSubtotal: 0.01, overhead: 0.01, profit: 0, tax: 0, grandTotal: 0.02 })
  })

  test("empty ledger: an estimate with no lines totals to zero (not an error)", () => {
    const totals = estimateTotals([], { overheadPct: 10, profitPct: 5, taxPct: 14.5 }, halfUp2)
    expect(totals).toEqual({ linesSubtotal: 0, overhead: 0, profit: 0, tax: 0, grandTotal: 0 })
  })

  test("same inputs → same outputs (deterministic, re-runnable)", () => {
    const params = { overheadPct: 10, profitPct: 5, taxPct: 0 }
    const first = estimateTotals([100, 50], params, halfUp2)
    const second = estimateTotals([100, 50], params, halfUp2)
    expect(first).toEqual(second)
    expect(first.grandTotal).toBe(173.25)
  })

  test("negative overheadPct / profitPct / taxPct throw LedgerError", () => {
    expect(() => estimateTotals([100], { overheadPct: -1, profitPct: 5, taxPct: 0 }, halfUp2)).toThrow(
      LedgerError,
    )
    expect(() => estimateTotals([100], { overheadPct: 10, profitPct: -0.5, taxPct: 0 }, halfUp2)).toThrow(
      /profitPct/,
    )
    expect(() => estimateTotals([100], { overheadPct: 10, profitPct: 5, taxPct: -2 }, halfUp2)).toThrow(
      /taxPct/,
    )
  })

  test("NaN / Infinity percentages throw LedgerError (never NaN out the door)", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => estimateTotals([100], { overheadPct: bad, profitPct: 5, taxPct: 0 }, halfUp2)).toThrow(
        LedgerError,
      )
      expect(() => estimateTotals([100], { overheadPct: 10, profitPct: bad, taxPct: 0 }, halfUp2)).toThrow(
        LedgerError,
      )
      expect(() => estimateTotals([100], { overheadPct: 10, profitPct: 5, taxPct: bad }, halfUp2)).toThrow(
        LedgerError,
      )
    }
  })

  test("non-finite line totals throw LedgerError naming the position", () => {
    expect(() => estimateTotals([10, Number.NaN], { overheadPct: 0, profitPct: 0, taxPct: 0 }, halfUp2)).toThrow(
      LedgerError,
    )
    expect(() => estimateTotals([10, Number.NaN], { overheadPct: 0, profitPct: 0, taxPct: 0 }, halfUp2)).toThrow(
      /lineTotals\[1\]/,
    )
    expect(() =>
      estimateTotals([Number.POSITIVE_INFINITY], { overheadPct: 0, profitPct: 0, taxPct: 0 }, halfUp2),
    ).toThrow(LedgerError)
  })

  test("non-array lineTotals throw LedgerError", () => {
    expect(() =>
      estimateTotals("100" as unknown as number[], { overheadPct: 10, profitPct: 5, taxPct: 0 }, halfUp2),
    ).toThrow(LedgerError)
  })
})

// ---------------------------------------------------------------------------
// estimateLineTotal × estimateTotals — the two layers compose deterministically
// ---------------------------------------------------------------------------

describe("estimateLineTotal + estimateTotals composition", () => {
  test("stored line totals feed the pinned totals formula without drift", () => {
    // Fixture (test constants): 12.5 m³ wall take-off at 1775.00 (see above),
    // plus a second line — 20 m³ with concrete at 95.2386 /m³:
    //   material amount = 20 × 1 × 1.05 = 21 → cost = 21 × 95.2386 = 2000.0106 → 2000.01
    //   labor amount     = 20 × 0.8 / 1.25 = 12.8 → cost = 12.8 × 25 = 320.00
    //   lineTotal        = roundTo(2000.01 + 320) = 2320.01
    // Totals (10% overhead, 5% profit, 0% tax, half-up 2):
    //   linesSubtotal = roundTo(1775 + 2320.01)       = 4095.01
    //   overhead      = roundTo(4095.01 × 10/100)      = roundTo(409.501) = 409.5
    //   profit        = roundTo(4504.51 × 5/100)      = roundTo(225.2255) = 225.23
    //   tax           = 0; grand = roundTo(4504.51 + 225.23) = 4729.74
    const lineA = estimateLineTotal({ value: 12.5 }, wallAssembly, wallRates, halfUp2)
    const lineB = estimateLineTotal({ value: 20 }, wallAssembly, {
      ...wallRates,
      concrete: { id: "rate-concrete", currency: "EUR", unitPrice: 95.2386, source: "price-book" },
    }, halfUp2)
    expect(lineA).toBe(1775)
    expect(lineB).toBe(2320.01)
    const totals = estimateTotals([lineA, lineB], { overheadPct: 10, profitPct: 5, taxPct: 0 }, halfUp2)
    expect(totals).toEqual({
      linesSubtotal: 4095.01,
      overhead: 409.5,
      profit: 225.23,
      tax: 0,
      grandTotal: 4729.74,
    })
  })
})
