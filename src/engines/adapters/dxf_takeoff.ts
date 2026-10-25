/**
 * Engineering OS — engine-adapter bridge for DXF VECTOR TAKEOFF (ezdxf).
 *
 * IMPLEMENTATION: Lane 16-V (Slice 15 vector-takeoff lane), following the
 * research-verified design (worklog 16-R1) and the femesh bridge pattern
 * (src/engines/adapters/femesh.ts → step_femesh.py):
 *   - DXF drawings → ezdxf via `dxf_takeoff.py` (parameters over STDIN per
 *     contract §5.1; JSON on stdout — success = the payload below, failure =
 *     {"error": …} exit 1; `adapterHash` is the script's own sha256).
 *
 * Unit honesty is the adapter's first gate: a DXF only measures in its
 * DECLARED millimetres ($INSUNITS = 4) — anything else is refused verbatim,
 * never converted by a guessed factor. Measured entities v1: LINE (exact
 * length), LWPOLYLINE (segment lengths; closed → shoelace area), CIRCLE
 * (exact 2πr), ARC (exact r×θ — no flattening anywhere); every other entity
 * type is counted under "others", never half-measured.
 *
 * Every failure — missing venv, missing ezdxf, corrupt DXF (after the
 * ezdxf.recover attempt), non-mm units, no supported entities, bad
 * parameters, adapter crash, timeout, malformed payload — surfaces as an
 * honest `EngineUnavailableError` (mapped to 422 `engine_unavailable` by
 * the broker); nothing is ever fabricated.
 */

import { execFile } from "node:child_process"
import path from "node:path"

import {
  EngineUnavailableError,
  adapterScriptPath,
  isPlainObject,
  parseAdapterStdoutObject,
  validateAdapterEnvelope,
} from "./quantities"

export { EngineUnavailableError }

/** Interpreter hosting ezdxf (same override the other bridges honour). */
const PYTHON_BIN = process.env.EOS_PYTHON ?? "/home/z/.venv/bin/python3"

/** Hard stop for a hung adapter process — never wait forever for an engine. */
const ADAPTER_TIMEOUT_MS = 60_000

const DXF_ADAPTER_SCRIPT = "dxf_takeoff.py"

// ---------------------------------------------------------------------------
// Types (the frozen 16-V bridge contract — the TL's broker cores import these)
// ---------------------------------------------------------------------------

export interface DxfTakeoffParameters {
  /** normalized layer filter; undefined = all layers */
  layerFilter?: string[]
}

export interface DxfTakeoffResult {
  engineKey: "ezdxf"
  engineVersion: string
  /** adapter script file name, e.g. "dxf_takeoff.py" */
  adapterScript: string
  /** sha256 of the adapter script content (recorded in provenance) */
  adapterHash: string
  unitsMm: boolean
  layerCount: number
  entityCount: number
  layers: Array<{
    name: string
    counts: { lines: number; polylines: number; arcs: number; circles: number; others: number }
    totalLengthMm: number
    totalClosedAreaMm2: number
  }>
}

// ---------------------------------------------------------------------------
// Parameter resolution (pure — unit-tested without spawning the engine)
// ---------------------------------------------------------------------------

/**
 * Normalize + validate dxf-takeoff parameters. PURE.
 *
 * layerFilter policy (mirrored verbatim by the python adapter's
 * read_request): absent, null, or an empty array → undefined (all layers);
 * otherwise every entry must be a non-empty string (non-strings refused
 * honestly — a typo'd filter silently measuring nothing is worse than an
 * error) and the result is deduplicated and sorted so the same logical
 * filter always produces byte-identical adapter requests.
 */
export function resolveDxfTakeoffParams(raw: Record<string, unknown>): DxfTakeoffParameters {
  const filter = raw.layerFilter
  if (filter === undefined || filter === null) return {}
  if (!Array.isArray(filter)) {
    throw new EngineUnavailableError(
      `dxf_takeoff parameters.layerFilter must be an array of layer names — got ${JSON.stringify(filter)}`,
    )
  }
  if (filter.length === 0) return {}
  const names: string[] = []
  for (const entry of filter) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new EngineUnavailableError(
        `dxf_takeoff parameters.layerFilter entries must be non-empty strings — got ${JSON.stringify(entry)}`,
      )
    }
    names.push(entry)
  }
  return { layerFilter: [...new Set(names)].sort() }
}

// ---------------------------------------------------------------------------
// Payload validation (pure — unit-tested with synthetic protocol strings)
// ---------------------------------------------------------------------------

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}

/** Validate the dxf-takeoff adapter's stdout payload. Pure; throws honestly. */
export function validateDxfTakeoffPayload(
  parsed: Record<string, unknown>,
  script: string,
): Omit<DxfTakeoffResult, "engineKey" | "engineVersion" | "adapterScript" | "adapterHash"> {
  const { unitsMm, layerCount, entityCount, layers } = parsed
  if (unitsMm !== true) {
    throw new EngineUnavailableError(`adapter ${script} payload is missing unitsMm: true`)
  }
  if (!isCount(layerCount) || layerCount < 1) {
    throw new EngineUnavailableError(
      `adapter ${script} payload is missing layerCount (positive integer — the adapter refuses unit-less or empty drawings)`,
    )
  }
  if (!isCount(entityCount)) {
    throw new EngineUnavailableError(`adapter ${script} payload is missing entityCount (integer >= 0)`)
  }
  if (!Array.isArray(layers) || layers.length !== layerCount) {
    throw new EngineUnavailableError(
      `adapter ${script} payload is missing the layers array (length must equal layerCount)`,
    )
  }
  layers.forEach((row: unknown, i: number) => {
    if (!isPlainObject(row)) {
      throw new EngineUnavailableError(`adapter ${script} layers[${i}] is not an object`)
    }
    const { name, counts, totalLengthMm, totalClosedAreaMm2 } = row
    if (typeof name !== "string" || name.length === 0) {
      throw new EngineUnavailableError(`adapter ${script} layers[${i}] has no name`)
    }
    if (!isPlainObject(counts)) {
      throw new EngineUnavailableError(`adapter ${script} layers[${i}] is missing the counts object`)
    }
    for (const key of ["lines", "polylines", "arcs", "circles", "others"] as const) {
      if (!isCount(counts[key])) {
        throw new EngineUnavailableError(
          `adapter ${script} layers[${i}].counts.${key} must be a non-negative integer`,
        )
      }
    }
    if (!isNonNegativeFinite(totalLengthMm)) {
      throw new EngineUnavailableError(
        `adapter ${script} layers[${i}] totalLengthMm must be a non-negative finite number (mm)`,
      )
    }
    if (!isNonNegativeFinite(totalClosedAreaMm2)) {
      throw new EngineUnavailableError(
        `adapter ${script} layers[${i}] totalClosedAreaMm2 must be a non-negative finite number (mm²)`,
      )
    }
    if (i > 0 && (layers[i - 1] as { name: string }).name >= name) {
      throw new EngineUnavailableError(
        `adapter ${script} layers must be sorted by name ascending (layers[${i - 1}] >= layers[${i}])`,
      )
    }
  })
  return {
    unitsMm: true,
    layerCount,
    entityCount,
    layers: layers as DxfTakeoffResult["layers"],
  }
}

/** Parse + validate the dxf-takeoff adapter's full stdout protocol. Pure. */
export function parseDxfTakeoffAdapterStdout(stdout: string, script: string): DxfTakeoffResult {
  const parsed = parseAdapterStdoutObject(stdout, script)
  const envelope = validateAdapterEnvelope(parsed, script)
  const payload = validateDxfTakeoffPayload(parsed, script)
  if (envelope.engineKey !== "ezdxf") {
    throw new EngineUnavailableError(
      `adapter ${script} reported engineKey ${JSON.stringify(envelope.engineKey)} — expected "ezdxf"`,
    )
  }
  return {
    engineKey: "ezdxf",
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
      `dxf-takeoff adapter (${script}) timed out after ${ADAPTER_TIMEOUT_MS}ms and was terminated`,
    )
  }
  if (err.code === "ENOENT") {
    return new EngineUnavailableError(
      `python interpreter not found at ${PYTHON_BIN} — the engine venv is not deployed on this host (${err.message})`,
    )
  }
  const stderrTail = (err.stderr ?? "").trim().slice(-400)
  return new EngineUnavailableError(
    `dxf-takeoff adapter (${script}) failed with exit code ${String(err.code)}${stderrTail ? `: ${stderrTail}` : ""}`,
  )
}

/**
 * Run the ezdxf DXF-takeoff adapter as an arm's-length subprocess with the
 * request JSON on stdin (pure python — no LD_LIBRARY_PATH bootstrap).
 * Throws `EngineUnavailableError` on every failure.
 */
async function execDxfTakeoffAdapter(
  script: string,
  storagePath: string,
  parameters: DxfTakeoffParameters,
): Promise<{ stdout: string; stderr: string }> {
  const scriptPath = adapterScriptPath(script)
  const request = JSON.stringify({
    storagePath: path.resolve(storagePath),
    parameters: parameters.layerFilter ? { layerFilter: parameters.layerFilter } : {},
  })
  return new Promise((resolve, reject) => {
    execFile(
      PYTHON_BIN,
      [scriptPath],
      { timeout: ADAPTER_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env: { ...process.env } },
      (err, stdout, stderr) => {
        if (err) {
          reject(errorFromExecFailure(script, { ...(err as ExecFailure), stdout: String(stdout), stderr: String(stderr) }))
          return
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) })
      },
    ).stdin?.end(request, "utf8")
  })
}

/**
 * Extract REAL vector geometry from a stored DXF file using ezdxf, measured
 * in the drawing's declared millimetres (a non-mm $INSUNITS is refused
 * verbatim by the adapter). Throws `EngineUnavailableError` with an honest
 * message when the engine, the file, the units, or the parameters are not
 * available/valid on this host.
 */
export async function dxfTakeoffFromStorage(
  storagePath: string,
  parameters: { layerFilter?: string[] },
): Promise<DxfTakeoffResult> {
  const resolved = resolveDxfTakeoffParams(parameters as Record<string, unknown>)
  const run = await execDxfTakeoffAdapter(DXF_ADAPTER_SCRIPT, storagePath, resolved)
  return parseDxfTakeoffAdapterStdout(run.stdout, DXF_ADAPTER_SCRIPT)
}
