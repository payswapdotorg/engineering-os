/**
 * Engineering OS — engine-adapter bridge for RTL synthesis (amaranth +
 * yowasp-yosys).
 *
 * CONTRACT OWNER: TL (pinned in docs/00-architecture/phase5-disciplines-
 * contract.md §17.5, Slice 30 — the chip lane the Slice-28 license-first
 * probe opened). REAL engine adapter:
 *   - eos-chip-rtl-model/1 JSON (contract §17.2) → `rtl_synthesize.py`
 * The script runs as an arm's-length subprocess of the venv python
 * (EOS_PYTHON-overridable) with the {storagePath, parameters} request JSON on
 * STDIN — the exact protocol of cfd.ts — and speaks the strict JSON protocol
 * on stdout: success = the payload below (every number copied VERBATIM from
 * the amaranth elaboration + the yowasp-yosys synthesis), failure =
 * {"error": …} exit 1.
 *
 * The lane is TWO engines (§17.3): amaranth is the front-end (the op's
 * engineKey — elaboration, RTLIL emission, the pysim trajectory) and
 * yowasp-yosys is the synthesis half, attributed in the payload's
 * `synthesis` block and the broker's audit detail.
 *
 * Every failure — missing venv, missing engines, invalid model, the
 * flip-flop/trajectory closed-form refusals, adapter crash, timeout,
 * malformed payload — surfaces as an honest `EngineUnavailableError`
 * (mapped to 422 `engine_unavailable` by the broker); nothing is ever
 * fabricated (ADR-0005, ADR-0006).
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

const RTL_ADAPTER_SCRIPT = "rtl_synthesize.py"

// ---------------------------------------------------------------------------
// Types (the bridge-half of the eos-chip-netlist/1 numbers; the broker adds
// the document identity fields — format/sourceArtifactName — when storing)
// ---------------------------------------------------------------------------

export interface RtlSimulationStep {
  cycle: number
  enabled: number
  count: number
}

export interface RtlResult {
  engineKey: string
  engineVersion: string
  /** adapter script file name, e.g. "rtl_synthesize.py" */
  adapterScript: string
  /** sha256 of the adapter script content (recorded in provenance) */
  adapterHash: string
  analysis: "rtl_synthesis"
  device: { kind: "enable_counter"; widthBits: number }
  rtlil: { sha256: string; charCount: number }
  netlist: {
    sha256: string
    charCount: number
    totalCells: number
    flipFlopCount: number
    cellHistogram: Record<string, number>
  }
  synthesis: { engineKey: string; engineVersion: string; script: string }
  simulation: { engine: string; pattern: string; steps: RtlSimulationStep[] }
  /** last 2000 chars of the adapter subprocess stdout, verbatim (broker execution record) */
  stdoutTail?: string
  /** last 2000 chars of the adapter subprocess stderr, verbatim (broker execution record) */
  stderrTail?: string
}

// ---------------------------------------------------------------------------
// Parameter validation (pure — unit-tested in chip.test.ts)
// ---------------------------------------------------------------------------

/**
 * Validate the synthesize_rtl parameters; throws honestly. Pure. The op takes
 * NO parameters by design (§17.3 — the yosys script is frozen; a non-empty
 * parameter set is refused, never silently ignored).
 */
export function validateRtlParameters(parameters: Record<string, unknown>): Record<string, never> {
  if (Object.keys(parameters).length !== 0) {
    throw new EngineUnavailableError("synthesize_rtl takes no parameters (the synthesis script is frozen)")
  }
  return {}
}

// ---------------------------------------------------------------------------
// Payload validation (pure — unit-tested in chip.test.ts)
// ---------------------------------------------------------------------------

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
}

/** Validate the RTL adapter's stdout payload. Pure; throws honestly. */
export function validateRtlPayload(
  parsed: Record<string, unknown>,
  script: string,
): Pick<
  RtlResult,
  "analysis" | "device" | "rtlil" | "netlist" | "synthesis" | "simulation"
> {
  if (parsed.analysis !== "rtl_synthesis") {
    throw new EngineUnavailableError(`adapter ${script} payload must carry analysis: "rtl_synthesis"`)
  }
  const { device, rtlil, netlist, synthesis, simulation } = parsed
  if (!isPlainObject(device) || device.kind !== "enable_counter" || !isFiniteNumber(device.widthBits)) {
    throw new EngineUnavailableError(
      `adapter ${script} payload must carry device {kind: "enable_counter", widthBits}`,
    )
  }
  if (!isFiniteNumber(device.widthBits) || !Number.isInteger(device.widthBits) || device.widthBits < 1 || device.widthBits > 64) {
    throw new EngineUnavailableError(`adapter ${script} payload device.widthBits must be an integer between 1 and 64`)
  }
  if (!isPlainObject(rtlil) || !isSha256(rtlil.sha256) || !isFiniteNumber(rtlil.charCount)) {
    throw new EngineUnavailableError(`adapter ${script} payload must carry rtlil {sha256, charCount}`)
  }
  if (
    !isPlainObject(netlist) ||
    !isSha256(netlist.sha256) ||
    !isFiniteNumber(netlist.charCount) ||
    !isFiniteNumber(netlist.totalCells) ||
    !isFiniteNumber(netlist.flipFlopCount) ||
    !isPlainObject(netlist.cellHistogram)
  ) {
    throw new EngineUnavailableError(
      `adapter ${script} payload must carry netlist {sha256, charCount, totalCells, flipFlopCount, cellHistogram}`,
    )
  }
  for (const [type, count] of Object.entries(netlist.cellHistogram)) {
    if (!isFiniteNumber(count) || !Number.isInteger(count) || count < 1) {
      throw new EngineUnavailableError(
        `adapter ${script} payload netlist.cellHistogram["${type}"] must be a positive integer`,
      )
    }
  }
  if (
    !isPlainObject(synthesis) ||
    synthesis.engineKey !== "yowasp-yosys" ||
    typeof synthesis.engineVersion !== "string" ||
    synthesis.engineVersion.length === 0 ||
    typeof synthesis.script !== "string" ||
    synthesis.script.length === 0
  ) {
    throw new EngineUnavailableError(
      `adapter ${script} payload must carry synthesis {engineKey: "yowasp-yosys", engineVersion, script}`,
    )
  }
  if (
    !isPlainObject(simulation) ||
    typeof simulation.engine !== "string" ||
    typeof simulation.pattern !== "string" ||
    !Array.isArray(simulation.steps) ||
    simulation.steps.length !== 25
  ) {
    throw new EngineUnavailableError(
      `adapter ${script} payload must carry simulation {engine, pattern, steps[25]} (the frozen 25-cycle stimulus)`,
    )
  }
  simulation.steps.forEach((s: unknown, i: number) => {
    if (!isPlainObject(s)) {
      throw new EngineUnavailableError(`adapter ${script} payload simulation.steps[${i}] is not an object`)
    }
    for (const key of ["cycle", "enabled", "count"] as const) {
      if (!isFiniteNumber(s[key]) || !Number.isInteger(s[key])) {
        throw new EngineUnavailableError(`adapter ${script} payload simulation.steps[${i}].${key} must be an integer`)
      }
    }
  })
  return {
    analysis: "rtl_synthesis",
    device: device as unknown as RtlResult["device"],
    rtlil: rtlil as unknown as RtlResult["rtlil"],
    netlist: netlist as unknown as RtlResult["netlist"],
    synthesis: synthesis as unknown as RtlResult["synthesis"],
    simulation: simulation as unknown as RtlResult["simulation"],
  }
}

/** Parse + validate the RTL adapter's full stdout protocol. Pure. */
export function parseRtlAdapterStdout(stdout: string, script: string): RtlResult {
  const parsed = parseAdapterStdoutObject(stdout, script)
  const envelope = validateAdapterEnvelope(parsed, script)
  const payload = validateRtlPayload(parsed, script)
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
      `rtl adapter (${script}) timed out after ${ADAPTER_TIMEOUT_MS}ms and was terminated`,
    )
  }
  if (err.code === "ENOENT") {
    return new EngineUnavailableError(
      `python interpreter not found at ${PYTHON_BIN} — the engine venv is not deployed on this host (${err.message})`,
    )
  }
  const stderrTail = (err.stderr ?? "").trim().slice(-400)
  return new EngineUnavailableError(
    `rtl adapter (${script}) failed with exit code ${String(err.code)}${stderrTail ? `: ${stderrTail}` : ""}`,
  )
}

/**
 * Run a REAL RTL synthesis (amaranth elaboration → RTLIL → yowasp-yosys
 * netlist → pysim trajectory) over a stored eos-chip-rtl-model/1 JSON file.
 * Throws `EngineUnavailableError` with an honest message for every failure
 * (invalid model, the flip-flop/trajectory closed-form refusals, missing
 * engines). The result carries the subprocess stdout/stderr tails (verbatim,
 * last 2000 chars) for the broker execution record.
 */
export async function runRtlSynthesisFromFile(
  absPath: string,
  parameters: Record<string, unknown>,
): Promise<RtlResult> {
  validateRtlParameters(parameters)
  const scriptPath = adapterScriptPath(RTL_ADAPTER_SCRIPT)
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
              reject(errorFromExecFailure(RTL_ADAPTER_SCRIPT, { ...(err as ExecFailure), stdout: String(stdout), stderr: String(stderr) }))
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
    throw errorFromExecFailure(RTL_ADAPTER_SCRIPT, err as ExecFailure)
  }
  const parsed = parseRtlAdapterStdout(run.stdout, RTL_ADAPTER_SCRIPT)
  return {
    ...parsed,
    stdoutTail: run.stdout.slice(-ADAPTER_TAIL_CHARS),
    stderrTail: run.stderr.slice(-ADAPTER_TAIL_CHARS),
  }
}
