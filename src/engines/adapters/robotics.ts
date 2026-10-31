/**
 * Engineering OS — engine-adapter bridge for kinematic analysis (Pinocchio,
 * pip distribution `pin`).
 *
 * CONTRACT OWNER: TL (pinned in docs/00-architecture/phase5-disciplines-
 * contract.md §18.5, Slice 32 — the robotics lane the Slice-28 license-first
 * probe opened). REAL engine adapter:
 *   - eos-robot-arm-model/1 JSON (contract §18.2) → `kinematics_solve.py`
 * The script runs as an arm's-length subprocess of the venv python
 * (EOS_PYTHON-overridable) with the {storagePath, parameters} request JSON on
 * STDIN — the exact protocol of chip.ts — and speaks the strict JSON protocol
 * on stdout: success = the payload below (every number copied VERBATIM from
 * the Pinocchio forward-kinematics/Jacobian computation, with the adapter's
 * own closed-form residuals in `verification`), failure = {"error": …} exit 1.
 *
 * Single engine by design (§18.3): Pinocchio computes every number; the
 * planar closed forms are the GATES inside the adapter (a disagreeing
 * kinematics result is refused, never stored — the flip-flop-gate precedent).
 *
 * Every failure — missing venv, missing engine, invalid model, the
 * FK/Jacobian closed-form refusals, adapter crash, timeout, malformed
 * payload — surfaces as an honest `EngineUnavailableError` (mapped to 422
 * `engine_unavailable` by the broker); nothing is ever fabricated
 * (ADR-0005, ADR-0006).
 */

import { execFile } from "node:child_process"
import path from "node:path"
import { promisify } from "node:util"

import {
  ADAPTER_TAIL_CHARS,
  EngineUnavailableError,
  adapterScriptPath,
  isPlainObject,
  parseAdapterStdoutObject,
  validateAdapterEnvelope,
} from "./quantities"

export { EngineUnavailableError }

/** Interpreter hosting the real engines (same override the other bridges honour). */
const PYTHON_BIN = process.env.EOS_PYTHON ?? "/home/z/.venv/bin/python3"

/** Hard stop for a hung adapter process — never wait forever for an engine. */
const ADAPTER_TIMEOUT_MS = 120_000

const KINEMATICS_ADAPTER_SCRIPT = "kinematics_solve.py"

// ---------------------------------------------------------------------------
// Types (the bridge-half of the eos-robot-kinematics/1 numbers; the broker
// adds the document identity fields — format/sourceArtifactName — when storing)
// ---------------------------------------------------------------------------

export interface KinematicsConfiguration {
  index: number
  jointsRad: [number, number]
  endEffector: { xMeters: number; yMeters: number; thetaRad: number }
  /** the 6×2 LOCAL_WORLD_ALIGNED frame Jacobian, row-major (12 numbers — §18.1's shape trap: the FULL spatial Jacobian) */
  jacobianRowMajor: number[]
  verification: { fkMaxAbsError: number; jacobianMaxAbsError: number }
}

export interface KinematicsResult {
  engineKey: string
  engineVersion: string
  /** adapter script file name, e.g. "kinematics_solve.py" */
  adapterScript: string
  /** sha256 of the adapter script content (recorded in provenance) */
  adapterHash: string
  analysis: "kinematic_analysis"
  mechanism: { kind: "planar_2r"; linkCount: number; linkLengthsMeters: [number, number] }
  configurations: KinematicsConfiguration[]
  /** last 2000 chars of the adapter subprocess stdout, verbatim (broker execution record) */
  stdoutTail?: string
  /** last 2000 chars of the adapter subprocess stderr, verbatim (broker execution record) */
  stderrTail?: string
}

// ---------------------------------------------------------------------------
// Parameter validation (pure — unit-tested in robotics.test.ts)
// ---------------------------------------------------------------------------

/**
 * Validate the solve_kinematics parameters; throws honestly. Pure. The op
 * takes NO parameters by design (§18.3 — the mechanism and the configuration
 * set are frozen at upload; a non-empty parameter set is refused, never
 * silently ignored).
 */
export function validateKinematicsParameters(parameters: Record<string, unknown>): Record<string, never> {
  if (Object.keys(parameters).length !== 0) {
    throw new EngineUnavailableError("solve_kinematics takes no parameters (the mechanism and configurations are frozen at upload)")
  }
  return {}
}

// ---------------------------------------------------------------------------
// Payload validation (pure — unit-tested in robotics.test.ts)
// ---------------------------------------------------------------------------

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

/** Validate the kinematics adapter's stdout payload. Pure; throws honestly. */
export function validateKinematicsPayload(
  parsed: Record<string, unknown>,
  script: string,
): Pick<
  KinematicsResult,
  "analysis" | "mechanism" | "configurations"
> {
  if (parsed.analysis !== "kinematic_analysis") {
    throw new EngineUnavailableError(`adapter ${script} payload must carry analysis: "kinematic_analysis"`)
  }
  const { mechanism, configurations } = parsed
  if (
    !isPlainObject(mechanism) ||
    mechanism.kind !== "planar_2r" ||
    !isFiniteNumber(mechanism.linkCount) ||
    !Array.isArray(mechanism.linkLengthsMeters) ||
    mechanism.linkLengthsMeters.length !== 2 ||
    !mechanism.linkLengthsMeters.every((v: unknown) => isFiniteNumber(v) && v > 0)
  ) {
    throw new EngineUnavailableError(
      `adapter ${script} payload must carry mechanism {kind: "planar_2r", linkCount, linkLengthsMeters[2]}`,
    )
  }
  if (!Array.isArray(configurations) || configurations.length < 1 || configurations.length > 8) {
    throw new EngineUnavailableError(
      `adapter ${script} payload must carry configurations[1..8] (the §18.2 model bound)`,
    )
  }
  configurations.forEach((c: unknown, i: number) => {
    if (!isPlainObject(c)) {
      throw new EngineUnavailableError(`adapter ${script} payload configurations[${i}] is not an object`)
    }
    if (!isFiniteNumber(c.index) || !Number.isInteger(c.index) || c.index !== i + 1) {
      throw new EngineUnavailableError(`adapter ${script} payload configurations[${i}].index must be the 1-based position ${i + 1}`)
    }
    if (!Array.isArray(c.jointsRad) || c.jointsRad.length !== 2 || !c.jointsRad.every((v: unknown) => isFiniteNumber(v))) {
      throw new EngineUnavailableError(`adapter ${script} payload configurations[${i}].jointsRad must be exactly 2 finite numbers`)
    }
    const ee = c.endEffector
    if (
      !isPlainObject(ee) ||
      !isFiniteNumber(ee.xMeters) ||
      !isFiniteNumber(ee.yMeters) ||
      !isFiniteNumber(ee.thetaRad)
    ) {
      throw new EngineUnavailableError(
        `adapter ${script} payload configurations[${i}].endEffector must carry {xMeters, yMeters, thetaRad}`,
      )
    }
    if (!Array.isArray(c.jacobianRowMajor) || c.jacobianRowMajor.length !== 12 || !c.jacobianRowMajor.every((v: unknown) => isFiniteNumber(v))) {
      throw new EngineUnavailableError(
        `adapter ${script} payload configurations[${i}].jacobianRowMajor must be exactly 12 finite numbers (the 6×2 spatial Jacobian)`,
      )
    }
    const verification = c.verification
    if (
      !isPlainObject(verification) ||
      !isFiniteNumber(verification.fkMaxAbsError) ||
      !isFiniteNumber(verification.jacobianMaxAbsError) ||
      verification.fkMaxAbsError < 0 ||
      verification.jacobianMaxAbsError < 0
    ) {
      throw new EngineUnavailableError(
        `adapter ${script} payload configurations[${i}].verification must carry {fkMaxAbsError, jacobianMaxAbsError} ≥ 0`,
      )
    }
  })
  return {
    analysis: "kinematic_analysis",
    mechanism: mechanism as unknown as KinematicsResult["mechanism"],
    configurations: configurations as unknown as KinematicsResult["configurations"],
  }
}

/** Parse + validate the kinematics adapter's full stdout protocol. Pure. */
export function parseKinematicsAdapterStdout(stdout: string, script: string): KinematicsResult {
  const parsed = parseAdapterStdoutObject(stdout, script)
  const envelope = validateAdapterEnvelope(parsed, script)
  const payload = validateKinematicsPayload(parsed, script)
  return {
    engineKey: envelope.engineKey,
    engineVersion: envelope.engineVersion,
    adapterScript: envelope.adapterScript,
    adapterHash: envelope.adapterHash,
    ...payload,
  }
}

// ---------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------

interface ExecFailure {
  code?: number | string | undefined
  killed?: boolean
  stdout?: string | undefined
  stderr?: string | undefined
  message: string
}

function errorFromExecFailure(script: string, err: ExecFailure): EngineUnavailableError {
  // Adapter ran and reported an honest {"error": …} envelope (exit 1).
  if (err.stdout) {
    try {
      const parsed = JSON.parse(err.stdout) as Record<string, unknown>
      if (isPlainObject(parsed) && typeof parsed.error === "string") {
        return new EngineUnavailableError(parsed.error)
      }
    } catch {
      // not JSON — fall through to the generic messages below
    }
  }
  if (err.killed) {
    return new EngineUnavailableError(
      `kinematics adapter (${script}) timed out after ${ADAPTER_TIMEOUT_MS}ms and was terminated`,
    )
  }
  if (err.code === "ENOENT") {
    return new EngineUnavailableError(
      `python interpreter not found at ${PYTHON_BIN} — the engine venv is not deployed on this host (${err.message})`,
    )
  }
  const stderrTail = (err.stderr ?? "").trim().slice(-400)
  return new EngineUnavailableError(
    `kinematics adapter (${script}) failed with exit code ${String(err.code)}${stderrTail ? `: ${stderrTail}` : ""}`,
  )
}

/**
 * Run a REAL kinematic analysis (Pinocchio forward kinematics + the
 * LOCAL_WORLD_ALIGNED frame Jacobian, both gated against the planar closed
 * forms inside the adapter) over a stored eos-robot-arm-model/1 JSON file.
 * Throws `EngineUnavailableError` with an honest message for every failure
 * (invalid model, the FK/Jacobian closed-form refusals, missing engines).
 * The result carries the subprocess stdout/stderr tails (verbatim, last 2000
 * chars) for the broker execution record.
 */
export async function runKinematicsFromFile(
  absPath: string,
  parameters: Record<string, unknown>,
): Promise<KinematicsResult> {
  validateKinematicsParameters(parameters)
  const scriptPath = adapterScriptPath(KINEMATICS_ADAPTER_SCRIPT)
  const request = JSON.stringify({
    storagePath: path.resolve(absPath),
    parameters: {},
  })
  let run: { stdout: string; stderr: string }
  try {
    const result = await new Promise<{ stdout: string | Buffer; stderr: string | Buffer }>(
      (resolve, reject) => {
        execFile(
          PYTHON_BIN,
          [scriptPath],
          { timeout: ADAPTER_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
          (err, stdout, stderr) => {
            if (err) {
              reject(errorFromExecFailure(KINEMATICS_ADAPTER_SCRIPT, { ...(err as ExecFailure), stdout: String(stdout), stderr: String(stderr) }))
              return
            }
            resolve({ stdout: String(stdout), stderr: String(stderr) })
          },
        ).stdin?.end(request, "utf8")
      },
    )
    run = { stdout: String(result.stdout), stderr: String(result.stderr) }
  } catch (err) {
    if (err instanceof EngineUnavailableError) throw err
    throw errorFromExecFailure(KINEMATICS_ADAPTER_SCRIPT, err as ExecFailure)
  }
  const parsed = parseKinematicsAdapterStdout(run.stdout, KINEMATICS_ADAPTER_SCRIPT)
  return {
    ...parsed,
    stdoutTail: run.stdout.slice(-ADAPTER_TAIL_CHARS),
    stderrTail: run.stderr.slice(-ADAPTER_TAIL_CHARS),
  }
}
