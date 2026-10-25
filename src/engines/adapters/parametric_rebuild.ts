/** STATUS (2026-10-25): smoke-verified bridge (see parametric_rebuild.py header) — NOT yet
 * harness-integrated or wired to a broker op/route; Slice 16 integrates. */
/**
 * Engineering OS — engine-adapter bridge for PARAMETRIC REBUILD (cadquery).
 *
 * IMPLEMENTATION: Lane 16-P (Slice 15 parametric-authoring lane), following
 * the research-proven design (worklog 16-R3) and the 16-V femesh/sheet bridge
 * patterns (src/engines/adapters/femesh.ts → step_femesh.py):
 *   - a stored PARAMETRIC MODEL script (python module declaring PARAM_SCHEMA,
 *     DEFAULT_PARAMS, build(params), analytic_volume_mm3(params)) →
 *     `parametric_rebuild.py` over STDIN ({storagePath, mode, parameters?,
 *     outputPath?}) — JSON on stdout; success = the payload below, failure =
 *     {"error": …} exit 1; `adapterHash` is the script's own sha256.
 *
 * Two modes, one adapter:
 *   - `parametricSchemaFromStorage` (mode "schema") reads the model's declared
 *     parameter schema + authored defaults — the Design Studio form source.
 *   - `parametricRebuildFromStorage` (mode "build") validates the user's
 *     parameter edits against the schema, merges over defaults, builds via
 *     cadquery, GATE-CHECKS the built volume against the model's analytic
 *     closed form (rel ≤ 1e-9 — the discipline that caught the research's own
 *     modeling bug), exports STEP, RE-IMPORTS it in the same process and
 *     returns the round-trip properties + the STEP bytes. A refused build
 *     leaves NO output file behind (the adapter deletes it).
 *
 * Determinism (16-R3 finding, pinned): identical parameters do NOT give
 * byte-identical STEPs — OCCT stamps an export timestamp into the STEP
 * FILE_NAME header and a per-export counter into PRODUCT(...) — so
 * byte-comparing STEP output is dishonest. The harness double-run compares
 * the GEOMETRY PROPERTIES (volumeMm3/areaMm2/bboxMm/centerOfMassMm/checks)
 * for exact equality; `stepBytes` is returned as the artifact payload but is
 * never part of a determinism signature.
 *
 * The BROKER pre-validates parameter edits with the pure mirror
 * `resolveParametricParams(schema, raw)` (same messages as the adapter) for
 * its pinned 422s BEFORE spawning; this bridge passes parameters through and
 * the python adapter re-validates (defense in depth — the broker never
 * trusts a client, and neither does the adapter).
 *
 * Every failure — missing venv, missing cadquery, missing/corrupt model
 * script, malformed schema, unknown keys, out-of-range/wrong-type values,
 * geometry contradictions authored in the model, analytic ground-truth
 * disagreements, adapter crash, timeout, malformed payload — surfaces as an
 * honest `EngineUnavailableError` (mapped to 422 `engine_unavailable` by the
 * broker); nothing is ever fabricated.
 */

import { execFile } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  EngineUnavailableError,
  adapterScriptPath,
  isPlainObject,
  parseAdapterStdoutObject,
  validateAdapterEnvelope,
} from "./quantities"

export { EngineUnavailableError }

/** Interpreter hosting cadquery (same override the other bridges honour). */
const PYTHON_BIN = process.env.EOS_PYTHON ?? "/home/z/.venv/bin/python3"

/** Hard stop for a hung adapter process — never wait forever for an engine. */
const ADAPTER_TIMEOUT_MS = 180_000

const PARAMETRIC_ADAPTER_SCRIPT = "parametric_rebuild.py"

/** The pinned analytic ground-truth gate (mirrors the adapter's REL_ERR_LIMIT). */
export const PARAMETRIC_VOLUME_REL_ERR_LIMIT = 1e-9

// ---------------------------------------------------------------------------
// Types (the frozen 16-P bridge contract — the TL's broker cores import these)
// ---------------------------------------------------------------------------

export interface ParametricSchemaResult {
  engineKey: "cadquery"
  engineVersion: string
  /** adapter script file name, e.g. "parametric_rebuild.py" */
  adapterScript: string
  /** sha256 of the adapter script content (recorded in provenance) */
  adapterHash: string
  /** sha256 of the MODEL script bytes (the artifact-revision identity) */
  modelScriptHash: string
  /** the model's PARAM_SCHEMA, verbatim (JSON-schema style) */
  schema: Record<string, unknown>
  /** the model's DEFAULT_PARAMS, verbatim (one authored default per key) */
  defaults: Record<string, number>
}

export interface ParametricBuildResult {
  engineKey: "cadquery"
  engineVersion: string
  adapterScript: string
  adapterHash: string
  modelScriptHash: string
  /** the merged parameters the model was actually built with */
  paramsUsed: Record<string, number>
  /** RE-IMPORTED STEP solid volume, mm³ (round-trip truth, not in-memory) */
  volumeMm3: number
  /** re-imported solid surface area, mm² */
  areaMm2: number
  /** re-imported solid bounding-box extents [x, y, z], mm */
  bboxMm: number[]
  /** re-imported solid centre of mass [x, y, z], mm */
  centerOfMassMm: number[]
  /** the analytic ground-truth gate (re-imported volume vs the closed form) */
  checks: { volumeRelErr: number; passed: boolean }
  /** the exported STEP file bytes (the new artifact revision's content) */
  stepBytes: Buffer
}

// ---------------------------------------------------------------------------
// Parameter resolution (pure — the TS-side mirror of the adapter's
// validate_params; unit-tested without spawning the engine)
// ---------------------------------------------------------------------------

/**
 * The python-side type name a JSON value would carry after json.loads — the
 * mirror's refusal messages name types exactly as the adapter does, so a
 * client refused by the broker and a client refused by the adapter read the
 * SAME message.
 */
function pythonTypeName(value: unknown): string {
  if (value === null || value === undefined) return "NoneType"
  if (typeof value === "string") return "str"
  if (typeof value === "boolean") return "bool"
  if (Array.isArray(value)) return "list"
  if (typeof value === "object") return "dict"
  if (typeof value === "bigint") return "int"
  return typeof value
}

/**
 * Resolve + validate parameter edits against a model's PARAM_SCHEMA. PURE —
 * the broker calls this BEFORE spawning the adapter so schema violations get
 * the pinned 422 without an engine run; the python adapter re-checks with
 * the IDENTICAL message shapes (defaults merge + unknown-key + type + range
 * checks, evaluated in schema property order like the adapter).
 *
 * Message-shape parity with parametric_rebuild.py's validate_params is
 * pinned by the unit tests. Known cosmetic edge: python renders a float
 * literal 10.0 as "10.0" in range messages while JS renders 10 — the
 * templates match; integer-valued JSON numbers (the pinned shapes) are
 * identical on both sides.
 */
export function resolveParametricParams(
  schema: Record<string, unknown>,
  raw: Record<string, unknown>,
): { ok: true; value: Record<string, number> } | { ok: false; message: string } {
  if (!isPlainObject(schema) || schema.type !== "object") {
    return { ok: false, message: 'model PARAM_SCHEMA must be an object schema ({type: "object", …})' }
  }
  const props = schema.properties
  if (!isPlainObject(props)) {
    return {
      ok: false,
      message: "model PARAM_SCHEMA declares no properties — a parametric model needs at least one numeric parameter",
    }
  }
  if (!isPlainObject(raw)) {
    return { ok: false, message: "parameter values must be a JSON object" }
  }
  const unknown = Object.keys(raw).filter((k) => !(k in props))
  if (unknown.length > 0 && schema.additionalProperties === false) {
    return {
      ok: false,
      message: `unknown parameter(s) rejected: [${unknown.sort().map((n) => `'${n}'`).join(", ")}]`,
    }
  }
  const required = Array.isArray(schema.required)
    ? schema.required.filter((r): r is string => typeof r === "string")
    : []
  const merged: Record<string, unknown> = {}
  for (const name of Object.keys(props)) {
    const spec = props[name]
    if (!isPlainObject(spec)) {
      return {
        ok: false,
        message: `model PARAM_SCHEMA property '${name}' must be a number spec ({type: "number", minimum, maximum, default, …})`,
      }
    }
    if (name in raw) {
      merged[name] = raw[name]
    } else if (typeof spec.default === "number") {
      merged[name] = spec.default
    } else if (required.includes(name)) {
      return { ok: false, message: `missing required parameter: ${name}` }
    }
    // optional property with no default: omitted, exactly like the adapter
  }
  for (const [name, value] of Object.entries(merged)) {
    const spec = (props as Record<string, Record<string, unknown>>)[name]
    if (spec.type !== "number") continue
    if (typeof value !== "number" || typeof value === "boolean") {
      return { ok: false, message: `parameter '${name}' must be a number, got ${pythonTypeName(value)}` }
    }
    if (!Number.isFinite(value)) {
      return { ok: false, message: `parameter '${name}' must be a finite number, got ${value}` }
    }
    const min = spec.minimum
    const max = spec.maximum
    if (typeof min === "number" && value < min) {
      return { ok: false, message: `parameter '${name}' = ${value} below minimum ${min}` }
    }
    if (typeof max === "number" && value > max) {
      return { ok: false, message: `parameter '${name}' = ${value} above maximum ${max}` }
    }
  }
  return { ok: true, value: merged as Record<string, number> }
}

// ---------------------------------------------------------------------------
// Payload validation (pure — unit-tested with synthetic protocol strings)
// ---------------------------------------------------------------------------

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isFinitePositive(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0
}

/** Validate the schema-mode adapter payload. Pure; throws honestly. */
export function validateParametricSchemaPayload(
  parsed: Record<string, unknown>,
  script: string,
): Pick<ParametricSchemaResult, "schema" | "defaults"> {
  const { schema, defaults } = parsed
  if (!isPlainObject(schema) || schema.type !== "object" || !isPlainObject(schema.properties)) {
    throw new EngineUnavailableError(
      `adapter ${script} payload is missing the model schema ({type: "object", properties: …})`,
    )
  }
  if (
    !isPlainObject(defaults) ||
    Object.keys(defaults).length === 0 ||
    !Object.values(defaults).every(isFiniteNumber)
  ) {
    throw new EngineUnavailableError(
      `adapter ${script} payload is missing defaults (a non-empty object of numbers — the model's authored DEFAULT_PARAMS)`,
    )
  }
  return { schema, defaults: defaults as Record<string, number> }
}

/** Validate the build-mode adapter payload. Pure; throws honestly. */
export function validateParametricBuildPayload(
  parsed: Record<string, unknown>,
  script: string,
): Omit<ParametricBuildResult, "engineKey" | "engineVersion" | "adapterScript" | "adapterHash" | "modelScriptHash" | "stepBytes"> {
  const { paramsUsed, volumeMm3, areaMm2, bboxMm, centerOfMassMm, checks } = parsed
  if (!isPlainObject(paramsUsed) || !Object.values(paramsUsed).every(isFiniteNumber)) {
    throw new EngineUnavailableError(
      `adapter ${script} payload is missing paramsUsed (an object of numbers — the merged parameters)`,
    )
  }
  if (!isFinitePositive(volumeMm3)) {
    throw new EngineUnavailableError(
      `adapter ${script} payload is missing volumeMm3 (positive finite — the re-imported solid volume in mm³)`,
    )
  }
  if (!isFinitePositive(areaMm2)) {
    throw new EngineUnavailableError(
      `adapter ${script} payload is missing areaMm2 (positive finite — the re-imported solid area in mm²)`,
    )
  }
  if (!Array.isArray(bboxMm) || bboxMm.length !== 3 || !bboxMm.every(isFinitePositive)) {
    throw new EngineUnavailableError(
      `adapter ${script} payload is missing bboxMm ([x, y, z] positive extents in mm)`,
    )
  }
  if (!Array.isArray(centerOfMassMm) || centerOfMassMm.length !== 3 || !centerOfMassMm.every(isFiniteNumber)) {
    throw new EngineUnavailableError(
      `adapter ${script} payload is missing centerOfMassMm ([x, y, z] finite coordinates in mm)`,
    )
  }
  if (
    !isPlainObject(checks) ||
    !isFiniteNumber(checks.volumeRelErr) ||
    !(checks.volumeRelErr >= 0) ||
    checks.passed !== true
  ) {
    throw new EngineUnavailableError(
      `adapter ${script} payload is missing checks {volumeRelErr, passed: true} (the analytic ground-truth gate — the adapter refuses to emit otherwise)`,
    )
  }
  // defense in depth: the bridge re-enforces the adapter's own gate — an
  // envelope claiming rel-err 0.8 with passed:true is dishonest no matter
  // who wrote it (the broker never trusts a client, even its own adapter)
  if ((checks.volumeRelErr as number) > PARAMETRIC_VOLUME_REL_ERR_LIMIT) {
    throw new EngineUnavailableError(
      `adapter ${script} reported checks.volumeRelErr ${checks.volumeRelErr} above the pinned ${PARAMETRIC_VOLUME_REL_ERR_LIMIT} analytic gate with passed: true — refusing the dishonest envelope`,
    )
  }
  return {
    paramsUsed: paramsUsed as Record<string, number>,
    volumeMm3,
    areaMm2,
    bboxMm,
    centerOfMassMm,
    checks: { volumeRelErr: checks.volumeRelErr as number, passed: true },
  }
}

/** Parse + validate the schema-mode adapter stdout protocol. Pure. */
export function parseParametricSchemaStdout(stdout: string, script: string): ParametricSchemaResult {
  const parsed = parseAdapterStdoutObject(stdout, script)
  const envelope = validateAdapterEnvelope(parsed, script)
  if (envelope.engineKey !== "cadquery") {
    throw new EngineUnavailableError(
      `adapter ${script} reported engineKey ${JSON.stringify(envelope.engineKey)} — expected "cadquery"`,
    )
  }
  const modelScriptHash = requireModelScriptHash(parsed, script)
  const payload = validateParametricSchemaPayload(parsed, script)
  return {
    engineKey: "cadquery",
    engineVersion: envelope.engineVersion,
    adapterScript: envelope.adapterScript,
    adapterHash: envelope.adapterHash,
    modelScriptHash,
    ...payload,
  }
}

/** Validate the modelScriptHash envelope field (the artifact-revision identity). */
function requireModelScriptHash(parsed: Record<string, unknown>, script: string): string {
  const { modelScriptHash } = parsed
  if (typeof modelScriptHash !== "string" || !/^[0-9a-f]{64}$/.test(modelScriptHash)) {
    throw new EngineUnavailableError(
      `adapter ${script} payload is missing modelScriptHash (the sha256 of the model script bytes — the artifact-revision identity)`,
    )
  }
  return modelScriptHash
}

/** Parse + validate the build-mode adapter stdout protocol. Pure. */
export function parseParametricBuildStdout(stdout: string, script: string): Omit<ParametricBuildResult, "stepBytes"> {
  const parsed = parseAdapterStdoutObject(stdout, script)
  const envelope = validateAdapterEnvelope(parsed, script)
  if (envelope.engineKey !== "cadquery") {
    throw new EngineUnavailableError(
      `adapter ${script} reported engineKey ${JSON.stringify(envelope.engineKey)} — expected "cadquery"`,
    )
  }
  const modelScriptHash = requireModelScriptHash(parsed, script)
  const payload = validateParametricBuildPayload(parsed, script)
  return {
    engineKey: "cadquery",
    engineVersion: envelope.engineVersion,
    adapterScript: envelope.adapterScript,
    adapterHash: envelope.adapterHash,
    modelScriptHash,
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
  // Adapter ran and reported an honest {"error": …} envelope (exit 1) — the
  // refusal message surfaces verbatim (unknown key / range / type / geometry
  // contradiction / ground-truth disagreement shapes).
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
      `parametric-rebuild adapter (${script}) timed out after ${ADAPTER_TIMEOUT_MS}ms and was terminated`,
    )
  }
  if (err.code === "ENOENT") {
    return new EngineUnavailableError(
      `python interpreter not found at ${PYTHON_BIN} — the engine venv is not deployed on this host (${err.message})`,
    )
  }
  const stderrTail = (err.stderr ?? "").trim().slice(-400)
  return new EngineUnavailableError(
    `parametric-rebuild adapter (${script}) failed with exit code ${String(err.code)}${stderrTail ? `: ${stderrTail}` : ""}`,
  )
}

/** Run the parametric-rebuild adapter with the request JSON on stdin. */
async function execParametricAdapter(script: string, request: string): Promise<{ stdout: string; stderr: string }> {
  const scriptPath = adapterScriptPath(script)
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
 * One adapter run: the stored model bytes are copied to a temp `.py` (the
 * femesh temp-.step pattern — the content store's extensionless `content`
 * key never reaches the engine), the STEP (build mode) is written to a temp
 * path that does NOT exist before the run (the adapter refuses to overwrite),
 * and the temp dir is removed in finally — after the STEP bytes were read
 * back. Pure-python engine — no LD_LIBRARY_PATH bootstrap.
 */
async function runParametricAdapter(
  storagePath: string,
  mode: "schema" | "build",
  parameters?: Record<string, unknown>,
): Promise<{ stdout: string; stderr: string; stepBytes?: Buffer }> {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "eos-parametric-"))
  try {
    const modelBytes = readFileSync(path.resolve(storagePath))
    const modelPath = path.join(tmp, "model.py")
    writeFileSync(modelPath, modelBytes)
    const stepPath = path.join(tmp, "parametric-rebuild.step")
    const request: Record<string, unknown> = { storagePath: modelPath, mode }
    if (mode === "build") {
      request.parameters = parameters
      request.outputPath = stepPath
    }
    const run = await execParametricAdapter(PARAMETRIC_ADAPTER_SCRIPT, JSON.stringify(request))
    let stepBytes: Buffer | undefined
    if (mode === "build") {
      // exit 0 means the adapter exported + re-imported + gate-checked the
      // STEP; a missing file at this point is a protocol violation
      if (!existsSync(stepPath)) {
        throw new EngineUnavailableError(
          `adapter ${PARAMETRIC_ADAPTER_SCRIPT} exited 0 but wrote no STEP file at the requested outputPath — refusing to emit`,
        )
      }
      stepBytes = readFileSync(stepPath)
    }
    return { ...run, stepBytes }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * Read a stored parametric model's declared parameter schema + authored
 * defaults (the Design Studio form source). Throws `EngineUnavailableError`
 * with an honest message when the engine, the venv, or a well-formed
 * parametric model is not available on this host.
 */
export async function parametricSchemaFromStorage(storagePath: string): Promise<ParametricSchemaResult> {
  const run = await runParametricAdapter(storagePath, "schema")
  return parseParametricSchemaStdout(run.stdout, PARAMETRIC_ADAPTER_SCRIPT)
}

/**
 * Rebuild a stored parametric model with the given parameter edits and return
 * the round-trip-checked STEP bytes + re-imported properties. The user's
 * parameters are validated against the model's schema by the ADAPTER (the
 * broker pre-validates with the pure `resolveParametricParams` mirror for
 * its pinned 422s before ever spawning). Throws `EngineUnavailableError`
 * with the adapter's verbatim refusal on any schema violation, geometry
 * contradiction, or analytic ground-truth disagreement.
 */
export async function parametricRebuildFromStorage(
  storagePath: string,
  parameters: Record<string, unknown>,
): Promise<ParametricBuildResult> {
  const run = await runParametricAdapter(storagePath, "build", parameters)
  const parsed = parseParametricBuildStdout(run.stdout, PARAMETRIC_ADAPTER_SCRIPT)
  return { ...parsed, stepBytes: run.stepBytes as Buffer }
}
