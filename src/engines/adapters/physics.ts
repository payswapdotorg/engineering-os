/**
 * Engineering OS — engine-adapter bridge for drop-impact simulation
 * (PyBullet, pip distribution `pybullet`).
 *
 * CONTRACT OWNER: TL (pinned in docs/00-architecture/phase5-disciplines-
 * contract.md §19.5, Slice 33 — the physics lane, the LAST Slice-28
 * license-first candidate). REAL engine adapter:
 *   - eos-impact-model/1 JSON (contract §19.2) → `impact_solve.py`
 * The script runs as an arm's-length subprocess of the venv python
 * (EOS_PYTHON-overridable) with the {storagePath, parameters} request JSON on
 * STDIN — the exact protocol of chip.ts — and speaks the strict JSON protocol
 * on stdout: success = the payload below (every number copied VERBATIM from
 * the PyBullet DIRECT-mode 240 Hz simulation, with the adapter's own
 * closed-form residuals in `impact`/`verification`), failure = {"error": …}
 * exit 1.
 *
 * Single engine by design (§19.3): PyBullet computes every number; the
 * hand-derived closed forms are the GATES inside the adapter (a disagreeing
 * trajectory, impact time, impact speed or rebound is refused, never stored —
 * the flip-flop-gate precedent).
 *
 * Every failure — missing venv, missing engine, invalid model, the
 * closed-form refusals, adapter crash, timeout, malformed payload — surfaces
 * as an honest `EngineUnavailableError` (mapped to 422 `engine_unavailable`
 * by the broker); nothing is ever fabricated (ADR-0005, ADR-0006).
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

const IMPACT_ADAPTER_SCRIPT = "impact_solve.py"

// ---------------------------------------------------------------------------
// Types (the bridge-half of the eos-impact-simulation/1 numbers; the broker
// adds the document identity fields — format/sourceArtifactName — when storing)
// ---------------------------------------------------------------------------

export interface ImpactSample {
  index: number
  timeSeconds: number
  centerHeightMeters: number
  velocityZMetersPerSecond: number
}

export interface ImpactSummary {
  firstContactStep: number
  firstContactTimeSeconds: number
  closedFormContactTimeSeconds: number
  timeResidualSeconds: number
  impactSpeedMetersPerSecond: number
  closedFormImpactSpeedMetersPerSecond: number
  speedResidualMetersPerSecond: number
  reboundPeakHeightMeters: number
  closedFormReboundPeakMeters: number
  reboundResidualMeters: number
}

export interface ImpactResult {
  engineKey: string
  engineVersion: string
  /** adapter script file name, e.g. "impact_solve.py" */
  adapterScript: string
  /** sha256 of the adapter script content (recorded in provenance) */
  adapterHash: string
  analysis: "impact_simulation"
  mechanism: {
    kind: "drop_impact"
    massKilograms: number
    radiusMeters: number
    restitution: number
  }
  drop: { centerHeightMeters: number; gravityMetersPerSecondSquared: number }
  timestepSeconds: number
  samples: ImpactSample[]
  impact: ImpactSummary
  verification: { maxPreContactHeightError: number; maxPreContactSpeedError: number }
  /** last 2000 chars of the adapter subprocess stdout, verbatim (broker execution record) */
  stdoutTail?: string
  /** last 2000 chars of the adapter subprocess stderr, verbatim (broker execution record) */
  stderrTail?: string
}

// ---------------------------------------------------------------------------
// Parameter validation (pure — unit-tested in physics.test.ts)
// ---------------------------------------------------------------------------

/**
 * Validate the simulate_impact parameters; throws honestly. Pure. The op
 * takes NO parameters by design (§19.3 — the mechanism and the drop are
 * frozen at upload; a non-empty parameter set is refused, never silently
 * ignored).
 */
export function validateImpactParameters(parameters: Record<string, unknown>): Record<string, never> {
  if (Object.keys(parameters).length !== 0) {
    throw new EngineUnavailableError("simulate_impact takes no parameters (the mechanism and the drop are frozen at upload)")
  }
  return {}
}

// ---------------------------------------------------------------------------
// Payload validation (pure — unit-tested in physics.test.ts)
// ---------------------------------------------------------------------------

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

/** Validate the impact adapter's stdout payload. Pure; throws honestly. */
export function validateImpactPayload(
  parsed: Record<string, unknown>,
  script: string,
): Pick<
  ImpactResult,
  "analysis" | "mechanism" | "drop" | "timestepSeconds" | "samples" | "impact" | "verification"
> {
  if (parsed.analysis !== "impact_simulation") {
    throw new EngineUnavailableError(`adapter ${script} payload must carry analysis: "impact_simulation"`)
  }
  const { mechanism, drop } = parsed
  if (
    !isPlainObject(mechanism) ||
    mechanism.kind !== "drop_impact" ||
    !isFiniteNumber(mechanism.massKilograms) ||
    !isFiniteNumber(mechanism.radiusMeters) ||
    !isFiniteNumber(mechanism.restitution)
  ) {
    throw new EngineUnavailableError(
      `adapter ${script} payload must carry mechanism {kind: "drop_impact", massKilograms, radiusMeters, restitution}`,
    )
  }
  if (
    !isPlainObject(drop) ||
    !isFiniteNumber(drop.centerHeightMeters) ||
    !isFiniteNumber(drop.gravityMetersPerSecondSquared)
  ) {
    throw new EngineUnavailableError(
      `adapter ${script} payload must carry drop {centerHeightMeters, gravityMetersPerSecondSquared}`,
    )
  }
  if (!isFiniteNumber(parsed.timestepSeconds) || parsed.timestepSeconds <= 0) {
    throw new EngineUnavailableError(`adapter ${script} payload must carry timestepSeconds > 0`)
  }
  if (!Array.isArray(parsed.samples) || parsed.samples.length < 2) {
    throw new EngineUnavailableError(`adapter ${script} payload must carry samples[2..] (the trajectory)`)
  }
  parsed.samples.forEach((s: unknown, i: number) => {
    if (
      !isPlainObject(s) ||
      !isFiniteNumber(s.index) ||
      !Number.isInteger(s.index) ||
      s.index !== i + 1 ||
      !isFiniteNumber(s.timeSeconds) ||
      !isFiniteNumber(s.centerHeightMeters) ||
      !isFiniteNumber(s.velocityZMetersPerSecond)
    ) {
      throw new EngineUnavailableError(
        `adapter ${script} payload samples[${i}] must carry {index: ${i + 1}, timeSeconds, centerHeightMeters, velocityZMetersPerSecond}`,
      )
    }
  })
  const impact = parsed.impact
  if (!isPlainObject(impact)) {
    throw new EngineUnavailableError(`adapter ${script} payload must carry the impact summary object`)
  }
  const impactFields = [
    "firstContactStep",
    "firstContactTimeSeconds",
    "closedFormContactTimeSeconds",
    "timeResidualSeconds",
    "impactSpeedMetersPerSecond",
    "closedFormImpactSpeedMetersPerSecond",
    "speedResidualMetersPerSecond",
    "reboundPeakHeightMeters",
    "closedFormReboundPeakMeters",
    "reboundResidualMeters",
  ] as const
  if (!Number.isInteger(impact.firstContactStep) || (impact.firstContactStep as number) < 2) {
    throw new EngineUnavailableError(`adapter ${script} payload impact.firstContactStep must be an integer ≥ 2`)
  }
  for (const field of impactFields) {
    if (!isFiniteNumber(impact[field])) {
      throw new EngineUnavailableError(`adapter ${script} payload impact.${field} must be a finite number`)
    }
  }
  const verification = parsed.verification
  if (
    !isPlainObject(verification) ||
    !isFiniteNumber(verification.maxPreContactHeightError) ||
    !isFiniteNumber(verification.maxPreContactSpeedError) ||
    verification.maxPreContactHeightError < 0 ||
    verification.maxPreContactSpeedError < 0
  ) {
    throw new EngineUnavailableError(
      `adapter ${script} payload verification must carry {maxPreContactHeightError, maxPreContactSpeedError} ≥ 0`,
    )
  }
  return {
    analysis: "impact_simulation",
    mechanism: mechanism as unknown as ImpactResult["mechanism"],
    drop: drop as unknown as ImpactResult["drop"],
    timestepSeconds: parsed.timestepSeconds as number,
    samples: parsed.samples as unknown as ImpactResult["samples"],
    impact: impact as unknown as ImpactSummary,
    verification: verification as unknown as ImpactResult["verification"],
  }
}

/** Parse + validate the impact adapter's full stdout protocol. Pure. */
export function parseImpactAdapterStdout(stdout: string, script: string): ImpactResult {
  const parsed = parseAdapterStdoutObject(stdout, script)
  const envelope = validateAdapterEnvelope(parsed, script)
  const payload = validateImpactPayload(parsed, script)
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
      `impact adapter (${script}) timed out after ${ADAPTER_TIMEOUT_MS}ms and was terminated`,
    )
  }
  if (err.code === "ENOENT") {
    return new EngineUnavailableError(
      `python interpreter not found at ${PYTHON_BIN} — the engine venv is not deployed on this host (${err.message})`,
    )
  }
  const stderrTail = (err.stderr ?? "").trim().slice(-400)
  return new EngineUnavailableError(
    `impact adapter (${script}) failed with exit code ${String(err.code)}${stderrTail ? `: ${stderrTail}` : ""}`,
  )
}

/**
 * Run a REAL drop-impact simulation (PyBullet DIRECT mode, 240 Hz, every
 * trajectory sample gated against the discrete closed forms inside the
 * adapter) over a stored eos-impact-model/1 JSON file. Throws
 * `EngineUnavailableError` with an honest message for every failure (invalid
 * model, the closed-form refusals, missing engines). The result carries the
 * subprocess stdout/stderr tails (verbatim, last 2000 chars) for the broker
 * execution record.
 */
export async function runImpactFromFile(
  absPath: string,
  parameters: Record<string, unknown>,
): Promise<ImpactResult> {
  validateImpactParameters(parameters)
  const scriptPath = adapterScriptPath(IMPACT_ADAPTER_SCRIPT)
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
              reject(errorFromExecFailure(IMPACT_ADAPTER_SCRIPT, { ...(err as ExecFailure), stdout: String(stdout), stderr: String(stderr) }))
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
    throw errorFromExecFailure(IMPACT_ADAPTER_SCRIPT, err as ExecFailure)
  }
  const parsed = parseImpactAdapterStdout(run.stdout, IMPACT_ADAPTER_SCRIPT)
  return {
    ...parsed,
    stdoutTail: run.stdout.slice(-ADAPTER_TAIL_CHARS),
    stderrTail: run.stderr.slice(-ADAPTER_TAIL_CHARS),
  }
}
