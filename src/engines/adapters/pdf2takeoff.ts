/**
 * Engineering OS — engine-adapter bridge for the ADOPTED takeoff engine
 * pdf2takeoff (ADR-0009 decision 5, Stage 1 — the audit's highest-value
 * reuse: room fill, revision compare, PDF annotation round-trip and BOQ
 * export are CONSUMED from upstream, not rebuilt).
 *
 * ARM'S-LENGTH CONTRACT (ADR-0005): the engine is an external Node checkout
 * pinned to the EXACT commit f5a1c08… (scripts/setup-pdf2takeoff.sh clones
 * ajflow/pdf2takeoff at it and stamps .eos-engine-pin; this bridge refuses to
 * spawn anything else). Every call is a fresh subprocess speaking the
 * upstream's own public surfaces — the headless CLI (bin/pdf2takeoff.js:
 * compare / annotate / export) and the stdio MCP server (open_document →
 * set_scale → fill_area) — JSON in, JSON out, nothing linked, nothing
 * vendored. `adapterHash` is the sha256 of THIS bridge file's own bytes (the
 * convert-document.ts self-report convention); `pinnedCommit` is verified
 * against .eos-engine-pin at every process start and echoed in every result.
 *
 * The four Stage-1 broker ops map onto it (ADR-0009 migration plan):
 *   - compare_revisions  → CLI `compare <old> <new>` (per-sheet change
 *     fractions + changed regions + vector diffs, deterministic JSON)
 *   - annotate_takeoff   → CLI `annotate <pdf> --spec <yaml> -o <out>` —
 *     writes spec-defined markups into the PDF as STANDARD annotations that
 *     open in Bluebeam Revu / Adobe Acrobat / the web app. Output embeds a
 *     creation timestamp: byte-determinism is NOT claimed (the LibreOffice
 *     §5.4 convention — structural evidence only), and re-runs REPLACE the
 *     pdf2takeoff markups idempotently (kept == 0 on the second run).
 *   - export_boq_xlsx    → CLI `export <pdf> --scale 1:R --unit m --format
 *     csv|xlsx` — reads pdf2takeoff annotations back out as a quantities
 *     table (the annotate→export ROUND-TRIP is the corpus pin).
 *   - fill_area          → MCP session `open_document` → `set_scale` (the
 *     platform calibration carried EXACTLY via from_points — no ratio
 *     rounding) → `fill_area` (Magic Fill: flood fill bounded by walls, door
 *     gaps closed; the value + full provenance come back in the tool result).
 *
 * Scale honesty (ADR-0006): every real-world number this bridge returns was
 * produced by the ENGINE under a scale the BROKER resolved (explicit
 * parameter or the revision's calibration markup — never a guess). fill_area
 * refuses the pinned verbatim message without one; export carries the
 * resolved scale as a 1:R string (4-dp) and the platform value is recorded
 * in provenance. Every failure — missing checkout, wrong pin, missing
 * node_modules, unreadable PDF, malformed payload, subprocess crash,
 * timeout, MCP protocol error, the engine's own honest refusals — surfaces
 * as an honest `EngineUnavailableError` (mapped to 422 by the broker);
 * nothing is ever fabricated.
 */

import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { ADAPTER_TAIL_CHARS, EngineUnavailableError, isPlainObject } from "./quantities"

export { EngineUnavailableError }

// ---------------------------------------------------------------------------
// The pinned engine checkout (resolved + verified once per process)
// ---------------------------------------------------------------------------

/** The audit-pinned upstream commit (ADR-0009; setup-pdf2takeoff.sh stamps it). */
export const PDF2TAKEOFF_PINNED_COMMIT = "f5a1c08b1308628755867df3b921e96ac2018969"

/** The engine checkout root (the registry probe path; overridable for honest skips). */
export const PDF2TAKEOFF_DIR = process.env.EOS_PDF2TAKEOFF_DIR ?? path.join(os.homedir(), ".local", "share", "eos-engines", "pdf2takeoff")

/** The node binary hosting the engine subprocess (never process.execPath — the platform may run under bun). */
const NODE_BIN = process.env.EOS_NODE_BIN ?? "node"

/** Hard stop for one CLI invocation — never wait forever for an engine. */
const CLI_TIMEOUT_MS = 120_000
/** Hard stop for a whole MCP session (open → set_scale → fill). */
const MCP_TIMEOUT_MS = 180_000

const ADAPTER_SCRIPT_NAME = "pdf2takeoff.ts"

/** Pinned verbatim refusals (unit-tested verbatim, mirrored nowhere else). */
export const PDF2TAKEOFF_REFUSAL_NO_SCALE =
  "fill_area parameters.scaleMmPerPt must be a positive number — calibrate the sheet first or pass it explicitly (an uncalibrated takeoff number is a fabricated number)"

/** Markup types the upstream annotate spec accepts (its parseSpec validation:
 * "markups[i].type must be length, area or count" — mirrored exactly). */
export const TAKEOFF_MARKUP_TYPES = ["length", "area", "count"] as const
export type TakeoffMarkupType = (typeof TAKEOFF_MARKUP_TYPES)[number]

/** Per-type point-count policy mirroring the upstream parseSpec validation:
 * length/area ≥ 2 points; count EXACTLY 1 point. */
const MIN_POINTS_BY_TYPE: Record<TakeoffMarkupType, number> = {
  length: 2,
  area: 2,
  count: 1,
}
const EXACT_POINTS_BY_TYPE: Partial<Record<TakeoffMarkupType, number>> = {
  count: 1,
}
const MAX_MARKUPS = 200
const MAX_POINTS_PER_MARKUP = 64

export interface TakeoffSpecMarkup {
  type: TakeoffMarkupType
  label?: string
  page?: number
  points: Array<[number, number]>
}

export interface Pdf2takeoffEngine {
  engineKey: "pdf2takeoff"
  engineVersion: string
  adapterScript: "pdf2takeoff.ts"
  adapterHash: string
  pinnedCommit: string
  /** absolute path of the engine checkout the call ran against */
  engineDir: string
}

let engineCache: Pdf2takeoffEngine | null = null
let adapterHashCache: string | null = null

/** sha256 of this bridge file's own bytes (the adapters' self-report). */
async function adapterSelfHash(): Promise<string> {
  if (adapterHashCache !== null) return adapterHashCache
  let selfPath: string
  try {
    selfPath = fileURLToPath(import.meta.url)
  } catch {
    selfPath = path.join(process.cwd(), "src", "engines", "adapters", ADAPTER_SCRIPT_NAME)
  }
  try {
    adapterHashCache = createHash("sha256").update(await readFile(selfPath)).digest("hex")
  } catch {
    adapterHashCache = createHash("sha256").update(ADAPTER_SCRIPT_NAME).digest("hex")
  }
  return adapterHashCache
}

/**
 * Resolve + verify the pinned engine checkout: the dir exists, its
 * package.json carries the version, bin/pdf2takeoff.js exists, node_modules
 * is installed, and .eos-engine-pin matches the ADAPTER's pinned commit
 * (a drifted checkout is a different engine — refused honestly, never run).
 */
export async function resolvePdf2takeoffEngine(): Promise<Pdf2takeoffEngine> {
  if (engineCache !== null) return engineCache
  const binPath = path.join(PDF2TAKEOFF_DIR, "bin", "pdf2takeoff.js")
  const pkgPath = path.join(PDF2TAKEOFF_DIR, "package.json")
  const pinPath = path.join(PDF2TAKEOFF_DIR, ".eos-engine-pin")
  if (!existsSync(binPath)) {
    throw new EngineUnavailableError(
      `pdf2takeoff is not installed at ${PDF2TAKEOFF_DIR} (run scripts/setup-pdf2takeoff.sh; EOS_PDF2TAKEOFF_DIR can override) — the takeoff engine is unavailable`,
    )
  }
  if (!existsSync(path.join(PDF2TAKEOFF_DIR, "node_modules", "pdfjs-dist"))) {
    throw new EngineUnavailableError(
      `pdf2takeoff at ${PDF2TAKEOFF_DIR} has no installed dependencies (run scripts/setup-pdf2takeoff.sh again) — the takeoff engine is unavailable`,
    )
  }
  let version = "unknown"
  try {
    version = (JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string }).version ?? "unknown"
  } catch {
    throw new EngineUnavailableError(`could not read the engine version from ${pkgPath} — the checkout is corrupt`)
  }
  let pin = ""
  try {
    pin = readFileSync(pinPath, "utf8").trim()
  } catch {
    throw new EngineUnavailableError(
      `${PDF2TAKEOFF_DIR} carries no .eos-engine-pin (run scripts/setup-pdf2takeoff.sh) — an unpinned engine checkout is never run`,
    )
  }
  if (pin !== PDF2TAKEOFF_PINNED_COMMIT) {
    throw new EngineUnavailableError(
      `pdf2takeoff checkout at ${PDF2TAKEOFF_DIR} is pinned to ${pin}, but the bridge requires ${PDF2TAKEOFF_PINNED_COMMIT} (ADR-0009 Stage 1) — run scripts/setup-pdf2takeoff.sh to restore the audited pin`,
    )
  }
  engineCache = {
    engineKey: "pdf2takeoff",
    engineVersion: version,
    adapterScript: ADAPTER_SCRIPT_NAME,
    adapterHash: await adapterSelfHash(),
    pinnedCommit: pin,
    engineDir: PDF2TAKEOFF_DIR,
  }
  return engineCache
}

// ---------------------------------------------------------------------------
// Pure parameter/spec validation (unit-tested without spawning the engine)
// ---------------------------------------------------------------------------

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

/**
 * Validate an annotate-spec markups array (the upstream SpecMarkup schema,
 * mirrored so bad input is refused BEFORE any subprocess spawn). PURE.
 */
export function validateTakeoffSpecMarkups(raw: unknown): { ok: true; value: TakeoffSpecMarkup[] } | { ok: false; message: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, message: "annotate_takeoff parameters.markups must be a non-empty array of markup objects" }
  }
  if (raw.length > MAX_MARKUPS) {
    return { ok: false, message: `annotate_takeoff parameters.markups is capped at ${MAX_MARKUPS} entries — got ${raw.length}` }
  }
  const out: TakeoffSpecMarkup[] = []
  for (let i = 0; i < raw.length; i++) {
    const m = raw[i]
    if (!isPlainObject(m)) {
      return { ok: false, message: `annotate_takeoff parameters.markups[${i}] must be an object` }
    }
    const type = m.type
    if (typeof type !== "string" || !(TAKEOFF_MARKUP_TYPES as readonly string[]).includes(type)) {
      return {
        ok: false,
        message: `annotate_takeoff parameters.markups[${i}].type must be one of ${TAKEOFF_MARKUP_TYPES.join("|")} — got ${JSON.stringify(type)}`,
      }
    }
    const markupType = type as TakeoffMarkupType
    if (m.label !== undefined && (typeof m.label !== "string" || m.label.length === 0 || m.label.length > 120)) {
      return { ok: false, message: `annotate_takeoff parameters.markups[${i}].label must be a 1..120-char string when provided` }
    }
    if (m.page !== undefined && (typeof m.page !== "number" || !Number.isInteger(m.page) || m.page < 1)) {
      return { ok: false, message: `annotate_takeoff parameters.markups[${i}].page must be a positive integer when provided` }
    }
    const points = m.points
    const exact = EXACT_POINTS_BY_TYPE[markupType]
    if (
      !Array.isArray(points) ||
      points.length < MIN_POINTS_BY_TYPE[markupType] ||
      points.length > MAX_POINTS_PER_MARKUP ||
      (exact !== undefined && points.length !== exact)
    ) {
      const wanted = exact !== undefined ? `exactly ${exact}` : `${MIN_POINTS_BY_TYPE[markupType]}..${MAX_POINTS_PER_MARKUP}`
      return {
        ok: false,
        message: `annotate_takeoff parameters.markups[${i}].points must be an array of ${wanted} [x,y] pairs for type ${markupType}`,
      }
    }
    const pts: Array<[number, number]> = []
    for (let j = 0; j < points.length; j++) {
      const p = points[j]
      if (!Array.isArray(p) || p.length !== 2 || !isFiniteNumber(p[0]) || !isFiniteNumber(p[1])) {
        return {
          ok: false,
          message: `annotate_takeoff parameters.markups[${i}].points[${j}] must be a finite [x, y] pair (PDF points)`,
        }
      }
      pts.push([p[0], p[1]])
    }
    out.push({
      type: markupType,
      ...(m.label !== undefined ? { label: m.label } : {}),
      ...(m.page !== undefined ? { page: m.page } : {}),
      points: pts,
    })
  }
  return { ok: true, value: out }
}

/**
 * Serialize a validated spec to deterministic YAML for the upstream annotate
 * command. The schema is CLOSED (type/label/page/points), labels are
 * sanitized to printable ASCII without YAML metacharacters — so a hand
 * emitter is exactly specified and no YAML dependency enters the platform.
 * PURE.
 */
export function buildTakeoffSpecYaml(markups: TakeoffSpecMarkup[]): string {
  const lines: string[] = ["markups:"]
  for (const m of markups) {
    lines.push(`  - type: ${m.type}`)
    if (m.label !== undefined) {
      lines.push(`    label: ${sanitizeYamlScalar(m.label)}`)
    }
    if (m.page !== undefined) {
      lines.push(`    page: ${m.page}`)
    }
    lines.push("    points:")
    for (const [x, y] of m.points) {
      lines.push(`      - [${fmtPt(x)}, ${fmtPt(y)}]`)
    }
  }
  return lines.join("\n") + "\n"
}

/** Deterministic number printing for spec points (≤4 dp, trailing-zero trim). */
function fmtPt(v: number): string {
  const s = v.toFixed(4).replace(/\.?0+$/, "")
  return s === "" || s === "-" ? "0" : s
}

/** YAML-safe scalar: printable ASCII, no quotes/colons/hash/control chars,
 * runs of stripped characters collapse to a single space. */
function sanitizeYamlScalar(label: string): string {
  const cleaned = label
    .split("")
    .filter((ch) => ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) <= 0x7e)
    .join("")
    .replace(/["':#]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return cleaned.length > 0 ? cleaned : "Takeoff"
}

/**
 * Parse the CLI export output (CSV/TSV) into a rows matrix. Handles the
 * quoted-comma fields the matrix writer emits. PURE.
 */
export function parseCsvTable(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === delimiter) {
      row.push(field)
      field = ""
    } else if (ch === "\n") {
      row.push(field)
      if (row.some((c) => c.length > 0)) rows.push(row)
      row = []
      field = ""
    } else if (ch !== "\r") {
      field += ch
    }
  }
  row.push(field)
  if (row.some((c) => c.length > 0)) rows.push(row)
  return rows
}

/**
 * Convert a platform calibration (mm per PDF point) to the engine's 1:R
 * ratio string (4 dp — the export CLI's scale surface). At the A-102's
 * exact 1:100 this is the round "1:100"; browser-calibrated values keep
 * 4 significant decimals of their own. PURE.
 */
export function scaleMmPerPtToRatioString(scaleMmPerPt: number): string {
  const ratio = (scaleMmPerPt * 72) / 25.4
  return `1:${ratio.toFixed(4).replace(/\.?0+$/, "")}`
}

// ---------------------------------------------------------------------------
// CLI subprocess core (compare / annotate / export)
// ---------------------------------------------------------------------------

interface ExecOutcome {
  code: number
  stdout: string
  stderr: string
}

/** Spawn `node bin/pdf2takeoff.js <args…>` and collect the outcome honestly.
 * execFile, not spawn — the standalone-output build traces execFile call
 * shapes (the house convention every bundled adapter follows). A non-zero
 * exit RESOLVES with its code (the caller maps the engine's stderr tail);
 * only spawn-level failures (timeout/ENOENT) reject. */
function runCli(args: string[], timeoutMs: number): Promise<ExecOutcome> {
  const binPath = path.join(PDF2TAKEOFF_DIR, "bin", "pdf2takeoff.js")
  return new Promise((resolve, reject) => {
    execFile(
      NODE_BIN,
      [binPath, ...args],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string }
          if (e.killed) {
            reject(
              new EngineUnavailableError(
                `pdf2takeoff CLI timed out after ${timeoutMs}ms and was terminated (${args[0] ?? "cli"})`,
              ),
            )
            return
          }
          if (e.code === "ENOENT") {
            reject(
              new EngineUnavailableError(
                `node is not runnable at "${NODE_BIN}" (EOS_NODE_BIN can override) — the pdf2takeoff engine cannot start`,
              ),
            )
            return
          }
          if (typeof e.code === "number") {
            // the process ran and exited non-zero — the engine's own honest
            // diagnostic rides stderr; the caller surfaces it verbatim
            resolve({ code: e.code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") })
            return
          }
          reject(new EngineUnavailableError(`pdf2takeoff CLI could not start: ${err.message}`))
          return
        }
        resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) })
      },
    )
  })
}

/** Map a failed CLI run to an honest EngineUnavailableError (stderr tail kept). */
function cliFailure(command: string, outcome: ExecOutcome): EngineUnavailableError {
  const stderrTail = outcome.stderr.trim().slice(-400)
  if (stderrTail.length > 0) {
    return new EngineUnavailableError(`pdf2takeoff ${command} failed: ${stderrTail}`)
  }
  return new EngineUnavailableError(
    `pdf2takeoff ${command} failed with exit code ${outcome.code} and no diagnostic output (stdout tail: ${JSON.stringify(outcome.stdout.slice(-200))})`,
  )
}

/** Parse the CLI's JSON stdout; refuses non-JSON output honestly. */
function parseCliJson(command: string, stdout: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(stdout)
    if (!isPlainObject(parsed)) {
      throw new Error("not an object")
    }
    return parsed
  } catch {
    throw new EngineUnavailableError(
      `pdf2takeoff ${command} printed non-JSON output (first 200 chars: ${JSON.stringify(stdout.slice(0, 200))}) — refusing to interpret it`,
    )
  }
}

// ---------------------------------------------------------------------------
// compare (revision comparison — CLI `compare <a> <b>`)
// ---------------------------------------------------------------------------

export interface Pdf2takeoffCompareResult extends Pdf2takeoffEngine {
  sheetCountA: number
  sheetCountB: number
  comparedSheets: number
  changedSheets: number[]
  summary: { changed: number; unchanged: number; onlyInA: number; onlyInB: number }
  sheets: Array<{
    page: number
    widthPt: number
    heightPt: number
    changedFraction: number
    changed: boolean
    regions: Array<{ xPt: number; yPt: number; wPt: number; hPt: number }>
    vector?: { identical: boolean; added: number; removed: number }
  }>
}

/** Validate the compare payload shape (pure; refuses malformed honestly). */
export function validateComparePayload(parsed: Record<string, unknown>): Omit<Pdf2takeoffCompareResult, keyof Pdf2takeoffEngine | "changedSheets"> {
  const { sheetCountA, sheetCountB, comparedSheets, changedSheets, summary, sheets } = parsed
  const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0
  if (!isCount(sheetCountA) || !isCount(sheetCountB) || !isCount(comparedSheets)) {
    throw new EngineUnavailableError("compare payload is missing integer sheetCountA/sheetCountB/comparedSheets")
  }
  if (!isPlainObject(summary) || !isCount(summary.changed) || !isCount(summary.unchanged) || !isCount(summary.onlyInA) || !isCount(summary.onlyInB)) {
    throw new EngineUnavailableError("compare payload is missing the summary {changed, unchanged, onlyInA, onlyInB} counts")
  }
  if (!Array.isArray(sheets) || sheets.length > 500) {
    throw new EngineUnavailableError("compare payload sheets must be an array capped at 500")
  }
  const outSheets: Pdf2takeoffCompareResult["sheets"] = []
  for (const s of sheets) {
    if (!isPlainObject(s) || !isCount(s.page) || !isFiniteNumber(s.changedFraction) || typeof s.changed !== "boolean" || !Array.isArray(s.regions)) {
      throw new EngineUnavailableError("compare payload sheets[] entries must carry {page, changedFraction, changed, regions}")
    }
    if (s.regions.length > 200) {
      throw new EngineUnavailableError("compare payload sheets[].regions is capped at 200")
    }
    const regions = s.regions.map((r) => {
      if (!isPlainObject(r) || !isFiniteNumber(r.xPt) || !isFiniteNumber(r.yPt) || !isFiniteNumber(r.wPt) || !isFiniteNumber(r.hPt)) {
        throw new EngineUnavailableError("compare payload regions[] entries must carry {xPt, yPt, wPt, hPt}")
      }
      return { xPt: r.xPt as number, yPt: r.yPt as number, wPt: r.wPt as number, hPt: r.hPt as number }
    })
    const vector =
      isPlainObject(s.vector) && typeof s.vector.identical === "boolean"
        ? { identical: s.vector.identical as boolean, added: (s.vector.added as number) ?? 0, removed: (s.vector.removed as number) ?? 0 }
        : undefined
    outSheets.push({
      page: s.page as number,
      widthPt: (s.widthPt as number) ?? 0,
      heightPt: (s.heightPt as number) ?? 0,
      changedFraction: s.changedFraction as number,
      changed: s.changed as boolean,
      regions,
      ...(vector !== undefined ? { vector } : {}),
    })
  }
  return {
    sheetCountA,
    sheetCountB,
    comparedSheets,
    summary: {
      changed: summary.changed as number,
      unchanged: summary.unchanged as number,
      onlyInA: summary.onlyInA as number,
      onlyInB: summary.onlyInB as number,
    },
    sheets: outSheets,
  }
}

/**
 * Compare two stored PDF revisions with the engine's raster+vector diff:
 * per-sheet change fractions, changed regions, added/removed sheets.
 * Deterministic JSON; every failure throws EngineUnavailableError.
 */
export async function pdf2takeoffCompareRevisions(oldPath: string, newPath: string): Promise<Pdf2takeoffCompareResult> {
  const engine = await resolvePdf2takeoffEngine()
  const args = ["compare", path.resolve(oldPath), path.resolve(newPath)]
  const outcome = await runCli(args, CLI_TIMEOUT_MS)
  if (outcome.code !== 0) throw cliFailure("compare", outcome)
  const payload = validateComparePayload(parseCliJson("compare", outcome.stdout))
  return { ...engine, ...payload, changedSheets: payload.sheets.filter((s) => s.changed).map((s) => s.page) }
}

// ---------------------------------------------------------------------------
// annotate (PDF annotation round-trip — CLI `annotate --spec <yaml> -o <pdf>`)
// ---------------------------------------------------------------------------

export interface Pdf2takeoffAnnotateResult extends Pdf2takeoffEngine {
  /** the annotated PDF bytes (creation timestamp embedded — NOT byte-deterministic) */
  pdfBytes: Buffer
  /** markups written by this run (idempotent re-runs REPLACE, so kept == 0) */
  markupCount: number
  /** pre-existing pdf2takeoff markups kept (only with keepExisting) */
  kept: number
}

/**
 * Write spec-defined markups into a stored PDF as STANDARD annotations
 * (Line/PolyLine/Polygon/FreeText) that open in Bluebeam Revu, Adobe Acrobat
 * and the web app. The output embeds a creation timestamp — structural
 * evidence only, byte-determinism is NOT claimed (the LibreOffice §5.4
 * convention).
 */
export async function pdf2takeoffAnnotateTakeoff(
  absPath: string,
  spec: { markups: unknown; keepExisting?: boolean },
): Promise<Pdf2takeoffAnnotateResult> {
  const validated = validateTakeoffSpecMarkups(spec.markups)
  if (!validated.ok) throw new EngineUnavailableError(validated.message)
  const engine = await resolvePdf2takeoffEngine()
  const tmpdir = await mkdtemp(path.join(os.tmpdir(), "eos-p2t-annotate-"))
  try {
    const specPath = path.join(tmpdir, "takeoff.yaml")
    const outPath = path.join(tmpdir, "annotated.pdf")
    await writeFile(specPath, buildTakeoffSpecYaml(validated.value), "utf8")
    const args = [
      "annotate",
      path.resolve(absPath),
      "--spec",
      specPath,
      "-o",
      outPath,
      ...(spec.keepExisting === true ? ["--keep-existing"] : []),
    ]
    const outcome = await runCli(args, CLI_TIMEOUT_MS)
    if (outcome.code !== 0) throw cliFailure("annotate", outcome)
    const parsed = parseCliJson("annotate", outcome.stdout)
    const markups = parsed.markups
    const kept = parsed.kept
    if (typeof markups !== "number" || !Number.isInteger(markups) || markups !== validated.value.length) {
      throw new EngineUnavailableError(
        `annotate reported ${JSON.stringify(markups)} markups for a ${validated.value.length}-markup spec — refusing the mismatched output`,
      )
    }
    if (typeof kept !== "number" || !Number.isInteger(kept) || kept < 0) {
      throw new EngineUnavailableError("annotate payload is missing the integer kept count")
    }
    let pdfBytes: Buffer
    try {
      pdfBytes = await readFile(outPath)
    } catch {
      throw new EngineUnavailableError("annotate reported success but produced no PDF at the requested output path")
    }
    if (pdfBytes.subarray(0, 5).toString("latin1") !== "%PDF-") {
      throw new EngineUnavailableError("annotate produced an output that is not a PDF (missing %PDF magic) — refusing to store it")
    }
    return { ...engine, pdfBytes, markupCount: markups, kept }
  } finally {
    await rm(tmpdir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// export (BOQ quantities table — CLI `export --scale 1:R --unit m --format …`)
// ---------------------------------------------------------------------------

export interface Pdf2takeoffExportRow {
  label: string
  type: string
  page: number
  value: number | string
  unit: string
}

export interface Pdf2takeoffExportResult extends Pdf2takeoffEngine {
  format: "csv" | "xlsx"
  /** csv: the verbatim table text (the artifact content); xlsx: null */
  csv: string | null
  /** xlsx: the workbook bytes (PK zip); csv: null */
  xlsxBytes: Buffer | null
  /** data rows parsed from the table (label/type/page/value/unit) */
  rows: Pdf2takeoffExportRow[]
  /** the scale string the engine was told (recorded in provenance) */
  scaleRatio: string | null
  unit: string
}

/**
 * Read a stored PDF's pdf2takeoff annotations back out as a quantities
 * table (the annotate→export round-trip is the product loop: markups become
 * BOQ rows). csv prints on stdout; xlsx is written to a temp file and read
 * back with the PK-zip magic verified.
 */
export async function pdf2takeoffExportTakeoff(
  absPath: string,
  opts: { scaleRatio?: string; unit?: string; format?: "csv" | "xlsx" },
): Promise<Pdf2takeoffExportResult> {
  const engine = await resolvePdf2takeoffEngine()
  const format = opts.format ?? "csv"
  const unit = opts.unit ?? "m"
  if (format !== "csv" && format !== "xlsx") {
    throw new EngineUnavailableError(`export format must be "csv"|"xlsx" — got ${JSON.stringify(format)}`)
  }
  const tmpdir = format === "xlsx" ? await mkdtemp(path.join(os.tmpdir(), "eos-p2t-export-")) : null
  try {
    const outPath = tmpdir !== null ? path.join(tmpdir, "boq.xlsx") : undefined
    const args = [
      "export",
      path.resolve(absPath),
      "--unit",
      unit,
      "--format",
      format,
      ...(opts.scaleRatio !== undefined ? ["--scale", opts.scaleRatio] : []),
      ...(outPath !== undefined ? ["-o", outPath] : []),
    ]
    const outcome = await runCli(args, CLI_TIMEOUT_MS)
    if (outcome.code !== 0) throw cliFailure("export", outcome)
    const rows: Pdf2takeoffExportRow[] = []
    let csv: string | null = null
    let xlsxBytes: Buffer | null = null
    if (format === "csv") {
      csv = outcome.stdout
      const table = parseCsvTable(csv, ",")
      // header row: Label,Type,Page,Value,Unit,Status,Layer — data rows follow
      // until the group-summary section header ("Group,Type,Items,Total");
      // the group rows below it repeat the labels, so they must NOT be
      // counted as data rows (the corpus rowCount pin enforces this)
      for (const r of table.slice(1)) {
        if (r[0] === "Group") break // the group-summary section — data rows end here
        if (r.length < 5) continue
        const numeric = Number(r[3])
        rows.push({
          label: r[0],
          type: r[1],
          page: Number(r[2]) || 1,
          value: Number.isFinite(numeric) ? numeric : r[3],
          unit: r[4],
        })
      }
    } else {
      try {
        xlsxBytes = await readFile(outPath as string)
      } catch {
        throw new EngineUnavailableError("export reported success but produced no XLSX at the requested output path")
      }
      if (xlsxBytes.subarray(0, 2).toString("latin1") !== "PK") {
        throw new EngineUnavailableError("export produced an output that is not an XLSX (missing PK zip magic) — refusing to store it")
      }
      // the XLSX is binary; the row pins ride on the CSV twin (same engine
      // path) — record the byte count as the structural evidence.
    }
    return {
      ...engine,
      format,
      csv,
      xlsxBytes,
      rows,
      scaleRatio: opts.scaleRatio ?? null,
      unit,
    }
  } finally {
    if (tmpdir !== null) await rm(tmpdir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// fill_area (Magic Fill room measurement — the engine's MCP surface)
// ---------------------------------------------------------------------------

export interface Pdf2takeoffFillResult extends Pdf2takeoffEngine {
  markupId: string
  label: string
  /** calibrated area in m² (null would mean uncalibrated — the bridge always calibrates) */
  value: number
  unit: string
  calibrated: boolean
  vertices: number
  bbox: [number, number, number, number] | null
  /** the doorway rule in force during the fill */
  doorwayClosesUpToM: number | null
  roomLabelsOnSheet: number
}

/** Validate the fill_area tool result (pure; refuses malformed honestly). */
export function validateFillPayload(parsed: Record<string, unknown>): Omit<Pdf2takeoffFillResult, keyof Pdf2takeoffEngine | "markupId" | "label"> {
  const { value, unit, calibrated, vertices, provenance } = parsed
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new EngineUnavailableError("fill_area result is missing a positive finite value (m²)")
  }
  if (unit !== "m2") {
    throw new EngineUnavailableError(`fill_area result carries unexpected unit ${JSON.stringify(unit)} — expected "m2"`)
  }
  if (typeof calibrated !== "boolean" || !calibrated) {
    throw new EngineUnavailableError("fill_area returned an uncalibrated value — the bridge always sets the scale, so this is an engine protocol error")
  }
  if (typeof vertices !== "number" || !Number.isInteger(vertices) || vertices < 3) {
    throw new EngineUnavailableError("fill_area result is missing an integer vertex count >= 3")
  }
  let bbox: [number, number, number, number] | null = null
  let doorwayClosesUpToM: number | null = null
  let roomLabelsOnSheet = 0
  if (isPlainObject(provenance)) {
    if (Array.isArray(provenance.bbox) && provenance.bbox.length === 4 && provenance.bbox.every(isFiniteNumber)) {
      bbox = [provenance.bbox[0] as number, provenance.bbox[1] as number, provenance.bbox[2] as number, provenance.bbox[3] as number]
    }
    if (isPlainObject(provenance.doorwayRule) && isFiniteNumber(provenance.doorwayRule.closesUpToM)) {
      doorwayClosesUpToM = provenance.doorwayRule.closesUpToM as number
    }
    if (typeof provenance.roomLabelsOnSheet === "number") {
      roomLabelsOnSheet = provenance.roomLabelsOnSheet
    }
  }
  return { value, unit: "m2", calibrated, vertices, bbox, doorwayClosesUpToM, roomLabelsOnSheet }
}

interface McpTextResult {
  json: Record<string, unknown>
  stdoutTail: string
}

/**
 * Start the engine's MCP server as a live subprocess — the EXACT runCli call
 * shape (Promise-wrapped execFile, rest-args array, full callback signature;
 * the standalone-output build traces this shape, proven by every bundled
 * adapter).
 */
function startMcpServer(timeoutMs: number, ...cliArgs: string[]): Promise<ReturnType<typeof execFile>> {
  const binPath = path.join(PDF2TAKEOFF_DIR, "bin", "pdf2takeoff.js")
  return new Promise((resolve, reject) => {
    const child = execFile(
      NODE_BIN,
      [binPath, ...cliArgs],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean }
          if (e.killed) {
            reject(
              new EngineUnavailableError(
                `the pdf2takeoff MCP server timed out after ${timeoutMs}ms and was terminated`,
              ),
            )
            return
          }
          if (e.code === "ENOENT") {
            reject(
              new EngineUnavailableError(
                `node is not runnable at "${NODE_BIN}" (EOS_NODE_BIN can override) — the pdf2takeoff engine cannot start`,
              ),
            )
            return
          }
          // a session that exits non-zero before answering is surfaced by the
          // close listener; the callback only guards spawn-level failures
          void stdout
          void stderr
        }
      },
    )
    resolve(child)
  })
}

/**
 * A minimal MCP stdio client for the engine's documented agent surface —
 * newline-delimited JSON-RPC, exactly the four calls Stage 1 needs
 * (initialize → open_document → set_scale → fill_area). No SDK dependency:
 * the wire format is pinned by the MCP spec and the upstream server.
 */
class McpSession {
  private proc: ReturnType<typeof execFile>
  private readonly spawnPromise: Promise<ReturnType<typeof execFile>>
  private readonly timeoutMs: number
  private buffer = ""
  private nextId = 0
  private pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>()
  private stderrTail = ""
  private closed = false

  constructor(timeoutMs: number) {
    this.timeoutMs = timeoutMs
    // execFile (not spawn — the standalone-build tracing convention) still
    // returns a LIVE ChildProcess: stdin/stdout/stderr are streams, so the
    // JSON-RPC session streams; the callback only guards spawn failures.
    this.proc = null as unknown as ReturnType<typeof execFile>
    this.spawnPromise = startMcpServer(timeoutMs, "mcp")
  }

  /** Resolve once the server process exists (stream wiring follows). */
  async ready(): Promise<void> {
    const child = await this.spawnPromise
    this.proc = child
    if (child.stdout === null || child.stderr === null || child.stdin === null) {
      child.kill("SIGKILL")
      throw new EngineUnavailableError("could not open stdio pipes to the pdf2takeoff MCP server — the session cannot run")
    }
    child.stdout.on("data", (d: Buffer) => this.onStdout(d))
    child.stderr.on("data", (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d.toString("utf8")).slice(-800)
    })
    child.on("error", () => {
      // spawn failures (ENOENT etc.) also fire 'close' right after — the
      // close listener rejects every pending waiter honestly
    })
    child.on("close", () => {
      this.closed = true
      for (const { reject } of this.pending.values()) {
        reject(new EngineUnavailableError(this.closeMessage()))
      }
      this.pending.clear()
    })
  }

  private closeMessage(): string {
    const tail = this.stderrTail.trim().slice(-300)
    return `the pdf2takeoff MCP server exited before answering${tail ? `: ${tail}` : ""}`
  }

  private onStdout(d: Buffer): void {
    this.buffer += d.toString("utf8")
    let nl: number
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim()
      this.buffer = this.buffer.slice(nl + 1)
      if (line.length === 0) continue
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue // non-protocol output — ignored, the response waiter enforces the deadline
      }
      const id = msg.id
      if (typeof id === "number" && this.pending.has(id)) {
        const waiter = this.pending.get(id) as { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }
        this.pending.delete(id)
        if (msg.error !== undefined) {
          waiter.reject(new EngineUnavailableError(`the pdf2takeoff MCP server refused: ${JSON.stringify(msg.error)}`))
        } else {
          waiter.resolve(msg.result as Record<string, unknown>)
        }
      }
    }
  }

  /** Send a JSON-RPC request and await its result under the session deadline. */
  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.closed || this.proc.stdin === null) {
      return Promise.reject(new EngineUnavailableError(this.closeMessage()))
    }
    const id = ++this.nextId
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new EngineUnavailableError(`the pdf2takeoff MCP server did not answer "${method}" within ${this.timeoutMs}ms — session terminated`))
      }, this.timeoutMs)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      try {
        this.proc.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n", "utf8")
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new EngineUnavailableError(`could not write to the pdf2takeoff MCP server stdin: ${(err as Error).message}`))
      }
    })
  }

  /** Fire-and-forget notification (no response expected). */
  notify(method: string): void {
    if (this.closed || this.proc.stdin === null) return
    try {
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n", "utf8")
    } catch {
      // the next request surfaces the closed session honestly
    }
  }

  /** Extract + parse the first text content block of a tools/call result. */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpTextResult> {
    const result = await this.request("tools/call", { name, arguments: args })
    const content = result.content
    if (!Array.isArray(content) || content.length === 0 || !isPlainObject(content[0]) || content[0].type !== "text") {
      throw new EngineUnavailableError(`the pdf2takeoff MCP tool ${name} returned no text content — refusing to interpret it`)
    }
    const text = String(content[0].text ?? "")
    if (result.isError === true) {
      throw new EngineUnavailableError(`pdf2takeoff ${name} refused: ${text.slice(0, 400)}`)
    }
    try {
      const json = JSON.parse(text)
      if (!isPlainObject(json)) throw new Error("not an object")
      return { json, stdoutTail: text.slice(-ADAPTER_TAIL_CHARS) }
    } catch {
      throw new EngineUnavailableError(
        `pdf2takeoff ${name} returned non-JSON text (first 200 chars: ${JSON.stringify(text.slice(0, 200))}) — refusing to interpret it`,
      )
    }
  }

  /** Close the session (stdin end lets the server exit; SIGKILL after a grace period). */
  async close(): Promise<void> {
    if (this.closed) return
    this.proc.stdin?.end()
    await new Promise<void>((resolve) => {
      const killer = setTimeout(() => {
        this.proc.kill("SIGKILL")
        resolve()
      }, 5_000)
      this.proc.on("close", () => {
        clearTimeout(killer)
        resolve()
      })
    })
  }
}

/**
 * Measure a room by clicking inside it (the engine's Magic Fill): flood fill
 * bounded by the walls, door gaps closed, boundary on the inner wall faces.
 * The platform calibration `scaleMmPerPt` (mm per PDF point) is REQUIRED —
 * the pinned verbatim refusal otherwise — and is carried to the engine
 * EXACTLY via a from_points dimension (a 1000 pt span declared as its true
 * length in metres), never a rounded ratio string.
 */
export async function pdf2takeoffFillRoom(
  absPath: string,
  params: { pageNo?: number; at: [number, number]; label?: string; scaleMmPerPt: number },
): Promise<Pdf2takeoffFillResult> {
  const pageNo = params.pageNo ?? 1
  if (typeof pageNo !== "number" || !Number.isInteger(pageNo) || pageNo < 1) {
    throw new EngineUnavailableError(`fill_area parameters.pageNo must be an integer >= 1 — got ${JSON.stringify(pageNo)}`)
  }
  if (
    !Array.isArray(params.at) ||
    params.at.length !== 2 ||
    !isFiniteNumber(params.at[0]) ||
    !isFiniteNumber(params.at[1])
  ) {
    throw new EngineUnavailableError(`fill_area parameters.at must be a finite [x, y] pair in PDF points — got ${JSON.stringify(params.at)}`)
  }
  if (!isFiniteNumber(params.scaleMmPerPt) || params.scaleMmPerPt <= 0) {
    throw new EngineUnavailableError(PDF2TAKEOFF_REFUSAL_NO_SCALE)
  }
  if (params.label !== undefined && (typeof params.label !== "string" || params.label.length === 0 || params.label.length > 120)) {
    throw new EngineUnavailableError("fill_area parameters.label must be a 1..120-char string when provided")
  }
  const engine = await resolvePdf2takeoffEngine()
  const session = new McpSession(MCP_TIMEOUT_MS)
  try {
    await session.ready()
    await session.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "engineering-os-bridge", version: "1" },
    })
    session.notify("notifications/initialized")
    const opened = await session.callTool("open_document", { path: path.resolve(absPath) })
    const docId = opened.json.id
    if (typeof docId !== "string" || docId.length === 0) {
      throw new EngineUnavailableError("open_document returned no document id — refusing to continue the session")
    }
    // carry the platform calibration EXACTLY: a 1000 pt horizontal span whose
    // true length is scaleMmPerPt metres (mm/pt × 1000 pt ÷ 1000 mm/m)
    await session.callTool("set_scale", {
      id: docId,
      page: pageNo,
      from_points: { a: [0, 0], b: [1000, 0], length: params.scaleMmPerPt, unit: "m" },
    })
    const filled = await session.callTool("fill_area", {
      id: docId,
      page: pageNo,
      at: [params.at[0], params.at[1]],
      ...(params.label !== undefined ? { label: params.label } : {}),
    })
    const markupId = filled.json.markupId
    const label = filled.json.label
    if (typeof markupId !== "string" || typeof label !== "string") {
      throw new EngineUnavailableError("fill_area returned no markupId/label — refusing the payload")
    }
    const payload = validateFillPayload(filled.json)
    return { ...engine, markupId, label, ...payload }
  } finally {
    await session.close()
  }
}
