/**
 * Engineering OS — engine-adapter bridge for SHEET-TEXT OCR (tesseract).
 *
 * IMPLEMENTATION: Slice 16-B (roadmap-gap-audit item 3, the 16-R2 research):
 * operator-driven region reads on raster/vector sheets — the Sheet Measure
 * marquee is rendered offscreen at a FIXED 4× page scale on the client, the
 * PNG bytes come to the broker route, and THIS bridge runs the real tesseract
 * 5 binary (`EOS_TESSERACT`-overridable, default /usr/bin/tesseract — the
 * LibreOffice pattern, src/engines/adapters/convert-document.ts) with the
 * TSV output parse:
 *
 *   tesseract <fresh tmp .png> stdout [--tessdata-dir <dir>] -l eng --psm <n> tsv
 *
 * Model determinism (16-R2): the vendored `tests/fixtures/tessdata/
 * eng.traineddata` (sha256 7d4322bd…, byte-identical to the ubuntu-24.04
 * tesseract-ocr package's model) is preferred when present — dev/CI runs are
 * model-pinned; .deb deployments (no tests/fixtures) fall back to the system
 * tessdata. `EOS_TESSDATA` overrides both.
 *
 * The Ø finding (16-R2, pinned by the harness fixture): tesseract NEVER reads
 * the Ø glyph natively — "Ø400" comes back as "@400" (the number is always
 * right, conf ~55). `normalizeDiameterToken` is the documented callout-context
 * normalization: a token of ONLY [@OØ0] + ≥2 digits maps to "Ø"+digits with
 * the RAW TRANSCRIPT ALWAYS PRESERVED alongside (the consumer sees both; the
 * platform never rewrites evidence).
 *
 * Every failure — missing binary, unreadable PNG, tesseract non-zero exit,
 * timeout, malformed TSV — surfaces as an honest `EngineUnavailableError`
 * (mapped to 422 engine_unavailable by the broker); nothing is fabricated.
 */

import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { EngineUnavailableError } from "./quantities"

export { EngineUnavailableError }

/** The tesseract binary (the registry probe path convention). */
const TESSERACT_BIN = process.env.EOS_TESSERACT ?? "/usr/bin/tesseract"

/** Hard stop for a hung engine — never wait forever. */
const OCR_TIMEOUT_MS = 60_000

/** The vendored pinned model — preferred when present (see header). */
const VENDORED_TESSDATA = path.join(process.cwd(), "tests", "fixtures", "tessdata")

/** Resolve the tessdata dir: explicit env > vendored (dev/CI) > system default. */
function resolveTessdataDir(explicit?: string): string | null {
  if (explicit !== undefined && explicit.length > 0) return explicit
  if (process.env.EOS_TESSDATA && process.env.EOS_TESSDATA.length > 0) return process.env.EOS_TESSDATA
  if (existsSync(path.join(VENDORED_TESSDATA, "eng.traineddata"))) return VENDORED_TESSDATA
  return null // tesseract's own default (/usr/share/tesseract-ocr/…)
}

const ADAPTER_SCRIPT_NAME = "sheet_ocr.ts"

// ---------------------------------------------------------------------------
// Pure core — TSV parse + the Ø normalization (unit-tested without the engine)
// ---------------------------------------------------------------------------

/** One tesseract word: text + confidence + the raster box (px, y-down). */
export interface OcrWord {
  text: string
  conf: number
  x: number
  y: number
  width: number
  height: number
}

/**
 * Parse tesseract's TSV output (level 5 = word rows) into words. Pure.
 * Rows with conf <= 0 (tesseract's "no text" marker) and empty text are
 * dropped; malformed rows throw the honest parse error (never silently
 * guessed geometry).
 */
export function parseTsvWords(tsv: string): OcrWord[] {
  const lines = tsv.split("\n")
  // No output at all (empty / whitespace-only) = zero words — an honest
  // empty read, not a parse failure (tesseract prints nothing for a blank
  // image at some psm modes; the region-read UI explains it instead).
  if (lines.length === 0 || lines[0].trim().length === 0) return []
  const header = lines[0].split("\t")
  // tesseract ≥ 4 TSV header: level page_num block_num par_num line_num
  // word_num left top width height conf text
  const expected = ["level", "left", "top", "width", "height", "conf", "text"]
  for (const key of expected) {
    if (!header.includes(key)) {
      throw new EngineUnavailableError(
        `tesseract TSV output is missing the "${key}" column (header: ${JSON.stringify(header.join(","))}) — refusing to guess geometry`,
      )
    }
  }
  const col = (name: string) => header.indexOf(name)
  const words: OcrWord[] = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim().length === 0) continue
    const cells = line.split("\t")
    if (cells.length < header.length) continue // trailing partial rows are dropped
    if (Number(cells[col("level")]) !== 5) continue
    const conf = Number(cells[col("conf")])
    const text = (cells[col("text")] ?? "").trim()
    if (!Number.isFinite(conf) || conf <= 0 || text.length === 0) continue
    const x = Number(cells[col("left")])
    const y = Number(cells[col("top")])
    const width = Number(cells[col("width")])
    const height = Number(cells[col("height")])
    if (![x, y, width, height].every(Number.isFinite)) {
      throw new EngineUnavailableError(
        `tesseract TSV row ${i + 1} carries non-numeric geometry (${JSON.stringify(line.slice(0, 80))}) — refusing to guess`,
      )
    }
    words.push({ text, conf, x, y, width, height })
  }
  return words
}

/** The diameter-glyph normalization outcome: normalized text, raw preserved. */
export interface DiameterNormalization {
  raw: string
  normalized: string
  rule: "diameter-glyph"
}

/**
 * The documented callout-context Ø normalization (16-R2): tesseract never
 * reads the Ø glyph — a diameter callout "Ø400" transcribes as "@400" (also
 * "O400"/"0400" depending on render). A token consisting ONLY of a leading
 * [@OØ0] followed by ≥ 2 digits normalizes to "Ø"+digits. The RAW transcript
 * is always preserved by the consumer (this returns both). Pure; null when
 * the rule does not fire (honest no-op, never a forced rewrite).
 */
export function normalizeDiameterToken(text: string): DiameterNormalization | null {
  const m = /^[@OØ0](\d{2,})$/.exec(text)
  if (m === null) return null
  return { raw: text, normalized: `Ø${m[1]}`, rule: "diameter-glyph" }
}

// ---------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------

let versionCache: string | null = null

/** Run `tesseract --version` once and return the parsed engine version. */
async function tesseractVersion(): Promise<string> {
  if (versionCache !== null) return versionCache
  const stdout: string = await new Promise((resolve, reject) => {
    execFile(TESSERACT_BIN, ["--version"], { timeout: 15_000 }, (err, out) => {
      // tesseract prints --version to STDOUT with exit 0 (and a stderr note)
      if (err) {
        reject(
          new EngineUnavailableError(
            `tesseract is not installed at ${TESSERACT_BIN} (EOS_TESSERACT can override) — sheet-text OCR is unavailable (${err.message})`,
          ),
        )
        return
      }
      resolve(String(out))
    })
  })
  const m = /tesseract\s+v?(\d+(?:\.\d+)+)/.exec(stdout)
  if (!m) {
    throw new EngineUnavailableError(
      `could not parse the tesseract version from: ${JSON.stringify(stdout.slice(0, 120))}`,
    )
  }
  versionCache = m[1]
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
    adapterHashCache = createHash("sha256").update(readFileSync(selfPath)).digest("hex")
  } catch {
    adapterHashCache = createHash("sha256").update(ADAPTER_SCRIPT_NAME).digest("hex")
  }
  return adapterHashCache
}

/** The pinned result envelope (the house adapter shape). */
export interface SheetOcrResult {
  engineKey: "tesseract"
  engineVersion: string
  adapterScript: string
  adapterHash: string
  /** tessdata dir actually used (provenance: which model produced the words) */
  tessdataDir: string | null
  psm: number
  /** words in reading order (tesseract TSV order), conf > 0 only */
  words: OcrWord[]
}

export interface SheetOcrOptions {
  /** page segmentation mode (default 6 — a uniform block, the picked region) */
  psm?: number
  /** explicit tessdata override (the broker passes none → env/vendored/system) */
  tessdataDir?: string
}

/**
 * Run the real tesseract on PNG bytes and return the parsed words. Throws
 * `EngineUnavailableError` with an honest message on every failure path —
 * missing binary, bad PNG (tesseract exits non-zero with its own stderr),
 * timeout, malformed TSV.
 */
export async function sheetOcrFromPng(pngBytes: Buffer, options: SheetOcrOptions = {}): Promise<SheetOcrResult> {
  const psm = options.psm ?? 6
  if (!Number.isInteger(psm) || psm < 0 || psm > 13) {
    throw new EngineUnavailableError(`psm must be an integer 0..13 (got ${psm})`)
  }
  // PNG magic — refuse anything else before spawning (honest, specific).
  if (pngBytes.length < 8 || pngBytes[0] !== 0x89 || pngBytes[1] !== 0x50 || pngBytes[2] !== 0x4e || pngBytes[3] !== 0x47) {
    throw new EngineUnavailableError("the region image is not a PNG (magic bytes missing) — Sheet Measure renders PNG regions")
  }

  const engineVersion = await tesseractVersion()
  const adapterHash = await adapterSelfHash()
  const tessdataDir = resolveTessdataDir(options.tessdataDir)

  const tmp = mkdtempSync(path.join(os.tmpdir(), "eos-ocr-"))
  try {
    const inPath = path.join(tmp, "region.png")
    writeFileSync(inPath, pngBytes)
    const args = [inPath, "stdout"]
    if (tessdataDir !== null) args.push("--tessdata-dir", tessdataDir)
    // NOTE (16-B, harness-caught): the `tsv` CONFIGFILE cannot be used with
    // --tessdata-dir — tesseract resolves config files inside the tessdata
    // dir, and the vendored dir carries only eng.traineddata, so tesseract
    // silently fell back to plain text. The equivalent OPTION form works
    // everywhere (verified: identical TSV with the system AND vendored dirs).
    args.push("-l", "eng", "--psm", String(psm), "-c", "tessedit_create_tsv=1")

    const tsv: string = await new Promise((resolve, reject) => {
      execFile(TESSERACT_BIN, args, { timeout: OCR_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          if ((err as { killed?: boolean }).killed) {
            reject(
              new EngineUnavailableError(`tesseract timed out after ${OCR_TIMEOUT_MS}ms and was terminated`),
            )
            return
          }
          const tail = String(stderr ?? "").trim().slice(-300)
          reject(
            new EngineUnavailableError(
              `tesseract failed with exit code ${String((err as { code?: number | string }).code)}${tail ? `: ${tail}` : " (no stderr)"}`,
            ),
          )
          return
        }
        resolve(String(stdout))
      })
    })

    return {
      engineKey: "tesseract",
      engineVersion,
      adapterScript: ADAPTER_SCRIPT_NAME,
      adapterHash,
      tessdataDir,
      psm,
      words: parseTsvWords(tsv),
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
