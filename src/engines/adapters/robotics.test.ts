import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  EngineUnavailableError,
  parseKinematicsAdapterStdout,
  runKinematicsFromFile,
  validateKinematicsParameters,
  type KinematicsResult,
} from "./robotics"

/**
 * Robotics bridge tests (Slice 32 — contract §18.5/§18.6).
 *
 * Honesty rules (ADR-0006 — the chip.test.ts convention): the PURE tests feed
 * SYNTHETIC protocol strings into the bridge's parse/validate half; every
 * number asserted in the REAL-engine tests is a HAND-DERIVED closed form for
 * the planar-2R fixtures (tests/fixtures/robot-arm-*.json) — never a value
 * copied from pinocchio output.
 *
 * Closed-form derivations (the planar 2R arm, links L1/L2 in the xy-plane,
 * two RZ joints, EE frame at the tip of link 2 — §18.1):
 *   FK:   x = L1·cos q1 + L2·cos(q1+q2)
 *         y = L1·sin q1 + L2·sin(q1+q2)
 *         θ = wrapPi(q1 + q2)
 *   JAC (6×2 LOCAL_WORLD_ALIGNED, rows vx,vy,vz,wx,wy,wz):
 *         vx/dq1 = −L1·sin q1 − L2·sin(q1+q2)   vx/dq2 = −L2·sin(q1+q2)
 *         vy/dq1 =  L1·cos q1 + L2·cos(q1+q2)   vy/dq2 =  L2·cos(q1+q2)
 *         vz, wx, wy identically 0;  wz row exactly [1, 1]
 *
 * Real-engine tests run ONLY when pinocchio is importable in the venv;
 * otherwise they are skipped with an explicit printed reason.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.resolve(here, "..", "..", "..", "tests", "fixtures")
const PYTHON_BIN = process.env.EOS_PYTHON ?? "/home/z/.venv/bin/python3"

const pinAvailable = spawnSync(PYTHON_BIN, ["-c", "import pinocchio"], { timeout: 60_000 }).status === 0
if (!pinAvailable) {
  console.log(
    "[robotics.test.ts] kinematics tests SKIPPED: pinocchio importable=false (recorded honestly — no results are simulated)",
  )
}

const TEST_TIMEOUT_MS = 120_000

function sha256Of(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex")
}

/** The hand-derived closed forms (§18.1) — independent of pinocchio. */
function closedForm(l1: number, l2: number, q1: number, q2: number) {
  const wrapPi = (a: number) => ((a + Math.PI) % (2 * Math.PI)) - Math.PI
  const x = l1 * Math.cos(q1) + l2 * Math.cos(q1 + q2)
  const y = l1 * Math.sin(q1) + l2 * Math.sin(q1 + q2)
  const theta = wrapPi(q1 + q2)
  const jac = new Array<number>(12).fill(0)
  jac[0] = -l1 * Math.sin(q1) - l2 * Math.sin(q1 + q2)
  jac[1] = -l2 * Math.sin(q1 + q2)
  jac[2] = l1 * Math.cos(q1) + l2 * Math.cos(q1 + q2)
  jac[3] = l2 * Math.cos(q1 + q2)
  jac[10] = 1
  jac[11] = 1
  return { x, y, theta, jac }
}

const TOL = 1e-12

/** Synthetic success stdout in the pinned adapter protocol (no engine). */
function syntheticKinematicsStdout(): string {
  const { x, y, theta, jac } = closedForm(0.5, 0.35, Math.PI / 6, Math.PI / 4)
  return JSON.stringify({
    engineKey: "synthetic-engine",
    engineVersion: "1.2.3",
    adapterScript: "kinematics_solve.py",
    adapterHash: "b".repeat(64),
    analysis: "kinematic_analysis",
    mechanism: { kind: "planar_2r", linkCount: 2, linkLengthsMeters: [0.5, 0.35] },
    configurations: [
      {
        index: 1,
        jointsRad: [Math.PI / 6, Math.PI / 4],
        endEffector: { xMeters: x, yMeters: y, thetaRad: theta },
        jacobianRowMajor: jac,
        verification: { fkMaxAbsError: 0, jacobianMaxAbsError: 0 },
      },
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
function kinematicsPayloadSignature(result: KinematicsResult): string {
  const { stdoutTail: _s, stderrTail: _e, ...payload } = result
  return JSON.stringify(payload)
}

// ---------------------------------------------------------------------------
// Pure half (synthetic protocol strings — no engine)
// ---------------------------------------------------------------------------

describe("robotics bridge pure half (synthetic protocol strings — no engine)", () => {
  test("parseKinematicsAdapterStdout accepts a well-formed payload and returns the KinematicsResult", () => {
    const result = parseKinematicsAdapterStdout(syntheticKinematicsStdout(), "kinematics_solve.py")
    expect(result.engineKey).toBe("synthetic-engine")
    expect(result.engineVersion).toBe("1.2.3")
    expect(result.adapterScript).toBe("kinematics_solve.py")
    expect(result.adapterHash).toBe("b".repeat(64))
    expect(result.analysis).toBe("kinematic_analysis")
    expect(result.mechanism.kind).toBe("planar_2r")
    expect(result.mechanism.linkCount).toBe(2)
    expect(result.mechanism.linkLengthsMeters).toEqual([0.5, 0.35])
    expect(result.configurations).toHaveLength(1)
    const c = result.configurations[0]
    expect(c.index).toBe(1)
    expect(c.jacobianRowMajor).toHaveLength(12)
    // the hand-derived closed form at (π/6, π/4) — see the file header
    expect(Math.abs(c.endEffector.xMeters - (0.5 * Math.cos(Math.PI / 6) + 0.35 * Math.cos((5 * Math.PI) / 12)))).toBeLessThan(TOL)
    expect(Math.abs(c.endEffector.thetaRad - (5 * Math.PI) / 12)).toBeLessThan(TOL)
    expect(c.jacobianRowMajor[10]).toBe(1)
    expect(c.jacobianRowMajor[11]).toBe(1)
  })

  test('error envelope {"error": …} surfaces verbatim as EngineUnavailableError', () => {
    const stdout = JSON.stringify({
      error:
        "pinocchio's forward kinematics disagrees with the planar closed form (configuration 1: max error 1.000e-05 exceeds 1e-12) - a disagreeing kinematics result is not an option",
    })
    expect(() => parseKinematicsAdapterStdout(stdout, "kinematics_solve.py")).toThrow(EngineUnavailableError)
    try {
      parseKinematicsAdapterStdout(stdout, "kinematics_solve.py")
    } catch (err) {
      expect((err as EngineUnavailableError).message).toContain("pinocchio's forward kinematics disagrees")
    }
  })

  test("payload validation refuses malformed shapes with honest messages", () => {
    const wellFormed = JSON.parse(syntheticKinematicsStdout()) as Record<string, unknown>

    const wrongAnalysis = { ...wellFormed, analysis: "dynamics" }
    expect(() => parseKinematicsAdapterStdout(JSON.stringify(wrongAnalysis), "kinematics_solve.py")).toThrow(
      'must carry analysis: "kinematic_analysis"',
    )

    const wrongMechanismKind = {
      ...wellFormed,
      mechanism: { ...(wellFormed.mechanism as object), kind: "spatial_6r" },
    }
    expect(() => parseKinematicsAdapterStdout(JSON.stringify(wrongMechanismKind), "kinematics_solve.py")).toThrow(
      'mechanism {kind: "planar_2r", linkCount, linkLengthsMeters[2]}',
    )

    const wrongIndex = {
      ...wellFormed,
      configurations: [
        { ...((wellFormed.configurations as Record<string, unknown>[])[0]), index: 2 },
      ],
    }
    expect(() => parseKinematicsAdapterStdout(JSON.stringify(wrongIndex), "kinematics_solve.py")).toThrow(
      "configurations[0].index must be the 1-based position 1",
    )

    const elevenEntryJacobian = {
      ...wellFormed,
      configurations: [
        {
          ...((wellFormed.configurations as Record<string, unknown>[])[0]),
          jacobianRowMajor: new Array(11).fill(0),
        },
      ],
    }
    expect(() => parseKinematicsAdapterStdout(JSON.stringify(elevenEntryJacobian), "kinematics_solve.py")).toThrow(
      "jacobianRowMajor must be exactly 12 finite numbers (the 6×2 spatial Jacobian)",
    )

    const negativeResidual = {
      ...wellFormed,
      configurations: [
        {
          ...((wellFormed.configurations as Record<string, unknown>[])[0]),
          verification: { fkMaxAbsError: -1, jacobianMaxAbsError: 0 },
        },
      ],
    }
    expect(() => parseKinematicsAdapterStdout(JSON.stringify(negativeResidual), "kinematics_solve.py")).toThrow(
      "verification must carry {fkMaxAbsError, jacobianMaxAbsError} ≥ 0",
    )

    const zeroConfigurations = { ...wellFormed, configurations: [] }
    expect(() => parseKinematicsAdapterStdout(JSON.stringify(zeroConfigurations), "kinematics_solve.py")).toThrow(
      "configurations[1..8] (the §18.2 model bound)",
    )
  })

  test("validateKinematicsParameters: {} accepted; ANY parameter refused (the frozen upload)", () => {
    expect(validateKinematicsParameters({})).toEqual({})
    expect(() => validateKinematicsParameters({ linkCount: 3 })).toThrow(
      "solve_kinematics takes no parameters (the mechanism and configurations are frozen at upload)",
    )
    expect(() => validateKinematicsParameters({ anything: true })).toThrow(
      "solve_kinematics takes no parameters (the mechanism and configurations are frozen at upload)",
    )
  })

  test("export surface: runKinematicsFromFile / EngineUnavailableError exist with the pinned shapes", () => {
    expect(typeof runKinematicsFromFile).toBe("function")
    expect(typeof EngineUnavailableError).toBe("function")
  })
})

// ---------------------------------------------------------------------------
// Real-engine half (Pinocchio; skipped honestly when absent)
// ---------------------------------------------------------------------------

describe.skipIf(!pinAvailable)(
  "runKinematicsFromFile — Pinocchio kinematic analysis (real engine runs)",
  () => {
    test(
      "robot-arm-2link.json: every EE pose + Jacobian entry matches the hand-derived closed forms at 1e-12, gate residuals ≤ 1e-12",
      async () => {
        const result = await runKinematicsFromFile(path.join(fixtures, "robot-arm-2link.json"), {})

        expect(result.engineKey).toBe("pin")
        expect(result.engineVersion).toBe("4.1.0")
        expect(result.adapterScript).toBe("kinematics_solve.py")
        // adapterHash is SELF-reported — verify it independently (node:crypto)
        expect(result.adapterHash).toBe(sha256Of(path.join(here, "kinematics_solve.py")))

        expect(result.analysis).toBe("kinematic_analysis")
        expect(result.mechanism.kind).toBe("planar_2r")
        expect(result.mechanism.linkCount).toBe(2)
        expect(result.mechanism.linkLengthsMeters).toEqual([0.5, 0.35])
        expect(result.configurations).toHaveLength(4)

        const l1 = 0.5
        const l2 = 0.35
        const qs: Array<[number, number]> = [
          [Math.PI / 6, Math.PI / 4],
          [-Math.PI / 3, Math.PI / 2],
          [0, 0], // the SINGULAR fully-extended config
          [2.5, -1.9],
        ]
        result.configurations.forEach((c, i) => {
          const { x, y, theta, jac } = closedForm(l1, l2, qs[i][0], qs[i][1])
          expect(c.index).toBe(i + 1)
          expect(c.jointsRad[0]).toBeCloseTo(qs[i][0], 12)
          expect(Math.abs(c.endEffector.xMeters - x)).toBeLessThan(TOL)
          expect(Math.abs(c.endEffector.yMeters - y)).toBeLessThan(TOL)
          expect(Math.abs(c.endEffector.thetaRad - theta)).toBeLessThan(TOL)
          c.jacobianRowMajor.forEach((entry, j) => {
            expect(Math.abs(entry - jac[j])).toBeLessThan(TOL)
          })
          // the identically-zero rows (vz, wx, wy — abs() folds the engine's
          // legitimate -0 floats) and the exactly-one wz row
          expect(Math.abs(c.jacobianRowMajor[4])).toBe(0)
          expect(Math.abs(c.jacobianRowMajor[5])).toBe(0)
          expect(c.jacobianRowMajor[10]).toBe(1)
          expect(c.jacobianRowMajor[11]).toBe(1)
          expect(c.verification.fkMaxAbsError).toBeLessThanOrEqual(TOL)
          expect(c.verification.jacobianMaxAbsError).toBeLessThanOrEqual(TOL)
        })
      },
      TEST_TIMEOUT_MS,
    )

    test(
      "robot-arm-long.json: the second arm incl. the folded-back q2=π singular (θ wrapped to −π/2)",
      async () => {
        const result = await runKinematicsFromFile(path.join(fixtures, "robot-arm-long.json"), {})
        expect(result.mechanism.linkLengthsMeters).toEqual([1.2, 0.8])
        expect(result.configurations).toHaveLength(3)
        const l1 = 1.2
        const l2 = 0.8
        const qs: Array<[number, number]> = [
          [Math.PI / 12, -Math.PI / 6],
          [-2.1, 2.6],
          [Math.PI / 2, Math.PI], // the FOLDED-BACK singular
        ]
        result.configurations.forEach((c, i) => {
          const { x, y, theta, jac } = closedForm(l1, l2, qs[i][0], qs[i][1])
          expect(Math.abs(c.endEffector.xMeters - x)).toBeLessThan(TOL)
          expect(Math.abs(c.endEffector.yMeters - y)).toBeLessThan(TOL)
          expect(Math.abs(c.endEffector.thetaRad - theta)).toBeLessThan(TOL)
          c.jacobianRowMajor.forEach((entry, j) => {
            expect(Math.abs(entry - jac[j])).toBeLessThan(TOL)
          })
        })
        // the folded config: EE at (≈0, 0.4), θ = −π/2 (the wrap convention)
        const folded = result.configurations[2]
        expect(Math.abs(folded.endEffector.xMeters)).toBeLessThan(TOL)
        expect(Math.abs(folded.endEffector.yMeters - 0.4)).toBeLessThan(TOL)
        expect(Math.abs(folded.endEffector.thetaRad + Math.PI / 2)).toBeLessThan(TOL)
      },
      TEST_TIMEOUT_MS,
    )

    test(
      "determinism: two real runs → byte-identical result payload (pinned engine, fixed key order)",
      async () => {
        const first = await runKinematicsFromFile(path.join(fixtures, "robot-arm-2link.json"), {})
        const second = await runKinematicsFromFile(path.join(fixtures, "robot-arm-2link.json"), {})
        expect(kinematicsPayloadSignature(second)).toBe(kinematicsPayloadSignature(first))
      },
      TEST_TIMEOUT_MS,
    )

    test(
      "robot-arm-invalid-kind.json (mechanism.kind spatial_6r) → the §18.2 v1-class refusal verbatim",
      async () => {
        const err = await expectEngineUnavailable(
          runKinematicsFromFile(path.join(fixtures, "robot-arm-invalid-kind.json"), {}),
        )
        expect(err.message).toContain('robot model mechanism.kind must be "planar_2r"')
      },
      TEST_TIMEOUT_MS,
    )

    test(
      "robot-arm-bad-length.json (link length 0) → the §18.2 range refusal verbatim",
      async () => {
        const err = await expectEngineUnavailable(
          runKinematicsFromFile(path.join(fixtures, "robot-arm-bad-length.json"), {}),
        )
        expect(err.message).toContain("mechanism.linkLengthsMeters[1] must be a finite number > 0 and ≤ 10 (meters)")
      },
      TEST_TIMEOUT_MS,
    )

    test(
      "a non-empty parameter set → the frozen-upload refusal (never silently ignored)",
      async () => {
        const err = await expectEngineUnavailable(
          runKinematicsFromFile(path.join(fixtures, "robot-arm-2link.json"), { meshRefinement: 4 }),
        )
        expect(err.message).toBe("solve_kinematics takes no parameters (the mechanism and configurations are frozen at upload)")
      },
      TEST_TIMEOUT_MS,
    )

    test(
      "non-JSON file path (site-notes.md) → the bridge's honest parse error, never a fabricated result",
      async () => {
        const err = await expectEngineUnavailable(
          runKinematicsFromFile(path.join(fixtures, "site-notes.md"), {}),
        )
        expect(err.message).toContain("robot model file is not valid JSON")
      },
      TEST_TIMEOUT_MS,
    )
  },
)
