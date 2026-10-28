import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  EngineUnavailableError,
  parseFeaAdapterStdout,
  runFeaFromFile,
  validateFeaParameters,
  type FeaResult,
} from "./fea"

/**
 * FEA bridge tests (Slice 22 — contract §14.5/§14.6).
 *
 * Honesty rules (ADR-0006 — the mesh.test.ts convention): the PURE tests feed
 * SYNTHETIC protocol strings into the bridge's parse/validate half; every
 * number asserted in the REAL-engine tests is a HAND-DERIVED closed form for
 * the uniform-tension plate (tests/fixtures/fea-uniform-tension.json) —
 * never a value copied from scikit-fem's output.
 *
 * Closed-form derivation (uniform uniaxial tension, plane stress):
 *   W=400, H=200, t=10 mm, E=200 000 MPa, ν=0.3, σ = 10 MPa on the right edge
 *   supports: left edge ux (u_x = σx/E = 0 at x=0 ✓), bottom edge uy
 *   (u_y = −νσy/E = 0 at y=0 ✓) — the uniform field satisfies BOTH exactly
 *   and is LINEAR, so tri6 elements reproduce it machine-verbatim:
 *     u_x(x) = σ/E·x      → u_x(400) = 10/200000·400 = 0.02 mm
 *     u_y(y) = −νσ/E·y    → u_y(200) = −0.3·10/200000·200 = −0.003 mm
 *     σ_xx = 10 uniform, σ_yy = τ_xy = 0 → von Mises = 10 MPa
 *     |u|max at (400,200): hypot(0.02, 0.003) = √0.000409 ≈ 0.0202237484 mm
 *   Cantilever plate (fea-cantilever-plate.json, end shear 2 MPa down):
 *     P = 2·25·500 = 25 000 N, I = t·H³/12 = 2.6041667e8 mm⁴,
 *     G = E/2(1+ν) = 76 923.08 MPa, κ = 5/6
 *     Timoshenko tip δ = PL³/3EI + PL/κGA ≈ 1.28 + 0.0624 = 1.3424 mm
 *     (the FEM converges from below at refinement 4: observed 1.3362 — the
 *     pin allows 1.5% around the closed form, the gmsh-volume precedent)
 *
 * Real-engine tests run ONLY when scikit-fem is genuinely importable in the
 * venv; otherwise they are skipped with an explicit printed reason.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.resolve(here, "..", "..", "..", "tests", "fixtures")
const PYTHON_BIN = process.env.EOS_PYTHON ?? "/home/z/.venv/bin/python3"

const skfemAvailable =
  spawnSync(PYTHON_BIN, ["-c", "import skfem"], { timeout: 60_000 }).status === 0
if (!skfemAvailable) {
  console.log(
    `[fea.test.ts] FEA tests SKIPPED: scikit-fem is not importable in ${PYTHON_BIN} (recorded honestly — no results are simulated)`,
  )
}

const TEST_TIMEOUT_MS = 180_000

function sha256Of(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex")
}

// The uniform-tension closed forms (hand-derived; see the file header).
const SIGMA = 10.0
const E = 200000.0
const NU = 0.3
const W = 400.0
const H = 200.0
const UX_AT_W = (SIGMA / E) * W // u_x(400) = 0.02 mm
const UY_AT_H = (-NU * SIGMA * H) / E // u_y(200) = −0.003 mm
const CANTILEVER_TIMOSHENKO = 1.3424 // PL³/3EI + PL/κGA (see header)

/** Synthetic success stdout in the pinned adapter protocol (no engine). */
function syntheticFeaStdout(): string {
  return JSON.stringify({
    engineKey: "synthetic-engine",
    engineVersion: "1.2.3",
    adapterScript: "fea_solve.py",
    adapterHash: "a".repeat(64),
    analysis: "plane_stress",
    mesh: { elementType: "tri6", refinement: 4, elementCount: 512, nodeCount: 2178 },
    thicknessMm: 10.0,
    elasticModulusMpa: 200000.0,
    poissonRatio: 0.3,
    samples: [
      { x: 0.0, y: 0.0, ux: 0.0, uy: 0.0 },
      { x: 0.0, y: 200.0, ux: 0.0, uy: -0.003 },
      { x: 200.0, y: 100.0, ux: 0.01, uy: -0.0015 },
      { x: 400.0, y: 0.0, ux: 0.02, uy: 0.0 },
      { x: 400.0, y: 200.0, ux: 0.02, uy: -0.003 },
    ],
    maxDisplacementMagnitudeMm: 0.020223748416157653,
    stress: { sigmaXxMinMpa: 10.0, sigmaXxMaxMpa: 10.0, vonMisesMaxMpa: 10.0 },
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

/** The result minus the run-specific tails (determinism comparator). */
function feaPayloadSignature(result: FeaResult): string {
  const { stdoutTail: _s, stderrTail: _e, ...payload } = result
  return JSON.stringify(payload)
}

// ---------------------------------------------------------------------------
// Pure half (synthetic protocol strings — no engine)
// ---------------------------------------------------------------------------

describe("fea bridge pure half (synthetic protocol strings — no engine)", () => {
  test("parseFeaAdapterStdout accepts a well-formed payload and returns the FeaResult", () => {
    const result = parseFeaAdapterStdout(syntheticFeaStdout(), "fea_solve.py")
    expect(result.engineKey).toBe("synthetic-engine")
    expect(result.engineVersion).toBe("1.2.3")
    expect(result.adapterScript).toBe("fea_solve.py")
    expect(result.adapterHash).toBe("a".repeat(64))
    expect(result.analysis).toBe("plane_stress")
    expect(result.mesh.elementType).toBe("tri6")
    expect(result.mesh.refinement).toBe(4)
    expect(result.mesh.elementCount).toBe(512)
    expect(result.mesh.nodeCount).toBe(2178)
    expect(result.samples).toHaveLength(5)
    expect(result.samples[4]).toEqual({ x: 400.0, y: 200.0, ux: 0.02, uy: -0.003 })
    expect(result.stress.vonMisesMaxMpa).toBe(10.0)
  })

  test('error envelope {"error": …} surfaces verbatim as EngineUnavailableError', () => {
    const envelope = JSON.stringify({
      error: "the supports do not constrain the model's rigid-body motion (free: translation in y) - an unconstrained model cannot be solved, and simulated results are not an option",
    })
    expect(() => parseFeaAdapterStdout(envelope, "fea_solve.py")).toThrow(EngineUnavailableError)
    expect(() => parseFeaAdapterStdout(envelope, "fea_solve.py")).toThrow(
      /rigid-body motion/,
    )
  })

  test("payload validation refuses malformed shapes with honest messages", () => {
    const bad = (mutate: (payload: Record<string, unknown>) => void) => {
      const parsed = JSON.parse(syntheticFeaStdout()) as Record<string, unknown>
      mutate(parsed)
      return JSON.stringify(parsed)
    }
    // wrong analysis marker
    expect(() =>
      parseFeaAdapterStdout(bad((p) => { p.analysis = "plane_strain" }), "fea_solve.py"),
    ).toThrow(/analysis: "plane_stress"/)
    // wrong element type
    expect(() =>
      parseFeaAdapterStdout(bad((p) => { (p.mesh as Record<string, unknown>).elementType = "tet4" }), "fea_solve.py"),
    ).toThrow(/elementType must be "tri6"/)
    // missing mesh
    expect(() =>
      parseFeaAdapterStdout(bad((p) => { delete p.mesh }), "fea_solve.py"),
    ).toThrow(/missing the mesh object/)
    // wrong sample count
    expect(() =>
      parseFeaAdapterStdout(
        bad((p) => { (p as { samples: unknown[] }).samples = (p as { samples: unknown[] }).samples.slice(1) }),
        "fea_solve.py",
      ),
    ).toThrow(/5 sample points/)
    // non-finite sample field
    expect(() =>
      parseFeaAdapterStdout(
        bad((p) => { ((p as { samples: { [k: string]: unknown }[] }).samples[0].ux = "oops" as unknown) }),
        "fea_solve.py",
      ),
    ).toThrow(/samples\[0\].ux must be a finite number/)
    // missing stress
    expect(() =>
      parseFeaAdapterStdout(bad((p) => { delete p.stress }), "fea_solve.py"),
    ).toThrow(/missing stress/)
    // non-finite maxDisplacement
    expect(() =>
      parseFeaAdapterStdout(bad((p) => { p.maxDisplacementMagnitudeMm = "big" as unknown }), "fea_solve.py"),
    ).toThrow(/maxDisplacementMagnitudeMm must be a finite number/)
  })

  test("validateFeaParameters: default 4, honest range refusals", () => {
    expect(validateFeaParameters({}).meshRefinement).toBe(4)
    expect(validateFeaParameters({ meshRefinement: 7 }).meshRefinement).toBe(7)
    expect(validateFeaParameters({ meshRefinement: 1 }).meshRefinement).toBe(1)
    expect(() => validateFeaParameters({ meshRefinement: 0 })).toThrow(/integer between 1 and 7/)
    expect(() => validateFeaParameters({ meshRefinement: 8 })).toThrow(/integer between 1 and 7/)
    expect(() => validateFeaParameters({ meshRefinement: 2.5 })).toThrow(/integer between 1 and 7/)
  })

  test("export surface: runFeaFromFile / EngineUnavailableError exist with the pinned shapes", () => {
    expect(typeof runFeaFromFile).toBe("function")
    expect(typeof EngineUnavailableError).toBe("function")
  })
})

// ---------------------------------------------------------------------------
// Real-engine half (scikit-fem; skipped honestly when absent)
// ---------------------------------------------------------------------------

describe.skipIf(!skfemAvailable)("runFeaFromFile — scikit-fem plane stress (real engine runs)", () => {
  test(
    "fea-uniform-tension.json: samples match the closed forms at abs ≤ 1e-9 (machine precision), stress uniform at 1e-9",
    async () => {
      const result = await runFeaFromFile(path.join(fixtures, "fea-uniform-tension.json"), {})

      expect(result.engineKey).toBe("scikit-fem")
      expect(result.engineVersion).toMatch(/^[0-9]/) // real version string, e.g. 12.0.2
      expect(result.adapterScript).toBe("fea_solve.py")
      // adapterHash is SELF-reported — verify it independently (node:crypto)
      expect(result.adapterHash).toBe(sha256Of(path.join(here, "fea_solve.py")))

      expect(result.analysis).toBe("plane_stress")
      expect(result.mesh.elementType).toBe("tri6")
      expect(result.mesh.refinement).toBe(4) // the default parameter
      // deterministic uniform mesh at refinement 4: 2·4⁴ = 512 tri6 elements
      expect(result.mesh.elementCount).toBe(512)

      // ── CLOSED FORMS (hand-derived; see the file header) ─────────────────
      // samples ascending x then y: (0,0), (0,H), (W/2,H/2), (W,0), (W,H)
      const [origin, topLeft, center, bottomRight, topRight] = result.samples
      expect(origin).toEqual({ x: 0.0, y: 0.0, ux: 0.0, uy: 0.0 })
      expect(Math.abs(topLeft.ux - 0.0)).toBeLessThanOrEqual(1e-9)
      expect(Math.abs(topLeft.uy - UY_AT_H)).toBeLessThanOrEqual(1e-9)
      expect(Math.abs(center.ux - UX_AT_W / 2)).toBeLessThanOrEqual(1e-9)
      expect(Math.abs(center.uy - UY_AT_H / 2)).toBeLessThanOrEqual(1e-9)
      expect(Math.abs(bottomRight.ux - UX_AT_W)).toBeLessThanOrEqual(1e-9)
      expect(Math.abs(bottomRight.uy - 0.0)).toBeLessThanOrEqual(1e-9)
      expect(Math.abs(topRight.ux - UX_AT_W)).toBeLessThanOrEqual(1e-9)
      expect(Math.abs(topRight.uy - UY_AT_H)).toBeLessThanOrEqual(1e-9)

      // stress: σ_xx uniform = 10 at machine precision; von Mises = 10
      expect(Math.abs(result.stress.sigmaXxMinMpa - SIGMA)).toBeLessThanOrEqual(1e-9)
      expect(Math.abs(result.stress.sigmaXxMaxMpa - SIGMA)).toBeLessThanOrEqual(1e-9)
      expect(Math.abs(result.stress.vonMisesMaxMpa - SIGMA)).toBeLessThanOrEqual(1e-9)

      // max |u| at the far corner: hypot(0.02, 0.003) at machine precision
      expect(Math.abs(result.maxDisplacementMagnitudeMm - Math.hypot(UX_AT_W, UY_AT_H))).toBeLessThanOrEqual(1e-9)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "determinism: two real runs → byte-identical result payload (direct sparse solve, no iteration)",
    async () => {
      const first = await runFeaFromFile(path.join(fixtures, "fea-uniform-tension.json"), {})
      const second = await runFeaFromFile(path.join(fixtures, "fea-uniform-tension.json"), {})
      expect(feaPayloadSignature(second)).toBe(feaPayloadSignature(first))
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "fea-cantilever-plate.json (end shear): tip sample vs the Timoshenko closed form at rel ≤ 1.5% (the convergence pin)",
    async () => {
      const result = await runFeaFromFile(path.join(fixtures, "fea-cantilever-plate.json"), {})
      // samples: (0,0), (0,500), (1000,250), (2000,0), (2000,500)
      const tipBottom = result.samples[3]
      const tipTop = result.samples[4]
      expect(tipBottom.x).toBe(2000.0)
      // the tip corners carry the centerline Timoshenko deflection (the
      // section rotation displaces the corners horizontally, not vertically)
      expect(Math.abs(tipBottom.uy - -CANTILEVER_TIMOSHENKO) / CANTILEVER_TIMOSHENKO).toBeLessThanOrEqual(0.015)
      expect(Math.abs(tipTop.uy - tipBottom.uy)).toBeLessThanOrEqual(0.01)
      // sanity: the plate bends DOWN (positive shear on the right edge = −y)
      expect(tipBottom.uy).toBeLessThan(0)
      // clamp stress: beam theory σ = P·L·c/I = 48 MPa at the extreme fibre —
      // the element-MEAN projection under-reads the clamp concentration at
      // refinement 4 (observed ~45); the pin allows the averaging band
      expect(result.stress.vonMisesMaxMpa).toBeGreaterThan(40)
      expect(result.stress.vonMisesMaxMpa).toBeLessThan(52)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "fea-underconstrained.json (ux-only bottom support) → the honest rigid-mode refusal naming the free modes",
    async () => {
      const err = await expectEngineUnavailable(
        runFeaFromFile(path.join(fixtures, "fea-underconstrained.json"), {}),
      )
      expect(err.message).toBe(
        "the supports do not constrain the model's rigid-body motion (free: translation in y, rotation about z) - " +
          "an unconstrained model cannot be solved, and simulated results are not an option",
      )
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "non-JSON file path (site-notes.md) → the bridge's honest parse error, never a fabricated result",
    async () => {
      const err = await expectEngineUnavailable(
        runFeaFromFile(path.join(fixtures, "site-notes.md"), {}),
      )
      expect(err.message).toContain("FEA model file is not valid JSON")
    },
    TEST_TIMEOUT_MS,
  )
})
