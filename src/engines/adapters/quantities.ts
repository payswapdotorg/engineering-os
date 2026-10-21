/**
 * Engineering OS — engine-adapter bridge for model-derived quantities.
 *
 * CONTRACT OWNER: TL (pinned in worklog.md "TL-pinned contracts").
 * IMPLEMENTATION: W2-b — REAL engine adapters (no simulated results, ever):
 *   - STEP → cadquery (OCCT kernel) via `step_quantities.py`
 *   - IFC  → IfcOpenShell via `ifc_quantities.py`
 * Both scripts run as arm's-length subprocesses of the uv venv python
 * (/home/z/.venv/bin/python3, overridable via EOS_PYTHON) and speak a strict
 * JSON protocol on stdout: success = the payload below, failure = {"error": …}
 * exit 1. Every failure — missing venv, missing engine, unreadable model,
 * geometry-free file, adapter crash, timeout — surfaces as an honest
 * `EngineUnavailableError`; nothing is ever fabricated (ADR-0005, ADR-0006).
 */

import { execFile } from "node:child_process"
import { accessSync, constants } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { extensionDeriveKind } from "./derive-kind"

const execFileAsync = promisify(execFile)

export interface DerivedQuantity {
  /** stable per-element reference, e.g. `step:solid:0`, `ifc:#<GlobalId>` */
  elementRef: string
  quantityType: "volume" | "area" | "length" | "count"
  value: number
  /** explicit unit string, e.g. "mm³" — never implicit */
  unit: string
  /** raw engine payload (unmodified numbers from the engine, for evidence) */
  raw: Record<string, unknown>
}

export interface DeriveResult {
  engineKey: string
  engineVersion: string
  /** adapter script file name, e.g. "step_quantities.py" */
  adapterScript: string
  /** sha256 of the adapter script content (recorded in quantity provenance) */
  adapterHash: string
  quantities: DerivedQuantity[]
}

export class EngineUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "EngineUnavailableError"
  }
}

/**
 * Which derivation path a stored artifact revision supports (by extension).
 * Delegates to the canonical detector so the string primitive and the
 * multi-signal `deriveKind` (src/engines/adapters/derive-kind.ts) can never
 * disagree.
 */
export function supportsDerive(storageKey: string): "ifc" | "step" | null {
  return extensionDeriveKind(storageKey)
}

/** Interpreter hosting the real engines (uv venv: cadquery, IfcOpenShell). */
const PYTHON_BIN = process.env.EOS_PYTHON ?? "/home/z/.venv/bin/python3"

/** Hard stop for a hung adapter process — never wait forever for an engine. */
const ADAPTER_TIMEOUT_MS = 120_000

const ADAPTER_SCRIPTS: Record<"ifc" | "step", string> = {
  ifc: "ifc_quantities.py",
  step: "step_quantities.py",
}

/**
 * Resolve an adapter script that exists on this host.
 * Primary: next to this module (works under `bun test` and `next dev`).
 * Fallback: repo-relative from cwd (guards against bundlers rewriting
 * import.meta.url). Missing adapter → honest EngineUnavailableError.
 *
 * (W2-d: exported additively so the mesh bridge — src/engines/adapters/
 * mesh.ts — resolves its scripts through the IDENTICAL mechanism.)
 */
export function adapterScriptPath(script: string): string {
  const candidates: string[] = []
  try {
    candidates.push(path.join(path.dirname(fileURLToPath(import.meta.url)), script))
  } catch {
    // import.meta.url unavailable in this loader — cwd fallback below.
  }
  candidates.push(path.join(process.cwd(), "src", "engines", "adapters", script))
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.F_OK)
      return candidate
    } catch {
      // try next candidate
    }
  }
  throw new EngineUnavailableError(
    `adapter script ${script} not found (looked in: ${candidates.join(", ")})`,
  )
}

interface AdapterPayload {
  engineKey: string
  engineVersion: string
  adapterScript: string
  adapterHash: string
  quantities: DerivedQuantity[]
}

const QUANTITY_TYPES = ["volume", "area", "length", "count"] as const

function isQuantityType(value: unknown): value is DerivedQuantity["quantityType"] {
  return typeof value === "string" && (QUANTITY_TYPES as readonly string[]).includes(value)
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The engine-provenance fields every adapter envelope carries (W2-d: shared
 * with the mesh bridge so both bridges enforce the exact same protocol). */
export interface AdapterEnvelope {
  engineKey: string
  engineVersion: string
  adapterScript: string
  adapterHash: string
}

/**
 * Parse the adapter's stdout as the shared JSON protocol (W2-d: extracted
 * verbatim from the former parseAdapterStdout prologue so both bridges speak
 * byte-identical errors). Throws honestly on invalid JSON, non-object payloads
 * and the adapter's own {"error": …} envelope.
 */
export function parseAdapterStdoutObject(stdout: string, script: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new EngineUnavailableError(
      `adapter ${script} stdout is not valid JSON (first 200 bytes: ${JSON.stringify(stdout.slice(0, 200))})`,
    )
  }
  if (!isPlainObject(parsed)) {
    throw new EngineUnavailableError(`adapter ${script} returned a non-object JSON payload`)
  }
  if (typeof parsed.error === "string") {
    throw new EngineUnavailableError(parsed.error)
  }
  return parsed
}

/** Validate the engine-provenance envelope fields (same messages as W2-b). */
export function validateAdapterEnvelope(
  parsed: Record<string, unknown>,
  script: string,
): AdapterEnvelope {
  const { engineKey, engineVersion, adapterScript, adapterHash } = parsed
  if (typeof engineKey !== "string" || engineKey.length === 0) {
    throw new EngineUnavailableError(`adapter ${script} payload is missing engineKey`)
  }
  if (typeof engineVersion !== "string" || engineVersion.length === 0) {
    throw new EngineUnavailableError(`adapter ${script} payload is missing engineVersion`)
  }
  if (typeof adapterScript !== "string" || typeof adapterHash !== "string") {
    throw new EngineUnavailableError(`adapter ${script} payload is missing adapterScript/adapterHash`)
  }
  if (!/^[0-9a-f]{64}$/.test(adapterHash)) {
    throw new EngineUnavailableError(`adapter ${script} reported a malformed adapterHash`)
  }
  return { engineKey, engineVersion, adapterScript, adapterHash }
}

/** Parse + validate the adapter's JSON protocol; error envelopes throw honestly. */
function parseAdapterStdout(stdout: string, script: string): AdapterPayload {
  const parsed = parseAdapterStdoutObject(stdout, script)
  const { engineKey, engineVersion, adapterScript, adapterHash } = validateAdapterEnvelope(parsed, script)
  const { quantities } = parsed
  if (!Array.isArray(quantities)) {
    throw new EngineUnavailableError(`adapter ${script} payload is missing the quantities array`)
  }
  quantities.forEach((q: unknown, i: number) => {
    if (!isPlainObject(q)) {
      throw new EngineUnavailableError(`adapter ${script} quantities[${i}] is not an object`)
    }
    const { elementRef, quantityType, value, unit, raw } = q
    if (typeof elementRef !== "string" || elementRef.length === 0) {
      throw new EngineUnavailableError(`adapter ${script} quantities[${i}] has no elementRef`)
    }
    if (!isQuantityType(quantityType)) {
      throw new EngineUnavailableError(
        `adapter ${script} quantities[${i}] has unsupported quantityType ${JSON.stringify(quantityType)}`,
      )
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new EngineUnavailableError(`adapter ${script} quantities[${i}] has a non-finite value`)
    }
    if (typeof unit !== "string" || unit.length === 0) {
      throw new EngineUnavailableError(`adapter ${script} quantities[${i}] has no unit`)
    }
    if (!isPlainObject(raw)) {
      throw new EngineUnavailableError(`adapter ${script} quantities[${i}] has no raw payload`)
    }
  })
  return { engineKey, engineVersion, adapterScript, adapterHash, quantities: quantities as DerivedQuantity[] }
}

interface ExecFailure {
  code?: number | string | undefined
  killed?: boolean
  stdout?: string | undefined
  stderr?: string | undefined
  message: string
}

function errorFromExecFailure(kind: "ifc" | "step", script: string, err: ExecFailure): EngineUnavailableError {
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
      `${kind} adapter (${script}) timed out after ${ADAPTER_TIMEOUT_MS}ms and was terminated`,
    )
  }
  if (err.code === "ENOENT") {
    return new EngineUnavailableError(
      `python interpreter not found at ${PYTHON_BIN} — the engine venv is not deployed on this host (${err.message})`,
    )
  }
  const stderrTail = (err.stderr ?? "").trim().slice(-400)
  return new EngineUnavailableError(
    `${kind} adapter (${script}) failed with exit code ${String(err.code)}${stderrTail ? `: ${stderrTail}` : ""}`,
  )
}

/**
 * Run an engine-adapter script as an arm's-length subprocess and return its
 * stdout (W2-d: extracted verbatim from the former deriveFromFile body so the
 * mesh bridge execs adapters through the IDENTICAL mechanism, timeout and
 * honest error mapping). Throws `EngineUnavailableError` on every failure.
 */
export async function execAdapterScript(kind: "ifc" | "step", script: string, absPath: string): Promise<string> {
  const scriptPath = adapterScriptPath(script)
  try {
    const result = await execFileAsync(PYTHON_BIN, [scriptPath, path.resolve(absPath)], {
      timeout: ADAPTER_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    })
    return result.stdout
  } catch (err) {
    throw errorFromExecFailure(kind, script, err as ExecFailure)
  }
}

/**
 * Derive real quantities from a stored model file using the registered engine
 * for `kind`. Throws `EngineUnavailableError` with an honest message when the
 * engine or adapter is not available on this host.
 */
export async function deriveFromFile(
  absPath: string,
  kind: "ifc" | "step",
): Promise<DeriveResult> {
  const script = ADAPTER_SCRIPTS[kind]
  const stdout = await execAdapterScript(kind, script, absPath)
  const payload = parseAdapterStdout(stdout, script)
  return {
    engineKey: payload.engineKey,
    engineVersion: payload.engineVersion,
    adapterScript: payload.adapterScript,
    adapterHash: payload.adapterHash,
    quantities: payload.quantities,
  }
}
