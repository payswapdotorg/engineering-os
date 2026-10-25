import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  EngineUnavailableError,
  SHEET_TAKEOFF_REFUSAL_NO_SCALE,
  parseSheetTakeoffAdapterStdout,
  resolveSheetTakeoffParams,
  sheetTakeoffFromStorage,
  type SheetTakeoffResult,
} from "./sheet_takeoff"

/**
 * Vector sheet-takeoff bridge tests (Lane 16-V, Slice 15 — pdfplumber).
 *
 * Honesty rules (ADR-0006 — the femesh.test.ts convention): the PURE tests
 * feed SYNTHETIC protocol strings into the bridge's parse/validate half and
 * pin the parameter policy — they test the BRIDGE, are labelled synthetic and
 * assert no engine values. Every number asserted in the REAL-engine tests is
 * a hand-derived closed form from the fixture builders (tests/fixtures/
 * build-sheet-pdf.ts + build-curve-pdf.ts — the analytic truth the fixtures
 * are drawn from), independent of the adapter.
 *
 * Real-engine tests run ONLY when the venv python and pdfplumber are
 * genuinely importable; otherwise they are skipped with an explicit printed
 * reason. A skipped test with a reason is honest; a fake result is not.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.resolve(here, "..", "..", "..", "tests", "fixtures")
const PYTHON_BIN = process.env.EOS_PYTHON ?? "/home/z/.venv/bin/python3"

const pythonRunnable = spawnSync(PYTHON_BIN, ["-c", "pass"], { timeout: 60_000 }).status === 0
const pdfplumberAvailable =
  pythonRunnable &&
  spawnSync(PYTHON_BIN, ["-c", "import pdfplumber"], { timeout: 60_000 }).status === 0

if (!pythonRunnable) {
  console.log(
    `[sheet_takeoff.test.ts] sheet-takeoff tests SKIPPED: python interpreter not runnable at ${PYTHON_BIN} (recorded honestly — no results are simulated)`,
  )
} else if (!pdfplumberAvailable) {
  console.log(
    `[sheet_takeoff.test.ts] real-engine sheet-takeoff tests SKIPPED: pdfplumber is not importable in ${PYTHON_BIN} (install tests/validation/engines-requirements.txt into the engine venv) — recorded honestly, no results are simulated`,
  )
}

const TEST_TIMEOUT_MS = 120_000

function sha256Of(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex")
}

/** The research-verified A-102 fixture scale: 1:100 on A3 → 2540/72 mm/pt. */
const A102_SCALE_MM_PER_PT = 1270 / 36

/** Analytic quarter-arc length of the curve fixture: 100 * pi/2 pt. */
const QUARTER_ARC_PT = (Math.PI / 2) * 100

function expectEngineUnavailable(promise: Promise<unknown>): Promise<EngineUnavailableError> {
  return promise.then(
    () => {
      throw new Error("expected the bridge to throw EngineUnavailableError")
    },
    (err: unknown) => {
      expect(err).toBeInstanceOf(EngineUnavailableError)
      return err as EngineUnavailableError
    },
  )
}

/** Synthetic success stdout in the pinned adapter protocol (no engine). */
function syntheticSheetTakeoffStdout(): string {
  return JSON.stringify({
    engineKey: "pdfplumber",
    engineVersion: "9.9.9",
    adapterScript: "sheet_takeoff.py",
    adapterHash: "b".repeat(64),
    pageCount: 3,
    pageNo: 2,
    scaleMmPerPt: 2.5,
    flattenSegments: 16,
    page: { widthPt: 1191, heightPt: 842 },
    entities: {
      lines: { count: 1, totalLengthMm: 10 },
      rects: { count: 1, totalPerimeterMm: 20, totalAreaMm2: 30 },
      curves: { count: 1, totalLengthMm: 40, totalClosedAreaMm2: 50 },
    },
    items: [],
    text: [],
  })
}

/**
 * The byte-determinism signature: the adapter's RESULT payload (what the
 * harness/broker compares across double runs). Subprocess stderr is
 * execution-record evidence, not payload.
 */
function sheetTakeoffSignature(r: SheetTakeoffResult): string {
  return JSON.stringify({
    engineKey: r.engineKey,
    engineVersion: r.engineVersion,
    adapterScript: r.adapterScript,
    adapterHash: r.adapterHash,
    pageCount: r.pageCount,
    pageNo: r.pageNo,
    scaleMmPerPt: r.scaleMmPerPt,
    flattenSegments: r.flattenSegments,
    page: r.page,
    entities: r.entities,
    items: r.items,
    text: r.text,
  })
}

// ---------------------------------------------------------------------------
// Pure half of the bridge: parameter policy + protocol parsing (synthetic —
// no engine)
// ---------------------------------------------------------------------------

describe("sheet-takeoff bridge pure half (synthetic — no engine)", () => {
  test("resolveSheetTakeoffParams: scale-only object → the pinned defaults (pageNo 1, flattenSegments 32)", () => {
    expect(resolveSheetTakeoffParams({ scaleMmPerPt: 1 })).toEqual({ pageNo: 1, scaleMmPerPt: 1, flattenSegments: 32 })
    expect(resolveSheetTakeoffParams({ scaleMmPerPt: 0.352777 })).toEqual({
      pageNo: 1,
      scaleMmPerPt: 0.352777,
      flattenSegments: 32,
    })
  })

  test("resolveSheetTakeoffParams: explicit values pass through", () => {
    expect(resolveSheetTakeoffParams({ pageNo: 2, scaleMmPerPt: 35.27777777777778, flattenSegments: 64 })).toEqual({
      pageNo: 2,
      scaleMmPerPt: 35.27777777777778,
      flattenSegments: 64,
    })
  })

  test("resolveSheetTakeoffParams: missing/zero/negative/NaN scale → the pinned VERBATIM no-scale refusal", () => {
    for (const bad of [{}, { scaleMmPerPt: 0 }, { scaleMmPerPt: -1 }, { scaleMmPerPt: Number.NaN }, { scaleMmPerPt: "30" }, { scaleMmPerPt: null }]) {
      let caught: unknown
      try {
        resolveSheetTakeoffParams(bad as Record<string, unknown>)
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(EngineUnavailableError)
      expect((caught as Error).message).toBe(SHEET_TAKEOFF_REFUSAL_NO_SCALE)
    }
  })

  test("resolveSheetTakeoffParams: pageNo must be an integer >= 1 — refused, never clamped", () => {
    for (const bad of [0, -1, 1.5, "2", null]) {
      let caught: unknown
      try {
        resolveSheetTakeoffParams({ pageNo: bad, scaleMmPerPt: 1 } as Record<string, unknown>)
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(EngineUnavailableError)
      expect((caught as Error).message).toContain("parameters.pageNo must be an integer >= 1")
    }
  })

  test("resolveSheetTakeoffParams: flattenSegments is clamped into 4..256 (truncation toward zero), non-finite refused", () => {
    expect(resolveSheetTakeoffParams({ scaleMmPerPt: 1, flattenSegments: 2 }).flattenSegments).toBe(4)
    expect(resolveSheetTakeoffParams({ scaleMmPerPt: 1, flattenSegments: -5 }).flattenSegments).toBe(4)
    expect(resolveSheetTakeoffParams({ scaleMmPerPt: 1, flattenSegments: 1000 }).flattenSegments).toBe(256)
    expect(resolveSheetTakeoffParams({ scaleMmPerPt: 1, flattenSegments: 32.9 }).flattenSegments).toBe(32)
    expect(resolveSheetTakeoffParams({ scaleMmPerPt: 1, flattenSegments: 4 }).flattenSegments).toBe(4)
    expect(resolveSheetTakeoffParams({ scaleMmPerPt: 1, flattenSegments: 256 }).flattenSegments).toBe(256)
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, "32", null]) {
      let caught: unknown
      try {
        resolveSheetTakeoffParams({ scaleMmPerPt: 1, flattenSegments: bad } as Record<string, unknown>)
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(EngineUnavailableError)
      expect((caught as Error).message).toContain("flattenSegments must be a finite number")
    }
  })

  test("sheetTakeoffFromStorage refuses a missing scale BEFORE any subprocess spawn (the pinned verbatim message)", async () => {
    const err = await expectEngineUnavailable(sheetTakeoffFromStorage("/nonexistent/anything", {}))
    expect(err.message).toBe(SHEET_TAKEOFF_REFUSAL_NO_SCALE)
  })

  test("parseSheetTakeoffAdapterStdout accepts a well-formed payload and returns the SheetTakeoffResult", () => {
    const result = parseSheetTakeoffAdapterStdout(syntheticSheetTakeoffStdout(), "sheet_takeoff.py")
    expect(result.engineKey).toBe("pdfplumber")
    expect(result.engineVersion).toBe("9.9.9")
    expect(result.adapterScript).toBe("sheet_takeoff.py")
    expect(result.adapterHash).toBe("b".repeat(64))
    expect(result.pageCount).toBe(3)
    expect(result.pageNo).toBe(2)
    expect(result.scaleMmPerPt).toBe(2.5)
    expect(result.flattenSegments).toBe(16)
    expect(result.page).toEqual({ widthPt: 1191, heightPt: 842 })
    expect(result.entities.rects.totalAreaMm2).toBe(30)
  })

  test('error envelope {"error": …} surfaces verbatim as EngineUnavailableError', () => {
    expect(() =>
      parseSheetTakeoffAdapterStdout(
        JSON.stringify({ error: "this sheet page has no vector path operators" }),
        "sheet_takeoff.py",
      ),
    ).toThrow("this sheet page has no vector path operators")
  })

  test("payload validation refuses missing/malformed fields with honest messages (incl. wrong engineKey)", () => {
    for (const [mutate, expected] of [
      [(p: Record<string, unknown>) => delete p.pageCount, "missing pageCount"],
      [(p: Record<string, unknown>) => (p.pageNo = 0), "missing pageNo"],
      [(p: Record<string, unknown>) => (p.scaleMmPerPt = -1), "positive scaleMmPerPt"],
      [(p: Record<string, unknown>) => (p.flattenSegments = 3), "flattenSegments (integer in 4..256)"],
      [(p: Record<string, unknown>) => delete p.page, "missing page {widthPt, heightPt}"],
      [(p: Record<string, unknown>) => delete p.entities, "missing the entities object"],
      [(p: Record<string, unknown>) => (p.entities = { lines: {} }), "entities.lines {count, totalLengthMm}"],
      [(p: Record<string, unknown>) => (p.items = {}), "items must be an array capped at 400"],
      [(p: Record<string, unknown>) => (p.text = new Array(201).fill({})), "text must be an array capped at 200"],
      [(p: Record<string, unknown>) => (p.engineKey = "not-pdfplumber"), 'expected "pdfplumber"'],
    ] as const) {
      const payload = JSON.parse(syntheticSheetTakeoffStdout()) as Record<string, unknown>
      mutate(payload)
      let caught: unknown
      try {
        parseSheetTakeoffAdapterStdout(JSON.stringify(payload), "sheet_takeoff.py")
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(EngineUnavailableError)
      expect((caught as Error).message).toContain(expected)
    }
  })

  test("export surface: sheetTakeoffFromStorage / EngineUnavailableError exist with the pinned shapes", () => {
    expect(typeof sheetTakeoffFromStorage).toBe("function")
    const err = new EngineUnavailableError("probe")
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe("EngineUnavailableError")
    expect(err.message).toBe("probe")
  })
})

// ---------------------------------------------------------------------------
// Real engine runs (skipIf pdfplumber is absent, with a printed reason)
// ---------------------------------------------------------------------------

describe.skipIf(!pdfplumberAvailable)("sheetTakeoffFromStorage — real pdfplumber runs", () => {
  test(
    "sheet-curve-arc.pdf @ scale 1.0: ONE curve whose flattened length matches the analytic quarter arc (rel 1e-3), ONE exact 160/1500 rect, zero text",
    async () => {
      const result = await sheetTakeoffFromStorage(path.join(fixtures, "sheet-curve-arc.pdf"), {
        scaleMmPerPt: 1.0,
        flattenSegments: 32,
      })
      expect(result.engineKey).toBe("pdfplumber")
      expect(result.engineVersion).toMatch(/^[0-9]/) // real version, e.g. 0.11.10
      expect(result.adapterScript).toBe("sheet_takeoff.py")
      // adapterHash is SELF-reported — verify it independently (node:crypto)
      expect(result.adapterHash).toBe(sha256Of(path.join(here, "sheet_takeoff.py")))

      // build-curve-pdf.ts truth: one A3 page, one kappa bezier + one rect, NO text
      expect(result.pageCount).toBe(1)
      expect(result.page).toEqual({ widthPt: 1191, heightPt: 842 })
      expect(result.entities.lines.count).toBe(0)
      expect(result.entities.rects.count).toBe(1)
      expect(result.entities.curves.count).toBe(1)
      expect(result.text).toEqual([])

      // rect: `10 10 50 30 re S` — perimeter 160 pt, area 1500 pt², EXACT at scale 1
      expect(result.entities.rects.totalPerimeterMm).toBeCloseTo(160, 9)
      expect(result.entities.rects.totalAreaMm2).toBeCloseTo(1500, 9)

      // curve: analytic quarter-arc 100*pi/2 = 157.0796327 pt; the kappa
      // bezier + N=32 flattening reads ~157.0859 (rel +4.0e-5, research 16-R1)
      const relErr = Math.abs(result.entities.curves.totalLengthMm - QUARTER_ARC_PT) / QUARTER_ARC_PT
      expect(relErr).toBeLessThanOrEqual(1e-3)

      // the curve item carries the FULL flattened polyline (32 segments → 33
      // points — the naive-endpoints regression would give 2) and, being open,
      // NO closedAreaMm2 key
      const curve = result.items.find((i) => (i as { type: string }).type === "curve") as
        | { pts: number[][]; closedAreaMm2?: number }
        | undefined
      expect(curve).toBeDefined()
      expect(curve!.pts).toHaveLength(33)
      expect(curve!.pts[0]).toEqual([100, 100])
      expect(curve!.closedAreaMm2).toBeUndefined()
      expect(result.entities.curves.totalClosedAreaMm2).toBe(0)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "determinism: two sheet-curve-arc runs → byte-identical result payloads (fixed-rate flattening, no clock/random)",
    async () => {
      const first = await sheetTakeoffFromStorage(path.join(fixtures, "sheet-curve-arc.pdf"), {
        scaleMmPerPt: 1.0,
        flattenSegments: 32,
      })
      const second = await sheetTakeoffFromStorage(path.join(fixtures, "sheet-curve-arc.pdf"), {
        scaleMmPerPt: 1.0,
        flattenSegments: 32,
      })
      expect(sheetTakeoffSignature(second)).toBe(sheetTakeoffSignature(first))
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "sheet-a102-plan.pdf page 1 @ 1270/36 mm/pt: the pinned 5-line/2-rect vector plan — bar 10000 mm, wall 3000 mm, room 26000 mm / 40e6 mm² (rel 1e-5), title text present",
    async () => {
      const result = await sheetTakeoffFromStorage(path.join(fixtures, "sheet-a102-plan.pdf"), {
        pageNo: 1,
        scaleMmPerPt: A102_SCALE_MM_PER_PT,
      })
      // build-sheet-pdf.ts truth: page 1 draws border rect + room rect, bar +
      // 2 end ticks + mid tick + wall lines
      expect(result.pageCount).toBe(2)
      expect(result.entities.lines.count).toBe(5)
      expect(result.entities.rects.count).toBe(2)
      expect(result.entities.curves.count).toBe(0)
      expect(result.page).toEqual({ widthPt: 1191, heightPt: 842 })

      // items locate the pinned ops: the scale bar from (60,120) → 283.4646 pt
      // drawn = 100 paper-mm = 10000.000 mm real @1:100 (fmt rounding → +1.2e-6 rel)
      const items = result.items as Array<Record<string, unknown>>
      const lengthMmAt = (x: number, y: number): number =>
        (items.find(
          (i) => i.type === "line" && (i.pts as number[][])[0][0] === x && (i.pts as number[][])[0][1] === y,
        ) as { lengthMm: number }).lengthMm
      const rectAt = (x: number, y: number): { perimeterMm: number; areaMm2: number } =>
        items.find(
          (i) => i.type === "rect" && (i.pts as number[][])[0][0] === x && (i.pts as number[][])[0][1] === y,
        ) as { perimeterMm: number; areaMm2: number }

      expect(Math.abs(lengthMmAt(60, 120) - 10000) / 10000).toBeLessThanOrEqual(1e-5)
      expect(Math.abs(lengthMmAt(613.3858, 400) - 3000) / 3000).toBeLessThanOrEqual(1e-5)
      const room = rectAt(500, 400)
      expect(Math.abs(room.perimeterMm - 26000) / 26000).toBeLessThanOrEqual(1e-5)
      expect(Math.abs(room.areaMm2 - 40000000) / 40000000).toBeLessThanOrEqual(1e-5)

      // vector text rows include the pinned title (16-R1(c): no OCR needed)
      const text = result.text as Array<{ str: string }>
      expect(
        text.some((t) => t.str.toLowerCase().includes("eos demo sheet a-102")),
      ).toBe(true)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "sheet-a102-plan.pdf page 2: 13 rects (border + 6×2 symbol squares — the Slice-13 field) with the builder-truth areas",
    async () => {
      const result = await sheetTakeoffFromStorage(path.join(fixtures, "sheet-a102-plan.pdf"), {
        pageNo: 2,
        scaleMmPerPt: A102_SCALE_MM_PER_PT,
      })
      // builder truth: page 2 draws the shared border rect + 6 outer 10 pt
      // stroked squares + 6 inner 4 pt filled squares; bar + 3 tick lines
      expect(result.entities.rects.count).toBe(13)
      expect(result.entities.lines.count).toBe(4)
      // total rect area = border 1143*794 + 6*100 + 6*16 pt², scaled by s²
      const s = A102_SCALE_MM_PER_PT
      const expectedAreaMm2 = (1143 * 794 + 6 * 100 + 6 * 16) * s * s
      expect(Math.abs(result.entities.rects.totalAreaMm2 - expectedAreaMm2) / expectedAreaMm2)
        .toBeLessThanOrEqual(1e-9)
      // one outer (10 pt) and one inner (4 pt) symbol square located by anchor
      const items = result.items as Array<Record<string, unknown>>
      const outer = items.find(
        (i) => i.type === "rect" && (i.pts as number[][])[0][0] === 200 && (i.pts as number[][])[0][1] === 500,
      ) as { areaMm2: number; stroke: boolean; fill: boolean }
      const inner = items.find(
        (i) => i.type === "rect" && (i.pts as number[][])[0][0] === 203 && (i.pts as number[][])[0][1] === 503,
      ) as { areaMm2: number; stroke: boolean; fill: boolean }
      expect(Math.abs(outer.areaMm2 - 100 * s * s) / (100 * s * s)).toBeLessThanOrEqual(1e-9)
      expect(outer.stroke).toBe(true)
      expect(outer.fill).toBe(false)
      expect(Math.abs(inner.areaMm2 - 16 * s * s) / (16 * s * s)).toBeLessThanOrEqual(1e-9)
      expect(inner.stroke).toBe(false)
      expect(inner.fill).toBe(true)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "sheet-scan-like.pdf (text-only page) → the pinned VERBATIM raster refusal",
    async () => {
      const err = await expectEngineUnavailable(
        sheetTakeoffFromStorage(path.join(fixtures, "sheet-scan-like.pdf"), { scaleMmPerPt: 1.0 }),
      )
      expect(err.message).toBe(
        "this sheet page has no vector path operators — it is a scan or raster-only page; " +
          "vector takeoff is not available for it, and simulated geometry is not an option",
      )
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "pageNo outside the document → the pinned range refusal; corrupt PDF → pdfminer's own error verbatim",
    async () => {
      const err = await expectEngineUnavailable(
        sheetTakeoffFromStorage(path.join(fixtures, "sheet-scan-like.pdf"), {
          pageNo: 9,
          scaleMmPerPt: 1.0,
        }),
      )
      expect(err.message).toBe("pageNo 9 is outside this document (1..1)")

      const tmp = mkdtempSync(path.join(os.tmpdir(), "eos-sheet-takeoff-test-"))
      try {
        const corrupt = path.join(tmp, "corrupt.pdf")
        writeFileSync(corrupt, "this is not a pdf at all\n")
        const err2 = await expectEngineUnavailable(sheetTakeoffFromStorage(corrupt, { scaleMmPerPt: 1.0 }))
        expect(err2.message).toContain("PDFSyntaxError")
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
    TEST_TIMEOUT_MS,
  )
})
