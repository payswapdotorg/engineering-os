import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  EngineUnavailableError,
  parseSwmmAdapterStdout,
  runSwmmFromFile,
  validateSwmmParameters,
  type SwmmResult,
} from "./swmm"

/**
 * SWMM bridge tests (Slice 23 — contract §15.5/§15.6).
 *
 * Honesty rules (ADR-0006 — the mesh.test.ts convention): the PURE tests feed
 * SYNTHETIC protocol strings into the bridge's parse/validate half; every
 * number asserted in the REAL-engine tests is a HAND-DERIVED closed form for
 * the fixtures — never a value copied from the engine's output.
 *
 * Closed-form derivation (swmm-runoff-balance.json — 1 ha impervious, 25 mm/hr × 2 h):
 *   rain volume  = i·A·t        = 0.025 m/hr × 2 hr × 10 000 m² = 500 m³
 *   equilibrium  = i·A          = 0.025/3600 × 10 000 = 0.06944444 m³/s
 *   Manning normal depth (B=0.5 m, n=0.015, S=0.005):
 *     Q = (1/n)·B·y·(B·y/(B+2y))^(2/3)·√S → y_N = 0.144866657 m
 *     (brentq-solved by hand script; probe-observed max depth 0.14486048,
 *      rel 4.3e-5 — the kinematic-wave equilibrium reproduces the cubic)
 * Manning fixture (swmm-manning-conduit.json — 2 ha, 50 mm/hr, B=0.8, n=0.013, S=0.01):
 *   rain volume  = 0.05 × 2 × 20 000 = 2 000 m³
 *   equilibrium  = 0.05/3600 × 20 000 = 0.27777778 m³/s
 *   y_N = 0.180951636 m (probe-observed 0.18094179, abs 9.8e-6)
 *
 * Real-engine tests run ONLY when pyswmm is genuinely importable in the venv;
 * otherwise they are skipped with an explicit printed reason.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.resolve(here, "..", "..", "..", "tests", "fixtures")
const PYTHON_BIN = process.env.EOS_PYTHON ?? "/home/z/.venv/bin/python3"

const pyswmmAvailable =
  spawnSync(PYTHON_BIN, ["-c", "import pyswmm"], { timeout: 60_000 }).status === 0
if (!pyswmmAvailable) {
  console.log(
    `[swmm.test.ts] SWMM tests SKIPPED: pyswmm is not importable in ${PYTHON_BIN} (recorded honestly — no results are simulated)`,
  )
}

const TEST_TIMEOUT_MS = 180_000

function sha256Of(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex")
}

// The runoff-balance closed forms (hand-derived; see the file header).
const RAIN_VOLUME_1 = 500.0 // i·A·t, m³
const Q_EQ_1 = 0.06944444444444444 // i·A, m³/s
const Y_NORMAL_1 = 0.14486665688316655 // Manning cubic, m
const RAIN_VOLUME_2 = 2000.0
const Q_EQ_2 = 0.2777777777777778
const Y_NORMAL_2 = 0.1809516359327449

/** Synthetic success stdout in the pinned adapter protocol (no engine). */
function syntheticSwmmStdout(): string {
  return JSON.stringify({
    engineKey: "synthetic-engine",
    engineVersion: "1.2.3",
    adapterScript: "swmm_run.py",
    adapterHash: "a".repeat(64),
    analysis: "drainage",
    rain: { intensityMMperHr: 25.0, durationMin: 120, totalDepthMm: 50.0, totalVolumeM3: 500.0 },
    routing: { model: "kinematic_wave", routingStepSec: 10 },
    continuity: { runoffErrorPct: -0.012, routingErrorPct: -0.055 },
    outfallVolumeM3: 500.02193805825715,
    volumeBalancePct: 0.0043876116514297795,
    peaks: { maxRunoffCms: 0.06945220755175956, maxConduitFlowCms: 0.07059164318103153 },
    depths: [
      { id: "C1", maxDepthM: 0.14486048192340867 },
      { id: "J1", maxDepthM: 0.14486048196573673 },
      { id: "OUT1", maxDepthM: 0.14652868150000456 },
    ],
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
function swmmPayloadSignature(result: SwmmResult): string {
  const { stdoutTail: _s, stderrTail: _e, ...payload } = result
  return JSON.stringify(payload)
}

// ---------------------------------------------------------------------------
// Pure half (synthetic protocol strings — no engine)
// ---------------------------------------------------------------------------

describe("swmm bridge pure half (synthetic protocol strings — no engine)", () => {
  test("parseSwmmAdapterStdout accepts a well-formed payload and returns the SwmmResult", () => {
    const result = parseSwmmAdapterStdout(syntheticSwmmStdout(), "swmm_run.py")
    expect(result.engineKey).toBe("synthetic-engine")
    expect(result.engineVersion).toBe("1.2.3")
    expect(result.adapterScript).toBe("swmm_run.py")
    expect(result.adapterHash).toBe("a".repeat(64))
    expect(result.analysis).toBe("drainage")
    expect(result.rain.totalVolumeM3).toBe(500.0)
    expect(result.routing.model).toBe("kinematic_wave")
    expect(result.routing.routingStepSec).toBe(10)
    expect(result.continuity.runoffErrorPct).toBe(-0.012)
    expect(result.outfallVolumeM3).toBe(500.02193805825715)
    expect(result.peaks.maxConduitFlowCms).toBe(0.07059164318103153)
    expect(result.depths).toHaveLength(3)
    expect(result.depths[0]).toEqual({ id: "C1", maxDepthM: 0.14486048192340867 })
  })

  test('error envelope {"error": …} surfaces verbatim as EngineUnavailableError', () => {
    const envelope = JSON.stringify({
      error:
        "the network has no outfall - runoff cannot leave the model, and simulated results are not an option",
    })
    expect(() => parseSwmmAdapterStdout(envelope, "swmm_run.py")).toThrow(EngineUnavailableError)
    expect(() => parseSwmmAdapterStdout(envelope, "swmm_run.py")).toThrow(/no outfall/)
  })

  test("payload validation refuses malformed shapes with honest messages", () => {
    const bad = (mutate: (payload: Record<string, unknown>) => void) => {
      const parsed = JSON.parse(syntheticSwmmStdout()) as Record<string, unknown>
      mutate(parsed)
      return JSON.stringify(parsed)
    }
    // wrong analysis marker
    expect(() =>
      parseSwmmAdapterStdout(bad((p) => { p.analysis = "flood" }), "swmm_run.py"),
    ).toThrow(/analysis: "drainage"/)
    // missing rain
    expect(() =>
      parseSwmmAdapterStdout(bad((p) => { delete p.rain }), "swmm_run.py"),
    ).toThrow(/missing the rain object/)
    // non-finite rain field
    expect(() =>
      parseSwmmAdapterStdout(
        bad((p) => { (p.rain as Record<string, unknown>).totalDepthMm = "lots" as unknown }),
        "swmm_run.py",
      ),
    ).toThrow(/rain\.totalDepthMm must be a finite number/)
    // wrong routing model
    expect(() =>
      parseSwmmAdapterStdout(
        bad((p) => { (p.routing as Record<string, unknown>).model = "dynamic_wave" }),
        "swmm_run.py",
      ),
    ).toThrow(/routing\.model must be "kinematic_wave"/)
    // missing continuity
    expect(() =>
      parseSwmmAdapterStdout(bad((p) => { delete p.continuity }), "swmm_run.py"),
    ).toThrow(/continuity/)
    // non-finite outfall volume
    expect(() =>
      parseSwmmAdapterStdout(bad((p) => { p.outfallVolumeM3 = null as unknown }), "swmm_run.py"),
    ).toThrow(/outfallVolumeM3 must be a finite number/)
    // missing peaks
    expect(() =>
      parseSwmmAdapterStdout(bad((p) => { delete p.peaks }), "swmm_run.py"),
    ).toThrow(/peaks/)
    // empty depths
    expect(() =>
      parseSwmmAdapterStdout(bad((p) => { p.depths = [] }), "swmm_run.py"),
    ).toThrow(/depths array/)
    // non-finite depth
    expect(() =>
      parseSwmmAdapterStdout(
        bad((p) => { ((p.depths as { [k: string]: unknown }[])[0].maxDepthM = "deep" as unknown) }),
        "swmm_run.py",
      ),
    ).toThrow(/depths\[0\]\.maxDepthM must be a finite number/)
  })

  test("validateSwmmParameters: default 10, honest range refusals", () => {
    expect(validateSwmmParameters({}).routingStepSec).toBe(10)
    expect(validateSwmmParameters({ routingStepSec: 1 }).routingStepSec).toBe(1)
    expect(validateSwmmParameters({ routingStepSec: 60 }).routingStepSec).toBe(60)
    expect(() => validateSwmmParameters({ routingStepSec: 0 })).toThrow(/integer between 1 and 60/)
    expect(() => validateSwmmParameters({ routingStepSec: 61 })).toThrow(/integer between 1 and 60/)
    expect(() => validateSwmmParameters({ routingStepSec: 2.5 })).toThrow(/integer between 1 and 60/)
  })

  test("export surface: runSwmmFromFile / EngineUnavailableError exist with the pinned shapes", () => {
    expect(typeof runSwmmFromFile).toBe("function")
    expect(typeof EngineUnavailableError).toBe("function")
  })
})

// ---------------------------------------------------------------------------
// Real-engine half (pyswmm/SWMM5; skipped honestly when absent)
// ---------------------------------------------------------------------------

describe.skipIf(!pyswmmAvailable)("runSwmmFromFile — pyswmm/SWMM5 drainage (real engine runs)", () => {
  test(
    "swmm-runoff-balance.json: outfall volume vs the closed form at rel ≤ 1e-3, equilibrium runoff, Manning depth pin, engine continuity ≤ 0.5%",
    async () => {
      const result = await runSwmmFromFile(path.join(fixtures, "swmm-runoff-balance.json"), {})

      expect(result.engineKey).toBe("pyswmm")
      expect(result.engineVersion).toMatch(/^[0-9]/) // real version string, e.g. 2.2.0
      expect(result.adapterScript).toBe("swmm_run.py")
      // adapterHash is SELF-reported — verify it independently (node:crypto)
      expect(result.adapterHash).toBe(sha256Of(path.join(here, "swmm_run.py")))

      expect(result.analysis).toBe("drainage")
      expect(result.routing.model).toBe("kinematic_wave")
      expect(result.routing.routingStepSec).toBe(10) // the default parameter

      // ── CLOSED FORMS (hand-derived; see the file header) ─────────────────
      // rain volume: i·A·t = 500 m³ (the doc's own rain block must agree)
      expect(result.rain.totalVolumeM3).toBe(RAIN_VOLUME_1)
      // outfall volume: mass conservation through the whole chain, rel ≤ 1e-3
      // (probe-observed rel 4.4e-5)
      expect(Math.abs(result.outfallVolumeM3 - RAIN_VOLUME_1) / RAIN_VOLUME_1).toBeLessThanOrEqual(1e-3)
      // equilibrium runoff = i·A, approached asymptotically (observed rel 1.1e-4)
      expect(Math.abs(result.peaks.maxRunoffCms - Q_EQ_1) / Q_EQ_1).toBeLessThanOrEqual(1e-2)
      // the engine's own continuity honesty: both magnitudes ≤ 0.5 %
      expect(Math.abs(result.continuity.runoffErrorPct)).toBeLessThanOrEqual(0.5)
      expect(Math.abs(result.continuity.routingErrorPct)).toBeLessThanOrEqual(0.5)
      // the conduit's kinematic-wave equilibrium depth vs the hand Manning
      // cubic (probe-observed abs 6.2e-6; the pin allows the numerical band)
      const c1 = result.depths.find((d) => d.id === "C1")
      expect(c1).toBeDefined()
      expect(Math.abs((c1?.maxDepthM ?? NaN) - Y_NORMAL_1)).toBeLessThanOrEqual(0.005)
      // every node + conduit reported, ascending id
      expect(result.depths.map((d) => d.id)).toEqual(["C1", "J1", "OUT1"])
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "determinism: two real runs → byte-identical result payload (fixed INP, no RNG)",
    async () => {
      const first = await runSwmmFromFile(path.join(fixtures, "swmm-runoff-balance.json"), {})
      const second = await runSwmmFromFile(path.join(fixtures, "swmm-runoff-balance.json"), {})
      expect(swmmPayloadSignature(second)).toBe(swmmPayloadSignature(first))
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "swmm-manning-conduit.json (steeper network): J1 depth vs the Manning cubic at abs ≤ 0.005, peak flow vs i·A at rel ≤ 3% (the surge allowance)",
    async () => {
      const result = await runSwmmFromFile(path.join(fixtures, "swmm-manning-conduit.json"), {})
      // volume conservation on the bigger storm
      expect(result.rain.totalVolumeM3).toBe(RAIN_VOLUME_2)
      expect(Math.abs(result.outfallVolumeM3 - RAIN_VOLUME_2) / RAIN_VOLUME_2).toBeLessThanOrEqual(1e-3)
      // the junction's max depth = the conduit's normal depth (probe abs 9.8e-6)
      const j1 = result.depths.find((d) => d.id === "J1")
      expect(Math.abs((j1?.maxDepthM ?? NaN) - Y_NORMAL_2)).toBeLessThanOrEqual(0.005)
      // peak conduit flow: kinematic-wave numerical surge over i·A
      // (probe-observed +1.0%; the pin allows 3%)
      expect(Math.abs(result.peaks.maxConduitFlowCms - Q_EQ_2) / Q_EQ_2).toBeLessThanOrEqual(0.03)
      expect(Math.abs(result.continuity.routingErrorPct)).toBeLessThanOrEqual(0.5)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "swmm-no-outfall.json → the honest no-outfall refusal (the rigid-mode analog), verbatim",
    async () => {
      const err = await expectEngineUnavailable(
        runSwmmFromFile(path.join(fixtures, "swmm-no-outfall.json"), {}),
      )
      expect(err.message).toBe(
        "the network has no outfall - runoff cannot leave the model, and simulated results are not an option",
      )
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "routingStepSec guard: 0 → the honest parameter refusal before any engine call",
    async () => {
      await expectEngineUnavailable(
        runSwmmFromFile(path.join(fixtures, "swmm-runoff-balance.json"), { routingStepSec: 0 }),
      )
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "non-JSON file path (site-notes.md) → the bridge's honest parse error, never a fabricated result",
    async () => {
      const err = await expectEngineUnavailable(
        runSwmmFromFile(path.join(fixtures, "site-notes.md"), {}),
      )
      expect(err.message).toContain("SWMM model file is not valid JSON")
    },
    TEST_TIMEOUT_MS,
  )
})
