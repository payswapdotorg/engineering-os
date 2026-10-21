import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  EngineUnavailableError,
  parseMeshAdapterStdout,
  tessellateFromFile,
  type MeshResult,
} from "./mesh"
import { deriveFromFile } from "./quantities"

/**
 * Mesh-bridge tests (Worker 2 lane, W2-d, Contracts A+B).
 *
 * Honesty rules (ADR-0006): the PURE tests below feed SYNTHETIC protocol
 * strings into the bridge's parse/validate half — they test the BRIDGE's
 * validation, are labelled synthetic, and assert no engine values. Every
 * number asserted in the REAL-engine tests comes from a hand-derived
 * closed form (independent of the adapters) or from a count pinned in the
 * committed corpus manifest. The adapter is never compared against itself.
 *
 * Real-engine tests run ONLY when the engine is genuinely importable in the
 * engine venv; otherwise they are skipped with an explicit printed reason
 * (a skipped test with a reason is honest; a fake result is a firing offense).
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.resolve(here, "..", "..", "..", "tests", "fixtures")
const PYTHON_BIN = process.env.EOS_PYTHON ?? "/home/z/.venv/bin/python3"

const stepAvailable =
  spawnSync(PYTHON_BIN, ["-c", "import cadquery"], { timeout: 60_000 }).status === 0
const ifcAvailable =
  spawnSync(PYTHON_BIN, ["-c", "import ifcopenshell"], { timeout: 20_000 }).status === 0
if (!stepAvailable) {
  console.log(
    `[mesh.test.ts] STEP mesh tests SKIPPED: cadquery is not importable in ${PYTHON_BIN} (recorded honestly — no results are simulated)`,
  )
}
if (!ifcAvailable) {
  console.log(
    `[mesh.test.ts] IFC mesh tests SKIPPED: ifcopenshell is not importable in ${PYTHON_BIN} (recorded honestly — no results are simulated)`,
  )
}

const TEST_TIMEOUT_MS = 120_000

function sha256Of(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex")
}

/** Synthetic success stdout in the pinned adapter protocol (no engine). */
function syntheticAdapterStdout(): string {
  return JSON.stringify({
    engineKey: "synthetic-engine",
    engineVersion: "1.2.3",
    adapterScript: "step_mesh.py",
    adapterHash: "a".repeat(64),
    mesh: {
      format: "eos-mesh/1",
      units: "m",
      upAxis: "z",
      tolerance: 0.0001,
      elements: [
        {
          elementRef: "step:solid:0",
          name: "Solid 1",
          vertices: [
            [0, 0, 0],
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
          ],
          triangles: [
            [0, 1, 2],
            [0, 1, 3],
          ],
        },
      ],
    },
  })
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

// ---------------------------------------------------------------------------
// Pure half of the bridge: protocol parsing + payload validation
// (synthetic protocol strings — no engine involvement)
// ---------------------------------------------------------------------------

describe("parseMeshAdapterStdout (pure protocol validation — synthetic stdout)", () => {
  test("accepts a well-formed adapter payload without generatedBy and returns the MeshResult", () => {
    const result = parseMeshAdapterStdout(syntheticAdapterStdout(), "step_mesh.py")
    expect(result.engineKey).toBe("synthetic-engine")
    expect(result.engineVersion).toBe("1.2.3")
    expect(result.adapterScript).toBe("step_mesh.py")
    expect(result.adapterHash).toBe("a".repeat(64))
    expect(result.mesh.format).toBe("eos-mesh/1")
    expect(result.mesh.units).toBe("m")
    expect(result.mesh.upAxis).toBe("z")
    expect(result.mesh.tolerance).toBe(0.0001)
    expect(result.mesh.elements).toHaveLength(1)
    // the parse half does NOT add generatedBy — only tessellateFromFile does
    expect(result.mesh.generatedBy).toBeUndefined()
    expect("generatedBy" in result.mesh).toBe(false)
  })

  test("error envelope: {\"error\": …} surfaces verbatim as EngineUnavailableError", () => {
    expect(() =>
      parseMeshAdapterStdout(JSON.stringify({ error: "no solid geometry found" }), "step_mesh.py"),
    ).toThrow("no solid geometry found")
  })

  test("invalid JSON / non-object stdout → honest errors", () => {
    let caught: unknown
    try {
      parseMeshAdapterStdout("OCCT chatter that is not JSON\n", "step_mesh.py")
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(EngineUnavailableError)
    expect((caught as Error).message).toContain("stdout is not valid JSON")

    caught = undefined
    try {
      parseMeshAdapterStdout("[1, 2, 3]", "step_mesh.py")
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(EngineUnavailableError)
    expect((caught as Error).message).toContain("non-object JSON payload")
  })

  test("envelope validation: missing engineKey / engineVersion / malformed adapterHash", () => {
    for (const [mutate, expected] of [
      [(p: Record<string, unknown>) => delete p.engineKey, "missing engineKey"],
      [(p: Record<string, unknown>) => delete p.engineVersion, "missing engineVersion"],
      [(p: Record<string, unknown>) => (p.adapterHash = "not-a-hash"), "malformed adapterHash"],
    ] as const) {
      const payload = JSON.parse(syntheticAdapterStdout()) as Record<string, unknown>
      mutate(payload)
      let caught: unknown
      try {
        parseMeshAdapterStdout(JSON.stringify(payload), "step_mesh.py")
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(EngineUnavailableError)
      expect((caught as Error).message).toContain(expected)
    }
  })

  test("payload validation: format/units/upAxis/tolerance invariants are enforced", () => {
    for (const [mutate, expected] of [
      [(m: Record<string, unknown>) => (m.format = "gltf/2.0"), 'mesh.format must be "eos-mesh/1"'],
      [(m: Record<string, unknown>) => (m.units = "mm"), 'mesh.units must be "m"'],
      [(m: Record<string, unknown>) => (m.upAxis = "x"), 'mesh.upAxis must be "z"|"y"'],
      [(m: Record<string, unknown>) => (m.tolerance = 0), "positive finite number"],
      [(m: Record<string, unknown>) => (m.tolerance = "0.0001"), "positive finite number"],
      [(m: Record<string, unknown>) => delete m.elements, "missing the elements array"],
    ] as const) {
      const payload = JSON.parse(syntheticAdapterStdout()) as { mesh: Record<string, unknown> }
      mutate(payload.mesh)
      let caught: unknown
      try {
        parseMeshAdapterStdout(JSON.stringify(payload), "step_mesh.py")
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(EngineUnavailableError)
      expect((caught as Error).message).toContain(expected)
    }
    // missing mesh object (payload-level mutation, not a mesh-field mutation)
    const payload = JSON.parse(syntheticAdapterStdout()) as Record<string, unknown>
    delete payload.mesh
    let caught: unknown
    try {
      parseMeshAdapterStdout(JSON.stringify(payload), "step_mesh.py")
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(EngineUnavailableError)
    expect((caught as Error).message).toContain("missing the mesh object")
  })

  test("payload validation: element/vertex/triangle structure is enforced (incl. out-of-range indices)", () => {
    for (const [mutate, expected] of [
      // element without elementRef
      [(e: Record<string, unknown>) => delete e.elementRef, "has no elementRef"],
      // vertex triple that is not [x, y, z] of finite numbers
      [(e: Record<string, unknown>) => (e.vertices = [[0, 0]]), "finite [x, y, z] triple"],
      [(e: Record<string, unknown>) => (e.vertices = [[0, 0, Number.NaN]]), "finite [x, y, z] triple"],
      // triangle with a non-integer / negative / out-of-range index
      [(e: Record<string, unknown>) => (e.triangles = [[0, 1, 2.5]]), "integer [i, j, k] triple"],
      [(e: Record<string, unknown>) => (e.triangles = [[0, 1, -1]]), "integer [i, j, k] triple"],
      [(e: Record<string, unknown>) => (e.triangles = [[0, 1, 99]]), "references vertex 99"],
      // missing name
      [(e: Record<string, unknown>) => delete e.name, "has no name"],
    ] as const) {
      const payload = JSON.parse(syntheticAdapterStdout())
      mutate(payload.mesh.elements[0])
      let caught: unknown
      try {
        parseMeshAdapterStdout(JSON.stringify(payload), "step_mesh.py")
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(EngineUnavailableError)
      expect((caught as Error).message).toContain(expected)
    }
  })

  test("protocol: the adapter must NOT emit generatedBy (the bridge adds it — Contract B)", () => {
    const payload = JSON.parse(syntheticAdapterStdout())
    payload.mesh.generatedBy = { engineKey: "x", engineVersion: "1", adapterScript: "y", adapterHash: "b".repeat(64) }
    let caught: unknown
    try {
      parseMeshAdapterStdout(JSON.stringify(payload), "step_mesh.py")
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(EngineUnavailableError)
    expect((caught as Error).message).toContain("must NOT emit generatedBy")
  })
})

// ---------------------------------------------------------------------------
// Real engine runs (skipIf the engine is absent, with a printed reason)
// ---------------------------------------------------------------------------

describe.skipIf(!stepAvailable)("tessellateFromFile — STEP via cadquery/OCCT (real engine run)", () => {
  test(
    "two-solids.step: eos-mesh/1 payload, pinned counts, mm→m conversion, analytic volume cross-check, byte-determinism",
    async () => {
      const result = await tessellateFromFile(path.join(fixtures, "two-solids.step"), "step")

      expect(result.engineKey).toBe("cadquery")
      expect(result.engineVersion).toMatch(/^[0-9]/) // real version string, e.g. 2.6.1
      expect(result.adapterScript).toBe("step_mesh.py")
      // adapterHash is SELF-reported — verify it independently (node:crypto)
      expect(result.adapterHash).toBe(sha256Of(path.join(here, "step_mesh.py")))

      const mesh = result.mesh
      expect(mesh.format).toBe("eos-mesh/1")
      expect(mesh.units).toBe("m")
      expect(mesh.upAxis).toBe("z")
      expect(mesh.tolerance).toBe(0.0001) // pinned linear deflection, metres
      expect(mesh.generatedBy).toEqual({
        engineKey: result.engineKey,
        engineVersion: result.engineVersion,
        adapterScript: result.adapterScript,
        adapterHash: result.adapterHash,
      })

      // ── ANALYTIC EXPECTATIONS (hand-derived, engine-independent) ──────────
      // Fixture (make_fixture_step_solids.py): box A 30×20×10 mm at the origin,
      // box B 15×15×40 mm at (100, 0, 0) — file declared in MILLIMETRES.
      // elementRefs MUST equal the quantity ledger's per-solid refs, in the
      // SAME enumeration order (cross-reference contract).
      expect(mesh.elements.map((e) => e.elementRef)).toEqual(["step:solid:0", "step:solid:1"])
      expect(mesh.elements.map((e) => e.name)).toEqual(["Solid 1", "Solid 2"])
      // an axis-aligned box tessellates to 6 faces × 4 nodes = 24 verts / 12 tris
      for (const el of mesh.elements) {
        expect(el.vertices).toHaveLength(24)
        expect(el.triangles).toHaveLength(12)
      }
      // mm→m conversion: box A spans x ∈ [0, 0.03], box B x ∈ [0.1, 0.115]
      const xs0 = mesh.elements[0].vertices.map((v) => v[0])
      expect(Math.max(...xs0)).toBeCloseTo(0.03, 15)
      const xs1 = mesh.elements[1].vertices.map((v) => v[0])
      expect(Math.min(...xs1)).toBeCloseTo(0.1, 15)
      expect(Math.max(...xs1)).toBeCloseTo(0.115, 15)
      // divergence-theorem volume vs closed forms (PLANAR → exact up to IEEE):
      //   V_A = 30·20·10 mm³ = 6×10⁻⁶ m³, V_B = 15·15·40 mm³ = 9×10⁻⁶ m³
      for (const [el, expectedM3] of [
        [mesh.elements[0], 6e-6],
        [mesh.elements[1], 9e-6],
      ] as const) {
        let vol = 0
        for (const [a, b, c] of el.triangles) {
          const p0 = el.vertices[a]
          const p1 = el.vertices[b]
          const p2 = el.vertices[c]
          vol +=
            (p0[0] * (p1[1] * p2[2] - p1[2] * p2[1]) -
              p0[1] * (p1[0] * p2[2] - p1[2] * p2[0]) +
              p0[2] * (p1[0] * p2[1] - p1[1] * p2[0])) /
            6
        }
        expect(Math.abs(Math.abs(vol) - expectedM3)).toBeLessThanOrEqual(1e-9 * Math.max(1, expectedM3))
      }

      // byte-determinism: two real runs produce identical mesh JSON
      const second = await tessellateFromFile(path.join(fixtures, "two-solids.step"), "step")
      expect(JSON.stringify(second.mesh)).toBe(JSON.stringify(mesh))
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "bracket.step (valid STEP, 0 solids) → honest EngineUnavailableError, never a fabricated mesh",
    async () => {
      const err = await expectEngineUnavailable(
        tessellateFromFile(path.join(fixtures, "bracket.step"), "step"),
      )
      expect(err.message.toLowerCase()).toContain("no solid geometry")
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "non-model file (site-notes.md) → honest EngineUnavailableError via the adapter's envelope",
    async () => {
      const err = await expectEngineUnavailable(
        tessellateFromFile(path.join(fixtures, "site-notes.md"), "step"),
      )
      expect(err.message).toContain("STEP import failed")
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "nonexistent STEP path → honest EngineUnavailableError (adapter's own error envelope)",
    async () => {
      const err = await expectEngineUnavailable(
        tessellateFromFile(path.join(fixtures, "no-such-model.step"), "step"),
      )
      expect(err.message.toLowerCase()).toContain("file not found")
    },
    TEST_TIMEOUT_MS,
  )
})

describe.skipIf(!ifcAvailable)("tessellateFromFile — IFC via ifcopenshell (real engine run)", () => {
  test(
    "two-elements.ifc: 3 elements, refs set-equal the QUANTITY ledger refs, metres, analytic volumes, byte-determinism",
    async () => {
      const result = await tessellateFromFile(path.join(fixtures, "two-elements.ifc"), "ifc")

      expect(result.engineKey).toBe("ifcopenshell")
      expect(result.engineVersion).toMatch(/^[0-9]/) // e.g. 0.9.0.post1
      expect(result.adapterScript).toBe("ifc_mesh.py")
      expect(result.adapterHash).toBe(sha256Of(path.join(here, "ifc_mesh.py")))

      const mesh = result.mesh
      expect(mesh.units).toBe("m")
      expect(mesh.upAxis).toBe("z")
      expect(mesh.tolerance).toBe(0.001) // default mesher-linear-deflection on the pinned wheel

      // ── ANALYTIC EXPECTATIONS (hand-derived from the fixture's entities) ──
      // 2 walls + 1 slab, authored in METRES (IFCSIUNIT LENGTHUNIT METRE):
      //   Wall A 4.0 × 0.25 × 2.8 → 8 verts / 12 tris / V = 2.8 m³
      //   Wall B 2.0 × 0.15 × 2.8 → 8 verts / 12 tris / V = 0.84 m³
      //   Slab S 5.0 × 3.0 × 0.2 → 8 verts / 12 tris / V = 3.0 m³
      expect(mesh.elements.map((e) => e.name)).toEqual(["Wall A", "Wall B", "Slab S"])
      const expectedVolumes: Record<string, number> = {
        "#3rUnE8CnPHBwLdZzIqZkf1": 2.8,
        "#3rUnE8CnPHBwLdZzIqZkf2": 0.84,
        "#3rUnE8CnPHBwLdZzIqZkf3": 3.0,
      }
      for (const el of mesh.elements) {
        expect(expectedVolumes[el.elementRef]).toBeDefined()
        expect(el.vertices).toHaveLength(8)
        expect(el.triangles).toHaveLength(12)
        let vol = 0
        for (const [a, b, c] of el.triangles) {
          const p0 = el.vertices[a]
          const p1 = el.vertices[b]
          const p2 = el.vertices[c]
          vol +=
            (p0[0] * (p1[1] * p2[2] - p1[2] * p2[1]) -
              p0[1] * (p1[0] * p2[2] - p1[2] * p2[0]) +
              p0[2] * (p1[0] * p2[1] - p1[1] * p2[0])) /
            6
        }
        const expected = expectedVolumes[el.elementRef]
        expect(Math.abs(Math.abs(vol) - expected)).toBeLessThanOrEqual(1e-9 * Math.max(1, expected))
      }

      // CROSS-REFERENCE CONTRACT: mesh elementRefs set-equal the quantity
      // adapter's per-element refs for the same file (the real ledger link).
      const quantities = await deriveFromFile(path.join(fixtures, "two-elements.ifc"), "ifc")
      const quantityRefs = new Set(quantities.quantities.map((q) => q.elementRef))
      const meshRefs = new Set(mesh.elements.map((e) => e.elementRef))
      expect(meshRefs).toEqual(quantityRefs)

      // byte-determinism: two real runs produce identical mesh JSON
      const second = await tessellateFromFile(path.join(fixtures, "two-elements.ifc"), "ifc")
      expect(JSON.stringify(second.mesh)).toBe(JSON.stringify(mesh))
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "wall-stripped.ifc (valid IFC, no geometry) → honest EngineUnavailableError, never an empty fabricated mesh",
    async () => {
      const err = await expectEngineUnavailable(
        tessellateFromFile(path.join(fixtures, "wall-stripped.ifc"), "ifc"),
      )
      expect(err.message).toContain("no meshable geometry")
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "non-model file (site-notes.md) → honest EngineUnavailableError via the adapter's envelope",
    async () => {
      const err = await expectEngineUnavailable(
        tessellateFromFile(path.join(fixtures, "site-notes.md"), "ifc"),
      )
      expect(err.message).toContain("could not open the file")
    },
    TEST_TIMEOUT_MS,
  )
})

// Engine-independent structural pin: the exported surface stays exactly the
// pinned set (MeshElement/MeshPayload/MeshResult/tessellateFromFile/
// EngineUnavailableError re-export) plus the W2-d additive pure parse export.
describe("mesh bridge export surface (engine-independent)", () => {
  test("tessellateFromFile and EngineUnavailableError exist with the pinned shapes", () => {
    expect(typeof tessellateFromFile).toBe("function")
    expect(typeof parseMeshAdapterStdout).toBe("function")
    const err = new EngineUnavailableError("probe")
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe("EngineUnavailableError")
    expect(err.message).toBe("probe")
  })

  test("MeshResult carries engine provenance fields next to the mesh payload (type-level shape probe)", () => {
    // Constructing a MeshResult literal typechecks ONLY if the pinned shape holds.
    const probe: MeshResult = {
      engineKey: "k",
      engineVersion: "v",
      adapterScript: "s",
      adapterHash: "0".repeat(64),
      mesh: {
        format: "eos-mesh/1",
        units: "m",
        upAxis: "z",
        tolerance: 0.0001,
        elements: [
          { elementRef: "step:solid:0", name: "Solid 1", vertices: [[0, 0, 0]], triangles: [[0, 0, 0]] },
        ],
      },
    }
    expect(probe.mesh.elements).toHaveLength(1)
  })
})
