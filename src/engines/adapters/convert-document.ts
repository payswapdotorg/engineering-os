/**
 * Engineering OS — engine-adapter bridge for document conversion (LibreOffice).
 *
 * CONTRACT OWNER: TL (pinned in docs/00-architecture/phase5-disciplines-
 * contract.md §5.4, Phase 5). IMPLEMENTATION: W2-f — REAL engine bridge, NO
 * python: spawns the LibreOffice binary (the registry's probe path,
 * `EOS_LIBREOFFICE`-overridable, default /usr/bin/libreoffice)
 *
 *   libreoffice --headless --convert-to pdf --outdir <fresh tmpdir> <source>
 *
 * reads the produced PDF bytes and returns them plus the engine provenance
 * (`adapterHash` is the sha256 of THIS bridge file's own bytes — the same
 * self-report convention as the python adapters; `engineVersion` is parsed
 * from `libreoffice --version` once and cached per process).
 *
 * Byte-determinism is NOT claimed (contract §5.4): PDFs embed creation
 * timestamps, so re-conversions append NEW revisions with different
 * content hashes and that is the honest record. The harness asserts
 * structural evidence (%PDF magic, size) on a single run instead.
 *
 * Honest refusals (the broker maps them to 422 `unsupported`):
 *   - non-convertible extension → `artifact "<name>" is not convertible to PDF (no LibreOffice import filter for this kind)`
 *   - .pdf input               → `artifact "<name>" is already a PDF`
 *   - crash/timeout            → EngineUnavailableError with the stderr tail (422 `engine_unavailable`)
 * The fresh tmpdir is removed in a `finally` on every path (ADR-0005/0006:
 * honest absence, never a fallback — no simulated PDF bytes, ever).
 */

import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { ADAPTER_TAIL_CHARS, EngineUnavailableError } from "./quantities"

export { EngineUnavailableError }

/** The registry's probe path; overridable for honest-skip harness runs. */
const LIBREOFFICE_BIN = process.env.EOS_LIBREOFFICE ?? "/usr/bin/libreoffice"

/** Hard stop for a hung conversion — never wait forever for an engine. */
const CONVERSION_TIMEOUT_MS = 120_000

const ADAPTER_SCRIPT_NAME = "convert-document.ts"

// ---------------------------------------------------------------------------
// The convertible-extension gate (contract §5.4 — LO Writer/Calc/Impress
// import filters; pure + unit-tested)
// ---------------------------------------------------------------------------

/** LibreOffice import filters this slice converts with, pinned in §5.4. */
export const CONVERTIBLE_EXTENSIONS = [
  ".odt",
  ".fodt",
  ".docx",
  ".rtf",
  ".txt",
  ".md",
  ".csv",
  ".ods",
  ".fods",
  ".xlsx",
  ".pptx",
  ".odp",
] as const

/** What a stored document's signals say about its convertibility. Pure. */
export type ConversionKind = "pdf" | "convertible" | "refused"

/** Extension gate on any single string (key or file name). Pure. */
export function conversionExtensionKind(storageKeyOrName: string): ConversionKind {
  const lower = storageKeyOrName.toLowerCase()
  if (lower.endsWith(".pdf")) return "pdf"
  for (const ext of CONVERTIBLE_EXTENSIONS) {
    if (lower.endsWith(ext)) return "convertible"
  }
  return "refused"
}

/** Pinned 422 `unsupported` text — non-convertible document kind. Pure. */
export function notConvertibleMessage(artifactName: string): string {
  return `artifact "${artifactName}" is not convertible to PDF (no LibreOffice import filter for this kind)`
}

/** Pinned 422 `unsupported` text — the input is already a PDF. Pure. */
export function alreadyPdfMessage(artifactName: string): string {
  return `artifact "${artifactName}" is already a PDF`
}

/**
 * MIME → convertible extension for LibreOffice's extension-dispatched import
 * filters. Mirrors MIME_BY_EXT for every convertible entry of the office set
 * (kept here so the bridge stays self-contained like the python adapters).
 * Flat-ODF uploads share the packaged ODF mediatype (OASIS) and LO sniffs the
 * serialization from content — verified live: fodt bytes named .odt convert
 * identically — so text/spreadsheet mimes resolve to odt/ods. Pure.
 */
const EXT_BY_MIME: Record<string, string> = {
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "application/rtf": "rtf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "application/vnd.oasis.opendocument.presentation": "odp",
}

/**
 * Resolve an extension-bearing source file name for the LO temp copy from the
 * artifact's TWO extension-carrying signals: the artifact name (uploads
 * usually register WITHOUT an extension) and the recorded revision MIME.
 * Returns null when neither signal maps to a convertible filter — the caller
 * distinguishes already-PDF from not-convertible with its own pinned 422s.
 * Pure.
 */
export function convertibleSourceName(artifactName: string, mimeType: string | null | undefined): string | null {
  if (conversionExtensionKind(artifactName) === "pdf") return null // caller reports already-PDF
  if (conversionExtensionKind(artifactName) === "convertible") {
    const base = path.basename(artifactName)
    if (base && base !== "." && base !== "..") return base
  }
  if (mimeType && mimeType !== "application/pdf") {
    const ext = EXT_BY_MIME[mimeType]
    if (ext && conversionExtensionKind(`document.${ext}`) === "convertible") {
      const raw = artifactName && artifactName.trim().length > 0 ? artifactName.trim() : "document"
      const base = path.basename(raw)
      if (base && base !== "." && base !== "..") return `${base}.${ext}`
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Engine version (parsed once per process, contract §5.4)
// ---------------------------------------------------------------------------

let versionCache: string | null = null

/** Run `libreoffice --version` and return the parsed engine version. */
async function libreofficeVersion(): Promise<string> {
  if (versionCache !== null) return versionCache
  let stdout: string
  try {
    const result = await promisify(execFile)(LIBREOFFICE_BIN, ["--version"], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    })
    stdout = result.stdout
  } catch (err) {
    const e = err as { code?: unknown; message: string }
    if (e.code === "ENOENT") {
      throw new EngineUnavailableError(
        `libreoffice is not installed at ${LIBREOFFICE_BIN} (EOS_LIBREOFFICE can override) — document conversion is unavailable`,
      )
    }
    throw new EngineUnavailableError(`libreoffice --version failed: ${e.message}`)
  }
  const m = /LibreOffice\s+([0-9][0-9.]*)/.exec(stdout)
  if (!m) {
    throw new EngineUnavailableError(
      `could not parse the LibreOffice version from: ${JSON.stringify(stdout.slice(0, 120))}`,
    )
  }
  versionCache = m[1].replace(/\.$/, "")
  return versionCache
}

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

// ---------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------

export interface ConversionResult {
  engineKey: string
  engineVersion: string
  adapterScript: string
  /** sha256 of this bridge file's own bytes (recorded in provenance) */
  adapterHash: string
  /** the raw produced PDF bytes (stored verbatim as the revision content) */
  pdfBytes: Buffer
  /** last 2000 chars of the conversion subprocess stdout, verbatim */
  stdoutTail?: string
  /** last 2000 chars of the conversion subprocess stderr, verbatim */
  stderrTail?: string
}

interface ExecFailure {
  code?: number | string | undefined
  killed?: boolean
  stdout?: string | undefined
  stderr?: string | undefined
  message: string
}

/**
 * Convert a stored LO-convertible document to REAL PDF bytes with headless
 * LibreOffice. The extension gate must have passed upstream (the broker pins
 * the two 422s); this bridge still defends itself. Fresh tmpdir per run,
 * removed in a `finally` on every path. Throws `EngineUnavailableError` on
 * every failure — crash, timeout, missing binary, missing/garbage output.
 */
export async function convertDocumentToFile(absPath: string, sourceName: string): Promise<ConversionResult> {
  const source = path.resolve(absPath)
  // Gate on the artifact's ORIGINAL NAME: the content store keeps bytes under
  // an extensionless `content` key, so the name is the only extension-bearing
  // signal (the broker gates on the same name — this is bridge-level defense).
  const usableName = path.basename(sourceName)
  if (!usableName || usableName === "." || usableName === "..") {
    throw new EngineUnavailableError(
      `the source document ${JSON.stringify(sourceName ?? "")} has no usable file name for conversion`,
    )
  }
  const kind = conversionExtensionKind(usableName)
  if (kind === "pdf") {
    throw new EngineUnavailableError(`the source document "${usableName}" is already a PDF — nothing to convert`)
  }
  if (kind === "refused") {
    throw new EngineUnavailableError(
      `the source document ${JSON.stringify(usableName)} has no LibreOffice import filter for this kind`,
    )
  }

  const engineVersion = await libreofficeVersion()
  const adapterHash = await adapterSelfHash()

  const tmpdir = await mkdtemp(path.join(os.tmpdir(), "eos-lo-convert-"))
  try {
    // LibreOffice dispatches its import filter by file EXTENSION — the stored
    // `content` file has none, so the real bytes are copied under the
    // artifact's original name inside the fresh tmpdir (bytes identical;
    // determinism is NOT claimed for the PDF OUTPUT, which embeds creation
    // timestamps — contract §5.4).
    const namedSource = path.join(tmpdir, usableName)
    await copyFile(source, namedSource)
    let stdout: string
    let stderr: string
    try {
      const result = await promisify(execFile)(
        LIBREOFFICE_BIN,
        ["--headless", "--convert-to", "pdf", "--outdir", tmpdir, namedSource],
        { timeout: CONVERSION_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      )
      stdout = result.stdout
      stderr = result.stderr ?? ""
    } catch (err) {
      const e = err as ExecFailure
      if (e.killed) {
        throw new EngineUnavailableError(
          `libreoffice conversion timed out after ${CONVERSION_TIMEOUT_MS}ms and was terminated`,
        )
      }
      if (e.code === "ENOENT") {
        throw new EngineUnavailableError(
          `libreoffice is not installed at ${LIBREOFFICE_BIN} (EOS_LIBREOFFICE can override) — document conversion is unavailable`,
        )
      }
      const stderrTail = (e.stderr ?? "").trim().slice(-400)
      throw new EngineUnavailableError(
        `libreoffice conversion failed with exit code ${String(e.code)}${stderrTail ? `: ${stderrTail}` : ""}`,
      )
    }

    const expected = `${path.basename(usableName, path.extname(usableName))}.pdf`
    const produced = path.join(tmpdir, expected)
    let pdfBytes: Buffer
    try {
      pdfBytes = await readFile(produced)
    } catch {
      throw new EngineUnavailableError(
        `libreoffice reported success but produced no PDF at ${JSON.stringify(expected)} (stdout: ${JSON.stringify(stdout.slice(0, 200))})`,
      )
    }
    // Structural honesty: a "PDF" that does not start with the %PDF magic is
    // not a PDF — refuse rather than storing garbage bytes.
    if (pdfBytes.subarray(0, 5).toString("latin1") !== "%PDF-") {
      throw new EngineUnavailableError(
        "libreoffice produced an output that is not a PDF (missing %PDF magic) — refusing to store it",
      )
    }

    return {
      engineKey: "libreoffice",
      engineVersion,
      adapterScript: ADAPTER_SCRIPT_NAME,
      adapterHash,
      pdfBytes,
      stdoutTail: stdout.slice(-ADAPTER_TAIL_CHARS),
      stderrTail: stderr.slice(-ADAPTER_TAIL_CHARS),
    }
  } finally {
    await rm(tmpdir, { recursive: true, force: true })
  }
}
