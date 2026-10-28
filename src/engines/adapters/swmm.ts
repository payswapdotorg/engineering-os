/**
 * Engineering OS — engine-adapter bridge for stormwater drainage (pyswmm/SWMM5).
 *
 * CONTRACT OWNER: TL (pinned in docs/00-architecture/phase5-disciplines-
 * contract.md §15.5, Slice 23). REAL engine adapter:
 *   - eos-swmm-model/1 JSON (contract §15.2) → `swmm_run.py`
 * The script runs as an arm's-length subprocess of the venv python
 * (EOS_PYTHON-overridable) with the {storagePath, parameters} request JSON on
 * STDIN — the exact protocol of femesh.ts/fea.ts — and speaks the strict JSON
 * protocol on stdout: success = the payload below (every numeric copied
 * VERBATIM from the SWMM5 engine run), failure = {"error": …} exit 1.
 *
 * Every failure — missing venv, missing engine, invalid model, no-outfall
 * network, unresolvable inverts, adapter crash, timeout, malformed payload —
 * surfaces as an honest `EngineUnavailableError` (mapped to 422
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

const SWMM_ADAPTER_SCRIPT = "swmm_run.py"

// ---------------------------------------------------------------------------
// Types (the bridge-half of the eos-swmm/1 numbers; the broker adds the
// document identity fields — format/sourceArtifactName — when storing)
// ---------------------------------------------------------------------------

export interface SwmmRainInfo {
  intensityMMperHr: number
  durationMin: number
  totalDepthMm: number
  totalVolumeM3: number
}

export interface SwmmRoutingInfo {
  model: "kinematic_wave"
  routingStepSec: number
}

export interface SwmmContinuity {
  runoffErrorPct: number
  routingErrorPct: number
}

export interface SwmmDepthSample {
  id: string
  maxDepthM: number
}

export interface SwmmResult {
  engineKey: string
  engineVersion: string
  /** adapter script file name, e.g. "swmm_run.py" */
  adapterScript: string
  /** sha256 of the adapter script content (recorded in provenance) */
  adapterHash: string
  analysis: "drainage"
  rain: SwmmRainInfo
  routing: SwmmRoutingInfo
  continuity: SwmmContinuity
  outfallVolumeM3: number
  volumeBalancePct: number
  peaks: { maxRunoffCms: number; maxConduitFlowCms: number }
  depths: SwmmDepthSample[]
  /** last 2000 chars of the adapter subprocess stdout, verbatim (broker execution record) */
  stdoutTail?: string
  /** last 2000 chars of the adapter subprocess stderr, verbatim (broker execution record) */
  stderrTail?: string
}

// ---------------------------------------------------------------------------
// Parameter validation (pure — unit-tested in swmm.test.ts)
// ---------------------------------------------------------------------------

export interface SwmmParameters {
  routingStepSec: number
}

/** Validate + default the run_swmm parameters; throws honestly. Pure. */
export function validateSwmmParameters(parameters: Record<string, unknown>): SwmmParameters {
  const raw = parameters.routingStepSec ?? 10
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 60) {
    throw new EngineUnavailableError("routingStepSec must be an integer between 1 and 60")
  }
  return { routingStepSec: raw }
}

// ---------------------------------------------------------------------------
// Payload validation (pure — unit-tested in swmm.test.ts)
// ---------------------------------------------------------------------------

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

/** Validate the SWMM adapter's stdout payload. Pure; throws honestly. */
export function validateSwmmPayload(
  parsed: Record<string, unknown>,
  script: string,
): Pick<
  SwmmResult,
  "analysis" | "rain" | "routing" | "continuity" | "outfallVolumeM3" | "volumeBalancePct" | "peaks" | "depths"
> {
  if (parsed.analysis !== "drainage") {
    throw new EngineUnavailableError(`adapter ${script} payload must carry analysis: "drainage"`)
  }
  const { rain, routing, continuity, peaks, depths } = parsed
  if (!isPlainObject(rain)) {
    throw new EngineUnavailableError(`adapter ${script} payload is missing the rain object`)
  }
  for (const key of ["intensityMMperHr", "durationMin", "totalDepthMm", "totalVolumeM3"] as const) {
    if (!isFiniteNumber(rain[key])) {
      throw new EngineUnavailableError(`adapter ${script} payload rain.${key} must be a finite number`)
    }
  }
  if (!isPlainObject(routing) || routing.model !== "kinematic_wave") {
    throw new EngineUnavailableError(
      `adapter ${script} payload routing.model must be "kinematic_wave"`,
    )
  }
  if (!isFiniteNumber(routing.routingStepSec)) {
    throw new EngineUnavailableError(`adapter ${script} payload routing.routingStepSec must be a finite number`)
  }
  if (
    !isPlainObject(continuity) ||
    !isFiniteNumber(continuity.runoffErrorPct) ||
    !isFiniteNumber(continuity.routingErrorPct)
  ) {
    throw new EngineUnavailableError(
      `adapter ${script} payload is missing continuity {runoffErrorPct, routingErrorPct}`,
    )
  }
  for (const key of ["outfallVolumeM3", "volumeBalancePct"] as const) {
    if (!isFiniteNumber(parsed[key])) {
      throw new EngineUnavailableError(`adapter ${script} payload ${key} must be a finite number`)
    }
  }
  if (!isPlainObject(peaks) || !isFiniteNumber(peaks.maxRunoffCms) || !isFiniteNumber(peaks.maxConduitFlowCms)) {
    throw new EngineUnavailableError(
      `adapter ${script} payload is missing peaks {maxRunoffCms, maxConduitFlowCms}`,
    )
  }
  if (!Array.isArray(depths) || depths.length === 0) {
    throw new EngineUnavailableError(`adapter ${script} payload must carry the depths array (every node + conduit)`)
  }
  depths.forEach((d: unknown, i: number) => {
    if (!isPlainObject(d)) {
      throw new EngineUnavailableError(`adapter ${script} depths[${i}] is not an object`)
    }
    if (typeof d.id !== "string" || d.id.length === 0) {
      throw new EngineUnavailableError(`adapter ${script} depths[${i}].id must be a non-empty string`)
    }
    if (!isFiniteNumber(d.maxDepthM)) {
      throw new EngineUnavailableError(`adapter ${script} depths[${i}].maxDepthM must be a finite number`)
    }
  })
  return {
    analysis: "drainage",
    rain: rain as unknown as SwmmRainInfo,
    routing: routing as unknown as SwmmRoutingInfo,
    continuity: continuity as unknown as SwmmContinuity,
    outfallVolumeM3: parsed.outfallVolumeM3 as number,
    volumeBalancePct: parsed.volumeBalancePct as number,
    peaks: peaks as unknown as SwmmResult["peaks"],
    depths: depths as SwmmDepthSample[],
  }
}

/** Parse + validate the SWMM adapter's full stdout protocol. Pure. */
export function parseSwmmAdapterStdout(stdout: string, script: string): SwmmResult {
  const parsed = parseAdapterStdoutObject(stdout, script)
  const envelope = validateAdapterEnvelope(parsed, script)
  const payload = validateSwmmPayload(parsed, script)
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
      `swmm adapter (${script}) timed out after ${ADAPTER_TIMEOUT_MS}ms and was terminated`,
    )
  }
  if (err.code === "ENOENT") {
    return new EngineUnavailableError(
      `python interpreter not found at ${PYTHON_BIN} — the engine venv is not deployed on this host (${err.message})`,
    )
  }
  const stderrTail = (err.stderr ?? "").trim().slice(-400)
  return new EngineUnavailableError(
    `swmm adapter (${script}) failed with exit code ${String(err.code)}${stderrTail ? `: ${stderrTail}` : ""}`,
  )
}

/**
 * Run a REAL stormwater drainage simulation (pyswmm/SWMM5) over a stored
 * eos-swmm-model/1 JSON file. Throws `EngineUnavailableError` with an honest
 * message for every failure (invalid model, no-outfall network, missing
 * engine). The result carries the subprocess stdout/stderr tails (verbatim,
 * last 2000 chars) for the broker execution record.
 */
export async function runSwmmFromFile(
  absPath: string,
  parameters: Record<string, unknown>,
): Promise<SwmmResult> {
  const validated = validateSwmmParameters(parameters)
  const scriptPath = adapterScriptPath(SWMM_ADAPTER_SCRIPT)
  const request = JSON.stringify({
    storagePath: path.resolve(absPath),
    parameters: { routingStepSec: validated.routingStepSec },
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
              reject(errorFromExecFailure(SWMM_ADAPTER_SCRIPT, { ...(err as ExecFailure), stdout: String(stdout), stderr: String(stderr) }))
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
    throw errorFromExecFailure(SWMM_ADAPTER_SCRIPT, err as ExecFailure)
  }
  const parsed = parseSwmmAdapterStdout(run.stdout, SWMM_ADAPTER_SCRIPT)
  return {
    ...parsed,
    stdoutTail: run.stdout.slice(-ADAPTER_TAIL_CHARS),
    stderrTail: run.stderr.slice(-ADAPTER_TAIL_CHARS),
  }
}
