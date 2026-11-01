import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  EngineUnavailableError,
  parseImpactAdapterStdout,
  runImpactFromFile,
  validateImpactParameters,
  type ImpactResult,
} from "./physics"

/**
 * Physics bridge tests (Slice 33 — contract §19.5/§19.6).
 *
 * Honesty rules (ADR-0006 — the robotics.test.ts convention): the PURE tests
 * feed SYNTHETIC protocol strings into the bridge's parse/validate half;
 * every number asserted in the REAL-engine tests is a HAND-DERIVED closed
 * form for the drop-impact fixtures (tests/fixtures/impact-drop-*.json) —
 * never a value copied from pybullet output.
 *
 * Closed-form derivations (the frozen v1 drop_impact mechanism — §19.1: a
 * sphere of radius r released from rest with center at height h over a
 * static ground plane, timestep dt = 1/240 s, semi-implicit Euler):
 *   free fall (discrete, velocity-first integrator):
 *         z_n = h − ½·g·dt²·n(n+1)      vz_n = −g·dt·n
 *   contact time  t* = sqrt(2(h−r)/g)
 *   impact speed  v* = sqrt(2·g·(h−r))
 *   rebound peak  r + e²·(h−r)   (energy: v_up = e·v*, peak = r + v_up²/2g)
 *
 * Real-engine tests run ONLY when pybullet is importable in the venv;
 * otherwise they are skipped with an explicit printed reason.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.resolve(here, "..", "..", "..", "tests", "fixtures")
const PYTHON_BIN = process.env.EOS_PYTHON ?? "/home/z/.venv/bin/python3"

const pybulletAvailable =
  spawnSync(PYTHON_BIN, ["-c", "import pybullet"], { timeout: 60_000 }).status === 0
if (!pybulletAvailable) {
  console.log(
    "[physics.test.ts] impact tests SKIPPED: pybullet importable=false (recorded honestly — no results are simulated)",
  )
}

const TEST_TIMEOUT_MS = 120_000

/** the fixture's frozen mechanism (§19.1 — the Slice-28 probe drop). */
const MASS = 1.0
const RADIUS = 0.1
const HEIGHT = 1.0
const GRAVITY = 9.81
const DT = 1 / 240
const T_STAR = Math.sqrt((2 * (HEIGHT - RADIUS)) / GRAVITY)
const V_STAR = Math.sqrt(2 * GRAVITY * (HEIGHT - RADIUS))

function sha256Of(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex")
}

/** The hand-derived DISCRETE closed forms (§19.1) — independent of pybullet. */
function discreteFallHeight(n: number): number {
  return HEIGHT - 0.5 * GRAVITY * DT * DT * n * (n + 1)
}
function discreteFallSpeed(n: number): number {
  return -GRAVITY * DT * n
}

/** Synthetic success stdout in the pinned adapter protocol (no engine). */
function syntheticImpactStdout(): string {
  const firstContact = 104 // a plausible step (the probe's, §19.1)
  const samples = Array.from({ length: firstContact + 240 }, (_, i) => ({
    index: i + 1,
    timeSeconds: (i + 1) * DT,
    centerHeightMeters: i + 1 < firstContact ? discreteFallHeight(i + 1) : RADIUS,
    velocityZMetersPerSecond: i + 1 < firstContact ? discreteFallSpeed(i + 1) : 0,
  }))
  return JSON.stringify({
    engineKey: "synthetic-engine",
    engineVersion: "1.2.3",
    adapterScript: "impact_solve.py",
    adapterHash: "b".repeat(64),
    analysis: "impact_simulation",
    mechanism: { kind: "drop_impact", massKilograms: MASS, radiusMeters: RADIUS, restitution: 0 },
    drop: { centerHeightMeters: HEIGHT, gravityMetersPerSecondSquared: GRAVITY },
    timestepSeconds: DT,
    samples,
    impact: {
      firstContactStep: firstContact,
      firstContactTimeSeconds: firstContact * DT,
      closedFormContactTimeSeconds: T_STAR,
      timeResidualSeconds: firstContact * DT - T_STAR,
      impactSpeedMetersPerSecond: Math.abs(discreteFallSpeed(firstContact - 1)),
      closedFormImpactSpeedMetersPerSecond: V_STAR,
      speedResidualMetersPerSecond: Math.abs(discreteFallSpeed(firstContact - 1)) - V_STAR,
      reboundPeakHeightMeters: RADIUS,
      closedFormReboundPeakMeters: RADIUS,
      reboundResidualMeters: 0,
    },
    verification: { maxPreContactHeightError: 0, maxPreContactSpeedError: 0 },
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
function impactPayloadSignature(result: ImpactResult): string {
  const { stdoutTail: _s, stderrTail: _e, ...payload } = result
  return JSON.stringify(payload)
}

// ---------------------------------------------------------------------------
// Pure half (synthetic protocol strings — no engine)
// ---------------------------------------------------------------------------

describe("physics bridge pure half (synthetic protocol strings — no engine)", () => {
  test("parseImpactAdapterStdout accepts a well-formed payload and returns the ImpactResult", () => {
    const result = parseImpactAdapterStdout(syntheticImpactStdout(), "impact_solve.py")
    expect(result.engineKey).toBe("synthetic-engine")
    expect(result.engineVersion).toBe("1.2.3")
    expect(result.adapterScript).toBe("impact_solve.py")
    expect(result.adapterHash).toBe("b".repeat(64))
    expect(result.analysis).toBe("impact_simulation")
    expect(result.mechanism.kind).toBe("drop_impact")
    expect(result.mechanism.massKilograms).toBe(MASS)
    expect(result.mechanism.radiusMeters).toBe(RADIUS)
    expect(result.mechanism.restitution).toBe(0)
    expect(result.drop.centerHeightMeters).toBe(HEIGHT)
    expect(result.drop.gravityMetersPerSecondSquared).toBe(GRAVITY)
    expect(result.timestepSeconds).toBeCloseTo(1 / 240, 15)
    expect(result.samples).toHaveLength(104 + 240)
    // the hand-derived discrete closed form at n=1 and n=50 — see the header
    expect(result.samples[0].centerHeightMeters).toBeCloseTo(discreteFallHeight(1), 12)
    expect(result.samples[49].centerHeightMeters).toBeCloseTo(discreteFallHeight(50), 12)
    expect(result.samples[49].velocityZMetersPerSecond).toBeCloseTo(discreteFallSpeed(50), 12)
    expect(result.impact.firstContactStep).toBe(104)
    // t* = sqrt(2·0.9/9.81) = 0.428006… (the §19.1 hand derivation)
    expect(result.impact.closedFormContactTimeSeconds).toBeCloseTo(T_STAR, 12)
    expect(result.impact.closedFormImpactSpeedMetersPerSecond).toBeCloseTo(V_STAR, 12)
    expect(result.verification.maxPreContactHeightError).toBe(0)
  })

  test('error envelope {"error": …} surfaces verbatim as EngineUnavailableError', () => {
    const stdout = JSON.stringify({
      error:
        "pybullet's free-fall trajectory disagrees with the discrete semi-implicit closed form (max height error 1.000e-05 exceeds 1e-09) - a disagreeing trajectory is not an option",
    })
    expect(() => parseImpactAdapterStdout(stdout, "impact_solve.py")).toThrow(EngineUnavailableError)
    try {
      parseImpactAdapterStdout(stdout, "impact_solve.py")
    } catch (err) {
      expect((err as EngineUnavailableError).message).toContain("pybullet's free-fall trajectory disagrees")
    }
  })

  test("payload validation refuses malformed shapes with honest messages", () => {
    const wellFormed = JSON.parse(syntheticImpactStdout()) as Record<string, unknown>

    const wrongAnalysis = { ...wellFormed, analysis: "dynamics" }
    expect(() => parseImpactAdapterStdout(JSON.stringify(wrongAnalysis), "impact_solve.py")).toThrow(
      'must carry analysis: "impact_simulation"',
    )

    const wrongMechanismKind = {
      ...wellFormed,
      mechanism: { ...(wellFormed.mechanism as object), kind: "pendulum" },
    }
    expect(() => parseImpactAdapterStdout(JSON.stringify(wrongMechanismKind), "impact_solve.py")).toThrow(
      'mechanism {kind: "drop_impact", massKilograms, radiusMeters, restitution}',
    )

    const wrongIndex = {
      ...wellFormed,
      samples: [
        { ...((wellFormed.samples as Record<string, unknown>[])[0]), index: 2 },
        ...((wellFormed.samples as Record<string, unknown>[]).slice(1)),
      ],
    }
    expect(() => parseImpactAdapterStdout(JSON.stringify(wrongIndex), "impact_solve.py")).toThrow(
      "samples[0] must carry {index: 1, timeSeconds, centerHeightMeters, velocityZMetersPerSecond}",
    )

    const oneSample = { ...wellFormed, samples: (wellFormed.samples as unknown[]).slice(0, 1) }
    expect(() => parseImpactAdapterStdout(JSON.stringify(oneSample), "impact_solve.py")).toThrow(
      "samples[2..] (the trajectory)",
    )

    const earlyContact = {
      ...wellFormed,
      impact: { ...(wellFormed.impact as object), firstContactStep: 1 },
    }
    expect(() => parseImpactAdapterStdout(JSON.stringify(earlyContact), "impact_solve.py")).toThrow(
      "impact.firstContactStep must be an integer ≥ 2",
    )

    const missingImpactField = {
      ...wellFormed,
      impact: { ...(wellFormed.impact as object), reboundPeakHeightMeters: undefined },
    }
    expect(() => parseImpactAdapterStdout(JSON.stringify(missingImpactField), "impact_solve.py")).toThrow(
      "impact.reboundPeakHeightMeters must be a finite number",
    )

    const negativeResidual = {
      ...wellFormed,
      verification: { maxPreContactHeightError: -1, maxPreContactSpeedError: 0 },
    }
    expect(() => parseImpactAdapterStdout(JSON.stringify(negativeResidual), "impact_solve.py")).toThrow(
      "verification must carry {maxPreContactHeightError, maxPreContactSpeedError} ≥ 0",
    )

    const zeroTimestep = { ...wellFormed, timestepSeconds: 0 }
    expect(() => parseImpactAdapterStdout(JSON.stringify(zeroTimestep), "impact_solve.py")).toThrow(
      "timestepSeconds > 0",
    )
  })

  test("validateImpactParameters: {} accepted; ANY parameter refused (the frozen upload)", () => {
    expect(validateImpactParameters({})).toEqual({})
    expect(() => validateImpactParameters({ restitution: 0.9 })).toThrow(
      "simulate_impact takes no parameters (the mechanism and the drop are frozen at upload)",
    )
    expect(() => validateImpactParameters({ anything: true })).toThrow(
      "simulate_impact takes no parameters (the mechanism and the drop are frozen at upload)",
    )
  })

  test("export surface: runImpactFromFile / EngineUnavailableError exist with the pinned shapes", () => {
    expect(typeof runImpactFromFile).toBe("function")
    expect(typeof EngineUnavailableError).toBe("function")
  })
})

// ---------------------------------------------------------------------------
// Real-engine half (PyBullet; skipped honestly when absent)
// ---------------------------------------------------------------------------

describe.skipIf(!pybulletAvailable)(
  "runImpactFromFile — PyBullet drop-impact simulation (real engine runs)",
  () => {
    test(
      "impact-drop-sphere.json: the trajectory matches the DISCRETE closed forms, the impact summary matches t*/v*, gate residuals ≤ 1e-9",
      async () => {
        const result = await runImpactFromFile(path.join(fixtures, "impact-drop-sphere.json"), {})

        expect(result.engineKey).toBe("pybullet")
        expect(result.engineVersion).toBe("3.2.7")
        expect(result.adapterScript).toBe("impact_solve.py")
        // adapterHash is SELF-reported — verify it independently (node:crypto)
        expect(result.adapterHash).toBe(sha256Of(path.join(here, "impact_solve.py")))

        expect(result.analysis).toBe("impact_simulation")
        expect(result.mechanism.kind).toBe("drop_impact")
        expect(result.mechanism.massKilograms).toBe(MASS)
        expect(result.mechanism.radiusMeters).toBe(RADIUS)
        expect(result.mechanism.restitution).toBe(0)
        expect(result.drop.centerHeightMeters).toBe(HEIGHT)
        expect(result.drop.gravityMetersPerSecondSquared).toBe(GRAVITY)
        expect(result.timestepSeconds).toBeCloseTo(1 / 240, 15)

        const fc = result.impact.firstContactStep
        expect(fc).toBeGreaterThanOrEqual(2)
        // the horizon: first contact + exactly 240 steps (§19.4)
        expect(result.samples).toHaveLength(fc + 240)

        // every PRE-CONTACT sample against the discrete semi-implicit forms
        for (const s of result.samples.slice(0, fc - 1)) {
          expect(Math.abs(s.centerHeightMeters - discreteFallHeight(s.index))).toBeLessThan(1e-9)
          expect(Math.abs(s.velocityZMetersPerSecond - discreteFallSpeed(s.index))).toBeLessThan(1e-9)
        }
        // the gate residuals the adapter itself computed
        expect(result.verification.maxPreContactHeightError).toBeLessThanOrEqual(1e-9)
        expect(result.verification.maxPreContactSpeedError).toBeLessThanOrEqual(1e-9)

        // the impact summary vs the continuous closed forms (hand-derived):
        // t* = sqrt(2·0.9/9.81) ≈ 0.428006 s — one/two 240 Hz quanta of the
        // measured step time (§19.1: the solver reports contact on overlap)
        expect(result.impact.closedFormContactTimeSeconds).toBeCloseTo(T_STAR, 12)
        expect(Math.abs(result.impact.firstContactTimeSeconds - T_STAR)).toBeLessThanOrEqual(2 * DT + 1e-12)
        // v* = sqrt(2·9.81·0.9) ≈ 4.200714 m/s — within 3·g·dt of the
        // last pre-contact speed
        expect(result.impact.closedFormImpactSpeedMetersPerSecond).toBeCloseTo(V_STAR, 12)
        expect(Math.abs(result.impact.impactSpeedMetersPerSecond - V_STAR)).toBeLessThanOrEqual(3 * GRAVITY * DT)
        // e = 0: no rebound — the post-contact peak IS the contact height
        // (§19.1 probed: rest 0.09999 = r − 1e-5 penetration, |vz| at rest 1.5e-15)
        expect(result.impact.closedFormReboundPeakMeters).toBeCloseTo(RADIUS, 12)
        expect(Math.abs(result.impact.reboundPeakHeightMeters - RADIUS)).toBeLessThanOrEqual(0.02)
        expect(Math.abs(result.impact.reboundPeakHeightMeters - 0.09999)).toBeLessThanOrEqual(0.005) // engine behavior, probed
      },
      TEST_TIMEOUT_MS,
    )

    test(
      "impact-drop-bounce.json: the rebound rides the ENERGY envelope (dissipative below r + e²(h−r), never above) — the measured peak pinned as engine behavior",
      async () => {
        const result = await runImpactFromFile(path.join(fixtures, "impact-drop-bounce.json"), {})
        expect(result.mechanism.restitution).toBe(0.6)
        // energy: v_up = e·v*, peak = r + v_up²/(2g) = r + e²(h−r)
        const peak_cf = RADIUS + 0.6 * 0.6 * (HEIGHT - RADIUS)
        expect(peak_cf).toBeCloseTo(0.424, 12)
        expect(result.impact.closedFormReboundPeakMeters).toBeCloseTo(peak_cf, 12)
        // the GATE: a dissipative LCP solver returns LESS than the ideal —
        // §19.1 probed live: ratio 0.419 < e (Bullet's restitution
        // under-delivers at 240 Hz) — but NEVER more (energy creation is a
        // refusal). The measured peak is pinned as ENGINE BEHAVIOR (the
        // chip-lane empirical-count precedent), tolerance 0.02 for build
        // variance.
        expect(result.impact.reboundPeakHeightMeters).toBeLessThanOrEqual(peak_cf + 0.01)
        expect(result.impact.reboundPeakHeightMeters).toBeGreaterThanOrEqual(RADIUS - 0.02)
        expect(Math.abs(result.impact.reboundPeakHeightMeters - 0.250143)).toBeLessThanOrEqual(0.02)
        expect(result.impact.reboundResidualMeters).toBeLessThan(0) // dissipative, as probed
        // the same impact-time/speed closed forms hold for the bounced drop
        expect(Math.abs(result.impact.firstContactTimeSeconds - T_STAR)).toBeLessThanOrEqual(2 * DT + 1e-12)
        expect(Math.abs(result.impact.impactSpeedMetersPerSecond - V_STAR)).toBeLessThanOrEqual(3 * GRAVITY * DT)
      },
      TEST_TIMEOUT_MS,
    )

    test(
      "determinism: two real runs → byte-identical result payload (DIRECT mode, fixed timestep, pinned build)",
      async () => {
        const first = await runImpactFromFile(path.join(fixtures, "impact-drop-bounce.json"), {})
        const second = await runImpactFromFile(path.join(fixtures, "impact-drop-bounce.json"), {})
        expect(impactPayloadSignature(second)).toBe(impactPayloadSignature(first))
      },
      TEST_TIMEOUT_MS,
    )

    test(
      "impact-drop-invalid-kind.json (mechanism.kind pendulum) → the §19.2 v1-class refusal verbatim",
      async () => {
        const err = await expectEngineUnavailable(
          runImpactFromFile(path.join(fixtures, "impact-drop-invalid-kind.json"), {}),
        )
        expect(err.message).toContain('impact model mechanism.kind must be "drop_impact"')
      },
      TEST_TIMEOUT_MS,
    )

    test(
      "impact-drop-bad-height.json (center below the contact height) → the §19.2 cross-field refusal verbatim",
      async () => {
        const err = await expectEngineUnavailable(
          runImpactFromFile(path.join(fixtures, "impact-drop-bad-height.json"), {}),
        )
        expect(err.message).toContain("drop.centerHeightMeters must be a finite number > radius (0.1 m, the contact height) and ≤ 50 (meters)")
      },
      TEST_TIMEOUT_MS,
    )

    test(
      "a non-empty parameter set → the frozen-upload refusal (never silently ignored)",
      async () => {
        const err = await expectEngineUnavailable(
          runImpactFromFile(path.join(fixtures, "impact-drop-sphere.json"), { restitution: 0.9 }),
        )
        expect(err.message).toBe("simulate_impact takes no parameters (the mechanism and the drop are frozen at upload)")
      },
      TEST_TIMEOUT_MS,
    )

    test(
      "non-JSON file path (site-notes.md) → the bridge's honest parse error, never a fabricated result",
      async () => {
        const err = await expectEngineUnavailable(
          runImpactFromFile(path.join(fixtures, "site-notes.md"), {}),
        )
        expect(err.message).toContain("impact model file is not valid JSON")
      },
      TEST_TIMEOUT_MS,
    )
  },
)
