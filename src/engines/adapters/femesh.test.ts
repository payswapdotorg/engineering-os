import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  EngineUnavailableError,
  defaultFeMeshParameters,
  feMeshFromFile,
  femeshLdLibraryPath,
  parseFeMeshAdapterStdout,
  supportsFeMesh,
  validateFeMeshParameters,
  type FeMeshResult,
} from "./femesh"

/**
 * FE-mesh bridge tests (W2-f completion, Phase 5 — contract §5.1/§7.1).
 *
 * Honesty rules (ADR-0006 — the mesh.test.ts convention): the PURE tests feed
 * SYNTHETIC protocol strings into the bridge's parse/validate half — they test
 * the BRIDGE, are labelled synthetic and assert no engine values. Every number
 * asserted in the REAL-engine tests is either a hand-derived closed form
 * (independent of the adapter) or a count pinned from a live observed run and
 * marked as such (the harness pins observed reality, never aspirations).
 *
 * Real-engine tests run ONLY when the venv python and gmsh (with its system
 * libraries) are genuinely importable; otherwise they are skipped with an
 * explicit printed reason. A skipped test with a reason is honest; a fake
 * result is not an option.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.resolve(here, "..", "..", "..", "tests", "fixtures")
const PYTHON_BIN = process.env.EOS_PYTHON ?? "/home/z/.venv/bin/python3"
const ENGINE_LIBDIR = process.env.EOS_ENGINE_LIBDIR ?? "/home/z/.local/lib/eos-engine-libs"

/** The bridge's own LD_LIBRARY_PATH construction — the probe mirrors it so the
 * availability answer can never disagree with the spawn (contract §5.1). */
function gmshProbeEnv(): NodeJS.ProcessEnv {
  // full environment + the engine-libs dir prepended (gmsh needs libGLU/libOpenGL)
  return { ...process.env, LD_LIBRARY_PATH: femeshLdLibraryPath(process.env.LD_LIBRARY_PATH) }
}

const pythonRunnable = spawnSync(PYTHON_BIN, ["-c", "pass"], { timeout: 60_000 }).status === 0
const gmshAvailable =
  pythonRunnable &&
  spawnSync(PYTHON_BIN, ["-c", "import gmsh"], { timeout: 60_000, env: gmshProbeEnv() }).status === 0

if (!pythonRunnable) {
  console.log(
    `[femesh.test.ts] FE-mesh tests SKIPPED: python interpreter not runnable at ${PYTHON_BIN} (recorded honestly — no results are simulated)`,
  )
} else if (!gmshAvailable) {
  console.log(
    `[femesh.test.ts] real-engine FE-mesh tests SKIPPED: gmsh is not importable in ${PYTHON_BIN} with LD_LIBRARY_PATH="${gmshProbeEnv().LD_LIBRARY_PATH}" (missing system libs? run scripts/setup-engine-libs.sh) — recorded honestly, no results are simulated`,
  )
}

const TEST_TIMEOUT_MS = 180_000

function sha256Of(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex")
}

/** Synthetic success stdout in the pinned adapter protocol (no engine). */
function syntheticFemeshStdout(): string {
  return JSON.stringify({
    engineKey: "synthetic-engine",
    engineVersion: "1.2.3",
    adapterScript: "step_femesh.py",
    adapterHash: "a".repeat(64),
    nodes: { count: 4 },
    elements: { type: "tet4", count: 1 },
    solids: [{ ref: "step:solid:0", name: "Solid 1", tetCount: 1, meshVolume: 1000.5 }],
    quality: { min: 0.5, mean: 0.75 },
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

/**
 * The byte-determinism signature: the adapter's RESULT JSON payload (what the
 * broker assembles into the stored eos-femesh/1 document). The subprocess
 * stderr is execution-record EVIDENCE, not payload — gmsh prints "Wall/CPU"
 * timing lines there, so stderr is excluded from the byte-identity pin by
 * design (observed live: stdout is byte-identical across runs).
 */
function femeshPayloadSignature(r: FeMeshResult): string {
  return JSON.stringify({
    engineKey: r.engineKey,
    engineVersion: r.engineVersion,
    adapterScript: r.adapterScript,
    adapterHash: r.adapterHash,
    nodes: r.nodes,
    elements: r.elements,
    solids: r.solids,
    quality: r.quality,
  })
}

// ---------------------------------------------------------------------------
// Pure half of the bridge: parameter validation, protocol parsing, payload
// validation, the LD_LIBRARY_PATH construction (synthetic — no engine)
// ---------------------------------------------------------------------------

describe("femesh bridge pure half (synthetic protocol strings — no engine)", () => {
  test("supportsFeMesh maps the model extensions exactly (.step/.stp/.ifc; everything else null)", () => {
    expect(supportsFeMesh("model.step")).toBe("step")
    expect(supportsFeMesh("model.stp")).toBe("step")
    expect(supportsFeMesh("model.ifc")).toBe("ifc")
    expect(supportsFeMesh("content")).toBeNull()
    expect(supportsFeMesh("site-notes.md")).toBeNull()
  })

  test("defaultFeMeshParameters pins the contract §4 defaults (2.0 / 4.0 / linear)", () => {
    expect(defaultFeMeshParameters()).toEqual({ meshSizeMin: 2.0, meshSizeMax: 4.0, elementOrder: 1 })
  })

  test("validateFeMeshParameters: empty object → the defaults; explicit values pass through", () => {
    expect(validateFeMeshParameters({})).toEqual({ meshSizeMin: 2.0, meshSizeMax: 4.0, elementOrder: 1 })
    expect(validateFeMeshParameters({ meshSizeMin: 1.5, meshSizeMax: 3 })).toEqual({
      meshSizeMin: 1.5,
      meshSizeMax: 3,
      elementOrder: 1,
    })
  })

  test("validateFeMeshParameters refuses min>max, non-positive sizes and elementOrder ≠ 1 with the pinned 422 texts", () => {
    for (const [params, expected] of [
      [{ meshSizeMin: 5, meshSizeMax: 4 }, "fe_mesh parameters.meshSizeMin must be <= parameters.meshSizeMax"],
      [{ meshSizeMin: 0 }, "fe_mesh parameters.meshSizeMin must be a positive number"],
      [{ meshSizeMax: -1 }, "fe_mesh parameters.meshSizeMax must be a positive number"],
      [{ elementOrder: 2 }, "fe_mesh parameters.elementOrder must be 1 (linear tets only in this phase)"],
    ] as const) {
      let caught: unknown
      try {
        validateFeMeshParameters(params as Record<string, unknown>)
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(EngineUnavailableError)
      expect((caught as Error).message).toContain(expected)
    }
  })

  test("parseFeMeshAdapterStdout accepts a well-formed payload and returns the FeMeshResult", () => {
    const result = parseFeMeshAdapterStdout(syntheticFemeshStdout(), "step_femesh.py")
    expect(result.engineKey).toBe("synthetic-engine")
    expect(result.engineVersion).toBe("1.2.3")
    expect(result.adapterScript).toBe("step_femesh.py")
    expect(result.adapterHash).toBe("a".repeat(64))
    expect(result.nodes).toEqual({ count: 4 })
    expect(result.elements).toEqual({ type: "tet4", count: 1 })
    expect(result.solids).toEqual([{ ref: "step:solid:0", name: "Solid 1", tetCount: 1, meshVolume: 1000.5 }])
    expect(result.quality).toEqual({ min: 0.5, mean: 0.75 })
  })

  test('error envelope {"error": …} surfaces verbatim as EngineUnavailableError', () => {
    expect(() =>
      parseFeMeshAdapterStdout(
        JSON.stringify({ error: "gmsh cannot import IFC geometry" }),
        "step_femesh.py",
      ),
    ).toThrow("gmsh cannot import IFC geometry")
  })

  test("payload validation refuses missing/malformed nodes/elements/solids/quality with honest messages", () => {
    for (const [mutate, expected] of [
      [(p: Record<string, unknown>) => delete p.nodes, "missing nodes.count"],
      [(p: Record<string, unknown>) => (p.nodes = { count: 0 }), "missing nodes.count"],
      [(p: Record<string, unknown>) => (p.elements = { type: "tri3", count: 1 }), 'elements {type:"tet4", count}'],
      [(p: Record<string, unknown>) => delete p.solids, "missing the solids array"],
      [(p: Record<string, unknown>) => (p.solids = [{ ref: "x", name: "S", tetCount: 0, meshVolume: 1 }]), "tetCount must be a positive integer"],
      [(p: Record<string, unknown>) => (p.solids = [{ ref: "x", name: "S", tetCount: 1, meshVolume: Number.NaN }]), "meshVolume must be a positive finite number"],
      [(p: Record<string, unknown>) => (p.quality = { min: 0, mean: 0.5 }), "missing quality {min, mean}"],
      [(p: Record<string, unknown>) => (p.quality = { min: 0.5, mean: Number.NaN }), "missing quality {min, mean}"],
    ] as const) {
      const payload = JSON.parse(syntheticFemeshStdout()) as Record<string, unknown>
      mutate(payload)
      let caught: unknown
      try {
        parseFeMeshAdapterStdout(JSON.stringify(payload), "step_femesh.py")
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(EngineUnavailableError)
      expect((caught as Error).message).toContain(expected)
    }
  })

  test("femeshLdLibraryPath injects the engine-libs dir: prepended before any existing value, alone when none", () => {
    // default libdir — the same expression the bridge module captures at import
    const libdir = process.env.EOS_ENGINE_LIBDIR ?? "/home/z/.local/lib/eos-engine-libs"
    expect(femeshLdLibraryPath(undefined)).toBe(libdir)
    expect(femeshLdLibraryPath("")).toBe(libdir)
    expect(femeshLdLibraryPath("/usr/lib/extra")).toBe(`${libdir}${path.delimiter}/usr/lib/extra`)
    // an existing multi-entry value keeps its order after the injection
    expect(femeshLdLibraryPath("/a:/b")).toBe(`${libdir}${path.delimiter}/a:/b`)
    // the EOS_ENGINE_LIBDIR override flows through the default parameter
    expect(femeshLdLibraryPath(undefined, "/custom/engine-libs")).toBe("/custom/engine-libs")
    expect(femeshLdLibraryPath("/x", "/custom/engine-libs")).toBe(`/custom/engine-libs${path.delimiter}/x`)
    // the pinned libdir is the setup script's target (contract §5.1)
    expect(ENGINE_LIBDIR).toBe("/home/z/.local/lib/eos-engine-libs")
  })

  test("export surface: feMeshFromFile / EngineUnavailableError exist with the pinned shapes", () => {
    expect(typeof feMeshFromFile).toBe("function")
    const err = new EngineUnavailableError("probe")
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe("EngineUnavailableError")
    expect(err.message).toBe("probe")
  })
})

// ---------------------------------------------------------------------------
// IFC-kind refusal — the broker-style kind gate fires BEFORE the gmsh import
// (step_femesh.py), so this honest capability-gap refusal needs the venv
// python but NOT the gmsh engine itself (no gmsh run happens).
// ---------------------------------------------------------------------------

describe.skipIf(!pythonRunnable)("feMeshFromFile — IFC kind refusal (kind gate, no gmsh run)", () => {
  test(
    'kind "ifc" → the verbatim gmsh-has-no-IFC-reader refusal (gmsh has no IFC import reader — OCC STEP/IGES/BRep only)',
    async () => {
      const err = await expectEngineUnavailable(
        feMeshFromFile(path.join(fixtures, "two-elements.ifc"), "ifc", {}),
      )
      expect(err.message).toBe(
        "gmsh cannot import IFC geometry (gmsh has no IFC import reader - OCC STEP/IGES/BRep only) " +
          "- cannot generate an FE mesh, and simulated meshes are not an option",
      )
    },
    TEST_TIMEOUT_MS,
  )
})

// ---------------------------------------------------------------------------
// Real engine runs (skipIf gmsh is absent, with a printed reason)
// ---------------------------------------------------------------------------

describe.skipIf(!gmshAvailable)("feMeshFromFile — STEP via gmsh/OCC (real engine runs)", () => {
  test(
    "bracket-solid.step: pinned 1088 nodes / 3482 tet4 (live-observed pins), meshVolume within 2% of 36000−960π, quality in (0,1]",
    async () => {
      const result = await feMeshFromFile(path.join(fixtures, "bracket-solid.step"), "step", {})

      expect(result.engineKey).toBe("gmsh")
      expect(result.engineVersion).toMatch(/^[0-9]/) // real version string, e.g. 4.15.2
      expect(result.adapterScript).toBe("step_femesh.py")
      // adapterHash is SELF-reported — verify it independently (node:crypto)
      expect(result.adapterHash).toBe(sha256Of(path.join(here, "step_femesh.py")))

      // ── LIVE-OBSERVED PINS (gmsh 4.15.2, contract §4 default sizes 2.0/4.0,
      // linear tets): observed live 2026-10-22 — re-pin together with the
      // engine pin if a count drifts (these pin observed reality, §7.1).
      expect(result.nodes.count).toBe(1088)
      expect(result.elements.type).toBe("tet4")
      expect(result.elements.count).toBe(3482)

      // ── ANALYTIC closed form (hand-derived, engine-independent):
      // L-profile area (80·10 + 10·50 − 10·10) = 1200 mm² extruded 30 mm,
      // minus two Ø8 through-holes: V = 36000 − 960π mm³. Linear tets
      // under-trap the CURVED HOLES (the faceted hole boundary removes less
      // material than the true cylinders), so the mesh volume runs slightly
      // ABOVE the analytic value: observed live 33286.264 vs 32984.071
      // (+0.92% — the linear-tet bias, shrinks quadratically with mesh size);
      // pinned at the contract's 2% tolerance (§7.1).
      expect(result.solids).toHaveLength(1)
      const solid = result.solids[0]
      expect(solid.ref).toBe("step:solid:0")
      expect(solid.name).toBe("Solid 1")
      expect(solid.tetCount).toBe(3482)
      const analytic = 36000 - 960 * Math.PI
      expect(Math.abs(solid.meshVolume - analytic)).toBeLessThanOrEqual(0.02 * analytic)

      // ── QUALITY: gmsh getElementQualities for tet4 live in (0, 1]; min ≤ mean
      expect(result.quality.min).toBeGreaterThan(0)
      expect(result.quality.min).toBeLessThanOrEqual(1)
      expect(result.quality.mean).toBeGreaterThan(0)
      expect(result.quality.mean).toBeLessThanOrEqual(1)
      expect(result.quality.min).toBeLessThanOrEqual(result.quality.mean)
      // live-observed quality stats (recorded honestly, informational pins)
      expect(Math.abs(result.quality.min - 0.2997276601357442)).toBeLessThanOrEqual(1e-12)
      expect(Math.abs(result.quality.mean - 0.7848223382144988)).toBeLessThanOrEqual(1e-12)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "determinism: two feMeshFromFile runs on bracket-solid → byte-identical result JSON payload",
    async () => {
      const first = await feMeshFromFile(path.join(fixtures, "bracket-solid.step"), "step", {})
      const second = await feMeshFromFile(path.join(fixtures, "bracket-solid.step"), "step", {})
      expect(femeshPayloadSignature(second)).toBe(femeshPayloadSignature(first))
      // the JSON protocol bytes on stdout are byte-identical too (both
      // payloads are < 2000 chars, so stdoutTail carries the whole protocol
      // line — observed live; the stderr evidence stream is excluded above)
      expect(second.stdoutTail).toBe(first.stdoutTail)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "two-solids.step: PLANAR solids → per-solid divergence volumes EXACT at rel ≤ 1e-12; pinned per-solid tet counts + node count (live-observed)",
    async () => {
      const result = await feMeshFromFile(path.join(fixtures, "two-solids.step"), "step", {})

      // ── LIVE-OBSERVED PINS (gmsh 4.15.2, defaults): nodes 479, tets 1378
      // split 599/779 — derived from live runs, then pinned (§7.2).
      expect(result.nodes.count).toBe(479)
      expect(result.elements.count).toBe(1378)

      // ── ANALYTIC closed forms (make_fixture_step_solids.py):
      // box A 30×20×10 mm = 6000 mm³, box B 15×15×40 mm = 9000 mm³.
      // PLANAR solids → the sum of signed linear-tet volumes is the exact box
      // volume up to IEEE rounding only (interior faces cancel); pinned at the
      // contract's analytic tolerance rel ≤ 1e-12.
      expect(result.solids.map((s) => s.ref)).toEqual(["step:solid:0", "step:solid:1"])
      expect(result.solids.map((s) => s.name)).toEqual(["Solid 1", "Solid 2"])
      const [a, b] = result.solids
      expect(a.tetCount).toBe(599)
      expect(b.tetCount).toBe(779)
      expect(Math.abs(a.meshVolume - 6000) / 6000).toBeLessThanOrEqual(1e-12)
      expect(Math.abs(b.meshVolume - 9000) / 9000).toBeLessThanOrEqual(1e-12)
      // Σ per-solid tet counts === the total (the payload is self-consistent)
      expect(a.tetCount + b.tetCount).toBe(result.elements.count)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "bracket.step (valid STEP, 0 solids after OCC import) → the verbatim geometry-free refusal",
    async () => {
      const err = await expectEngineUnavailable(feMeshFromFile(path.join(fixtures, "bracket.step"), "step", {}))
      expect(err.message).toBe(
        "no solid geometry found in STEP file (import produced 0 solids) - cannot generate an FE mesh, and simulated meshes are not an option",
      )
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "non-model file (site-notes.md) → honest EngineUnavailableError via the adapter's envelope",
    async () => {
      const err = await expectEngineUnavailable(feMeshFromFile(path.join(fixtures, "site-notes.md"), "step", {}))
      // gmsh's own import failure surfaces verbatim inside the envelope (the
      // temp-dir path inside the message varies per run — pinned by substring)
      expect(err.message).toContain("gmsh could not import the file")
    },
    TEST_TIMEOUT_MS,
  )
})
