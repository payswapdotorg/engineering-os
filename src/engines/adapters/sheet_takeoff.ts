/**
 * Engineering OS — engine-adapter bridge for VECTOR SHEET TAKEOFF (pdfplumber).
 *
 * IMPLEMENTATION: Lane 16-V (Slice 15 vector-takeoff lane), following the
 * research-verified design (worklog 16-R1) and the W2-f femesh bridge
 * pattern (src/engines/adapters/femesh.ts → step_femesh.py):
 *   - vector PDF pages → pdfplumber (+pdfminer.six) via `sheet_takeoff.py`
 * Unlike the argv-based quantity/tessellation adapters, this one carries its
 * parameters over STDIN ({storagePath, parameters{pageNo, scaleMmPerPt,
 * flattenSegments}}) per contract §5.1. The subprocess protocol is otherwise
 * the exact house style: JSON on stdout — success = the payload below,
 * failure = {"error": …} exit 1; `adapterHash` is the script's own sha256.
 *
 * `scaleMmPerPt` is the calibrated drawing scale (true mm per PDF point) —
 * the BROKER resolves it from the revision's calibration record before
 * calling. It is REQUIRED: the bridge refuses with the pinned verbatim
 * message when it is missing or not a positive number (calibrate first —
 * an uncalibrated takeoff number is a fabricated number, ADR-0005/0006).
 * `flattenSegments` is a resolution knob clamped into its pinned 4..256
 * range (the clamped value is echoed by the adapter, never silent).
 * Pure-python engine — no LD_LIBRARY_PATH bootstrap needed (unlike gmsh).
 *
 * Every failure — missing venv, missing pdfplumber, unreadable PDF, page
 * out of range, raster-only page, bad parameters, adapter crash, timeout,
 * malformed payload — surfaces as an honest `EngineUnavailableError`
 * (mapped to 422 `engine_unavailable` by the broker); nothing is ever
 * fabricated.
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

/** Interpreter hosting pdfplumber (same override the other bridges honour). */
const PYTHON_BIN = process.env.EOS_PYTHON ?? "/home/z/.venv/bin/python3"

/** Hard stop for a hung adapter process — never wait forever for an engine. */
const ADAPTER_TIMEOUT_MS = 60_000

const SHEET_ADAPTER_SCRIPT = "sheet_takeoff.py"

// ---------------------------------------------------------------------------
// Types (the frozen 16-V bridge contract — the TL's broker cores import these)
// ---------------------------------------------------------------------------

export interface SheetTakeoffParameters {
  pageNo: number
  scaleMmPerPt: number
  flattenSegments: number
}

export interface SheetTakeoffResult {
  engineKey: "pdfplumber"
  engineVersion: string
  /** adapter script file name, e.g. "sheet_takeoff.py" */
  adapterScript: string
  /** sha256 of the adapter script content (recorded in provenance) */
  adapterHash: string
  pageCount: number
  pageNo: number
  scaleMmPerPt: number
  flattenSegments: number
  page: { widthPt: number; heightPt: number }
  entities: {
    lines: { count: number; totalLengthMm: number }
    rects: { count: number; totalPerimeterMm: number; totalAreaMm2: number }
    curves: { count: number; totalLengthMm: number; totalClosedAreaMm2: number }
  }
  items: unknown[]
  text: unknown[]
}

/** The pinned verbatim no-scale refusal (shared with the python adapter). */
export const SHEET_TAKEOFF_REFUSAL_NO_SCALE =
  "scaleMmPerPt must be a positive number — calibrate the sheet first or pass it explicitly"

/** flattenSegments clamp range (the adapter re-applies the identical policy). */
export const FLATTEN_SEGMENTS_MIN = 4
export const FLATTEN_SEGMENTS_MAX = 256

// ---------------------------------------------------------------------------
// Parameter resolution (pure — unit-tested without spawning the engine)
// ---------------------------------------------------------------------------

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

/**
 * Resolve + validate sheet-takeoff parameters. PURE.
 *
 * Policy (mirrored verbatim by the python adapter's read_request):
 *   - pageNo: default 1; must be an integer >= 1 — refused otherwise (a
 *     wrong page is a wrong number, never clamped);
 *   - scaleMmPerPt: REQUIRED, must be a positive finite number — the pinned
 *     verbatim refusal otherwise (this is the calibration-correctness knob);
 *   - flattenSegments: default 32; a resolution knob — truncated toward zero
 *     and clamped into [4, 256], never rejected (the adapter echoes the
 *     clamped value, so nothing is silent).
 */
export function resolveSheetTakeoffParams(raw: Record<string, unknown>): SheetTakeoffParameters {
  // only `undefined` means absent — an explicit null is a bad value and is
  // refused (the python adapter's params.get() treats null the same way)
  const pageNoRaw = raw.pageNo === undefined ? 1 : raw.pageNo
  if (typeof pageNoRaw !== "number" || !Number.isInteger(pageNoRaw) || pageNoRaw < 1) {
    throw new EngineUnavailableError(
      `sheet_takeoff parameters.pageNo must be an integer >= 1 — got ${JSON.stringify(pageNoRaw)}`,
    )
  }
  const scale = raw.scaleMmPerPt
  if (!isFiniteNumber(scale) || !(scale > 0)) {
    throw new EngineUnavailableError(SHEET_TAKEOFF_REFUSAL_NO_SCALE)
  }
  const segRaw = raw.flattenSegments === undefined ? 32 : raw.flattenSegments
  if (!isFiniteNumber(segRaw)) {
    throw new EngineUnavailableError(
      `sheet_takeoff parameters.flattenSegments must be a finite number — got ${JSON.stringify(raw.flattenSegments)}`,
    )
  }
  const flattenSegments = Math.min(
    FLATTEN_SEGMENTS_MAX,
    Math.max(FLATTEN_SEGMENTS_MIN, Math.trunc(segRaw)),
  )
  return { pageNo: pageNoRaw, scaleMmPerPt: scale, flattenSegments }
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

/** Validate the sheet-takeoff adapter's stdout payload. Pure; throws honestly. */
export function validateSheetTakeoffPayload(
  parsed: Record<string, unknown>,
  script: string,
): Omit<SheetTakeoffResult, "engineKey" | "engineVersion" | "adapterScript" | "adapterHash"> {
  const { pageCount, pageNo, scaleMmPerPt, flattenSegments, page, entities, items, text } = parsed
  if (!isCount(pageCount) || pageCount < 1) {
    throw new EngineUnavailableError(`adapter ${script} payload is missing pageCount (positive integer)`)
  }
  if (!isCount(pageNo) || pageNo < 1) {
    throw new EngineUnavailableError(`adapter ${script} payload is missing pageNo (positive integer)`)
  }
  if (!isFiniteNumber(scaleMmPerPt) || !(scaleMmPerPt > 0)) {
    throw new EngineUnavailableError(`adapter ${script} payload is missing a positive scaleMmPerPt`)
  }
  if (
    typeof flattenSegments !== "number" ||
    !Number.isInteger(flattenSegments) ||
    flattenSegments < FLATTEN_SEGMENTS_MIN ||
    flattenSegments > FLATTEN_SEGMENTS_MAX
  ) {
    throw new EngineUnavailableError(
      `adapter ${script} payload is missing flattenSegments (integer in ${FLATTEN_SEGMENTS_MIN}..${FLATTEN_SEGMENTS_MAX})`,
    )
  }
  if (!isPlainObject(page) || !isFiniteNumber(page.widthPt) || !isFiniteNumber(page.heightPt)) {
    throw new EngineUnavailableError(`adapter ${script} payload is missing page {widthPt, heightPt}`)
  }
  if (!isPlainObject(entities)) {
    throw new EngineUnavailableError(`adapter ${script} payload is missing the entities object`)
  }
  const { lines, rects, curves } = entities
  if (!isPlainObject(lines) || !isCount(lines.count) || !isNonNegativeFinite(lines.totalLengthMm)) {
    throw new EngineUnavailableError(
      `adapter ${script} payload is missing entities.lines {count, totalLengthMm}`,
    )
  }
  if (
    !isPlainObject(rects) ||
    !isCount(rects.count) ||
    !isNonNegativeFinite(rects.totalPerimeterMm) ||
    !isNonNegativeFinite(rects.totalAreaMm2)
  ) {
    throw new EngineUnavailableError(
      `adapter ${script} payload is missing entities.rects {count, totalPerimeterMm, totalAreaMm2}`,
    )
  }
  if (
    !isPlainObject(curves) ||
    !isCount(curves.count) ||
    !isNonNegativeFinite(curves.totalLengthMm) ||
    !isNonNegativeFinite(curves.totalClosedAreaMm2)
  ) {
    throw new EngineUnavailableError(
      `adapter ${script} payload is missing entities.curves {count, totalLengthMm, totalClosedAreaMm2}`,
    )
  }
  if (!Array.isArray(items) || items.length > 400) {
    throw new EngineUnavailableError(`adapter ${script} payload items must be an array capped at 400`)
  }
  if (!Array.isArray(text) || text.length > 200) {
    throw new EngineUnavailableError(`adapter ${script} payload text must be an array capped at 200`)
  }
  return {
    pageCount,
    pageNo,
    scaleMmPerPt,
    flattenSegments,
    page: { widthPt: page.widthPt as number, heightPt: page.heightPt as number },
    entities: {
      lines: { count: lines.count as number, totalLengthMm: lines.totalLengthMm as number },
      rects: {
        count: rects.count as number,
        totalPerimeterMm: rects.totalPerimeterMm as number,
        totalAreaMm2: rects.totalAreaMm2 as number,
      },
      curves: {
        count: curves.count as number,
        totalLengthMm: curves.totalLengthMm as number,
        totalClosedAreaMm2: curves.totalClosedAreaMm2 as number,
      },
    },
    items: items as unknown[],
    text: text as unknown[],
  }
}

/** Parse + validate the sheet-takeoff adapter's full stdout protocol. Pure. */
export function parseSheetTakeoffAdapterStdout(stdout: string, script: string): SheetTakeoffResult {
  const parsed = parseAdapterStdoutObject(stdout, script)
  const envelope = validateAdapterEnvelope(parsed, script)
  const payload = validateSheetTakeoffPayload(parsed, script)
  if (envelope.engineKey !== "pdfplumber") {
    throw new EngineUnavailableError(
      `adapter ${script} reported engineKey ${JSON.stringify(envelope.engineKey)} — expected "pdfplumber"`,
    )
  }
  return {
    engineKey: "pdfplumber",
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
      `sheet-takeoff adapter (${script}) timed out after ${ADAPTER_TIMEOUT_MS}ms and was terminated`,
    )
  }
  if (err.code === "ENOENT") {
    return new EngineUnavailableError(
      `python interpreter not found at ${PYTHON_BIN} — the engine venv is not deployed on this host (${err.message})`,
    )
  }
  const stderrTail = (err.stderr ?? "").trim().slice(-400)
  return new EngineUnavailableError(
    `sheet-takeoff adapter (${script}) failed with exit code ${String(err.code)}${stderrTail ? `: ${stderrTail}` : ""}`,
  )
}

/**
 * Run the pdfplumber sheet-takeoff adapter as an arm's-length subprocess with
 * the request JSON on stdin (pure python — no LD_LIBRARY_PATH bootstrap).
 * Throws `EngineUnavailableError` on every failure.
 */
async function execSheetTakeoffAdapter(
  script: string,
  storagePath: string,
  parameters: SheetTakeoffParameters,
): Promise<{ stdout: string; stderr: string }> {
  const scriptPath = adapterScriptPath(script)
  const request = JSON.stringify({
    storagePath: path.resolve(storagePath),
    parameters: {
      pageNo: parameters.pageNo,
      scaleMmPerPt: parameters.scaleMmPerPt,
      flattenSegments: parameters.flattenSegments,
    },
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
 * Extract REAL vector geometry (lines/rects/curves with full bezier control
 * points, flattened deterministically) from one page of a stored PDF file
 * using pdfplumber. `scaleMmPerPt` is the resolved drawing calibration and is
 * REQUIRED — missing/invalid values throw the pinned verbatim refusal.
 * Throws `EngineUnavailableError` with an honest message when the engine, the
 * file, the page, or the calibration is not available on this host.
 */
export async function sheetTakeoffFromStorage(
  storagePath: string,
  parameters: { pageNo?: number; scaleMmPerPt?: number; flattenSegments?: number },
): Promise<SheetTakeoffResult> {
  const resolved = resolveSheetTakeoffParams(parameters as Record<string, unknown>)
  const run = await execSheetTakeoffAdapter(SHEET_ADAPTER_SCRIPT, storagePath, resolved)
  const result = parseSheetTakeoffAdapterStdout(run.stdout, SHEET_ADAPTER_SCRIPT)
  // echo guard: the adapter must answer about the exact request we sent
  if (result.pageNo !== resolved.pageNo || result.scaleMmPerPt !== resolved.scaleMmPerPt || result.flattenSegments !== resolved.flattenSegments) {
    throw new EngineUnavailableError(
      `adapter ${SHEET_ADAPTER_SCRIPT} echoed a different request than the one sent (pageNo/scaleMmPerPt/flattenSegments mismatch) — refusing the payload`,
    )
  }
  return result
}
