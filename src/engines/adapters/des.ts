/**
 * Engineering OS — engine-adapter bridge for discrete-event simulation (SimPy).
 *
 * CONTRACT OWNER: TL (pinned in docs/00-architecture/phase5-disciplines-
 * contract.md §5.3, Phase 5). IMPLEMENTATION: W2-f — REAL engine adapter:
 *   - eos-des-scenario/1 JSON (contract §3.3) → `des.py`
 * The script runs as an arm's-length subprocess of the venv python
 * (EOS_PYTHON-overridable) with the scenario file path as argv[1] — the exact
 * exec/parse machinery style of quantities.ts/mesh.ts — and speaks the strict
 * JSON protocol on stdout: success = the payload below (deterministic FIFO
 * schedule, times verbatim in the scenario's unit), failure = {"error": …}
 * exit 1.
 *
 * Every failure — missing venv, missing engine, invalid scenario, absent
 * resource reference, adapter crash, timeout, malformed payload — surfaces
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

const DES_ADAPTER_SCRIPT = "des.py"

// ---------------------------------------------------------------------------
// Types (the bridge-half of the eos-des/1 numbers; the broker adds the
// document identity fields — format/sourceArtifactName — when storing)
// ---------------------------------------------------------------------------

export interface DesResource {
  id: string
  /** total served time (sum of task durations), scenario time unit */
  busy: number
  utilization: number
}

export interface DesJob {
  id: string
  startAt: number
  endAt: number
}

export interface DesResult {
  engineKey: string
  engineVersion: string
  /** adapter script file name, e.g. "des.py" */
  adapterScript: string
  /** sha256 of the adapter script content (recorded in provenance) */
  adapterHash: string
  policy: "fifo"
  makespan: number
  resources: DesResource[]
  jobs: DesJob[]
  /** last 2000 chars of the adapter subprocess stdout, verbatim (broker execution record) */
  stdoutTail?: string
  /** last 2000 chars of the adapter subprocess stderr, verbatim (broker execution record) */
  stderrTail?: string
}

// ---------------------------------------------------------------------------
// Payload validation (pure — unit-tested in des.test.ts)
// ---------------------------------------------------------------------------

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

/** Validate the DES adapter's stdout payload. Pure; throws honestly. */
export function validateDesPayload(
  parsed: Record<string, unknown>,
  script: string,
): Pick<DesResult, "policy" | "makespan" | "resources" | "jobs"> {
  const { policy, makespan, resources, jobs } = parsed
  if (policy !== "fifo") {
    throw new EngineUnavailableError(`adapter ${script} payload policy must be "fifo" (got ${JSON.stringify(policy)})`)
  }
  if (!isFiniteNumber(makespan) || makespan <= 0) {
    throw new EngineUnavailableError(`adapter ${script} payload makespan must be a positive finite number`)
  }
  if (!Array.isArray(resources) || resources.length === 0) {
    throw new EngineUnavailableError(`adapter ${script} payload is missing the resources array`)
  }
  resources.forEach((r: unknown, i: number) => {
    if (!isPlainObject(r)) {
      throw new EngineUnavailableError(`adapter ${script} resources[${i}] is not an object`)
    }
    if (typeof r.id !== "string" || r.id.length === 0) {
      throw new EngineUnavailableError(`adapter ${script} resources[${i}] has no id`)
    }
    if (!isFiniteNumber(r.busy) || r.busy < 0) {
      throw new EngineUnavailableError(`adapter ${script} resources[${i}].busy must be a number >= 0`)
    }
    if (!isFiniteNumber(r.utilization) || r.utilization < 0) {
      throw new EngineUnavailableError(`adapter ${script} resources[${i}].utilization must be a number >= 0`)
    }
  })
  if (!Array.isArray(jobs) || jobs.length === 0) {
    throw new EngineUnavailableError(`adapter ${script} payload is missing the jobs array`)
  }
  jobs.forEach((j: unknown, i: number) => {
    if (!isPlainObject(j)) {
      throw new EngineUnavailableError(`adapter ${script} jobs[${i}] is not an object`)
    }
    if (typeof j.id !== "string" || j.id.length === 0) {
      throw new EngineUnavailableError(`adapter ${script} jobs[${i}] has no id`)
    }
    if (!isFiniteNumber(j.startAt) || j.startAt < 0) {
      throw new EngineUnavailableError(`adapter ${script} jobs[${i}].startAt must be a number >= 0`)
    }
    if (!isFiniteNumber(j.endAt) || j.endAt < j.startAt) {
      throw new EngineUnavailableError(`adapter ${script} jobs[${i}].endAt must be a number >= startAt`)
    }
  })
  return {
    policy: "fifo",
    makespan: makespan as number,
    resources: resources as DesResource[],
    jobs: jobs as DesJob[],
  }
}

/** Parse + validate the DES adapter's full stdout protocol. Pure. */
export function parseDesAdapterStdout(stdout: string, script: string): DesResult {
  const parsed = parseAdapterStdoutObject(stdout, script)
  const envelope = validateAdapterEnvelope(parsed, script)
  const payload = validateDesPayload(parsed, script)
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
      `des adapter (${script}) timed out after ${ADAPTER_TIMEOUT_MS}ms and was terminated`,
    )
  }
  if (err.code === "ENOENT") {
    return new EngineUnavailableError(
      `python interpreter not found at ${PYTHON_BIN} — the engine venv is not deployed on this host (${err.message})`,
    )
  }
  const stderrTail = (err.stderr ?? "").trim().slice(-400)
  return new EngineUnavailableError(
    `des adapter (${script}) failed with exit code ${String(err.code)}${stderrTail ? `: ${stderrTail}` : ""}`,
  )
}

/**
 * Run a REAL deterministic FIFO discrete-event simulation (SimPy) over a
 * stored eos-des-scenario/1 JSON file. Throws `EngineUnavailableError` with
 * an honest message for every failure. The result carries the subprocess
 * stdout/stderr tails (verbatim, last 2000 chars) for the broker execution
 * record.
 */
export async function runDesFromFile(absPath: string): Promise<DesResult> {
  const scriptPath = adapterScriptPath(DES_ADAPTER_SCRIPT)
  let run: { stdout: string; stderr: string }
  try {
    const result = await promisify(execFile)(PYTHON_BIN, [scriptPath, path.resolve(absPath)], {
      timeout: ADAPTER_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    })
    run = { stdout: result.stdout, stderr: result.stderr ?? "" }
  } catch (err) {
    throw errorFromExecFailure(DES_ADAPTER_SCRIPT, err as ExecFailure)
  }
  const parsed = parseDesAdapterStdout(run.stdout, DES_ADAPTER_SCRIPT)
  return {
    ...parsed,
    stdoutTail: run.stdout.slice(-ADAPTER_TAIL_CHARS),
    stderrTail: run.stderr.slice(-ADAPTER_TAIL_CHARS),
  }
}
