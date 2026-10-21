/**
 * Engineering OS — engine-adapter bridge for 3D model tessellation (meshes).
 *
 * CONTRACT OWNER: TL (pinned in worklog.md "TL-pinned contracts — Phase 2").
 * IMPLEMENTATION: W2-d — REAL tessellation adapters (no simulated results, ever):
 *   - STEP → cadquery (OCCT kernel) via `step_mesh.py`
 *   - IFC  → IfcOpenShell via `ifc_mesh.py`
 * Both scripts run as arm's-length subprocesses of the uv venv python
 * (/home/z/.venv/bin/python3, overridable via EOS_PYTHON) and speak a strict
 * JSON protocol on stdout — the EXACT exec/parse machinery shared with
 * `quantities.ts` (W2-d additive refactor: `execAdapterScript`,
 * `parseAdapterStdoutObject`, `validateAdapterEnvelope`):
 *   success = {engineKey, engineVersion, adapterScript, adapterHash,
 *              mesh: <eos-mesh/1 WITHOUT generatedBy>}
 *   failure = {"error": …} exit 1.
 * The BRIDGE adds `generatedBy` into the mesh payload when returning (the
 * python adapters never include it — Contract B); the returned `mesh` object
 * is exactly what gets stored as the byte-deterministic eos-mesh/1 file
 * (Contract A: NO timestamps anywhere; creation time lives in the DB revision
 * row, never in the file).
 *
 * Every failure — missing venv, missing engine, unreadable model,
 * geometry-free file, adapter crash, timeout, malformed mesh payload —
 * surfaces as an honest `EngineUnavailableError`; nothing is ever fabricated
 * (ADR-0005, ADR-0006). That surfaces as 422 `engine_unavailable` on the
 * route, never a fake mesh.
 */

import {
  ADAPTER_TAIL_CHARS,
  EngineUnavailableError,
  execAdapterScriptWithStreams,
  isPlainObject,
  parseAdapterStdoutObject,
  validateAdapterEnvelope,
} from "./quantities"

export { EngineUnavailableError }

/** One tessellated element; `elementRef` MUST match quantity element refs. */
export interface MeshElement {
  /** stable per-element reference — `step:solid:<i>` or `#<GlobalId>` (the quantity-ledger ref format, so mesh elements set-equal the ledger's per-element refs) */
  elementRef: string
  /** human-readable name (STEP: `Solid <i+1>`; IFC: element Name or GlobalId) */
  name: string
  /** vertices in meters, source up-axis preserved (see `upAxis`) */
  vertices: number[][]
  /** 0-based triangle indices into `vertices` */
  triangles: number[][]
}

/**
 * Stored mesh file format (pinned, byte-deterministic — NO timestamps).
 * `generatedBy` is added by THIS bridge when returning (the adapters omit it);
 * it is part of the stored eos-mesh/1 file (Contract A) but optional here so
 * the pinned shape stays a pure widening — flagged for TL ratification.
 */
export interface MeshPayload {
  format: "eos-mesh/1"
  units: "m"
  /** source up-axis; the viewer applies the rotation, the adapter never rewrites it */
  upAxis: "z" | "y"
  /** the linear deflection tolerance used (meters), documented per adapter */
  tolerance: number
  elements: MeshElement[]
  /** added by the bridge when returning (Contract A stored format field) */
  generatedBy?: {
    engineKey: string
    engineVersion: string
    adapterScript: string
    adapterHash: string
  }
}

export interface MeshResult {
  engineKey: string
  engineVersion: string
  /** adapter script file name, e.g. "step_mesh.py" */
  adapterScript: string
  /** sha256 of the adapter script content (recorded in provenance) */
  adapterHash: string
  mesh: MeshPayload
  /** last 2000 chars of the adapter subprocess stdout, verbatim (broker execution record — additive, Phase 4) */
  stdoutTail?: string
  /** last 2000 chars of the adapter subprocess stderr, verbatim (broker execution record — additive, Phase 4) */
  stderrTail?: string
}

const MESH_ADAPTER_SCRIPTS: Record<"ifc" | "step", string> = {
  ifc: "ifc_mesh.py",
  step: "step_mesh.py",
}

// ---------------------------------------------------------------------------
// Protocol validation (pure — unit-tested in mesh.test.ts)
// ---------------------------------------------------------------------------

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isTriangleIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}

/** Validate the eos-mesh/1 payload of an adapter run. Pure; throws honestly. */
export function validateMeshPayload(
  parsed: Record<string, unknown>,
  script: string,
): MeshPayload {
  const { mesh } = parsed
  if (!isPlainObject(mesh)) {
    throw new EngineUnavailableError(`adapter ${script} payload is missing the mesh object`)
  }
  if ("generatedBy" in mesh) {
    throw new EngineUnavailableError(
      `adapter ${script} must NOT emit generatedBy (the bridge adds it — Contract B)`,
    )
  }
  const { format, units, upAxis, tolerance, elements } = mesh
  if (format !== "eos-mesh/1") {
    throw new EngineUnavailableError(
      `adapter ${script} mesh.format must be "eos-mesh/1" (got ${JSON.stringify(format)})`,
    )
  }
  if (units !== "m") {
    throw new EngineUnavailableError(`adapter ${script} mesh.units must be "m" (got ${JSON.stringify(units)})`)
  }
  if (upAxis !== "z" && upAxis !== "y") {
    throw new EngineUnavailableError(
      `adapter ${script} mesh.upAxis must be "z"|"y" (got ${JSON.stringify(upAxis)})`,
    )
  }
  if (!isFiniteNumber(tolerance) || tolerance <= 0) {
    throw new EngineUnavailableError(
      `adapter ${script} mesh.tolerance must be a positive finite number (got ${JSON.stringify(tolerance)})`,
    )
  }
  if (!Array.isArray(elements)) {
    throw new EngineUnavailableError(`adapter ${script} mesh payload is missing the elements array`)
  }
  elements.forEach((e: unknown, i: number) => {
    if (!isPlainObject(e)) {
      throw new EngineUnavailableError(`adapter ${script} mesh.elements[${i}] is not an object`)
    }
    const { elementRef, name, vertices, triangles } = e
    if (typeof elementRef !== "string" || elementRef.length === 0) {
      throw new EngineUnavailableError(`adapter ${script} mesh.elements[${i}] has no elementRef`)
    }
    if (typeof name !== "string") {
      throw new EngineUnavailableError(`adapter ${script} mesh.elements[${i}] has no name`)
    }
    if (!Array.isArray(vertices)) {
      throw new EngineUnavailableError(`adapter ${script} mesh.elements[${i}] has no vertices array`)
    }
    vertices.forEach((v: unknown, j: number) => {
      if (!Array.isArray(v) || v.length !== 3 || !v.every(isFiniteNumber)) {
        throw new EngineUnavailableError(
          `adapter ${script} mesh.elements[${i}].vertices[${j}] is not a finite [x, y, z] triple`,
        )
      }
    })
    if (!Array.isArray(triangles)) {
      throw new EngineUnavailableError(`adapter ${script} mesh.elements[${i}] has no triangles array`)
    }
    triangles.forEach((t: unknown, j: number) => {
      if (!Array.isArray(t) || t.length !== 3 || !t.every(isTriangleIndex)) {
        throw new EngineUnavailableError(
          `adapter ${script} mesh.elements[${i}].triangles[${j}] is not an integer [i, j, k] triple`,
        )
      }
      // an out-of-range index would silently break the viewer — refuse honestly
      for (const idx of t as number[]) {
        if (idx >= vertices.length) {
          throw new EngineUnavailableError(
            `adapter ${script} mesh.elements[${i}].triangles[${j}] references vertex ${idx} but the element has only ${vertices.length} vertices`,
          )
        }
      }
    })
  })
  return {
    format,
    units,
    upAxis,
    tolerance,
    elements: elements as MeshElement[],
  }
}

/**
 * Parse + validate a mesh adapter's full stdout protocol (pure half of
 * `tessellateFromFile`; exported additively for the pure-part bun tests —
 * shapes of the pinned exports are untouched).
 */
export function parseMeshAdapterStdout(stdout: string, script: string): MeshResult {
  const parsed = parseAdapterStdoutObject(stdout, script)
  const envelope = validateAdapterEnvelope(parsed, script)
  const mesh = validateMeshPayload(parsed, script)
  return {
    engineKey: envelope.engineKey,
    engineVersion: envelope.engineVersion,
    adapterScript: envelope.adapterScript,
    adapterHash: envelope.adapterHash,
    mesh,
  }
}

// ---------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------

/**
 * Tessellate a stored model file into the pinned eos-mesh/1 payload using the
 * registered engine for `kind`. Throws `EngineUnavailableError` with an
 * honest message when the engine or adapter is not available on this host.
 * W2-e additive: the result carries the subprocess stdout/stderr tails
 * (verbatim, last 2000 chars) for the broker execution record — the protocol
 * fields are untouched.
 */
export async function tessellateFromFile(
  absPath: string,
  kind: "ifc" | "step",
): Promise<MeshResult> {
  const script = MESH_ADAPTER_SCRIPTS[kind]
  const run = await execAdapterScriptWithStreams(kind, script, absPath)
  const { engineKey, engineVersion, adapterScript, adapterHash, mesh } =
    parseMeshAdapterStdout(run.stdout, script)
  // The BRIDGE adds generatedBy into the mesh payload when returning (the
  // python adapter does not include it) — this object is exactly what W3-d
  // stores as the byte-deterministic eos-mesh/1 file.
  const meshWithProvenance: MeshPayload = {
    ...mesh,
    generatedBy: { engineKey, engineVersion, adapterScript, adapterHash },
  }
  return {
    engineKey,
    engineVersion,
    adapterScript,
    adapterHash,
    mesh: meshWithProvenance,
    stdoutTail: run.stdout.slice(-ADAPTER_TAIL_CHARS),
    stderrTail: run.stderr.slice(-ADAPTER_TAIL_CHARS),
  }
}
