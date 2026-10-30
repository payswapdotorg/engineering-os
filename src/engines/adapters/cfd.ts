/**
 * Engineering OS — engine-adapter bridge for steady scalar transport (SfePy).
 *
 * CONTRACT OWNER: TL (pinned in docs/00-architecture/phase5-disciplines-
 * contract.md §16.5, Slice 29 — the CFD lane the Slice-28 license-first
 * probe opened). REAL engine adapter:
 *   - eos-cfd-transport-model/1 JSON (contract §16.2) → `transport_solve.py`
 * The script runs as an arm's-length subprocess of the venv python
 * (EOS_PYTHON-overridable) with the {storagePath, parameters} request JSON on
 * STDIN — the exact protocol of fea.ts — and speaks the strict JSON protocol
 * on stdout: success = the payload below (every numeric copied VERBATIM from
 * the SfePy solve), failure = {"error": …} exit 1.
 *
 * Every failure — missing venv, missing engine, invalid model, the
 * mesh-Péclet stability refusal, adapter crash, timeout, malformed payload —
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

const TRANSPORT_ADAPTER_SCRIPT = "transport_solve.py"

// ---------------------------------------------------------------------------
// Types (the bridge-half of the eos-cfd-transport/1 numbers; the broker adds
// the document identity fields — format/sourceArtifactName — when storing)
// ---------------------------------------------------------------------------

export interface TransportSample {
  x: number
  y: number
  concentration: number
}

export interface TransportMeshInfo {
  elementType: string
  approximation: string
  refinement: number
  elementCount: number
  nodeCount: number
}

export interface TransportResult {
  engineKey: string
  engineVersion: string
  /** adapter script file name, e.g. "transport_solve.py" */
  adapterScript: string
  /** sha256 of the adapter script content (recorded in provenance) */
  adapterHash: string
  analysis: "scalar_transport"
  mesh: TransportMeshInfo
  domain: { lengthM: number; heightM: number }
  diffusivityM2PerS: number
  velocityMPerS: number
  inletConcentration: number
  outletConcentration: number
  pecletNumber: number
  meshPecletNumber: number
  samples: TransportSample[]
  minConcentration: number
  maxConcentration: number
  /** last 2000 chars of the adapter subprocess stdout, verbatim (broker execution record) */
  stdoutTail?: string
  /** last 2000 chars of the adapter subprocess stderr, verbatim (broker execution record) */
  stderrTail?: string
}

// ---------------------------------------------------------------------------
// Parameter validation (pure — unit-tested in cfd.test.ts)
// ---------------------------------------------------------------------------

export interface TransportParameters {
  meshRefinement: number
}

/** Validate + default the solve_transport parameters; throws honestly. Pure. */
export function validateTransportParameters(parameters: Record<string, unknown>): TransportParameters {
  const raw = parameters.meshRefinement ?? 4
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 7) {
    throw new EngineUnavailableError("meshRefinement must be an integer between 1 and 7")
  }
  return { meshRefinement: raw }
}

// ---------------------------------------------------------------------------
// Payload validation (pure — unit-tested in cfd.test.ts)
// ---------------------------------------------------------------------------

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

/** Validate the transport adapter's stdout payload. Pure; throws honestly. */
export function validateTransportPayload(
  parsed: Record<string, unknown>,
  script: string,
): Pick<
  TransportResult,
  | "analysis"
  | "mesh"
  | "domain"
  | "diffusivityM2PerS"
  | "velocityMPerS"
  | "inletConcentration"
  | "outletConcentration"
  | "pecletNumber"
  | "meshPecletNumber"
  | "samples"
  | "minConcentration"
  | "maxConcentration"
> {
  if (parsed.analysis !== "scalar_transport") {
    throw new EngineUnavailableError(`adapter ${script} payload must carry analysis: "scalar_transport"`)
  }
  const { mesh, domain, samples } = parsed
  if (!isPlainObject(mesh)) {
    throw new EngineUnavailableError(`adapter ${script} payload is missing the mesh object`)
  }
  if (mesh.elementType !== "quad" || mesh.approximation !== "Q2") {
    throw new EngineUnavailableError(
      `adapter ${script} payload mesh must carry elementType "quad" + approximation "Q2"`,
    )
  }
  for (const key of ["refinement", "elementCount", "nodeCount"] as const) {
    if (!isFiniteNumber(mesh[key])) {
      throw new EngineUnavailableError(`adapter ${script} payload mesh.${key} must be a finite number`)
    }
  }
  if (!isPlainObject(domain) || !isFiniteNumber(domain.lengthM) || !isFiniteNumber(domain.heightM)) {
    throw new EngineUnavailableError(`adapter ${script} payload must carry domain {lengthM, heightM}`)
  }
  for (const key of [
    "diffusivityM2PerS",
    "velocityMPerS",
    "inletConcentration",
    "outletConcentration",
    "pecletNumber",
    "meshPecletNumber",
    "minConcentration",
    "maxConcentration",
  ] as const) {
    if (!isFiniteNumber(parsed[key])) {
      throw new EngineUnavailableError(`adapter ${script} payload ${key} must be a finite number`)
    }
  }
  if (!Array.isArray(samples) || samples.length !== 5) {
    throw new EngineUnavailableError(`adapter ${script} payload must carry the 5 centerline sample stations`)
  }
  samples.forEach((s: unknown, i: number) => {
    if (!isPlainObject(s)) {
      throw new EngineUnavailableError(`adapter ${script} samples[${i}] is not an object`)
    }
    for (const key of ["x", "y", "concentration"] as const) {
      if (!isFiniteNumber(s[key])) {
        throw new EngineUnavailableError(`adapter ${script} samples[${i}].${key} must be a finite number`)
      }
    }
  })
  return {
    analysis: "scalar_transport",
    mesh: mesh as unknown as TransportMeshInfo,
    domain: domain as unknown as { lengthM: number; heightM: number },
    diffusivityM2PerS: parsed.diffusivityM2PerS as number,
    velocityMPerS: parsed.velocityMPerS as number,
    inletConcentration: parsed.inletConcentration as number,
    outletConcentration: parsed.outletConcentration as number,
    pecletNumber: parsed.pecletNumber as number,
    meshPecletNumber: parsed.meshPecletNumber as number,
    samples: samples as TransportSample[],
    minConcentration: parsed.minConcentration as number,
    maxConcentration: parsed.maxConcentration as number,
  }
}

/** Parse + validate the transport adapter's full stdout protocol. Pure. */
export function parseTransportAdapterStdout(stdout: string, script: string): TransportResult {
  const parsed = parseAdapterStdoutObject(stdout, script)
  const envelope = validateAdapterEnvelope(parsed, script)
  const payload = validateTransportPayload(parsed, script)
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
      `transport adapter (${script}) timed out after ${ADAPTER_TIMEOUT_MS}ms and was terminated`,
    )
  }
  if (err.code === "ENOENT") {
    return new EngineUnavailableError(
      `python interpreter not found at ${PYTHON_BIN} — the engine venv is not deployed on this host (${err.message})`,
    )
  }
  const stderrTail = (err.stderr ?? "").trim().slice(-400)
  return new EngineUnavailableError(
    `transport adapter (${script}) failed with exit code ${String(err.code)}${stderrTail ? `: ${stderrTail}` : ""}`,
  )
}

/**
 * Run a REAL steady scalar-transport solve (SfePy) over a stored
 * eos-cfd-transport-model/1 JSON file. Throws `EngineUnavailableError` with
 * an honest message for every failure (invalid model, the mesh-Péclet
 * stability refusal, missing engine). The result carries the subprocess
 * stdout/stderr tails (verbatim, last 2000 chars) for the broker execution
 * record.
 */
export async function runTransportFromFile(
  absPath: string,
  parameters: Record<string, unknown>,
): Promise<TransportResult> {
  const validated = validateTransportParameters(parameters)
  const scriptPath = adapterScriptPath(TRANSPORT_ADAPTER_SCRIPT)
  const request = JSON.stringify({
    storagePath: path.resolve(absPath),
    parameters: { meshRefinement: validated.meshRefinement },
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
              reject(errorFromExecFailure(TRANSPORT_ADAPTER_SCRIPT, { ...(err as ExecFailure), stdout: String(stdout), stderr: String(stderr) }))
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
    throw errorFromExecFailure(TRANSPORT_ADAPTER_SCRIPT, err as ExecFailure)
  }
  const parsed = parseTransportAdapterStdout(run.stdout, TRANSPORT_ADAPTER_SCRIPT)
  return {
    ...parsed,
    stdoutTail: run.stdout.slice(-ADAPTER_TAIL_CHARS),
    stderrTail: run.stderr.slice(-ADAPTER_TAIL_CHARS),
  }
}
