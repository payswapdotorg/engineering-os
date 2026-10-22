/**
 * Engineering OS — engine-adapter bridge for FE meshing (gmsh).
 *
 * CONTRACT OWNER: TL (pinned in docs/00-architecture/phase5-disciplines-
 * contract.md §5.1, Phase 5). IMPLEMENTATION: W2-f — REAL engine adapter:
 *   - STEP → gmsh (OCC) via `step_femesh.py`, linear tetrahedra only this phase
 * Unlike the argv-based quantity/tessellation adapters, this one carries its
 * parameters over STDIN ({storagePath, parameters{meshSizeMin, meshSizeMax,
 * elementOrder}}) per contract §5.1. The subprocess protocol is otherwise the
 * exact house style: JSON on stdout — success = the payload below, failure =
 * {"error": …} exit 1; `adapterHash` is the script's own sha256.
 *
 * gmsh links libGLU.so.1 + libOpenGL.so.0, which the sandbox image lacks:
 * the bridge PREPENDS `process.env.EOS_ENGINE_LIBDIR ?? "/home/z/.local/lib/
 * eos-engine-libs"` (the directory scripts/setup-engine-libs.sh maintains) to
 * the subprocess LD_LIBRARY_PATH. If the import still fails the adapter
 * refuses with the message naming the setup script — honest absence, never a
 * fallback (contract §5.1).
 *
 * Every failure — missing venv, missing gmsh, missing system libs, unreadable
 * model, geometry-free file, non-STEP model, bad parameters, adapter crash,
 * timeout, malformed payload — surfaces as an honest `EngineUnavailableError`
 * (mapped to 422 `engine_unavailable` by the broker); nothing is ever
 * fabricated (ADR-0005, ADR-0006).
 */

import { execFile } from "node:child_process"
import path from "node:path"
import { promisify } from "node:util"

import { extensionDeriveKind } from "./derive-kind"
import {
  ADAPTER_TAIL_CHARS,
  EngineUnavailableError,
  adapterScriptPath,
  isPlainObject,
  parseAdapterStdoutObject,
  validateAdapterEnvelope,
} from "./quantities"

export { EngineUnavailableError }

/** Interpreter hosting gmsh (same override the other bridges honour). */
const PYTHON_BIN = process.env.EOS_PYTHON ?? "/home/z/.venv/bin/python3"

/** Hard stop for a hung adapter process — never wait forever for an engine. */
const ADAPTER_TIMEOUT_MS = 120_000

/** gmsh's system-library dir (scripts/setup-engine-libs.sh recreates it). */
const ENGINE_LIBDIR = process.env.EOS_ENGINE_LIBDIR ?? "/home/z/.local/lib/eos-engine-libs"

/**
 * The gmsh subprocess LD_LIBRARY_PATH construction (contract §5.1): the
 * engine-libs dir is PREPENDED to the caller's existing value; with no existing
 * value it stands alone. PURE — exported so femesh.test.ts can pin the
 * injection without spawning gmsh; the bridge runs it on every spawn.
 */
export function femeshLdLibraryPath(existing: string | undefined, libdir: string = ENGINE_LIBDIR): string {
  return existing ? `${libdir}${path.delimiter}${existing}` : libdir
}

const FEMESH_ADAPTER_SCRIPT = "step_femesh.py"

// ---------------------------------------------------------------------------
// Types (the bridge-half of the eos-femesh/1 numbers; the broker adds the
// document identity fields — format/sourceArtifactName/units/… — when storing)
// ---------------------------------------------------------------------------

export interface FeMeshParameters {
  meshSizeMin: number
  meshSizeMax: number
  elementOrder: 1
}

export interface FeMeshSolid {
  /** stable per-solid reference — `step:solid:<i>` (the ledger ref format) */
  ref: string
  /**
   * Optional per contract §2 (`solids:[{ref, name?, …}]`): the gmsh adapter
   * ALWAYS emits it (validateFeMeshPayload enforces the field on the wire),
   * but the eos-femesh/1 document format pins it as optional and the broker's
   * buildFeMeshDocument omits the key when it is undefined.
   */
  name?: string
  tetCount: number
  /** divergence-theorem mesh volume of this solid's tets, mm³ */
  meshVolume: number
}

export interface FeMeshResult {
  engineKey: string
  engineVersion: string
  /** adapter script file name, e.g. "step_femesh.py" */
  adapterScript: string
  /** sha256 of the adapter script content (recorded in provenance) */
  adapterHash: string
  nodes: { count: number }
  elements: { type: "tet4"; count: number }
  solids: FeMeshSolid[]
  quality: { min: number; mean: number }
  /** last 2000 chars of the adapter subprocess stdout, verbatim (broker execution record) */
  stdoutTail?: string
  /** last 2000 chars of the adapter subprocess stderr, verbatim (broker execution record) */
  stderrTail?: string
}

/** Default FE-mesh parameters (contract §4: 2.0 / 4.0 / linear tets). */
export function defaultFeMeshParameters(): FeMeshParameters {
  return { meshSizeMin: 2.0, meshSizeMax: 4.0, elementOrder: 1 }
}

/**
 * Which stored model files support FE meshing (by extension) — `.step/.stp/
 * .ifc` per contract §5.1. Delegates to the canonical extension detector so
 * the bridge and the multi-signal `deriveKind` can never disagree. (.ifc is
 * admitted per the contract and the ENGINE refuses it honestly — gmsh has no
 * IFC reader; the 422 surfaces the real capability gap.)
 */
export function supportsFeMesh(storageKeyOrName: string): "step" | "ifc" | null {
  return extensionDeriveKind(storageKeyOrName)
}

// ---------------------------------------------------------------------------
// Parameter validation (pure — the broker validates first for its pinned
// 422s; this defense guards direct bridge callers the same way the python
// adapter guards itself)
// ---------------------------------------------------------------------------

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
}

/** Validate + default FE-mesh parameters; throws honestly on bad input. Pure. */
export function validateFeMeshParameters(
  parameters: Record<string, unknown>,
): FeMeshParameters {
  const base = defaultFeMeshParameters()
  const min = parameters.meshSizeMin ?? base.meshSizeMin
  const max = parameters.meshSizeMax ?? base.meshSizeMax
  const order = parameters.elementOrder ?? base.elementOrder
  if (!isPositiveNumber(min)) {
    throw new EngineUnavailableError("fe_mesh parameters.meshSizeMin must be a positive number")
  }
  if (!isPositiveNumber(max)) {
    throw new EngineUnavailableError("fe_mesh parameters.meshSizeMax must be a positive number")
  }
  if (min > max) {
    throw new EngineUnavailableError("fe_mesh parameters.meshSizeMin must be <= parameters.meshSizeMax")
  }
  if (order !== 1) {
    throw new EngineUnavailableError(
      `fe_mesh parameters.elementOrder must be 1 (linear tets only in this phase) — got ${JSON.stringify(order)}`,
    )
  }
  return { meshSizeMin: min, meshSizeMax: max, elementOrder: 1 }
}

// ---------------------------------------------------------------------------
// Payload validation (pure — unit-tested in femesh.test.ts)
// ---------------------------------------------------------------------------

function isFinitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
}

/** Validate the femesh adapter's stdout payload. Pure; throws honestly. */
export function validateFeMeshPayload(
  parsed: Record<string, unknown>,
  script: string,
): Pick<FeMeshResult, "nodes" | "elements" | "solids" | "quality"> {
  const { nodes, elements, solids, quality } = parsed
  if (!isPlainObject(nodes) || !Number.isInteger(nodes.count) || (nodes.count as number) <= 0) {
    throw new EngineUnavailableError(
      `adapter ${script} payload is missing nodes.count (positive integer)`,
    )
  }
  if (!isPlainObject(elements) || elements.type !== "tet4" || !Number.isInteger(elements.count) || (elements.count as number) <= 0) {
    throw new EngineUnavailableError(
      `adapter ${script} payload is missing elements {type:"tet4", count} (positive integer)`,
    )
  }
  if (!Array.isArray(solids) || solids.length === 0) {
    throw new EngineUnavailableError(`adapter ${script} payload is missing the solids array`)
  }
  solids.forEach((s: unknown, i: number) => {
    if (!isPlainObject(s)) {
      throw new EngineUnavailableError(`adapter ${script} solids[${i}] is not an object`)
    }
    if (typeof s.ref !== "string" || s.ref.length === 0) {
      throw new EngineUnavailableError(`adapter ${script} solids[${i}] has no ref`)
    }
    if (typeof s.name !== "string" || s.name.length === 0) {
      throw new EngineUnavailableError(`adapter ${script} solids[${i}] has no name`)
    }
    if (!Number.isInteger(s.tetCount) || (s.tetCount as number) <= 0) {
      throw new EngineUnavailableError(`adapter ${script} solids[${i}] tetCount must be a positive integer`)
    }
    if (!isFinitePositive(s.meshVolume)) {
      throw new EngineUnavailableError(
        `adapter ${script} solids[${i}] meshVolume must be a positive finite number (mm³)`,
      )
    }
  })
  if (!isPlainObject(quality) || !isFinitePositive(quality.min) || !isFinitePositive(quality.mean)) {
    throw new EngineUnavailableError(
      `adapter ${script} payload is missing quality {min, mean} (positive finite gmsh getElementQualities stats)`,
    )
  }
  return {
    nodes: { count: nodes.count as number },
    elements: { type: "tet4", count: elements.count as number },
    solids: solids as FeMeshSolid[],
    quality: { min: quality.min as number, mean: quality.mean as number },
  }
}

/** Parse + validate the femesh adapter's full stdout protocol. Pure. */
export function parseFeMeshAdapterStdout(stdout: string, script: string): FeMeshResult {
  const parsed = parseAdapterStdoutObject(stdout, script)
  const envelope = validateAdapterEnvelope(parsed, script)
  const payload = validateFeMeshPayload(parsed, script)
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
      `femesh adapter (${script}) timed out after ${ADAPTER_TIMEOUT_MS}ms and was terminated`,
    )
  }
  if (err.code === "ENOENT") {
    return new EngineUnavailableError(
      `python interpreter not found at ${PYTHON_BIN} — the engine venv is not deployed on this host (${err.message})`,
    )
  }
  const stderrTail = (err.stderr ?? "").trim().slice(-400)
  return new EngineUnavailableError(
    `femesh adapter (${script}) failed with exit code ${String(err.code)}${stderrTail ? `: ${stderrTail}` : ""}`,
  )
}

/**
 * Run the gmsh FE-mesh adapter as an arm's-length subprocess with the request
 * JSON on stdin and the gmsh system-library dir PREPENDED to
 * LD_LIBRARY_PATH (contract §5.1). Both captured streams are returned for
 * the broker execution record. Throws `EngineUnavailableError` on every
 * failure.
 */
async function execFemeshAdapter(
  script: string,
  storagePath: string,
  kind: "step" | "ifc",
  parameters: FeMeshParameters,
): Promise<{ stdout: string; stderr: string }> {
  const scriptPath = adapterScriptPath(script)
  const env = { ...process.env }
  env.LD_LIBRARY_PATH = femeshLdLibraryPath(process.env.LD_LIBRARY_PATH)
  const request = JSON.stringify({
    storagePath: path.resolve(storagePath),
    kind,
    parameters: { meshSizeMin: parameters.meshSizeMin, meshSizeMax: parameters.meshSizeMax, elementOrder: parameters.elementOrder },
  })
  return new Promise((resolve, reject) => {
    execFile(
      PYTHON_BIN,
      [scriptPath],
      { timeout: ADAPTER_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env },
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
 * Generate a REAL linear-tet FE mesh from a stored STEP/IFC model file using
 * gmsh. Throws `EngineUnavailableError` with an honest message when the
 * engine, its system libraries, or the model are not available on this host.
 * The result carries the subprocess stdout/stderr tails (verbatim, last 2000
 * chars) for the broker execution record.
 */
export async function feMeshFromFile(
  absPath: string,
  kind: "step" | "ifc",
  parameters: Record<string, unknown>,
): Promise<FeMeshResult> {
  const validated = validateFeMeshParameters(parameters)
  const run = await execFemeshAdapter(FEMESH_ADAPTER_SCRIPT, absPath, kind, validated)
  const result = parseFeMeshAdapterStdout(run.stdout, FEMESH_ADAPTER_SCRIPT)
  return {
    ...result,
    stdoutTail: run.stdout.slice(-ADAPTER_TAIL_CHARS),
    stderrTail: run.stderr.slice(-ADAPTER_TAIL_CHARS),
  }
}
