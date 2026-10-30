import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  EngineUnavailableError,
  parseTransportAdapterStdout,
  runTransportFromFile,
  validateTransportParameters,
  type TransportResult,
} from "./cfd"

/**
 * Transport bridge tests (Slice 29 — contract §16.5/§16.6).
 *
 * Honesty rules (ADR-0006 — the fea.test.ts convention): the PURE tests feed
 * SYNTHETIC protocol strings into the bridge's parse/validate half; every
 * number asserted in the REAL-engine tests is a HAND-DERIVED closed form for
 * the channel-transport fixture (tests/fixtures/transport-channel.json) —
 * never a value copied from SfePy's output.
 *
 * Closed-form derivation (steady advection-diffusion down a channel):
 *   L=2 m, H=0.5 m, D=0.01 m²/s, a=0.05 m/s → Pe = a·L/D = 10
 *   inlet u(0)=1, outlet u(L)=0, zero-flux walls → the exact solution is
 *   x-only: u(x) = (e^Pe − e^(Pe·x/L))/(e^Pe − 1)
 *     u(L/8)  = (e^10 − e^1.25)/(e^10 − 1) = 0.9998869334714342
 *     u(L/4)  = (e^10 − e^2.5)/(e^10 − 1)  = 0.9994922925097303
 *     u(L/2)  = (e^10 − e^5)/(e^10 − 1)    = 0.9933071490757152
 *     u(3L/4) = (e^10 − e^7.5)/(e^10 − 1)  = 0.9179566765447413
 *     u(7L/8) = (e^10 − e^8.75)/(e^10 − 1) = 0.7135275972426084
 *   Mesh at the default refinement 4: N = 8·2³ = 64 divisions on the longer
 *   (x) axis, y gets round(64·0.5/2) = 16 → 1024 quads;
 *   Pe_h = a·(L/64)/(2D) = 0.078125 (deep inside the probed-monotone bound 2).
 *   The uniform fixture (inlet = outlet = 1) makes u ≡ 1 identically — the
 *   machine-class assembly pin (observed |u−1| ≤ 7.7e-14).
 *
 * Real-engine tests run ONLY when sfepy is genuinely importable in the venv;
 * otherwise they are skipped with an explicit printed reason.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.resolve(here, "..", "..", "..", "tests", "fixtures")
const PYTHON_BIN = process.env.EOS_PYTHON ?? "/home/z/.venv/bin/python3"

const sfepyAvailable =
  spawnSync(PYTHON_BIN, ["-c", "import sfepy"], { timeout: 60_000 }).status === 0
if (!sfepyAvailable) {
  console.log(
    `[cfd.test.ts] transport tests SKIPPED: sfepy is not importable in ${PYTHON_BIN} (recorded honestly — no results are simulated)`,
  )
}

const TEST_TIMEOUT_MS = 180_000

function sha256Of(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex")
}

// The channel closed forms (hand-derived; see the file header).
const PE = 10.0
function uOf(x: number): number {
  const ePe = Math.exp(PE)
  return (ePe - Math.exp((PE * x) / 2.0)) / (ePe - 1.0)
}

/** Synthetic success stdout in the pinned adapter protocol (no engine). */
function syntheticTransportStdout(): string {
  return JSON.stringify({
    engineKey: "synthetic-engine",
    engineVersion: "1.2.3",
    adapterScript: "transport_solve.py",
    adapterHash: "b".repeat(64),
    analysis: "scalar_transport",
    mesh: { elementType: "quad", approximation: "Q2", refinement: 4, elementCount: 1024, nodeCount: 4257 },
    domain: { lengthM: 2.0, heightM: 0.5 },
    diffusivityM2PerS: 0.01,
    velocityMPerS: 0.05,
    inletConcentration: 1.0,
    outletConcentration: 0.0,
    pecletNumber: 10.0,
    meshPecletNumber: 0.078125,
    samples: [
      { x: 0.25, y: 0.25, concentration: uOf(0.25) },
      { x: 0.5, y: 0.25, concentration: uOf(0.5) },
      { x: 1.0, y: 0.25, concentration: uOf(1.0) },
      { x: 1.5, y: 0.25, concentration: uOf(1.5) },
      { x: 1.75, y: 0.25, concentration: uOf(1.75) },
    ],
    minConcentration: 0.0,
    maxConcentration: 1.0,
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
function transportPayloadSignature(result: TransportResult): string {
  const { stdoutTail: _s, stderrTail: _e, ...payload } = result
  return JSON.stringify(payload)
}

// ---------------------------------------------------------------------------
// Pure half (synthetic protocol strings — no engine)
// ---------------------------------------------------------------------------

describe("transport bridge pure half (synthetic protocol strings — no engine)", () => {
  test("parseTransportAdapterStdout accepts a well-formed payload and returns the TransportResult", () => {
    const result = parseTransportAdapterStdout(syntheticTransportStdout(), "transport_solve.py")
    expect(result.engineKey).toBe("synthetic-engine")
    expect(result.engineVersion).toBe("1.2.3")
    expect(result.adapterScript).toBe("transport_solve.py")
    expect(result.adapterHash).toBe("b".repeat(64))
    expect(result.analysis).toBe("scalar_transport")
    expect(result.mesh.elementType).toBe("quad")
    expect(result.mesh.approximation).toBe("Q2")
    expect(result.mesh.elementCount).toBe(1024)
    expect(result.mesh.nodeCount).toBe(4257)
    expect(result.pecletNumber).toBe(10.0)
    expect(result.meshPecletNumber).toBe(0.078125)
    expect(result.samples).toHaveLength(5)
    expect(result.samples[0]).toEqual({ x: 0.25, y: 0.25, concentration: uOf(0.25) })
    expect(result.minConcentration).toBe(0.0)
    expect(result.maxConcentration).toBe(1.0)
  })

  test('error envelope {"error": …} surfaces verbatim as EngineUnavailableError', () => {
    const stdout = JSON.stringify({
      error: "the mesh does not resolve the transport boundary layer (element Péclet 7.81 exceeds the stability bound 2)",
    })
    expect(() => parseTransportAdapterStdout(stdout, "transport_solve.py")).toThrow(
      EngineUnavailableError,
    )
    try {
      parseTransportAdapterStdout(stdout, "transport_solve.py")
    } catch (err) {
      expect((err as EngineUnavailableError).message).toContain(
        "the mesh does not resolve the transport boundary layer",
      )
    }
  })

  test("payload validation refuses malformed shapes with honest messages", () => {
    const wellFormed = JSON.parse(syntheticTransportStdout()) as Record<string, unknown>

    const wrongAnalysis = { ...wellFormed, analysis: "navier_stokes" }
    expect(() =>
      parseTransportAdapterStdout(JSON.stringify(wrongAnalysis), "transport_solve.py"),
    ).toThrow('must carry analysis: "scalar_transport"')

    const wrongElementType = { ...wellFormed, mesh: { ...(wellFormed.mesh as object), elementType: "tri6" } }
    expect(() =>
      parseTransportAdapterStdout(JSON.stringify(wrongElementType), "transport_solve.py"),
    ).toThrow('elementType "quad" + approximation "Q2"')

    const fourSamples = { ...wellFormed, samples: (wellFormed.samples as unknown[]).slice(0, 4) }
    expect(() =>
      parseTransportAdapterStdout(JSON.stringify(fourSamples), "transport_solve.py"),
    ).toThrow("must carry the 5 centerline sample stations")

    const nanPeclet = { ...wellFormed, pecletNumber: "not-a-number" }
    expect(() =>
      parseTransportAdapterStdout(JSON.stringify(nanPeclet), "transport_solve.py"),
    ).toThrow("pecletNumber must be a finite number")

    const noDomain = { ...wellFormed }
    delete noDomain.domain
    expect(() =>
      parseTransportAdapterStdout(JSON.stringify(noDomain), "transport_solve.py"),
    ).toThrow("must carry domain {lengthM, heightM}")
  })

  test("validateTransportParameters: default 4, honest range refusals", () => {
    expect(validateTransportParameters({})).toEqual({ meshRefinement: 4 })
    expect(validateTransportParameters({ meshRefinement: 1 })).toEqual({ meshRefinement: 1 })
    expect(validateTransportParameters({ meshRefinement: 7 })).toEqual({ meshRefinement: 7 })
    expect(() => validateTransportParameters({ meshRefinement: 0 })).toThrow(
      "meshRefinement must be an integer between 1 and 7",
    )
    expect(() => validateTransportParameters({ meshRefinement: 8 })).toThrow(
      "meshRefinement must be an integer between 1 and 7",
    )
    expect(() => validateTransportParameters({ meshRefinement: 4.5 })).toThrow(
      "meshRefinement must be an integer between 1 and 7",
    )
  })

  test("export surface: runTransportFromFile / EngineUnavailableError exist with the pinned shapes", () => {
    expect(typeof runTransportFromFile).toBe("function")
    expect(typeof EngineUnavailableError).toBe("function")
  })
})

// ---------------------------------------------------------------------------
// Real-engine half (sfepy; skipped honestly when absent)
// ---------------------------------------------------------------------------

describe.skipIf(!sfepyAvailable)("runTransportFromFile — sfepy scalar transport (real engine runs)", () => {
  test(
    "transport-channel.json: the 5 stations match the exponential closed form at abs ≤ 1e-4 (observed 3.0e-7)",
    async () => {
      const result = await runTransportFromFile(path.join(fixtures, "transport-channel.json"), {})

      expect(result.engineKey).toBe("sfepy")
      expect(result.engineVersion).toMatch(/^[0-9]/) // real version string, e.g. 2026.3
      expect(result.adapterScript).toBe("transport_solve.py")
      // adapterHash is SELF-reported — verify it independently (node:crypto)
      expect(result.adapterHash).toBe(sha256Of(path.join(here, "transport_solve.py")))

      expect(result.analysis).toBe("scalar_transport")
      expect(result.mesh.elementType).toBe("quad")
      expect(result.mesh.approximation).toBe("Q2")
      expect(result.mesh.refinement).toBe(4) // the default parameter
      // deterministic square-element mesh at refinement 4: 64·16 = 1024 quads
      expect(result.mesh.elementCount).toBe(1024)
      expect(result.mesh.nodeCount).toBe(4257)

      // ── CLOSED FORMS (hand-derived; see the file header) ─────────────────
      expect(result.pecletNumber).toBe(10.0)
      expect(result.meshPecletNumber).toBe(0.078125)
      expect(result.samples).toHaveLength(5)
      for (const s of result.samples) {
        expect(Math.abs(s.concentration - uOf(s.x))).toBeLessThanOrEqual(1e-4)
      }
      // the monotone range is exactly the Dirichlet values — no overshoot
      expect(result.minConcentration).toBe(0.0)
      expect(result.maxConcentration).toBe(1.0)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "transport-uniform.json: u ≡ 1 at every station and dof at abs ≤ 1e-12 (the machine-class assembly pin)",
    async () => {
      const result = await runTransportFromFile(path.join(fixtures, "transport-uniform.json"), {})
      for (const s of result.samples) {
        expect(Math.abs(s.concentration - 1.0)).toBeLessThanOrEqual(1e-12)
      }
      expect(Math.abs(result.minConcentration - 1.0)).toBeLessThanOrEqual(1e-12)
      expect(Math.abs(result.maxConcentration - 1.0)).toBeLessThanOrEqual(1e-12)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "determinism: two real runs → byte-identical result payload (direct sparse solve, no iteration)",
    async () => {
      const first = await runTransportFromFile(path.join(fixtures, "transport-channel.json"), {})
      const second = await runTransportFromFile(path.join(fixtures, "transport-channel.json"), {})
      expect(transportPayloadSignature(second)).toBe(transportPayloadSignature(first))
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "transport-high-peclet.json (element Péclet 7.8125) → the honest stability refusal verbatim",
    async () => {
      const err = await expectEngineUnavailable(
        runTransportFromFile(path.join(fixtures, "transport-high-peclet.json"), {}),
      )
      expect(err.message).toBe(
        "the mesh does not resolve the transport boundary layer (element Péclet 7.81 exceeds the " +
          "stability bound 2) - refine the mesh (increase meshRefinement) or reduce the flow Péclet " +
          "number; an oscillatory solution is not an option",
      )
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "non-JSON file path (site-notes.md) → the bridge's honest parse error, never a fabricated result",
    async () => {
      const err = await expectEngineUnavailable(
        runTransportFromFile(path.join(fixtures, "site-notes.md"), {}),
      )
      expect(err.message).toContain("transport model file is not valid JSON")
    },
    TEST_TIMEOUT_MS,
  )
})
