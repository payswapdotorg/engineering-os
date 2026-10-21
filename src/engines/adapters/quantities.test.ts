import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  deriveFromFile,
  EngineUnavailableError,
  supportsDerive,
  type DeriveResult,
  type DerivedQuantity,
} from "./quantities"

/**
 * Quantity-derivation adapter tests (Worker 2 lane, W2-b).
 *
 * Honesty rules (ADR-0006): every number asserted below comes either from a
 * hand-written analytic closed form (independent of the adapter/engine code
 * path — derived in the comments from the fixture's parametric entities) or
 * from a value DECLARED inside the fixture file authored by the committed
 * generator. The adapter is never compared against itself.
 *
 * STEP (cadquery) and IFC (IfcOpenShell) tests run ONLY if the engine is
 * actually importable in the venv the bridge spawns; otherwise they are
 * skipped with an explicit printed reason (a skipped test with a reason is
 * honest; a fake result is a firing offense). Same guard as mesh.test.ts.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.resolve(here, "..", "..", "..", "tests", "fixtures")
const PYTHON_BIN = process.env.EOS_PYTHON ?? "/home/z/.venv/bin/python3"

// Real-availability probes (no mocks): the real-engine tests only run if the
// engine is genuinely importable in the venv the bridge spawns.
const stepAvailable =
  spawnSync(PYTHON_BIN, ["-c", "import cadquery"], { timeout: 20_000 }).status === 0
if (!stepAvailable) {
  console.log(
    `[quantities.test.ts] STEP adapter tests SKIPPED: cadquery is not importable in ${PYTHON_BIN} (recorded honestly — no results are simulated)`,
  )
}
const ifcAvailable =
  spawnSync(PYTHON_BIN, ["-c", "import ifcopenshell"], { timeout: 20_000 }).status === 0
if (!ifcAvailable) {
  // Explicit, printed skip reason — honest absence, not a failure or a fake.
  console.log(
    `[quantities.test.ts] IFC adapter tests SKIPPED: ifcopenshell is not importable in ${PYTHON_BIN} (recorded honestly — no results are simulated)`,
  )
}

const TEST_TIMEOUT_MS = 60_000

/** Assert |actual − expected| / expected ≤ 0.02 (the mandated 2% tolerance). */
function expectWithin2Pct(actual: number, expected: number, label: string): void {
  const rel = Math.abs(actual - expected) / Math.abs(expected)
  expect(rel).toBeLessThanOrEqual(0.02)
}

function sha256Of(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex")
}

function byQuantityName(result: DeriveResult): Map<string, DerivedQuantity> {
  return new Map(
    result.quantities.map((q) => [String((q.raw as Record<string, unknown>).quantityName), q]),
  )
}

describe("supportsDerive (extension → adapter-kind mapping)", () => {
  test("maps .step/.stp → step and .ifc → ifc, case-insensitively; everything else null", () => {
    expect(supportsDerive("artifacts/rev/bracket-solid.step")).toBe("step")
    expect(supportsDerive("artifacts/rev/BRACKET.STP")).toBe("step")
    expect(supportsDerive("artifacts/rev/wall.ifc")).toBe("ifc")
    expect(supportsDerive("artifacts/rev/wall.IFC")).toBe("ifc")
    expect(supportsDerive("artifacts/rev/plan.pdf")).toBeNull()
    expect(supportsDerive("artifacts/rev/model.ifcxml")).toBeNull()
    expect(supportsDerive("artifacts/rev/stepnotes.step.md")).toBeNull()
    expect(supportsDerive("")).toBeNull()
  })
})

describe.skipIf(!stepAvailable)("deriveFromFile — STEP via cadquery/OCCT (real engine run)", () => {
  test(
    "bracket-solid.step: engine values match hand-derived analytic closed forms (±2%)",
    async () => {
      const result = await deriveFromFile(path.join(fixtures, "bracket-solid.step"), "step")

      expect(result.engineKey).toBe("cadquery")
      expect(result.engineVersion).toMatch(/^[0-9]/) // real version string, e.g. 2.6.1
      expect(result.adapterScript).toBe("step_quantities.py")

      // adapterHash is SELF-reported by the adapter — verify it independently
      // against the actual script bytes (node:crypto, not the python path).
      expect(result.adapterHash).toBe(sha256Of(path.join(here, "step_quantities.py")))

      // ── ANALYTIC EXPECTATIONS (hand-derived, engine-independent) ──────────
      // Fixture geometry (see src/engines/adapters/make_fixture_bracket.py):
      //   L-profile in the XY plane extruded 30 mm in +Z:
      //     foot X 0..80 × Y 0..10, leg X 0..10 × Y 0..50  (all mm)
      //   two Ø8 (r = 4) through-holes at (30, 5) and (60, 5)
      //
      //   profile area   A = 80·10 + 10·50 − 10·10 = 1200 mm²
      //   volume         V = A·30 − 2·(π·4²·30) = 36000 − 960π mm³
      //   profile perimeter P = 2·(80 + 50) = 260 mm
      //     (an L-notch removes one horizontal run and adds one equal horizontal
      //      run, likewise vertically — perimeter equals that of the 80×50 box)
      //   surface area   S = 2·(A − 2·π·4²) + P·30 + 2·(2π·4·30)
      //                  = (2400 − 64π) + 7800 + 480π = 10200 + 416π mm²
      //   bbox diagonal  d = √(80² + 50² + 30²) = √9800 mm
      const expectedVolume = 36000 - 960 * Math.PI
      const expectedArea = 10200 + 416 * Math.PI
      const expectedDiagonal = Math.sqrt(9800)

      const volume = result.quantities.find((q) => q.quantityType === "volume")
      expect(volume).toBeDefined()
      expect(volume?.elementRef).toBe("step:solid:0")
      expect(volume?.unit).toBe("mm³") // fixture declares SI_UNIT(.MILLI.,.METRE.)
      expectWithin2Pct(volume?.value ?? 0, expectedVolume, "volume")

      const totalArea = result.quantities.find((q) => q.elementRef === "step:solids:all")
      expect(totalArea?.quantityType).toBe("area")
      expect(totalArea?.unit).toBe("mm²")
      expectWithin2Pct(totalArea?.value ?? 0, expectedArea, "total surface area")

      const bbox = result.quantities.find((q) => q.elementRef === "step:model:bbox")
      expect(bbox?.quantityType).toBe("length")
      expect(bbox?.unit).toBe("mm")
      expectWithin2Pct(bbox?.value ?? 0, expectedDiagonal, "bbox diagonal")

      // Single-solid fixture → exactly 3 entries (per-solid volume, total
      // area, bbox diagonal), all from the real engine, none invented.
      expect(result.quantities).toHaveLength(3)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "bracket.step (Phase-1 storage fixture: valid STEP text, zero solids) → honest EngineUnavailableError, never fabricated values",
    async () => {
      let caught: unknown
      try {
        await deriveFromFile(path.join(fixtures, "bracket.step"), "step")
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(EngineUnavailableError)
      const message = (caught as Error).message
      expect(message.toLowerCase()).toContain("no solid geometry")
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "nonexistent STEP path → honest EngineUnavailableError (adapter's own error envelope)",
    async () => {
      let caught: unknown
      try {
        await deriveFromFile(path.join(fixtures, "no-such-model.step"), "step")
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(EngineUnavailableError)
      expect((caught as Error).message.toLowerCase()).toContain("file not found")
    },
    TEST_TIMEOUT_MS,
  )
})

describe.skipIf(!ifcAvailable)("deriveFromFile — IFC via IfcOpenShell (real engine run)", () => {
  test(
    "wall-quantities.ifc: BaseQuantities are read back exactly as authored in the fixture",
    async () => {
      const result = await deriveFromFile(path.join(fixtures, "wall-quantities.ifc"), "ifc")

      expect(result.engineKey).toBe("ifcopenshell")
      expect(result.engineVersion).toMatch(/^[0-9]/) // e.g. 0.9.0.post1
      expect(result.adapterScript).toBe("ifc_quantities.py")
      expect(result.adapterHash).toBe(sha256Of(path.join(here, "ifc_quantities.py")))

      // ── AUTHORED EXPECTATIONS (hand-derived in make_fixture_wall.py and
      // written into the IFC file itself; the adapter must READ them back
      // unmodified — these are declared values, not computed approximations):
      //   Length = 3.0 m, Width = 0.2 m, Height = 2.0 m
      //   Gross/NetSideArea = 2·(3.0 + 0.2)·2.0 = 12.8 m²
      //   Gross/NetFootprintArea = 3.0·0.2 = 0.6 m²
      //   Gross/NetVolume = 3.0·0.2·2.0 = 1.2 m³
      //   WallTieCount = 2 (dimensionless count)
      const byName = byQuantityName(result)
      const expectNamed = (name: string, qtype: DerivedQuantity["quantityType"], value: number, unit: string) => {
        const q = byName.get(name)
        expect(q).toBeDefined()
        expect(q?.quantityType).toBe(qtype)
        expect(q?.value).toBeCloseTo(value, 10)
        expect(q?.unit).toBe(unit)
      }
      expectNamed("Length", "length", 3.0, "m")
      expectNamed("Width", "length", 0.2, "m")
      expectNamed("Height", "length", 2.0, "m")
      expectNamed("GrossSideArea", "area", 12.8, "m²")
      expectNamed("NetSideArea", "area", 12.8, "m²")
      expectNamed("GrossFootprintArea", "area", 0.6, "m²")
      expectNamed("NetVolume", "volume", 1.2, "m³")
      expectNamed("WallTieCount", "count", 2, "count")

      // elementRef contract: "#<GlobalId>" of the wall authored in the fixture.
      expect(result.quantities.every((q) => q.elementRef === "#2rUnE8CnPHBwLdZzIqZkf1")).toBe(true)

      // NetWeight (IfcQuantityWeight, 2880 kg) exists in the fixture but the
      // DerivedQuantity contract has no "weight" quantityType — the adapter
      // must SKIP it (recorded in raw), never relabel or approximate it.
      expect(byName.has("NetWeight")).toBe(false)
      const skipped = (result.quantities[0].raw as Record<string, unknown>)
        .skippedUnsupportedQuantities
      expect(JSON.stringify(skipped)).toContain("IfcQuantityWeight:NetWeight")
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "wall-geometry.ifc: geometric fallback (ifcopenshell.geom mesh) matches analytic box forms (±2%)",
    async () => {
      const result = await deriveFromFile(path.join(fixtures, "wall-geometry.ifc"), "ifc")

      // Same wall, no IfcElementQuantity → adapter falls back to real
      // ifcopenshell.geom triangulation. Hand-derived closed forms for the
      // 3.0 m × 0.2 m × 2.0 m box (mesh volume is exact for planar solids):
      //   volume V = 3.0 · 0.2 · 2.0 = 1.2 m³
      //   surface S = 2·(3·0.2) + 2·(3·2) + 2·(0.2·2) = 1.2 + 12 + 0.8 = 14.0 m²
      const volume = result.quantities.find(
        (q) => q.quantityType === "volume" && (q.raw as Record<string, unknown>).method === "mesh-triangulation",
      )
      const area = result.quantities.find(
        (q) => q.quantityType === "area" && (q.raw as Record<string, unknown>).method === "mesh-triangulation",
      )
      expect(volume).toBeDefined()
      expect(area).toBeDefined()
      expectWithin2Pct(volume?.value ?? 0, 1.2, "mesh volume")
      expectWithin2Pct(area?.value ?? 0, 14.0, "mesh surface area")
      expect(volume?.unit).toBe("m³")
      expect(area?.unit).toBe("m²")
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "wall-stripped.ifc (valid IFC, wall without geometry or quantities) → honest empty result",
    async () => {
      const result = await deriveFromFile(path.join(fixtures, "wall-stripped.ifc"), "ifc")
      expect(result.engineKey).toBe("ifcopenshell")
      expect(result.quantities).toEqual([])
    },
    TEST_TIMEOUT_MS,
  )
})
