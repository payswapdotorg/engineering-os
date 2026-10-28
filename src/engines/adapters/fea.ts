/**
 * Engineering OS — engine-adapter bridge for plane-stress FEA (scikit-fem).
 *
 * CONTRACT OWNER: TL (pinned in docs/00-architecture/phase5-disciplines-
 * contract.md §14.5, Slice 22). REAL engine adapter:
 *   - eos-fea-model/1 JSON (contract §14.2) → `fea_solve.py`
 * The script runs as an arm's-length subprocess of the venv python
 * (EOS_PYTHON-overridable) with the {storagePath, parameters} request JSON on
 * STDIN — the exact protocol of femesh.ts — and speaks the strict JSON
 * protocol on stdout: success = the payload below (every numeric copied
 * VERBATIM from the scikit-fem solve), failure = {"error": …} exit 1.
 *
 * Every failure — missing venv, missing engine, invalid model,
 * under-constrained supports, adapter crash, timeout, malformed payload —
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

const FEA_ADAPTER_SCRIPT = "fea_solve.py"

// ---------------------------------------------------------------------------
// Types (the bridge-half of the eos-fea/1 numbers; the broker adds the
// document identity fields — format/sourceArtifactName — when storing)
// ---------------------------------------------------------------------------

export interface FeaSample {
  x: number
  y: number
  ux: number
  uy: number
}

export interface FeaStress {
  sigmaXxMinMpa: number
  sigmaXxMaxMpa: number
  vonMisesMaxMpa: number
}

export interface FeaMeshInfo {
  elementType: string
  refinement: number
  elementCount: number
  nodeCount: number
}

export interface FeaResult {
  engineKey: string
  engineVersion: string
  /** adapter script file name, e.g. "fea_solve.py" */
  adapterScript: string
  /** sha256 of the adapter script content (recorded in provenance) */
  adapterHash: string
  analysis: "plane_stress"
  mesh: FeaMeshInfo
  thicknessMm: number
  elasticModulusMpa: number
  poissonRatio: number
  samples: FeaSample[]
  maxDisplacementMagnitudeMm: number
  stress: FeaStress
  /** last 2000 chars of the adapter subprocess stdout, verbatim (broker execution record) */
  stdoutTail?: string
  /** last 2000 chars of the adapter subprocess stderr, verbatim (broker execution record) */
  stderrTail?: string
}

// ---------------------------------------------------------------------------
// Parameter validation (pure — unit-tested in fea.test.ts)
// ---------------------------------------------------------------------------

export interface FeaParameters {
  meshRefinement: number
}

/** Validate + default the solve_fea parameters; throws honestly. Pure. */
export function validateFeaParameters(parameters: Record<string, unknown>): FeaParameters {
  const raw = parameters.meshRefinement ?? 4
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 7) {
    throw new EngineUnavailableError("meshRefinement must be an integer between 1 and 7")
  }
  return { meshRefinement: raw }
}

// ---------------------------------------------------------------------------
// Payload validation (pure — unit-tested in fea.test.ts)
// ---------------------------------------------------------------------------

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

/** Validate the FEA adapter's stdout payload. Pure; throws honestly. */
export function validateFeaPayload(
  parsed: Record<string, unknown>,
  script: string,
): Pick<
  FeaResult,
  "analysis" | "mesh" | "thicknessMm" | "elasticModulusMpa" | "poissonRatio" | "samples" | "maxDisplacementMagnitudeMm" | "stress"
> {
  if (parsed.analysis !== "plane_stress") {
    throw new EngineUnavailableError(`adapter ${script} payload must carry analysis: "plane_stress"`)
  }
  const { mesh, samples, stress } = parsed
  if (!isPlainObject(mesh)) {
    throw new EngineUnavailableError(`adapter ${script} payload is missing the mesh object`)
  }
  if (mesh.elementType !== "tri6") {
    throw new EngineUnavailableError(`adapter ${script} payload mesh.elementType must be "tri6"`)
  }
  for (const key of ["refinement", "elementCount", "nodeCount"] as const) {
    if (!isFiniteNumber(mesh[key])) {
      throw new EngineUnavailableError(`adapter ${script} payload mesh.${key} must be a finite number`)
    }
  }
  for (const key of ["thicknessMm", "elasticModulusMpa", "poissonRatio", "maxDisplacementMagnitudeMm"] as const) {
    if (!isFiniteNumber(parsed[key])) {
      throw new EngineUnavailableError(`adapter ${script} payload ${key} must be a finite number`)
    }
  }
  if (!Array.isArray(samples) || samples.length !== 5) {
    throw new EngineUnavailableError(`adapter ${script} payload must carry the 5 sample points (4 corners + center)`)
  }
  samples.forEach((s: unknown, i: number) => {
    if (!isPlainObject(s)) {
      throw new EngineUnavailableError(`adapter ${script} samples[${i}] is not an object`)
    }
    for (const key of ["x", "y", "ux", "uy"] as const) {
      if (!isFiniteNumber(s[key])) {
        throw new EngineUnavailableError(`adapter ${script} samples[${i}].${key} must be a finite number`)
      }
    }
  })
  if (
    !isPlainObject(stress) ||
    !isFiniteNumber(stress.sigmaXxMinMpa) ||
    !isFiniteNumber(stress.sigmaXxMaxMpa) ||
    !isFiniteNumber(stress.vonMisesMaxMpa)
  ) {
    throw new EngineUnavailableError(
      `adapter ${script} payload is missing stress {sigmaXxMinMpa, sigmaXxMaxMpa, vonMisesMaxMpa}`,
    )
  }
  return {
    analysis: "plane_stress",
    mesh: mesh as unknown as FeaMeshInfo,
    thicknessMm: parsed.thicknessMm as number,
    elasticModulusMpa: parsed.elasticModulusMpa as number,
    poissonRatio: parsed.poissonRatio as number,
    samples: samples as FeaSample[],
    maxDisplacementMagnitudeMm: parsed.maxDisplacementMagnitudeMm as number,
    stress: stress as unknown as FeaStress,
  }
}

/** Parse + validate the FEA adapter's full stdout protocol. Pure. */
export function parseFeaAdapterStdout(stdout: string, script: string): FeaResult {
  const parsed = parseAdapterStdoutObject(stdout, script)
  const envelope = validateAdapterEnvelope(parsed, script)
  const payload = validateFeaPayload(parsed, script)
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
      `fea adapter (${script}) timed out after ${ADAPTER_TIMEOUT_MS}ms and was terminated`,
    )
  }
  if (err.code === "ENOENT") {
    return new EngineUnavailableError(
      `python interpreter not found at ${PYTHON_BIN} — the engine venv is not deployed on this host (${err.message})`,
    )
  }
  const stderrTail = (err.stderr ?? "").trim().slice(-400)
  return new EngineUnavailableError(
    `fea adapter (${script}) failed with exit code ${String(err.code)}${stderrTail ? `: ${stderrTail}` : ""}`,
  )
}

/**
 * Run a REAL plane-stress solve (scikit-fem) over a stored eos-fea-model/1
 * JSON file. Throws `EngineUnavailableError` with an honest message for every
 * failure (invalid model, under-constrained supports, missing engine). The
 * result carries the subprocess stdout/stderr tails (verbatim, last 2000
 * chars) for the broker execution record.
 */
export async function runFeaFromFile(
  absPath: string,
  parameters: Record<string, unknown>,
): Promise<FeaResult> {
  const validated = validateFeaParameters(parameters)
  const scriptPath = adapterScriptPath(FEA_ADAPTER_SCRIPT)
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
              reject(errorFromExecFailure(FEA_ADAPTER_SCRIPT, { ...(err as ExecFailure), stdout: String(stdout), stderr: String(stderr) }))
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
    throw errorFromExecFailure(FEA_ADAPTER_SCRIPT, err as ExecFailure)
  }
  const parsed = parseFeaAdapterStdout(run.stdout, FEA_ADAPTER_SCRIPT)
  return {
    ...parsed,
    stdoutTail: run.stdout.slice(-ADAPTER_TAIL_CHARS),
    stderrTail: run.stderr.slice(-ADAPTER_TAIL_CHARS),
  }
}
