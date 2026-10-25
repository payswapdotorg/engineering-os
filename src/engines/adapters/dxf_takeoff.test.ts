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
  dxfTakeoffFromStorage,
  parseDxfTakeoffAdapterStdout,
  resolveDxfTakeoffParams,
  type DxfTakeoffResult,
} from "./dxf_takeoff"

/**
 * DXF takeoff bridge tests (Lane 16-V, Slice 15 — ezdxf).
 *
 * Honesty rules (ADR-0006 — the femesh.test.ts convention): the PURE tests
 * feed SYNTHETIC protocol strings into the bridge's parse/validate half and
 * pin the layerFilter policy — they test the BRIDGE, are labelled synthetic
 * and assert no engine values. Every number asserted in the REAL-engine
 * tests is a hand-derived closed form from the fixture generator
 * (src/engines/adapters/make_fixture_takeoff_room.py — the analytic block in
 * its docstring), independent of the adapter.
 *
 * Real-engine tests run ONLY when the venv python and ezdxf are genuinely
 * importable; otherwise they are skipped with an explicit printed reason.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.resolve(here, "..", "..", "..", "tests", "fixtures")
const PYTHON_BIN = process.env.EOS_PYTHON ?? "/home/z/.venv/bin/python3"

const pythonRunnable = spawnSync(PYTHON_BIN, ["-c", "pass"], { timeout: 60_000 }).status === 0
const ezdxfAvailable =
  pythonRunnable &&
  spawnSync(PYTHON_BIN, ["-c", "import ezdxf"], { timeout: 60_000 }).status === 0

if (!pythonRunnable) {
  console.log(
    `[dxf_takeoff.test.ts] DXF-takeoff tests SKIPPED: python interpreter not runnable at ${PYTHON_BIN} (recorded honestly — no results are simulated)`,
  )
} else if (!ezdxfAvailable) {
  console.log(
    `[dxf_takeoff.test.ts] real-engine DXF-takeoff tests SKIPPED: ezdxf is not importable in ${PYTHON_BIN} (install tests/validation/engines-requirements.txt into the engine venv) — recorded honestly, no results are simulated`,
  )
}

const TEST_TIMEOUT_MS = 120_000

function sha256Of(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex")
}

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
function syntheticDxfTakeoffStdout(): string {
  return JSON.stringify({
    engineKey: "ezdxf",
    engineVersion: "9.9.9",
    adapterScript: "dxf_takeoff.py",
    adapterHash: "c".repeat(64),
    unitsMm: true,
    layerCount: 2,
    entityCount: 3,
    layers: [
      {
        name: "A-LAYER",
        counts: { lines: 1, polylines: 0, arcs: 0, circles: 0, others: 0 },
        totalLengthMm: 100,
        totalClosedAreaMm2: 0,
      },
      {
        name: "B-LAYER",
        counts: { lines: 0, polylines: 1, arcs: 0, circles: 0, others: 1 },
        totalLengthMm: 200,
        totalClosedAreaMm2: 300,
      },
    ],
  })
}

/** The byte-determinism signature (the payload the harness double-run compares). */
function dxfTakeoffSignature(r: DxfTakeoffResult): string {
  return JSON.stringify({
    engineKey: r.engineKey,
    engineVersion: r.engineVersion,
    adapterScript: r.adapterScript,
    adapterHash: r.adapterHash,
    unitsMm: r.unitsMm,
    layerCount: r.layerCount,
    entityCount: r.entityCount,
    layers: r.layers,
  })
}

// ---------------------------------------------------------------------------
// Pure half of the bridge: layerFilter policy + protocol parsing (synthetic —
// no engine)
// ---------------------------------------------------------------------------

describe("dxf-takeoff bridge pure half (synthetic — no engine)", () => {
  test("resolveDxfTakeoffParams: absent / null / [] → all layers ({}); valid filter passes deduped + sorted", () => {
    expect(resolveDxfTakeoffParams({})).toEqual({})
    expect(resolveDxfTakeoffParams({ layerFilter: null })).toEqual({})
    expect(resolveDxfTakeoffParams({ layerFilter: [] })).toEqual({})
    expect(resolveDxfTakeoffParams({ layerFilter: ["WALLS"] })).toEqual({ layerFilter: ["WALLS"] })
    expect(resolveDxfTakeoffParams({ layerFilter: ["DIM", "WALLS", "DIM", "FURN"] })).toEqual({
      layerFilter: ["DIM", "FURN", "WALLS"],
    })
  })

  test("resolveDxfTakeoffParams: non-array / non-string / empty-string entries refused honestly", () => {
    for (const [bad, expected] of [
      [{ layerFilter: "WALLS" }, "must be an array of layer names"],
      [{ layerFilter: 42 }, "must be an array of layer names"],
      [{ layerFilter: ["WALLS", 1] }, "entries must be non-empty strings"],
      [{ layerFilter: [""] }, "entries must be non-empty strings"],
      [{ layerFilter: [null] }, "entries must be non-empty strings"],
    ] as const) {
      let caught: unknown
      try {
        resolveDxfTakeoffParams(bad as Record<string, unknown>)
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(EngineUnavailableError)
      expect((caught as Error).message).toContain(expected)
    }
  })

  test("parseDxfTakeoffAdapterStdout accepts a well-formed payload and returns the DxfTakeoffResult", () => {
    const result = parseDxfTakeoffAdapterStdout(syntheticDxfTakeoffStdout(), "dxf_takeoff.py")
    expect(result.engineKey).toBe("ezdxf")
    expect(result.engineVersion).toBe("9.9.9")
    expect(result.adapterScript).toBe("dxf_takeoff.py")
    expect(result.adapterHash).toBe("c".repeat(64))
    expect(result.unitsMm).toBe(true)
    expect(result.layerCount).toBe(2)
    expect(result.entityCount).toBe(3)
    expect(result.layers).toHaveLength(2)
    expect(result.layers[1].counts.others).toBe(1)
    expect(result.layers[1].totalClosedAreaMm2).toBe(300)
  })

  test('error envelope {"error": …} surfaces verbatim as EngineUnavailableError', () => {
    expect(() =>
      parseDxfTakeoffAdapterStdout(
        JSON.stringify({ error: "this drawing does not declare millimetre units ($INSUNITS=1)" }),
        "dxf_takeoff.py",
      ),
    ).toThrow("this drawing does not declare millimetre units ($INSUNITS=1)")
  })

  test("payload validation refuses missing/malformed fields with honest messages", () => {
    for (const [mutate, expected] of [
      [(p: Record<string, unknown>) => delete p.unitsMm, "missing unitsMm: true"],
      [(p: Record<string, unknown>) => (p.layerCount = 0), "missing layerCount (positive integer"],
      [(p: Record<string, unknown>) => (p.entityCount = -1), "missing entityCount (integer >= 0)"],
      [(p: Record<string, unknown>) => (p.layers = []), "missing the layers array (length must equal layerCount)"],
      [(p: Record<string, unknown>) => (((p.layers as unknown[])[0] as Record<string, unknown>).name = ""), "layers[0] has no name"],
      [(p: Record<string, unknown>) => (((p.layers as unknown[])[1] as Record<string, unknown>).name = "A-LAYER"), "sorted by name ascending"],
      [(p: Record<string, unknown>) => (((p.layers as unknown[])[0] as Record<string, unknown>).counts = {}), "counts.lines must be a non-negative integer"],
      [(p: Record<string, unknown>) => (((p.layers as unknown[])[0] as Record<string, unknown>).totalLengthMm = -5), "totalLengthMm must be a non-negative finite number"],
      [(p: Record<string, unknown>) => (((p.layers as unknown[])[0] as Record<string, unknown>).totalClosedAreaMm2 = Number.NaN), "totalClosedAreaMm2 must be a non-negative finite number"],
      [(p: Record<string, unknown>) => (p.engineKey = "not-ezdxf"), 'expected "ezdxf"'],
    ] as const) {
      const payload = JSON.parse(syntheticDxfTakeoffStdout()) as Record<string, unknown>
      mutate(payload)
      let caught: unknown
      try {
        parseDxfTakeoffAdapterStdout(JSON.stringify(payload), "dxf_takeoff.py")
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(EngineUnavailableError)
      expect((caught as Error).message).toContain(expected)
    }
  })

  test("export surface: dxfTakeoffFromStorage / EngineUnavailableError exist with the pinned shapes", () => {
    expect(typeof dxfTakeoffFromStorage).toBe("function")
    const err = new EngineUnavailableError("probe")
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe("EngineUnavailableError")
  })
})

// ---------------------------------------------------------------------------
// Real engine runs (skipIf ezdxf is absent, with a printed reason)
// ---------------------------------------------------------------------------

describe.skipIf(!ezdxfAvailable)("dxfTakeoffFromStorage — real ezdxf runs", () => {
  test(
    "takeoff-room.dxf: the analytic fixture — WALLS 14000 mm / 12e6 mm², DIM 2000+900π/2 mm (EXACT arc), FURN 2π·100 mm, all at rel 1e-9",
    async () => {
      const result = await dxfTakeoffFromStorage(path.join(fixtures, "takeoff-room.dxf"), {})
      expect(result.engineKey).toBe("ezdxf")
      expect(result.engineVersion).toMatch(/^[0-9]/) // real version, e.g. 1.4.5
      expect(result.adapterScript).toBe("dxf_takeoff.py")
      // adapterHash is SELF-reported — verify it independently (node:crypto)
      expect(result.adapterHash).toBe(sha256Of(path.join(here, "dxf_takeoff.py")))

      // make_fixture_takeoff_room.py truth: 3 layers, 4 entities, $INSUNITS=4
      expect(result.unitsMm).toBe(true)
      expect(result.layerCount).toBe(3)
      expect(result.entityCount).toBe(4)
      expect(result.layers.map((l) => l.name)).toEqual(["DIM", "FURN", "WALLS"])

      const walls = result.layers.find((l) => l.name === "WALLS")!
      expect(walls.counts).toEqual({ lines: 0, polylines: 1, arcs: 0, circles: 0, others: 0 })
      expect(Math.abs(walls.totalLengthMm - 14000) / 14000).toBeLessThanOrEqual(1e-9)
      expect(Math.abs(walls.totalClosedAreaMm2 - 12000000) / 12000000).toBeLessThanOrEqual(1e-9)

      // EXACT closed forms: the DXF stores full doubles and the adapter
      // computes r*theta / 2*pi*r directly — no flattening anywhere
      const dim = result.layers.find((l) => l.name === "DIM")!
      expect(dim.counts).toEqual({ lines: 1, polylines: 0, arcs: 1, circles: 0, others: 0 })
      const dimAnalytic = 2000 + 900 * (Math.PI / 2)
      expect(Math.abs(dim.totalLengthMm - dimAnalytic) / dimAnalytic).toBeLessThanOrEqual(1e-9)
      expect(dim.totalClosedAreaMm2).toBe(0)

      const furn = result.layers.find((l) => l.name === "FURN")!
      expect(furn.counts).toEqual({ lines: 0, polylines: 0, arcs: 0, circles: 1, others: 0 })
      const circAnalytic = 2 * Math.PI * 100
      expect(Math.abs(furn.totalLengthMm - circAnalytic) / circAnalytic).toBeLessThanOrEqual(1e-9)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "determinism: two takeoff-room.dxf runs → byte-identical result payloads",
    async () => {
      const first = await dxfTakeoffFromStorage(path.join(fixtures, "takeoff-room.dxf"), {})
      const second = await dxfTakeoffFromStorage(path.join(fixtures, "takeoff-room.dxf"), {})
      expect(dxfTakeoffSignature(second)).toBe(dxfTakeoffSignature(first))
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "layerFilter: WALLS+DIM (deduped/sorted by the bridge) → 2 layers / 3 entities; FURN excluded",
    async () => {
      const result = await dxfTakeoffFromStorage(path.join(fixtures, "takeoff-room.dxf"), {
        layerFilter: ["DIM", "WALLS", "WALLS"],
      })
      expect(result.layerCount).toBe(2)
      expect(result.entityCount).toBe(3)
      expect(result.layers.map((l) => l.name)).toEqual(["DIM", "WALLS"])
      expect(result.layers.some((l) => l.name === "FURN")).toBe(false)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "non-mm units / no supported entities / corrupt DXF → the pinned verbatim refusals",
    async () => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), "eos-dxf-takeoff-test-"))
      try {
        // hand-written minimal R12 DXF with one LINE but NO $INSUNITS
        // declaration (R12 predates it) — the adapter must refuse units,
        // never guess a conversion
        const unitless = path.join(tmp, "unitless.dxf")
        writeFileSync(
          unitless,
          [
            "0", "SECTION", "2", "HEADER",
            "9", "$ACADVER", "1", "AC1009",
            "0", "ENDSEC",
            "0", "SECTION", "2", "ENTITIES",
            "0", "LINE", "8", "TEST", "10", "0.0", "20", "0.0", "11", "100.0", "21", "0.0",
            "0", "ENDSEC",
            "0", "EOF",
            "",
          ].join("\n"),
        )
        const err = await expectEngineUnavailable(dxfTakeoffFromStorage(unitless, {}))
        expect(err.message).toBe(
          "this drawing does not declare millimetre units ($INSUNITS=0) — refusing to guess a unit conversion",
        )

        // garbage bytes — ezdxf's own refusal, verbatim (readfile raises
        // OSError for non-DXF content; the recover attempt only engages on
        // DXFStructureError, per the frozen adapter contract)
        const corrupt = path.join(tmp, "corrupt.dxf")
        writeFileSync(corrupt, "hello world\nnot a dxf\n")
        const err2 = await expectEngineUnavailable(dxfTakeoffFromStorage(corrupt, {}))
        expect(err2.message).toContain("is not a DXF file")

        // an empty-but-valid mm drawing — 0 supported entities, never zeros
        const empty = path.join(tmp, "empty.dxf")
        const { spawnSync: sp } = await import("node:child_process")
        const gen = sp(
          PYTHON_BIN,
          ["-c", "import ezdxf; ezdxf.options.write_fixed_meta_data_for_testing = True; d = ezdxf.new('R2010', units=4); d.saveas('" + empty + "')"],
          { timeout: 60_000 },
        )
        expect(gen.status).toBe(0)
        const err3 = await expectEngineUnavailable(dxfTakeoffFromStorage(empty, {}))
        expect(err3.message).toBe(
          "this drawing contains no supported entities (LINE/LWPOLYLINE/CIRCLE/ARC)",
        )
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
    TEST_TIMEOUT_MS,
  )
})
