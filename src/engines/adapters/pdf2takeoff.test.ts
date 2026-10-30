import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  EngineUnavailableError,
  PDF2TAKEOFF_PINNED_COMMIT,
  PDF2TAKEOFF_REFUSAL_NO_SCALE,
  buildTakeoffSpecYaml,
  parseCsvTable,
  pdf2takeoffAnnotateTakeoff,
  pdf2takeoffCompareRevisions,
  pdf2takeoffExportTakeoff,
  pdf2takeoffFillRoom,
  resolvePdf2takeoffEngine,
  scaleMmPerPtToRatioString,
  validateComparePayload,
  validateFillPayload,
  validateTakeoffSpecMarkups,
  type TakeoffSpecMarkup,
} from "./pdf2takeoff"

/**
 * pdf2takeoff bridge tests (ADR-0011 Stage 1 — the ADOPTED takeoff engine).
 *
 * Honesty rules (ADR-0006 — the sheet_takeoff.test.ts convention): the PURE
 * tests feed SYNTHETIC inputs into the bridge's validate/serialize half and
 * pin the parameter policy — they test the BRIDGE, are labelled synthetic
 * and assert no engine values. Every number asserted in the REAL-engine
 * tests is a hand-derived closed form from the fixture builder
 * (tests/fixtures/build-sheet-pdf.ts — the A-102 demo sheet: the room
 * rectangle is exactly 80 × 50 paper-mm → 8.000 × 5.000 m real @ 1:100, the
 * scale bar spans 100 paper-mm → 10.000 m), independent of the adapter.
 *
 * Real-engine tests run ONLY when the pinned checkout is genuinely installed
 * (scripts/setup-pdf2takeoff.sh); otherwise they are skipped with an
 * explicit printed reason. A skipped test with a reason is honest; a fake
 * result is not.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.resolve(here, "..", "..", "..", "tests", "fixtures")

const A102 = path.join(fixtures, "sheet-a102-plan.pdf")
const CURVE = path.join(fixtures, "sheet-curve-arc.pdf")

/** The research-verified A-102 fixture scale: 1:100 on A3 → 2540/72 mm/pt. */
const A102_SCALE_MM_PER_PT = 1270 / 36

function engineInstalled(): boolean {
  const dir = process.env.EOS_PDF2TAKEOFF_DIR ?? path.join(os.homedir(), ".local", "share", "eos-engines", "pdf2takeoff")
  try {
    const pin = readFileSync(path.join(dir, ".eos-engine-pin"), "utf8").trim()
    return pin === PDF2TAKEOFF_PINNED_COMMIT
  } catch {
    return false
  }
}

if (!engineInstalled()) {
  console.log(
    "[pdf2takeoff.test.ts] real-engine tests SKIPPED: the pinned checkout is not installed (run scripts/setup-pdf2takeoff.sh) — recorded honestly, no results are simulated",
  )
}

const TEST_TIMEOUT_MS = 240_000

function expectEngineUnavailable(promise: Promise<unknown>): Promise<EngineUnavailableError> {
  return promise.then(
    () => {
      throw new Error("expected the bridge to throw EngineUnavailableError")
    },
    (err) => {
      if (!(err instanceof EngineUnavailableError)) {
        throw new Error(`expected EngineUnavailableError, got ${String(err)}`)
      }
      return err
    },
  )
}

/** The pinned A-102 annotate spec: the scale-bar run (10.000 m @ 1:100), the room rectangle (40.000 m²) and one socket on page 2. */
const A102_SPEC: Array<Record<string, unknown>> = [
  { type: "length", label: "Scale bar", page: 1, points: [[60, 400], [343.4646, 400]] },
  { type: "area", label: "Room 101", page: 1, points: [[500, 400], [726.7717, 400], [726.7717, 541.7323], [500, 541.7323]] },
  { type: "count", label: "Socket", page: 2, points: [[205, 505]] },
]

describe("pdf2takeoff bridge pure half (synthetic — no engine)", () => {
  test("validateTakeoffSpecMarkups accepts a well-formed spec and normalizes nothing silently", () => {
    const res = validateTakeoffSpecMarkups(A102_SPEC)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.value).toHaveLength(3)
      expect(res.value[0]?.type).toBe("length")
      expect(res.value[0]?.points).toEqual([[60, 400], [343.4646, 400]])
    }
  })

  test("validateTakeoffSpecMarkups refuses empty/missing/non-array markups", () => {
    expect(validateTakeoffSpecMarkups(undefined).ok).toBe(false)
    expect(validateTakeoffSpecMarkups([]).ok).toBe(false)
    expect(validateTakeoffSpecMarkups("nope").ok).toBe(false)
    const bad = validateTakeoffSpecMarkups([{ type: "length", points: [] }])
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.message).toContain("markups[0].points")
  })

  test("validateTakeoffSpecMarkups refuses unknown types, bad labels, bad pages, non-pair points", () => {
    expect(validateTakeoffSpecMarkups([{ type: "vibes", points: [[0, 0], [1, 1]] }]).ok).toBe(false)
    expect(validateTakeoffSpecMarkups([{ type: "count", label: "", points: [[0, 0]] }]).ok).toBe(false)
    expect(validateTakeoffSpecMarkups([{ type: "count", page: 0, points: [[0, 0]] }]).ok).toBe(false)
    expect(validateTakeoffSpecMarkups([{ type: "length", points: [[0, 0], [1]] }]).ok).toBe(false)
    expect(validateTakeoffSpecMarkups([{ type: "length", points: [[0, 0], ["x", 1]] }]).ok).toBe(false)
    // per-type policies mirrored from upstream parseSpec: length/area need ≥2
    // points, count EXACTLY 1
    expect(validateTakeoffSpecMarkups([{ type: "area", points: [[0, 0]] }]).ok).toBe(false)
    expect(validateTakeoffSpecMarkups([{ type: "length", points: [[0, 0]] }]).ok).toBe(false)
    expect(validateTakeoffSpecMarkups([{ type: "count", points: [[0, 0], [1, 1]] }]).ok).toBe(false)
  })

  test("buildTakeoffSpecYaml is deterministic, closed-schema YAML with sanitized labels", () => {
    const validated = validateTakeoffSpecMarkups([
      { type: "count", label: 'Doors: "west" #1', page: 2, points: [[10, 20]] },
    ])
    expect(validated.ok).toBe(true)
    if (!validated.ok) return
    const yaml = buildTakeoffSpecYaml(validated.value)
    expect(yaml).toBe(buildTakeoffSpecYaml(validated.value)) // deterministic
    expect(yaml).toContain("type: count")
    expect(yaml).toContain("page: 2")
    expect(yaml).toContain("- [10, 20]")
    // YAML metacharacters stripped from the label (": \" #" gone)
    expect(yaml).not.toContain('Doors: "west" #1')
    expect(yaml).toContain("label: Doors west 1")
  })

  test("parseCsvTable handles quoted fields, blank lines and trailing rows", () => {
    const rows = parseCsvTable('Label,Type\n"Wall, A",length\n\nGroup,Type\n', ",")
    expect(rows).toEqual([
      ["Label", "Type"],
      ["Wall, A", "length"],
      ["Group", "Type"],
    ])
  })

  test("scaleMmPerPtToRatioString: the A-102's exact 1:100 stays the round 1:100; calibrated values keep 4 decimals", () => {
    expect(scaleMmPerPtToRatioString(1270 / 36)).toBe("1:100")
    // 3.6 mm/pt → 3.6 × 72/25.4 = 10.2047… (a ~1:10 detail-sheet scale)
    expect(scaleMmPerPtToRatioString(3.6)).toBe("1:10.2047")
  })

  test("validateComparePayload refuses malformed payloads with honest messages", () => {
    expect(() => validateComparePayload({})).toThrow(EngineUnavailableError)
    expect(() =>
      validateComparePayload({ sheetCountA: 1, sheetCountB: 1, comparedSheets: 1, summary: { changed: 0, unchanged: 1, onlyInA: 0, onlyInB: 0 }, sheets: "x" }),
    ).toThrow(EngineUnavailableError)
    expect(() =>
      validateComparePayload({
        sheetCountA: 1,
        sheetCountB: 1,
        comparedSheets: 1,
        summary: { changed: 0, unchanged: 1, onlyInA: 0, onlyInB: 0 },
        sheets: [{ page: 1, changedFraction: 0.1, changed: true, regions: [{ xPt: 0 }] }],
      }),
    ).toThrow(EngineUnavailableError)
  })

  test("validateFillPayload refuses uncalibrated/malformed results (the bridge always calibrates)", () => {
    expect(() => validateFillPayload({ value: 40, unit: "m2", calibrated: false, vertices: 8 })).toThrow(EngineUnavailableError)
    expect(() => validateFillPayload({ value: -1, unit: "m2", calibrated: true, vertices: 8 })).toThrow(EngineUnavailableError)
    expect(() => validateFillPayload({ value: 40, unit: "ft2", calibrated: true, vertices: 8 })).toThrow(EngineUnavailableError)
    expect(() => validateFillPayload({ value: 40, unit: "m2", calibrated: true, vertices: 2 })).toThrow(EngineUnavailableError)
  })

  test("fill_area refuses a missing/invalid scale BEFORE any subprocess spawn (the pinned verbatim message)", async () => {
    const err = await expectEngineUnavailable(
      pdf2takeoffFillRoom(A102, { at: [560, 460], scaleMmPerPt: 0 }) as Promise<unknown>,
    )
    expect(err.message).toBe(PDF2TAKEOFF_REFUSAL_NO_SCALE)
    const err2 = await expectEngineUnavailable(
      pdf2takeoffFillRoom(A102, { at: [560, 460], scaleMmPerPt: Number.NaN }) as Promise<unknown>,
    )
    expect(err2.message).toBe(PDF2TAKEOFF_REFUSAL_NO_SCALE)
  })

  test("annotate refuses a bad spec BEFORE any subprocess spawn", async () => {
    const err = await expectEngineUnavailable(pdf2takeoffAnnotateTakeoff(A102, { markups: [{ type: "area", points: [[0, 0]] }] }) as Promise<unknown>)
    expect(err.message).toContain("markups[0].points")
  })
})

describe.skipIf(!engineInstalled())("pdf2takeoff — real pinned-engine runs", () => {
  test(
    "resolvePdf2takeoffEngine reports the pinned commit, version and self-hash",
    async () => {
      const engine = await resolvePdf2takeoffEngine()
      expect(engine.engineKey).toBe("pdf2takeoff")
      expect(engine.pinnedCommit).toBe(PDF2TAKEOFF_PINNED_COMMIT)
      expect(engine.engineVersion).toBe("0.1.0")
      expect(engine.adapterScript).toBe("pdf2takeoff.ts")
      expect(engine.adapterHash).toMatch(/^[0-9a-f]{64}$/)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "compare: identical revisions → unchanged on every sheet; the vector diff agrees",
    async () => {
      const result = await pdf2takeoffCompareRevisions(A102, A102)
      expect(result.summary).toEqual({ changed: 0, unchanged: 4, onlyInA: 0, onlyInB: 0 })
      expect(result.changedSheets).toEqual([])
      for (const sheet of result.sheets) {
        expect(sheet.changed).toBe(false)
        expect(sheet.changedFraction).toBe(0)
        expect(sheet.vector?.identical).toBe(true)
      }
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "compare: a different sheet → changed with regions, and onlyInA counts the unmatched sheets",
    async () => {
      const result = await pdf2takeoffCompareRevisions(A102, CURVE)
      expect(result.sheetCountA).toBe(4)
      expect(result.sheetCountB).toBe(1)
      expect(result.comparedSheets).toBe(1)
      expect(result.summary.onlyInA).toBe(3)
      expect(result.changedSheets).toEqual([1])
      const sheet1 = result.sheets.find((s) => s.page === 1)
      expect(sheet1?.changed).toBe(true)
      expect(sheet1 && sheet1.changedFraction > 0).toBe(true)
      expect(sheet1 && sheet1.regions.length > 0).toBe(true)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "annotate → export round-trip: the A-102 closed forms come back from the engine (10 m bar, 40 m² room, 1 socket)",
    async () => {
      const annotated = await pdf2takeoffAnnotateTakeoff(A102, { markups: A102_SPEC })
      expect(annotated.markupCount).toBe(3)
      expect(annotated.kept).toBe(0)
      expect(annotated.pdfBytes.subarray(0, 5).toString("latin1")).toBe("%PDF-")
      // the annotated bytes go through a real file so export reads them back
      const tmpdir = mkdtempSync(path.join(os.tmpdir(), "eos-p2t-test-"))
      try {
        const pdfPath = path.join(tmpdir, "annotated.pdf")
        writeFileSync(pdfPath, annotated.pdfBytes)
        const csv = await pdf2takeoffExportTakeoff(pdfPath, { scaleRatio: "1:100", unit: "m", format: "csv" })
        const byLabel = new Map(csv.rows.map((r) => [r.label, r]))
        const bar = byLabel.get("Scale bar")
        const room = byLabel.get("Room 101")
        const socket = byLabel.get("Socket")
        expect(bar?.type).toBe("length")
        expect(bar?.unit).toBe("m")
        // 283.4646 pt × (25.4/72 ÷ 10) m/pt = 10.0000… m (the engine's 8-dp
        // metersPerPt for 1:100 = 0.03527778 — the pinned derivation)
        expect(typeof bar?.value === "number" && Math.abs((bar.value as number) - 10.000001166666667) < 1e-9).toBe(true)
        expect(room?.type).toBe("area")
        expect(typeof room?.value === "number" && Math.abs((room.value as number) - 40.00001783583051) < 1e-9).toBe(true)
        expect(socket?.value).toBe(1)
        expect(socket?.unit).toBe("each")
        // the XLSX twin is a real workbook (PK zip magic + non-trivial size)
        const xlsx = await pdf2takeoffExportTakeoff(pdfPath, { scaleRatio: "1:100", unit: "m", format: "xlsx" })
        expect(xlsx.xlsxBytes?.subarray(0, 2).toString("latin1")).toBe("PK")
        expect((xlsx.xlsxBytes?.byteLength ?? 0) > 3000).toBe(true)
      } finally {
        rmSync(tmpdir, { recursive: true, force: true })
      }
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "annotate is idempotent: re-annotating an already-annotated PDF REPLACES the markups (kept 0, same count)",
    async () => {
      const first = await pdf2takeoffAnnotateTakeoff(A102, { markups: A102_SPEC })
      const tmpdir = mkdtempSync(path.join(os.tmpdir(), "eos-p2t-test-"))
      try {
        const pdfPath = path.join(tmpdir, "annotated.pdf")
        writeFileSync(pdfPath, first.pdfBytes)
        const second = await pdf2takeoffAnnotateTakeoff(pdfPath, { markups: A102_SPEC })
        expect(second.markupCount).toBe(3)
        expect(second.kept).toBe(0)
      } finally {
        rmSync(tmpdir, { recursive: true, force: true })
      }
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "export refuses an unannotated PDF with the engine's honest message",
    async () => {
      const err = await expectEngineUnavailable(
        pdf2takeoffExportTakeoff(A102, { scaleRatio: "1:100", unit: "m", format: "csv" }) as Promise<unknown>,
      )
      expect(err.message).toContain("no pdf2takeoff annotations found")
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "fill_area: the A-102 room measures the analytic 8 × 5 m rectangle on the INNER wall faces",
    async () => {
      const result = await pdf2takeoffFillRoom(A102, {
        pageNo: 1,
        at: [560, 460],
        label: "Room 101",
        scaleMmPerPt: A102_SCALE_MM_PER_PT,
      })
      expect(result.unit).toBe("m2")
      expect(result.calibrated).toBe(true)
      expect(result.vertices).toBe(8)
      // the analytic room area is exactly 40 m²; the fill boundary runs on the
      // INNER faces of the 1-pt stroke → ~0.67 pt inset per side ≈ 39.4 m²
      // (documented engine behaviour; the harness pins 39.4009 ± 0.1)
      expect(Math.abs(result.value - 39.4009) < 0.1).toBe(true)
      expect(result.bbox?.[0]).toBeGreaterThan(499)
      expect(result.bbox?.[2]).toBeLessThan(727)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "fill_area: a click on a line is the engine's honest refusal, not a fabricated number",
    async () => {
      const err = await expectEngineUnavailable(
        pdf2takeoffFillRoom(A102, {
          pageNo: 1,
          at: [613, 470], // the interior wall's anchor zone — on a line
          scaleMmPerPt: A102_SCALE_MM_PER_PT,
        }) as Promise<unknown>,
      )
      expect(err.message).toContain("clicked on a line")
    },
    TEST_TIMEOUT_MS,
  )
})
