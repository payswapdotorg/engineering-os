/**
 * Engineering OS — engine-adapter bridge for power-flow analysis (pandapower).
 *
 * CONTRACT OWNER: TL (pinned in docs/00-architecture/phase5-disciplines-
 * contract.md §5.2, Phase 5). IMPLEMENTATION: W2-f — REAL engine adapter:
 *   - eos-powerflow-network/1 JSON (contract §3.2) → `powerflow.py`
 * The script runs as an arm's-length subprocess of the venv python
 * (EOS_PYTHON-overridable) with the network file path as argv[1] — the exact
 * exec/parse machinery style of quantities.ts/mesh.ts — and speaks the strict
 * JSON protocol on stdout: success = the payload below (every numeric copied
 * VERBATIM from the pandapower result frames), failure = {"error": …} exit 1.
 *
 * Every failure — missing venv, missing engine, invalid/islanded/non-converged
 * network, adapter crash, timeout, malformed payload — surfaces as an honest
 * `EngineUnavailableError` (mapped to 422 `engine_unavailable` by the broker);
 * nothing is ever fabricated (ADR-0005, ADR-0006).
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

const POWERFLOW_ADAPTER_SCRIPT = "powerflow.py"

// ---------------------------------------------------------------------------
// Types (the bridge-half of the eos-powerflow/1 numbers; the broker adds the
// document identity fields — format/sourceArtifactName — when storing)
// ---------------------------------------------------------------------------

export interface PowerflowBus {
  id: string
  vmPu: number
  angleDeg: number
  pMw: number
  qMvar: number
}

export interface PowerflowLine {
  fromBus: string
  toBus: string
  iKa: number
  pLossMw: number
  qLossMvar: number
}

export interface PowerflowTotals {
  lossMw: number
  loadMw: number
}

export interface PowerflowResult {
  engineKey: string
  engineVersion: string
  /** adapter script file name, e.g. "powerflow.py" */
  adapterScript: string
  /** sha256 of the adapter script content (recorded in provenance) */
  adapterHash: string
  converged: boolean
  buses: PowerflowBus[]
  lines: PowerflowLine[]
  totals: PowerflowTotals
  /** last 2000 chars of the adapter subprocess stdout, verbatim (broker execution record) */
  stdoutTail?: string
  /** last 2000 chars of the adapter subprocess stderr, verbatim (broker execution record) */
  stderrTail?: string
}

// ---------------------------------------------------------------------------
// Payload validation (pure — unit-tested in powerflow.test.ts)
// ---------------------------------------------------------------------------

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

/** Validate the powerflow adapter's stdout payload. Pure; throws honestly. */
export function validatePowerflowPayload(
  parsed: Record<string, unknown>,
  script: string,
): Pick<PowerflowResult, "converged" | "buses" | "lines" | "totals"> {
  const { converged, buses, lines, totals } = parsed
  if (converged !== true) {
    throw new EngineUnavailableError(`adapter ${script} payload must carry converged: true (non-convergence is an error envelope)`)
  }
  if (!Array.isArray(buses) || buses.length === 0) {
    throw new EngineUnavailableError(`adapter ${script} payload is missing the buses array`)
  }
  buses.forEach((b: unknown, i: number) => {
    if (!isPlainObject(b)) {
      throw new EngineUnavailableError(`adapter ${script} buses[${i}] is not an object`)
    }
    if (typeof b.id !== "string" || b.id.length === 0) {
      throw new EngineUnavailableError(`adapter ${script} buses[${i}] has no id`)
    }
    for (const key of ["vmPu", "angleDeg", "pMw", "qMvar"] as const) {
      if (!isFiniteNumber(b[key])) {
        throw new EngineUnavailableError(`adapter ${script} buses[${i}].${key} must be a finite number (verbatim result frame)`)
      }
    }
  })
  if (!Array.isArray(lines)) {
    throw new EngineUnavailableError(`adapter ${script} payload is missing the lines array`)
  }
  lines.forEach((l: unknown, i: number) => {
    if (!isPlainObject(l)) {
      throw new EngineUnavailableError(`adapter ${script} lines[${i}] is not an object`)
    }
    if (typeof l.fromBus !== "string" || typeof l.toBus !== "string") {
      throw new EngineUnavailableError(`adapter ${script} lines[${i}] has no fromBus/toBus`)
    }
    for (const key of ["iKa", "pLossMw", "qLossMvar"] as const) {
      if (!isFiniteNumber(l[key])) {
        throw new EngineUnavailableError(`adapter ${script} lines[${i}].${key} must be a finite number (verbatim result frame)`)
      }
    }
  })
  if (!isPlainObject(totals) || !isFiniteNumber(totals.lossMw) || !isFiniteNumber(totals.loadMw)) {
    throw new EngineUnavailableError(`adapter ${script} payload is missing totals {lossMw, loadMw}`)
  }
  return {
    converged: true,
    buses: buses as PowerflowBus[],
    lines: lines as PowerflowLine[],
    totals: { lossMw: totals.lossMw as number, loadMw: totals.loadMw as number },
  }
}

/** Parse + validate the powerflow adapter's full stdout protocol. Pure. */
export function parsePowerflowAdapterStdout(stdout: string, script: string): PowerflowResult {
  const parsed = parseAdapterStdoutObject(stdout, script)
  const envelope = validateAdapterEnvelope(parsed, script)
  const payload = validatePowerflowPayload(parsed, script)
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
      `powerflow adapter (${script}) timed out after ${ADAPTER_TIMEOUT_MS}ms and was terminated`,
    )
  }
  if (err.code === "ENOENT") {
    return new EngineUnavailableError(
      `python interpreter not found at ${PYTHON_BIN} — the engine venv is not deployed on this host (${err.message})`,
    )
  }
  const stderrTail = (err.stderr ?? "").trim().slice(-400)
  return new EngineUnavailableError(
    `powerflow adapter (${script}) failed with exit code ${String(err.code)}${stderrTail ? `: ${stderrTail}` : ""}`,
  )
}

/**
 * Run a REAL Newton-Raphson power flow (pandapower, init="flat") over a stored
 * eos-powerflow-network/1 JSON file. Throws `EngineUnavailableError` with an
 * honest message for every failure (invalid network, islanded buses,
 * non-convergence, missing engine). The result carries the subprocess
 * stdout/stderr tails (verbatim, last 2000 chars) for the broker execution
 * record.
 */
export async function runPowerflowFromFile(absPath: string): Promise<PowerflowResult> {
  const scriptPath = adapterScriptPath(POWERFLOW_ADAPTER_SCRIPT)
  let run: { stdout: string; stderr: string }
  try {
    const result = await promisify(execFile)(PYTHON_BIN, [scriptPath, path.resolve(absPath)], {
      timeout: ADAPTER_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    })
    run = { stdout: result.stdout, stderr: result.stderr ?? "" }
  } catch (err) {
    throw errorFromExecFailure(POWERFLOW_ADAPTER_SCRIPT, err as ExecFailure)
  }
  const parsed = parsePowerflowAdapterStdout(run.stdout, POWERFLOW_ADAPTER_SCRIPT)
  return {
    ...parsed,
    stdoutTail: run.stdout.slice(-ADAPTER_TAIL_CHARS),
    stderrTail: run.stderr.slice(-ADAPTER_TAIL_CHARS),
  }
}
