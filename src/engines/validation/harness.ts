/**
 * Engineering OS — engine validation harness (Worker 2 lane, W2-c, Contract A).
 *
 * Turns the W2-b adapters' "analytic-fixture tested" claim into a
 * benchmark-corpus "validated" claim, honestly:
 *
 *   - Loads the committed corpus manifest (tests/validation/corpus-manifest.json):
 *     every case pins fixture + adapter + expectation + the FULL expected
 *     quantity set, each entry with a hand-derived closed form and its
 *     tolerance class. Ground truth NEVER comes from adapter output (ADR-0006).
 *   - Drives the REAL production bridge (`deriveFromFile` in
 *     src/engines/adapters/quantities.ts) — no mocks, no shortcuts.
 *   - Compares per the pinned tolerance policy:
 *       exact   → |obs − exp| ≤ 1e-9 · max(1, |exp|)
 *       analytic→ |obs − exp| ≤ 1e-9 · max(1, |exp|)
 *       mesh    → |obs − exp| ≤ 1e-2 · |exp|   (pinned 1% engineering
 *                 tolerance for triangulated curved surfaces; the observed
 *                 relative error is RECORDED in every report — the harness
 *                 quantifies the mesh limitation, it never hides it)
 *   - Set equality per (elementRef, quantityType): an EXTRA or MISSING adapter
 *     quantity is a FAIL even when all pinned values match — this is what
 *     proves skipped IFC weight/time quantities were really skipped.
 *   - Runs every success case TWICE and requires bitwise-identical quantity
 *     values (determinism: true).
 *   - Error cases must throw EngineUnavailableError whose message contains the
 *     pinned `errorContains` substring.
 *   - If python / an engine is unavailable, every affected case is reported as
 *     `skip` with the honest reason (never faked); an all-skip run is NOT RUN.
 *
 * W2-f (Phase 5, contract §7) — the harness now also drives the four
 * disciplines engines + the platform CPM core over the SAME manifest:
 *   - `femesh` cases run the REAL gmsh bridge (`feMeshFromFile` in
 *     src/engines/adapters/femesh.ts → `step_femesh.py`, system-library
 *     bootstrap via LD_LIBRARY_PATH) with pinned node/tet counts, per-solid
 *     divergence-theorem mesh volumes vs closed forms (planar exact at
 *     rel ≤ 1e-12, the bracket's curved holes at the pinned 2%), quality
 *     range checks, and byte-deterministic eos-femesh/1 document double-runs.
 *   - `powerflow` cases run the REAL pandapower bridge (`runPowerflowFromFile`
 *     → `powerflow.py`) — the 2-bus lossless closed form V₂ =
 *     √((1+√(1−4p²x²))/2) pinned at rel ≤ 1e-6, loss ≈ 0 at 1e-9, plus the
 *     islanded honest-refusal probe.
 *   - `des` cases run the REAL SimPy bridge (`runDesFromFile` → `des.py`) — the
 *     makespan-13 flow-shop hand trace with pinned busy/utilization and
 *     byte-deterministic eos-des/1 double-runs.
 *   - `cpm` cases drive the EXACT pure pipeline the `analyze_schedule` broker
 *     core runs (`validateScheduleDocument` → `analyzeCpm` →
 *     `buildCpmAnalysisDocument` from src/engines/broker.ts + src/core/cpm.ts,
 *     all pure) — the DB-backed op path stays with the routes/e2e; the case
 *     notes record that routing honestly. Engine identity is asserted ABSENT.
 *   - `libreoffice` cases run the REAL conversion bridge
 *     (`convertDocumentToFile` → headless soffice) ONCE with structural pins
 *     (%PDF magic, size floor) — byte-determinism is NOT claimed for PDFs
 *     (contract §5.4: creation timestamps are embedded) and is honestly
 *     reported as null. Skips on EOS_LIBREOFFICE=/nonexistent.
 *   - Determinism pins for femesh/powerflow/des compare the BYTE-IDENTICAL
 *     §2 documents the broker would store (buildFeMeshDocument /
 *     buildPowerflowDocument / buildDesDocument), not the subprocess streams
 *     (gmsh/LO chatter on stderr carries timing lines — evidence, not payload).
 */

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { analyzeCpm } from "@/core/cpm"
import {
  adapterScriptPath,
  deriveFromFile,
  EngineUnavailableError,
  type DerivedQuantity,
  type DeriveResult,
} from "../adapters/quantities"
import { tessellateFromFile, type MeshElement, type MeshResult } from "../adapters/mesh"
import { defaultFeMeshParameters, femeshLdLibraryPath, feMeshFromFile, validateFeMeshParameters, type FeMeshParameters, type FeMeshResult } from "../adapters/femesh"
import { runPowerflowFromFile, type PowerflowResult } from "../adapters/powerflow"
import { runDesFromFile, type DesResult } from "../adapters/des"
import { runFeaFromFile, validateFeaParameters, type FeaParameters, type FeaResult } from "../adapters/fea"
import { runTransportFromFile, validateTransportParameters, type TransportParameters, type TransportResult } from "../adapters/cfd"
import { runRtlSynthesisFromFile, type RtlResult } from "../adapters/chip"
import { runSwmmFromFile, validateSwmmParameters, type SwmmParameters, type SwmmResult } from "../adapters/swmm"
import { convertDocumentToFile, type ConversionResult } from "../adapters/convert-document"
import { sheetTakeoffFromStorage, type SheetTakeoffResult } from "../adapters/sheet_takeoff"
import { dxfTakeoffFromStorage, type DxfTakeoffResult } from "../adapters/dxf_takeoff"
import {
  normalizeDiameterToken,
  sheetOcrFromPng,
  type SheetOcrResult,
} from "../adapters/sheet_ocr"
import {
  parametricRebuildFromStorage,
  parametricSchemaFromStorage,
  type ParametricBuildResult,
  type ParametricSchemaResult,
} from "../adapters/parametric_rebuild"
import {
  PDF2TAKEOFF_PINNED_COMMIT,
  pdf2takeoffAnnotateTakeoff,
  pdf2takeoffCompareRevisions,
  pdf2takeoffExportTakeoff,
  pdf2takeoffFillRoom,
  type Pdf2takeoffAnnotateResult,
  type Pdf2takeoffCompareResult,
  type Pdf2takeoffExportResult,
  type Pdf2takeoffFillResult,
} from "../adapters/pdf2takeoff"
import {
  buildCpmAnalysisDocument,
  buildDesDocument,
  buildFeaDocument,
  buildSwmmDocument,
  buildTransportDocument,
  buildRtlDocument,
  buildFeMeshDocument,
  buildPowerflowDocument,
  validateScheduleDocument,
} from "../broker"

// ---------------------------------------------------------------------------
// Corpus manifest types (shape pinned in worklog.md "Contract A — W2-c")
// ---------------------------------------------------------------------------

export type AdapterKind =
  | "ifc"
  | "step"
  | "femesh"
  | "powerflow"
  | "des"
  | "fea"
  | "transport"
  | "chip"
  | "swmm"
  | "cpm"
  | "libreoffice"
  | "sheet"
  | "dxf"
  | "parametric"
  | "ocr"
  | "pdf2takeoff"
export type ToleranceKind = "exact" | "analytic" | "mesh"
export type QuantityType = DerivedQuantity["quantityType"]

/** The Phase-5 discipline case kinds (W2-f — one shared pin schema). The
 * 16-V vector-takeoff kinds (sheet/dxf) run their own sub-expectation
 * machinery but share the DisciplineAdapter dispatch surface. */
export type DisciplineAdapter =
  | "femesh"
  | "powerflow"
  | "des"
  | "fea"
  | "transport"
  | "chip"
  | "swmm"
  | "cpm"
  | "libreoffice"
  | "sheet"
  | "dxf"

/** 16-V (Slice 15 vector-takeoff lane): the pdfplumber/ezdxf case kinds. */
export type TakeoffAdapter = "sheet" | "dxf"

/** 16-P (Slice 15 parametric-authoring lane): the cadquery parametric-rebuild kind. */
export type ParametricAdapter = "parametric"

/** ADR-0011 Stage 1: the ADOPTED takeoff engine's case kind — one adapter,
 * four ops (compare | annotate | export | fill), each case pinning the op in
 * its block. */
export type Pdf2takeoffAdapter = "pdf2takeoff"
export type Pdf2takeoffOp = "compare" | "annotate" | "export" | "fill"

export interface GroundTruthEntry {
  elementRef: string
  quantityType: QuantityType
  value: number
  unit: string
  tolerance: ToleranceKind
  derivation: string
}

export interface CorpusCase {
  caseId: string
  adapter: AdapterKind
  fixture: string
  expect: "success" | "error"
  errorContains?: string
  groundTruth?: GroundTruthEntry[]
  /** 16-V takeoff cases: the case-level analytic narrative (a string, not the
   * quantity-ledger entry array — the pins carry the numbers). */
  takeoffGroundTruth?: string
  /** W2-d (Contract C): optional tessellation expectations for this fixture —
   * pinned element refs (set-equal to the quantity element refs), per-element
   * vertex/triangle counts, payload invariants, divergence-theorem mesh
   * volumes vs closed forms, or an honest error probe. */
  mesh?: MeshExpectation
  /** W2-f (Phase 5): the per-adapter expectation block for the discipline
   * kinds — `femesh` for adapter "femesh", `powerflow` for "powerflow",
   * `des` for "des", `cpm` for "cpm", `libreoffice` for "libreoffice"
   * (exactly one block per case, validated in parseManifest). */
  femesh?: DisciplineExpectation
  powerflow?: DisciplineExpectation
  des?: DisciplineExpectation
  fea?: DisciplineExpectation
  transport?: DisciplineExpectation
  chip?: DisciplineExpectation
  swmm?: DisciplineExpectation
  cpm?: DisciplineExpectation
  libreoffice?: DisciplineExpectation
  /** 16-V: the per-adapter expectation block for the takeoff kinds — `sheet`
   * for adapter "sheet" (pdfplumber), `dxf` for "dxf" (ezdxf). */
  sheet?: TakeoffExpectation
  dxf?: TakeoffExpectation
  /** 16-P: the per-adapter expectation block for the parametric kind —
   * `parametric` for adapter "parametric" (cadquery parametric rebuild). */
  parametric?: ParametricExpectation
  /** 16-P: the case-level analytic narrative for parametric success cases
   * (a string, like the 16-V takeoffGroundTruth — the pins carry the numbers). */
  parametricGroundTruth?: string
  /** 16-B: the per-adapter expectation block for the OCR kind — `ocr` for
   * adapter "ocr" (tesseract sheet-text region reads). */
  ocr?: OcrExpectation
  /** 16-B: the case-level narrative for OCR success cases (a string — the
   * expectedWords pins carry the transcript + conf floors + the Ø rule). */
  ocrGroundTruth?: string
  /** ADR-0011 Stage 1: the per-adapter expectation block for the ADOPTED
   * engine — `pdf2takeoff` for adapter "pdf2takeoff" (one block per case,
   * pinning which op it exercises). */
  pdf2takeoff?: Pdf2takeoffExpectation
  /** ADR-0011 Stage 1: the case-level analytic narrative for pdf2takeoff
   * success cases (a string — the pins carry the numbers). */
  pdf2takeoffGroundTruth?: string
}

// ---------------------------------------------------------------------------
// Discipline expectations (W2-f — contract §7; one shared pin schema for the
// femesh/powerflow/des/cpm/libreoffice case kinds)
// ---------------------------------------------------------------------------

/** One pinned expectation: locate a value in the adapter result by `field`
 * (plus `ref` for per-bus/per-solid/per-resource/per-job/per-activity rows)
 * and compare it against the hand-derived `value`. */
export interface DisciplinePin {
  /** row locator: bus id / "from>to" line key / solid ref / resource id / job id / activity id; null for scalars */
  ref: string | null
  /** the observed-value field name on the result payload (see resolveDisciplineObserved) */
  field: string
  value: number | string | boolean | (string | number)[]
  unit?: string
  /** numeric: |obs − exp| ≤ relTolerance·|exp| */
  relTolerance?: number
  /** numeric: |obs − exp| ≤ absTolerance */
  absTolerance?: number
  /** numeric: observed ≥ value (structural lower bound, e.g. the PDF size floor) */
  minBound?: boolean
  derivation: string
}

export interface DisciplineExpectation {
  expect: "success" | "error"
  errorContains?: string
  /** femesh only: the broker-style model-kind detection input (default "step") */
  kind?: "step" | "ifc"
  /** femesh: mesh parameters override (defaults per contract §4); fea: the
   * meshRefinement override (Slice 22, contract §14.3 — default 4); swmm: the
   * routingStepSec override (Slice 23, contract §15.3 — default 10); chip:
   * always {} (Slice 30, contract §17.3 — NO parameters, the script is frozen) */
  parameters?:
    | { meshSizeMin: number; meshSizeMax: number; elementOrder: number }
    | { meshRefinement: number }
    | { routingStepSec: number }
    | Record<string, never>
  /** success cases only: the pinned expectation set (every entry carries a derivation) */
  pins?: DisciplinePin[]
  /** honest routing/limitation note, rendered into the case notes */
  note?: string
}

// ---------------------------------------------------------------------------
// Takeoff expectations (16-V — Slice 15 vector-takeoff lane; the pdfplumber/
// ezdxf case kinds. Same DisciplinePin schema as the Phase-5 blocks, plus a
// `runs` array: one takeoff case may exercise several parameter sets (e.g.
// the A-102 sheet case measures BOTH pages — pageNo 1 and pageNo 2), and each
// run is executed TWICE with byte-identity asserted on the adapter result.)
// ---------------------------------------------------------------------------

/** One adapter invocation inside a takeoff case: its parameters + pins. */
export interface TakeoffRun {
  /** sheet: {pageNo?, scaleMmPerPt (REQUIRED), flattenSegments?}; dxf: {layerFilter?} */
  parameters?: Record<string, unknown>
  /** success runs: non-empty (validated); error runs: pins are not resolved */
  pins?: DisciplinePin[]
}

export interface TakeoffExpectation {
  expect: "success" | "error"
  errorContains?: string
  /** success cases: the non-empty runs array (one row per parameter set) */
  runs?: TakeoffRun[]
  /** honest routing/limitation note, rendered into the case notes */
  note?: string
}

// ---------------------------------------------------------------------------
// pdf2takeoff expectations (ADR-0011 Stage 1 — the ADOPTED takeoff engine;
// same DisciplinePin schema, plus `op` (which of the four broker surfaces the
// case exercises) and, for compare cases, `otherFixture` (the second
// revision). Determinism policy per op: compare = JSON identity; export =
// CSV row identity; fill = value/vertices identity (the markup id carries a
// random suffix); annotate = NOT claimed (the annotated PDF embeds a creation
// timestamp — the LibreOffice §5.4 convention, structural evidence only).
// ---------------------------------------------------------------------------

/** One op invocation inside a pdf2takeoff case: its parameters + pins. */
export interface Pdf2takeoffRun {
  /** compare: {}; annotate: {markups, keepExisting?}; export: {spec?, scaleRatio?, unit?, format?}; fill: {pageNo?, at, label?, scaleMmPerPt (REQUIRED)} */
  parameters?: Record<string, unknown>
  /** success runs: non-empty (validated); error runs: pins are not resolved */
  pins?: DisciplinePin[]
  /** error runs only: THIS run's pinned refusal substring */
  errorContains?: string
}

export interface Pdf2takeoffExpectation {
  expect: "success" | "error"
  /** which broker surface this case exercises */
  op: Pdf2takeoffOp
  errorContains?: string
  /** compare cases only: the OTHER revision's fixture (the case fixture is the old revision) */
  otherFixture?: string
  /** success cases: the non-empty runs array (one row per parameter set) */
  runs?: Pdf2takeoffRun[]
  /** honest routing/limitation note, rendered into the case notes */
  note?: string
}

// ---------------------------------------------------------------------------
// Parametric expectations (16-P — Slice 15 parametric-authoring lane; the
// cadquery parametric-rebuild kind. Same DisciplinePin schema as the Phase-5
// blocks, plus a `runs` array of {mode, parameters, pins}: one parametric
// case may exercise several modes/parameter sets, and each run executes
// TWICE — schema runs assert byte-identity on the schema JSON, build runs
// assert EXACT equality on the GEOMETRY PROPERTIES (volume/area/bbox/
// centerOfMass/checks), NEVER on the STEP bytes: OCCT stamps an export
// timestamp into FILE_NAME and a per-export counter into PRODUCT(...) — the
// 16-R3 finding, pinned here. Determinism on content hashes would be a
// dishonest claim; determinism on the rebuilt geometry is the real one.)
// ---------------------------------------------------------------------------

/** One adapter invocation inside a parametric case. */
export interface ParametricRun {
  /** schema = read PARAM_SCHEMA/DEFAULT_PARAMS (no parameters, no STEP);
   *  build = validate + merge parameters, build, analytic-gate-check,
   *  export STEP, re-import, emit the round-trip properties. */
  mode: "schema" | "build"
  /** build runs only: the user's parameter edits (merged over DEFAULT_PARAMS
   *  by the adapter); schema runs take no parameters (parse refuses them). */
  parameters?: Record<string, unknown>
  /** success runs: non-empty (validated); error runs: pins are not resolved */
  pins?: DisciplinePin[]
  /** error runs only: THIS run's pinned refusal substring. A parametric
   *  error case may pin several DISTINCT refusal shapes across its runs
   *  (range / unknown-key / geometry contradiction) — one block-level
   *  substring cannot cover them all, so every error run pins its own. */
  errorContains?: string
}

export interface ParametricExpectation {
  expect: "success" | "error"
  /** error cases: OPTIONAL common substring asserted against EVERY run's
   *  message in addition to the per-run pins */
  errorContains?: string
  /** one row per mode/parameter set (non-empty, validated) */
  runs?: ParametricRun[]
  /** honest routing/limitation note, rendered into the case notes */
  note?: string
}

// ---------------------------------------------------------------------------
// 16-B OCR expectations (Slice 16-B sheet-text OCR — tesseract region reads
// over the COMMITTED PNG fixture with the VENDORED sha-pinned eng model; every
// success run executes TWICE and the word list (text+conf+boxes) must be
// identical — tesseract is deterministic for identical input+model+psm)
// ---------------------------------------------------------------------------

/** One pinned expected word (the RAW transcript text — tesseract verbatim). */
export interface OcrExpectedWord {
  /** the exact raw text tesseract must emit (ordered list, set-equal + order) */
  text: string
  /** conf floor 0..100 (default 0 — pin what the research observed, live) */
  confFloor?: number
  /** when set: the Ø diameter rule must fire on THIS word and produce exactly
   *  this normalized form (the raw above is preserved verbatim either way) */
  normalized?: string
}

export interface OcrRun {
  /** psm 0..13 (default 6 — the uniform-block region read) */
  parameters?: { psm?: number }
  /** success runs: the ordered expected word list (non-empty, validated) */
  expectedWords?: OcrExpectedWord[]
  /** error runs only: this run's pinned refusal substring */
  errorContains?: string
}

export interface OcrExpectation {
  expect: "success" | "error"
  /** one row per parameter set (non-empty, validated) */
  runs?: OcrRun[]
  /** honest routing/limitation note, rendered into the case notes */
  note?: string
}

/** 16-B: the OCR case kind. */
export type OcrAdapter = "ocr"

// ---------------------------------------------------------------------------
// Mesh expectations (W2-d — Contract C; shapes additive to the W2-c manifest)
// ---------------------------------------------------------------------------

export interface MeshElementExpectation {
  elementRef: string
  name: string
  vertexCount: number
  triangleCount: number
}

export interface MeshVolumeExpectation {
  elementRef: string
  value: number
  unit: string
  tolerance: ToleranceKind
  derivation: string
}

export interface MeshExpectation {
  expect: "success" | "error"
  /** error cases only: required substring of the thrown message */
  errorContains?: string
  /** success cases only: pinned payload upAxis (the adapter never rewrites it) */
  upAxis?: "z" | "y"
  /** success cases only: pinned payload tolerance in METERS (exact equality) */
  tolerance?: number
  /** success cases only: pinned element-ref set (set equality — extras/missing both FAIL) */
  elementRefs?: string[]
  elements?: MeshElementExpectation[]
  volume?: MeshVolumeExpectation[]
}

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

export interface ComparisonResult {
  elementRef: string
  quantityType: QuantityType
  expected: number | null
  observed: number | null
  unit: string
  observedUnit: string | null
  tolerance: ToleranceKind | null
  absDiff: number | null
  observedRelError: number | null
  ok: boolean
  /** matched | missing (no adapter quantity for a pinned entry) | extra (adapter quantity with no pinned entry) | value | unit */
  problem: "matched" | "missing" | "extra" | "value" | "unit"
  derivation: string | null
}

export interface CaseResult {
  caseId: string
  adapter: AdapterKind
  fixture: string
  fixturePath: string
  expect: "success" | "error"
  status: "pass" | "fail" | "skip"
  skipReason?: string
  engine?: { engineKey: string; engineVersion: string; adapterScript: string; adapterHash: string }
  /** for error cases: the message the bridge actually threw */
  errorObserved?: string
  errorContains?: string
  /** true iff two consecutive real runs produced bitwise-identical quantity values (success cases only) */
  determinism: boolean | null
  quantityCount: number | null
  groundTruthCount: number | null
  comparisons: ComparisonResult[] | null
  problems: string[]
  /** W2-d: tessellation sub-result for cases carrying mesh expectations */
  mesh?: MeshCaseResult
  /** W2-f: disciplines sub-result for the Phase-5 case kinds */
  discipline?: DisciplineCaseResult
}

// ---------------------------------------------------------------------------
// Discipline case results (W2-f — the shared shape for femesh / powerflow /
// des / cpm / libreoffice sub-expectations)
// ---------------------------------------------------------------------------

export interface DisciplineComparison {
  /** the manifest pin's field name ("nodes", "meshVolume", "vmPu", "makespan", "criticalPath", …) */
  field: string
  ref: string | null
  expected: number | string | boolean | (string | number)[] | null
  observed: number | string | boolean | (string | number)[] | null
  unit: string | null
  /** "rel:<n>" | "abs:<n>" | "min" | "exact" | "structural" */
  bound: string | null
  absDiff: number | null
  observedRelError: number | null
  ok: boolean
  problem: "matched" | "missing" | "value" | "type"
  derivation: string | null
}

export interface DisciplineCaseResult {
  adapter: DisciplineAdapter | TakeoffAdapter | ParametricAdapter | OcrAdapter | Pdf2takeoffAdapter
  expect: "success" | "error"
  status: "pass" | "fail"
  /** engine provenance — null for the cpm platform core (the honest record) */
  engine?: { engineKey: string; engineVersion: string; adapterScript: string; adapterHash: string } | null
  errorObserved?: string
  errorContains?: string
  /** true iff the two real runs' stored-document bytes are identical; null when byte-determinism is NOT claimed (libreoffice) or n/a (error cases) */
  determinism: boolean | null
  comparisons: DisciplineComparison[]
  problems: string[]
}

export interface MeshComparison {
  /** refs (set equality) | name | upAxis | tolerance | vertexCount | triangleCount | volume */
  kind: "refs" | "name" | "upAxis" | "tolerance" | "vertexCount" | "triangleCount" | "volume"
  elementRef: string | null
  expected: number | string | null
  observed: number | string | null
  tolerance: ToleranceKind | null
  absDiff: number | null
  observedRelError: number | null
  ok: boolean
  problem: "matched" | "missing" | "extra" | "value"
  derivation: string | null
}

export interface MeshCaseResult {
  expect: "success" | "error"
  status: "pass" | "fail"
  engine?: { engineKey: string; engineVersion: string; adapterScript: string; adapterHash: string }
  errorObserved?: string
  errorContains?: string
  /** true iff two consecutive real runs produced byte-identical mesh JSON */
  determinism: boolean | null
  elementCount: number | null
  vertexCount: number | null
  triangleCount: number | null
  comparisons: MeshComparison[]
  problems: string[]
}

export interface HarnessReport {
  ranAt: string
  pythonBin: string
  manifestPath: string
  caseCount: number
  environment: {
    engineAvailability: Record<AdapterKind, { available: boolean; reason?: string }>
  }
  /** real engine versions as reported by the adapters inside DeriveResults (null = engine produced no successful run) */
  engineVersions: Record<string, string | null>
  adapterHashes: Record<string, string | null>
  cases: CaseResult[]
  summary: {
    total: number
    pass: number
    fail: number
    skip: number
    ran: number
    notRun: boolean
    note?: string
  }
}

// ---------------------------------------------------------------------------
// Paths & engine availability
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(here, "..", "..", "..")
export const MANIFEST_PATH = path.join(REPO_ROOT, "tests", "validation", "corpus-manifest.json")
const FIXTURES_DIR = path.join(REPO_ROOT, "tests", "fixtures")

/** Interpreter hosting the real engines (same override the bridge honours). */
const PYTHON_BIN = process.env.EOS_PYTHON ?? "/home/z/.venv/bin/python3"

/** The LibreOffice binary (same override the conversion bridge honours). */
const LIBREOFFICE_BIN = process.env.EOS_LIBREOFFICE ?? "/usr/bin/libreoffice"

/** Python engines per adapter kind (cpm/libreoffice/ocr are probed differently). */
const PYTHON_ENGINE_MODULES: Record<
  "step" | "ifc" | "femesh" | "powerflow" | "des" | "fea" | "transport" | "chip" | "swmm" | "sheet" | "dxf" | "parametric",
  string
> = {
  step: "cadquery",
  ifc: "ifcopenshell",
  femesh: "gmsh",
  powerflow: "pandapower",
  des: "simpy",
  fea: "skfem",
  transport: "sfepy",
  chip: "amaranth",
  swmm: "pyswmm",
  sheet: "pdfplumber",
  dxf: "ezdxf",
  parametric: "cadquery",
}

/** The tesseract binary (same override the OCR bridge honours). */
const TESSERACT_BIN = process.env.EOS_TESSERACT ?? "/usr/bin/tesseract"

/** The VENDORED sha-pinned eng model the harness always reads with (16-R2:
 * byte-identical CI models; the product path prefers this dir too — see
 * src/engines/adapters/sheet_ocr.ts). */
export const VENDORED_TESSDATA_DIR = path.join(REPO_ROOT, "tests", "fixtures", "tessdata")
export const VENDORED_ENG_SHA256 = "7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2"

/** Human labels for the availability line in the evidence doc. */
export const ADAPTER_LABELS: Record<AdapterKind, string> = {
  step: "cadquery (STEP quantities)",
  ifc: "ifcopenshell (IFC quantities)",
  femesh: "gmsh (FE mesh)",
  powerflow: "pandapower (power flow)",
  des: "simpy (discrete-event)",
  fea: "scikit-fem (plane-stress FEA)",
  transport: "sfepy/SfePy (steady scalar transport CFD)",
  chip: "amaranth + yowasp-yosys (RTL synthesis)",
  swmm: "pyswmm/SWMM5 (stormwater drainage)",
  cpm: "platform CPM core (no engine)",
  libreoffice: "libreoffice (document conversion)",
  sheet: "pdfplumber (vector sheet takeoff)",
  dxf: "ezdxf (DXF takeoff)",
  parametric: "cadquery (parametric rebuild)",
  ocr: "tesseract (sheet-text OCR)",
  pdf2takeoff: "pdf2takeoff (ADOPTED takeoff engine — ADR-0011)",
}

/**
 * Real-availability probe (no mocks): is the engine importable in the venv the
 * bridge spawns? Mirrors the pattern proven in quantities.test.ts. W2-f:
 *   - gmsh needs its system libraries, so the femesh probe runs with the SAME
 *     LD_LIBRARY_PATH construction the bridge injects (`femeshLdLibraryPath`)
 *     — the probe answer can never disagree with the spawn.
 *   - the cpm platform core has NO engine — always available, honestly.
 *   - libreoffice is probed via `--version` (EOS_LIBREOFFICE-overridable, so
 *     EOS_LIBREOFFICE=/nonexistent yields honest skips for its cases).
 */
export function probeEngine(kind: AdapterKind): { available: boolean; reason?: string } {
  if (kind === "cpm") {
    return { available: true } // pure platform core — no engine to probe (contract §6)
  }
  if (kind === "pdf2takeoff") {
    // ADR-0011 Stage 1: the ADOPTED engine — pinned checkout + dependencies
    // + a runnable CLI (EOS_PDF2TAKEOFF_DIR-overridable, so a missing install
    // yields honest skips for its cases, never fabricated results).
    const dir = process.env.EOS_PDF2TAKEOFF_DIR ?? path.join(os.homedir(), ".local", "share", "eos-engines", "pdf2takeoff")
    if (!existsSync(path.join(dir, "bin", "pdf2takeoff.js"))) {
      return { available: false, reason: `pdf2takeoff is not installed at ${dir} (run scripts/setup-pdf2takeoff.sh)` }
    }
    if (!existsSync(path.join(dir, "node_modules", "pdfjs-dist"))) {
      return { available: false, reason: `pdf2takeoff at ${dir} has no installed dependencies (run scripts/setup-pdf2takeoff.sh again)` }
    }
    let pin = ""
    try {
      pin = readFileSync(path.join(dir, ".eos-engine-pin"), "utf8").trim()
    } catch {
      return { available: false, reason: `pdf2takeoff at ${dir} carries no .eos-engine-pin (run scripts/setup-pdf2takeoff.sh) — an unpinned checkout is never run` }
    }
    if (pin !== PDF2TAKEOFF_PINNED_COMMIT) {
      return { available: false, reason: `pdf2takeoff checkout is pinned to ${pin}, but the harness requires ${PDF2TAKEOFF_PINNED_COMMIT} (ADR-0011 Stage 1)` }
    }
    const res = spawnSync(process.env.EOS_NODE_BIN ?? "node", [path.join(dir, "bin", "pdf2takeoff.js"), "help"], { timeout: 60_000 })
    if (res.error || res.status !== 0) {
      return { available: false, reason: `the pinned pdf2takeoff checkout does not run (node >= 22.13 required): ${res.error ? res.error.message : `exit ${res.status}`}` }
    }
    return { available: true }
  }
  if (kind === "libreoffice") {
    const res = spawnSync(LIBREOFFICE_BIN, ["--version"], { timeout: 60_000 })
    if (res.error) {
      return { available: false, reason: `libreoffice is not runnable at ${LIBREOFFICE_BIN} (${res.error.message})` }
    }
    if (res.status !== 0) {
      return { available: false, reason: `libreoffice --version exited with code ${res.status} at ${LIBREOFFICE_BIN}` }
    }
    return { available: true }
  }
  if (kind === "ocr") {
    // 16-B: the tesseract binary + the VENDORED sha-pinned model (the harness
    // always reads with the vendored dir, so its absence is an honest skip).
    const res = spawnSync(TESSERACT_BIN, ["--version"], { timeout: 60_000 })
    if (res.error) {
      return { available: false, reason: `tesseract is not runnable at ${TESSERACT_BIN} (${res.error.message})` }
    }
    if (res.status !== 0) {
      return { available: false, reason: `tesseract --version exited with code ${res.status} at ${TESSERACT_BIN}` }
    }
    if (!existsSync(path.join(VENDORED_TESSDATA_DIR, "eng.traineddata"))) {
      return { available: false, reason: `the vendored eng.traineddata is missing at ${VENDORED_TESSDATA_DIR} (harness reads are model-pinned)` }
    }
    return { available: true }
  }
  if (kind === "chip") {
    // Slice 30 (§17.1): the chip lane needs BOTH halves — the amaranth import
    // (front-end) AND the yowasp-yosys entry point (synthesis). Probing one
    // would let cases FAIL at run time instead of skipping honestly.
    const amaranth = spawnSync(PYTHON_BIN, ["-c", "import amaranth"], { timeout: 60_000 })
    if (amaranth.error || amaranth.status !== 0) {
      return { available: false, reason: `amaranth is not importable in ${PYTHON_BIN} (exit code ${String(amaranth.status)})` }
    }
    const yosysBin = path.join(path.dirname(PYTHON_BIN), "yowasp-yosys")
    const yosys = spawnSync(yosysBin, ["-V"], { timeout: 120_000 })
    if (yosys.error || yosys.status !== 0) {
      return { available: false, reason: `yowasp-yosys is not runnable at ${yosysBin} (exit code ${String(yosys.status)}) — the synthesis half of the chip lane` }
    }
    return { available: true }
  }
  const mod = PYTHON_ENGINE_MODULES[kind]
  const probeEnv =
    kind === "femesh"
      ? { ...process.env, LD_LIBRARY_PATH: femeshLdLibraryPath(process.env.LD_LIBRARY_PATH) }
      : undefined
  const res = spawnSync(PYTHON_BIN, ["-c", `import ${mod}`], { timeout: 60_000, env: probeEnv })
  if (res.error) {
    return { available: false, reason: `python interpreter not runnable at ${PYTHON_BIN} (${res.error.message})` }
  }
  if (res.status !== 0) {
    const libs = kind === "femesh" ? " — missing system libs? run scripts/setup-engine-libs.sh" : ""
    return { available: false, reason: `${mod} is not importable in ${PYTHON_BIN} (exit code ${res.status})${libs}` }
  }
  return { available: true }
}

// ---------------------------------------------------------------------------
// Manifest loading & validation (strict — the corpus is committed evidence)
// ---------------------------------------------------------------------------

const QUANTITY_TYPES: readonly QuantityType[] = ["volume", "area", "length", "count"]
const TOLERANCES: readonly ToleranceKind[] = ["exact", "analytic", "mesh"]

function isQuantityType(v: unknown): v is QuantityType {
  return typeof v === "string" && (QUANTITY_TYPES as readonly string[]).includes(v)
}

function isToleranceKind(v: unknown): v is ToleranceKind {
  return typeof v === "string" && (TOLERANCES as readonly string[]).includes(v)
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** W2-d: strict validation of the optional mesh expectation block. */
function parseMeshExpectation(caseId: string, meshRaw: unknown): MeshExpectation {
  if (!isPlainObject(meshRaw)) {
    throw new Error(`manifest case ${caseId}: mesh must be an object`)
  }
  const { expect, errorContains, upAxis, tolerance, elementRefs, elements, volume } = meshRaw
  if (expect !== "success" && expect !== "error") {
    throw new Error(`manifest case ${caseId}: mesh.expect must be "success"|"error"`)
  }
  const mesh: MeshExpectation = { expect }
  if (expect === "error") {
    if (typeof errorContains !== "string" || errorContains.length === 0) {
      throw new Error(`manifest case ${caseId}: mesh error cases must pin errorContains`)
    }
    mesh.errorContains = errorContains
    return mesh
  }
  // success mesh block: payload invariants + pinned ref set + counts + volumes
  if (upAxis !== "z" && upAxis !== "y") {
    throw new Error(`manifest case ${caseId}: mesh.upAxis must be "z"|"y"`)
  }
  if (typeof tolerance !== "number" || !Number.isFinite(tolerance) || tolerance <= 0) {
    throw new Error(`manifest case ${caseId}: mesh.tolerance must be a positive finite number (meters)`)
  }
  if (!Array.isArray(elementRefs) || elementRefs.length === 0) {
    throw new Error(
      `manifest case ${caseId}: mesh success cases must pin a non-empty elementRefs array (adapters error on zero-mesh models)`,
    )
  }
  const seenRefs = new Set<string>()
  for (const ref of elementRefs) {
    if (typeof ref !== "string" || ref.length === 0) {
      throw new Error(`manifest case ${caseId}: mesh.elementRefs entries must be non-empty strings`)
    }
    if (seenRefs.has(ref)) {
      throw new Error(`manifest case ${caseId}: mesh.elementRefs entry ${JSON.stringify(ref)} is not unique`)
    }
    seenRefs.add(ref)
  }
  if (!Array.isArray(elements)) {
    throw new Error(`manifest case ${caseId}: mesh success cases must pin an elements array`)
  }
  const pinnedElementRefs = new Set<string>()
  for (const e of elements) {
    if (!isPlainObject(e)) {
      throw new Error(`manifest case ${caseId}: mesh.elements entries must be objects`)
    }
    const { elementRef, name, vertexCount, triangleCount } = e
    if (typeof elementRef !== "string" || !seenRefs.has(elementRef)) {
      throw new Error(
        `manifest case ${caseId}: mesh.elements entry ${JSON.stringify(elementRef)} is not in the pinned elementRefs set`,
      )
    }
    if (pinnedElementRefs.has(elementRef)) {
      throw new Error(`manifest case ${caseId}: mesh.elements entry ${JSON.stringify(elementRef)} is pinned twice`)
    }
    pinnedElementRefs.add(elementRef)
    if (typeof name !== "string" || name.length === 0) {
      throw new Error(`manifest case ${caseId}: mesh.elements ${elementRef} must pin a name`)
    }
    if (typeof vertexCount !== "number" || !Number.isInteger(vertexCount) || vertexCount < 3) {
      throw new Error(`manifest case ${caseId}: mesh.elements ${elementRef} vertexCount must be an integer ≥ 3`)
    }
    if (typeof triangleCount !== "number" || !Number.isInteger(triangleCount) || triangleCount < 1) {
      throw new Error(`manifest case ${caseId}: mesh.elements ${elementRef} triangleCount must be an integer ≥ 1`)
    }
  }
  if (pinnedElementRefs.size !== seenRefs.size) {
    throw new Error(
      `manifest case ${caseId}: mesh.elements must cover the pinned elementRefs set exactly (missing: ${[...seenRefs].filter((r) => !pinnedElementRefs.has(r)).join(", ")})`,
    )
  }
  const volumes = Array.isArray(volume) ? volume : []
  for (const v of volumes) {
    if (!isPlainObject(v)) {
      throw new Error(`manifest case ${caseId}: mesh.volume entries must be objects`)
    }
    const { elementRef, value, unit, tolerance: vTol, derivation } = v
    if (typeof elementRef !== "string" || !seenRefs.has(elementRef)) {
      throw new Error(
        `manifest case ${caseId}: mesh.volume entry ${JSON.stringify(elementRef)} is not in the pinned elementRefs set`,
      )
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new Error(`manifest case ${caseId}: mesh.volume ${elementRef} value must be a positive finite number (m³)`)
    }
    if (typeof unit !== "string" || unit.length === 0) {
      throw new Error(`manifest case ${caseId}: mesh.volume ${elementRef} has no unit`)
    }
    if (!isToleranceKind(vTol)) {
      throw new Error(
        `manifest case ${caseId}: mesh.volume ${elementRef} has unsupported tolerance ${JSON.stringify(vTol)}`,
      )
    }
    if (typeof derivation !== "string" || derivation.length === 0) {
      throw new Error(`manifest case ${caseId}: mesh.volume ${elementRef} must carry a hand-derived closed form`)
    }
  }
  mesh.upAxis = upAxis
  mesh.tolerance = tolerance
  mesh.elementRefs = elementRefs as string[]
  mesh.elements = elements as MeshElementExpectation[]
  mesh.volume = volumes as MeshVolumeExpectation[]
  return mesh
}

/** W2-f: strict validation of a Phase-5 discipline expectation block. */
function parseDisciplineExpectation(
  caseId: string,
  blockName: string,
  raw: unknown,
): DisciplineExpectation {
  if (!isPlainObject(raw)) {
    throw new Error(`manifest case ${caseId}: the ${blockName} block must be an object`)
  }
  const { expect, errorContains, kind, parameters, pins, note } = raw
  if (expect !== "success" && expect !== "error") {
    throw new Error(`manifest case ${caseId}: ${blockName}.expect must be "success"|"error"`)
  }
  const block: DisciplineExpectation = { expect }
  if (note !== undefined && (typeof note !== "string" || note.length === 0)) {
    throw new Error(`manifest case ${caseId}: ${blockName}.note must be a non-empty string when provided`)
  }
  if (typeof note === "string") block.note = note
  if (expect === "error") {
    if (typeof errorContains !== "string" || errorContains.length === 0) {
      throw new Error(`manifest case ${caseId}: ${blockName} error cases must pin errorContains`)
    }
    block.errorContains = errorContains
    // error cases may pin the model kind too (e.g. the femesh IFC refusal is
    // reached by handing the bridge kind "ifc" — without this the case would
    // run as "step" and never exercise the refusal)
    if (kind !== undefined) {
      if (kind !== "step" && kind !== "ifc") {
        throw new Error(`manifest case ${caseId}: ${blockName}.kind must be "step"|"ifc" (got ${JSON.stringify(kind)})`)
      }
      block.kind = kind
    }
    return block
  }
  if (kind !== undefined && kind !== "step" && kind !== "ifc") {
    throw new Error(`manifest case ${caseId}: ${blockName}.kind must be "step"|"ifc" (got ${JSON.stringify(kind)})`)
  }
  if (kind !== undefined) block.kind = kind
  if (parameters !== undefined) {
    if (!isPlainObject(parameters)) {
      throw new Error(`manifest case ${caseId}: ${blockName}.parameters must be an object`)
    }
    if (blockName === "fea" || blockName === "transport") {
      // Slice 22 (contract §14.3) / Slice 29 (contract §16.3): the ONLY
      // parameter is the mesh refinement level.
      const { meshRefinement } = parameters
      if (
        typeof meshRefinement !== "number" ||
        !Number.isInteger(meshRefinement) ||
        !(meshRefinement >= 1 && meshRefinement <= 7)
      ) {
        throw new Error(
          `manifest case ${caseId}: ${blockName}.parameters.meshRefinement must be an integer between 1 and 7`,
        )
      }
      block.parameters = { meshRefinement }
    } else if (blockName === "chip") {
      // Slice 30 (contract §17.3): synthesize_rtl takes NO parameters — the
      // yosys script is frozen; a non-empty parameter set is a manifest error.
      const keys = Object.keys(parameters)
      if (keys.length !== 0) {
        throw new Error(
          `manifest case ${caseId}: chip.parameters must be empty (the synthesis script is frozen; got ${JSON.stringify(keys)})`,
        )
      }
      block.parameters = {}
    } else if (blockName === "swmm") {
      // Slice 23 (contract §15.3): the ONLY parameter is the routing step.
      const { routingStepSec } = parameters
      if (
        typeof routingStepSec !== "number" ||
        !Number.isInteger(routingStepSec) ||
        !(routingStepSec >= 1 && routingStepSec <= 60)
      ) {
        throw new Error(
          `manifest case ${caseId}: ${blockName}.parameters.routingStepSec must be an integer between 1 and 60`,
        )
      }
      block.parameters = { routingStepSec }
    } else {
      const { meshSizeMin, meshSizeMax, elementOrder } = parameters
      if (typeof meshSizeMin !== "number" || !(meshSizeMin > 0)) {
        throw new Error(`manifest case ${caseId}: ${blockName}.parameters.meshSizeMin must be a positive number`)
      }
      if (typeof meshSizeMax !== "number" || !(meshSizeMax > 0)) {
        throw new Error(`manifest case ${caseId}: ${blockName}.parameters.meshSizeMax must be a positive number`)
      }
      if (elementOrder !== 1) {
        throw new Error(`manifest case ${caseId}: ${blockName}.parameters.elementOrder must be 1 (linear tets only this phase)`)
      }
      block.parameters = { meshSizeMin, meshSizeMax, elementOrder: 1 }
    }
  }
  if (!Array.isArray(pins) || pins.length === 0) {
    throw new Error(
      `manifest case ${caseId}: ${blockName} success cases must pin a non-empty pins array (structural pins included)`,
    )
  }
  block.pins = parseDisciplinePins(caseId, blockName, pins)
  return block
}

/** Validate a pins array into DisciplinePins (W2-f rules, verbatim — 16-V
 * extracted this block so the takeoff blocks enforce the IDENTICAL schema:
 * every entry needs a field, a comparable value with an explicit numeric
 * bound, and a hand-derived audit string). */
function parseDisciplinePins(caseId: string, blockName: string, pins: unknown[]): DisciplinePin[] {
  return pins.map((p: unknown, j: number) => {
    if (!isPlainObject(p)) {
      throw new Error(`manifest case ${caseId}: ${blockName}.pins[${j}] is not an object`)
    }
    const { ref, field, value, unit, relTolerance, absTolerance, minBound, derivation } = p
    if (ref !== null && (typeof ref !== "string" || ref.length === 0)) {
      throw new Error(`manifest case ${caseId}: ${blockName}.pins[${j}].ref must be a non-empty string or null`)
    }
    if (typeof field !== "string" || field.length === 0) {
      throw new Error(`manifest case ${caseId}: ${blockName}.pins[${j}] has no field`)
    }
    const isNumber = typeof value === "number" && Number.isFinite(value)
    const isString = typeof value === "string"
    const isBool = typeof value === "boolean"
    const isArray =
      Array.isArray(value) && value.length > 0 && value.every((x) => typeof x === "string" || typeof x === "number")
    if (!isNumber && !isString && !isBool && !isArray) {
      throw new Error(
        `manifest case ${caseId}: ${blockName}.pins[${j}].value must be a finite number, string, boolean or a non-empty (string|number)[]`,
      )
    }
    if (isNumber || isArray) {
      // numeric pins need an explicit bound (relTolerance | absTolerance | minBound;
      // a missing bound means bitwise-exact, which is also explicit via abs 0)
      if (
        relTolerance !== undefined &&
        (typeof relTolerance !== "number" || !(relTolerance > 0))
      ) {
        throw new Error(`manifest case ${caseId}: ${blockName}.pins[${j}].relTolerance must be a positive number`)
      }
      if (
        absTolerance !== undefined &&
        (typeof absTolerance !== "number" || !(absTolerance >= 0))
      ) {
        throw new Error(`manifest case ${caseId}: ${blockName}.pins[${j}].absTolerance must be a number ≥ 0`)
      }
      if (minBound !== undefined && minBound !== true) {
        throw new Error(`manifest case ${caseId}: ${blockName}.pins[${j}].minBound must be true when provided`)
      }
      if (minBound === true && (relTolerance !== undefined || absTolerance !== undefined)) {
        throw new Error(
          `manifest case ${caseId}: ${blockName}.pins[${j}] cannot combine minBound with relTolerance/absTolerance`,
        )
      }
    } else if (relTolerance !== undefined || absTolerance !== undefined || minBound !== undefined) {
      throw new Error(
        `manifest case ${caseId}: ${blockName}.pins[${j}] string/boolean pins are compared exactly — no tolerance keys allowed`,
      )
    }
    if (unit !== undefined && (typeof unit !== "string" || unit.length === 0)) {
      throw new Error(`manifest case ${caseId}: ${blockName}.pins[${j}].unit must be a non-empty string when provided`)
    }
    if (typeof derivation !== "string" || derivation.length === 0) {
      throw new Error(
        `manifest case ${caseId}: ${blockName}.pins[${j}] must carry a hand-derived audit string (the closed form or the live-observed pin provenance)`,
      )
    }
    const pin: DisciplinePin = { ref: ref === null ? null : (ref as string), field, value, derivation }
    if (typeof unit === "string") pin.unit = unit
    if (typeof relTolerance === "number") pin.relTolerance = relTolerance
    if (typeof absTolerance === "number") pin.absTolerance = absTolerance
    if (minBound === true) pin.minBound = true
    return pin
  })
}

/** 16-V: validate one takeoff run's parameters per adapter kind (sheet: the
 * calibration is REQUIRED — the bridge refuses without it; dxf: layerFilter
 * must be a string array; the bridges normalize/validate again at run time). */
function parseTakeoffRunParameters(
  caseId: string,
  blockName: string,
  adapter: TakeoffAdapter,
  runIndex: number,
  parameters: unknown,
): Record<string, unknown> {
  if (parameters === undefined) parameters = {}
  if (!isPlainObject(parameters)) {
    throw new Error(`manifest case ${caseId}: ${blockName}.runs[${runIndex}].parameters must be an object`)
  }
  if (adapter === "sheet") {
    const { pageNo, scaleMmPerPt, flattenSegments } = parameters
    if (pageNo !== undefined && (typeof pageNo !== "number" || !Number.isInteger(pageNo) || pageNo < 1)) {
      throw new Error(`manifest case ${caseId}: ${blockName}.runs[${runIndex}].parameters.pageNo must be an integer >= 1`)
    }
    if (typeof scaleMmPerPt !== "number" || !(scaleMmPerPt > 0)) {
      throw new Error(
        `manifest case ${caseId}: ${blockName}.runs[${runIndex}].parameters.scaleMmPerPt must be a positive number (sheet takeoff is REFUSED without a calibration)`,
      )
    }
    if (flattenSegments !== undefined && (typeof flattenSegments !== "number" || !Number.isFinite(flattenSegments))) {
      throw new Error(`manifest case ${caseId}: ${blockName}.runs[${runIndex}].parameters.flattenSegments must be a finite number`)
    }
  } else {
    const { layerFilter } = parameters
    if (
      layerFilter !== undefined &&
      (!Array.isArray(layerFilter) || layerFilter.some((x) => typeof x !== "string" || x.length === 0))
    ) {
      throw new Error(
        `manifest case ${caseId}: ${blockName}.runs[${runIndex}].parameters.layerFilter must be an array of non-empty layer names`,
      )
    }
  }
  return parameters
}

/** 16-V: strict validation of a takeoff expectation block (sheet/dxf cases). */
function parseTakeoffExpectation(
  caseId: string,
  blockName: string,
  raw: unknown,
  adapter: TakeoffAdapter,
): TakeoffExpectation {
  if (!isPlainObject(raw)) {
    throw new Error(`manifest case ${caseId}: the ${blockName} block must be an object`)
  }
  const { expect, errorContains, runs, note } = raw
  if (expect !== "success" && expect !== "error") {
    throw new Error(`manifest case ${caseId}: ${blockName}.expect must be "success"|"error"`)
  }
  const block: TakeoffExpectation = { expect }
  if (note !== undefined && (typeof note !== "string" || note.length === 0)) {
    throw new Error(`manifest case ${caseId}: ${blockName}.note must be a non-empty string when provided`)
  }
  if (typeof note === "string") block.note = note
  if (expect === "error") {
    if (typeof errorContains !== "string" || errorContains.length === 0) {
      throw new Error(`manifest case ${caseId}: ${blockName} error cases must pin errorContains`)
    }
    block.errorContains = errorContains
    // error runs may still carry parameters (e.g. the raster-refusal case must
    // pass a valid scale so the bridge does not refuse on calibration first)
    if (runs !== undefined) {
      if (!Array.isArray(runs) || runs.length === 0) {
        throw new Error(`manifest case ${caseId}: ${blockName}.runs must be a non-empty array when provided`)
      }
      block.runs = runs.map((r: unknown, j: number) => {
        if (!isPlainObject(r)) {
          throw new Error(`manifest case ${caseId}: ${blockName}.runs[${j}] is not an object`)
        }
        return { parameters: parseTakeoffRunParameters(caseId, blockName, adapter, j, r.parameters) }
      })
    }
    return block
  }
  if (!Array.isArray(runs) || runs.length === 0) {
    throw new Error(
      `manifest case ${caseId}: ${blockName} success cases must pin a non-empty runs array (one row per parameter set)`,
    )
  }
  block.runs = runs.map((r: unknown, j: number) => {
    if (!isPlainObject(r)) {
      throw new Error(`manifest case ${caseId}: ${blockName}.runs[${j}] is not an object`)
    }
    const runPins = r.pins
    if (!Array.isArray(runPins) || runPins.length === 0) {
      throw new Error(
        `manifest case ${caseId}: ${blockName}.runs[${j}] must pin a non-empty pins array (structural pins included)`,
      )
    }
    return {
      parameters: parseTakeoffRunParameters(caseId, blockName, adapter, j, r.parameters),
      pins: parseDisciplinePins(caseId, `${blockName}.runs[${j}]`, runPins),
    }
  })
  return block
}

/** 16-P: strict validation of a parametric expectation block. Error runs pin
 * their refusal substring PER RUN (a parametric error case may exercise
 * several DISTINCT refusal shapes — range, unknown key, geometry
 * contradiction); an optional block-level substring, when present, is
 * asserted against every run's message too. */
function parseParametricExpectation(
  caseId: string,
  blockName: string,
  raw: unknown,
): ParametricExpectation {
  if (!isPlainObject(raw)) {
    throw new Error(`manifest case ${caseId}: the ${blockName} block must be an object`)
  }
  const { expect, errorContains, runs, note } = raw
  if (expect !== "success" && expect !== "error") {
    throw new Error(`manifest case ${caseId}: ${blockName}.expect must be "success"|"error"`)
  }
  const block: ParametricExpectation = { expect }
  if (note !== undefined && (typeof note !== "string" || note.length === 0)) {
    throw new Error(`manifest case ${caseId}: ${blockName}.note must be a non-empty string when provided`)
  }
  if (typeof note === "string") block.note = note
  if (!Array.isArray(runs) || runs.length === 0) {
    throw new Error(
      `manifest case ${caseId}: ${blockName} cases must pin a non-empty runs array (one row per mode/parameter set)`,
    )
  }
  if (errorContains !== undefined && (typeof errorContains !== "string" || errorContains.length === 0)) {
    throw new Error(`manifest case ${caseId}: ${blockName}.errorContains must be a non-empty string when provided`)
  }
  if (typeof errorContains === "string") block.errorContains = errorContains
  block.runs = runs.map((r: unknown, j: number) => {
    if (!isPlainObject(r)) {
      throw new Error(`manifest case ${caseId}: ${blockName}.runs[${j}] is not an object`)
    }
    if (r.mode !== "schema" && r.mode !== "build") {
      throw new Error(`manifest case ${caseId}: ${blockName}.runs[${j}].mode must be "schema"|"build"`)
    }
    const run: ParametricRun = { mode: r.mode }
    if (r.parameters !== undefined) {
      if (!isPlainObject(r.parameters)) {
        throw new Error(`manifest case ${caseId}: ${blockName}.runs[${j}].parameters must be an object`)
      }
      if (r.mode === "schema") {
        throw new Error(
          `manifest case ${caseId}: ${blockName}.runs[${j}] is a schema run — schema runs take no parameters (the adapter refuses them)`,
        )
      }
      run.parameters = r.parameters
    }
    if (expect === "error") {
      if (typeof r.errorContains !== "string" || r.errorContains.length === 0) {
        throw new Error(
          `manifest case ${caseId}: ${blockName}.runs[${j}] error runs must pin their own errorContains (a parametric error case may pin several DISTINCT refusal shapes)`,
        )
      }
      run.errorContains = r.errorContains
      return run
    }
    const runPins = r.pins
    if (!Array.isArray(runPins) || runPins.length === 0) {
      throw new Error(
        `manifest case ${caseId}: ${blockName}.runs[${j}] must pin a non-empty pins array (structural pins included)`,
      )
    }
    run.pins = parseDisciplinePins(caseId, `${blockName}.runs[${j}]`, runPins)
    return run
  })
  return block
}

/** 16-B: strict validation of an OCR expectation block. Success runs pin the
 * ORDERED expected word list (raw transcript text + conf floors + the Ø-rule
 * rows); error runs pin their refusal substring per run. */
function parseOcrExpectation(
  caseId: string,
  blockName: string,
  raw: unknown,
): OcrExpectation {
  if (!isPlainObject(raw)) {
    throw new Error(`manifest case ${caseId}: the ${blockName} block must be an object`)
  }
  const { expect, runs, note } = raw
  if (expect !== "success" && expect !== "error") {
    throw new Error(`manifest case ${caseId}: ${blockName}.expect must be "success"|"error"`)
  }
  const block: OcrExpectation = { expect }
  if (note !== undefined && (typeof note !== "string" || note.length === 0)) {
    throw new Error(`manifest case ${caseId}: ${blockName}.note must be a non-empty string when provided`)
  }
  if (typeof note === "string") block.note = note
  if (!Array.isArray(runs) || runs.length === 0) {
    throw new Error(
      `manifest case ${caseId}: ${blockName} cases must pin a non-empty runs array (one row per parameter set)`,
    )
  }
  block.runs = runs.map((r: unknown, j: number) => {
    if (!isPlainObject(r)) {
      throw new Error(`manifest case ${caseId}: ${blockName}.runs[${j}] is not an object`)
    }
    const run: OcrRun = {}
    if (r.parameters !== undefined) {
      if (!isPlainObject(r.parameters)) {
        throw new Error(`manifest case ${caseId}: ${blockName}.runs[${j}].parameters must be an object`)
      }
      const psm = (r.parameters as { psm?: unknown }).psm
      if (psm !== undefined && (typeof psm !== "number" || !Number.isInteger(psm) || psm < 0 || psm > 13)) {
        throw new Error(`manifest case ${caseId}: ${blockName}.runs[${j}].parameters.psm must be an integer 0..13`)
      }
      run.parameters = (r.parameters as { psm?: number })
    }
    if (expect === "error") {
      if (typeof r.errorContains !== "string" || r.errorContains.length === 0) {
        throw new Error(
          `manifest case ${caseId}: ${blockName}.runs[${j}] error runs must pin their own errorContains`,
        )
      }
      run.errorContains = r.errorContains
      return run
    }
    const words = r.expectedWords
    if (!Array.isArray(words) || words.length === 0) {
      throw new Error(
        `manifest case ${caseId}: ${blockName}.runs[${j}] must pin a non-empty expectedWords array (the ordered raw transcript)`,
      )
    }
    run.expectedWords = words.map((w: unknown, k: number) => {
      if (!isPlainObject(w)) {
        throw new Error(`manifest case ${caseId}: ${blockName}.runs[${j}].expectedWords[${k}] is not an object`)
      }
      if (typeof w.text !== "string" || w.text.length === 0) {
        throw new Error(
          `manifest case ${caseId}: ${blockName}.runs[${j}].expectedWords[${k}].text must be a non-empty string (the RAW transcript pin)`,
        )
      }
      const word: OcrExpectedWord = { text: w.text }
      if (w.confFloor !== undefined && (typeof w.confFloor !== "number" || w.confFloor < 0 || w.confFloor > 100)) {
        throw new Error(
          `manifest case ${caseId}: ${blockName}.runs[${j}].expectedWords[${k}].confFloor must be a number 0..100 when provided`,
        )
      }
      if (typeof w.confFloor === "number") word.confFloor = w.confFloor
      if (w.normalized !== undefined && (typeof w.normalized !== "string" || w.normalized.length === 0)) {
        throw new Error(
          `manifest case ${caseId}: ${blockName}.runs[${j}].expectedWords[${k}].normalized must be a non-empty string when provided (the Ø-rule pin)`,
        )
      }
      if (typeof w.normalized === "string") word.normalized = w.normalized
      return word
    })
    return run
  })
  return block
}

/** Validate one pdf2takeoff expectation block (ADR-0011 Stage 1). */
function parsePdf2takeoffExpectation(caseId: string, blockName: string, raw: unknown): Pdf2takeoffExpectation {
  if (!isPlainObject(raw)) {
    throw new Error(`manifest case ${caseId}: ${blockName} block must be an object`)
  }
  const { expect, op, errorContains, otherFixture, runs, note } = raw as {
    expect?: unknown
    op?: unknown
    errorContains?: unknown
    otherFixture?: unknown
    runs?: unknown
    note?: unknown
  }
  if (expect !== "success" && expect !== "error") {
    throw new Error(`manifest case ${caseId}: ${blockName}.expect must be "success"|"error"`)
  }
  if (op !== "compare" && op !== "annotate" && op !== "export" && op !== "fill") {
    throw new Error(
      `manifest case ${caseId}: ${blockName}.op must be one of "compare"|"annotate"|"export"|"fill" (got ${JSON.stringify(op)})`,
    )
  }
  const block: Pdf2takeoffExpectation = { expect, op }
  if (note !== undefined && (typeof note !== "string" || note.length === 0)) {
    throw new Error(`manifest case ${caseId}: ${blockName}.note must be a non-empty string when provided`)
  }
  if (typeof note === "string") block.note = note
  if (op === "compare") {
    if (typeof otherFixture !== "string" || otherFixture.length === 0 || path.isAbsolute(otherFixture) || otherFixture.includes("..")) {
      throw new Error(`manifest case ${caseId}: ${blockName} compare cases must pin otherFixture (a plain file name under tests/fixtures/ — the NEW revision)`)
    }
    block.otherFixture = otherFixture
  } else if (otherFixture !== undefined) {
    throw new Error(`manifest case ${caseId}: ${blockName}.otherFixture is a compare-only field`)
  }
  if (errorContains !== undefined && (typeof errorContains !== "string" || errorContains.length === 0)) {
    throw new Error(`manifest case ${caseId}: ${blockName}.errorContains must be a non-empty string when provided`)
  }
  if (typeof errorContains === "string") block.errorContains = errorContains
  if (!Array.isArray(runs) || runs.length === 0) {
    throw new Error(`manifest case ${caseId}: ${blockName} cases must pin a non-empty runs array (one row per parameter set)`)
  }
  if (expect === "error" && errorContains === undefined && !runs.some((r) => isPlainObject(r) && typeof (r as { errorContains?: unknown }).errorContains === "string")) {
    throw new Error(`manifest case ${caseId}: ${blockName} error cases must pin errorContains (block-level or per run)`)
  }
  block.runs = runs.map((r: unknown, j: number) => {
    if (!isPlainObject(r)) {
      throw new Error(`manifest case ${caseId}: ${blockName}.runs[${j}] is not an object`)
    }
    const run: Pdf2takeoffRun = {}
    if (r.parameters !== undefined) {
      if (!isPlainObject(r.parameters)) {
        throw new Error(`manifest case ${caseId}: ${blockName}.runs[${j}].parameters must be an object`)
      }
      run.parameters = r.parameters as Record<string, unknown>
    }
    if (expect === "error") {
      if (typeof r.errorContains !== "string" || r.errorContains.length === 0) {
        throw new Error(`manifest case ${caseId}: ${blockName}.runs[${j}] error runs must pin their own errorContains`)
      }
      run.errorContains = r.errorContains
      return run
    }
    const pins = r.pins
    if (!Array.isArray(pins) || pins.length === 0) {
      throw new Error(`manifest case ${caseId}: ${blockName}.runs[${j}] must pin a non-empty pins array`)
    }
    run.pins = pins.map((p: unknown, k: number) => {
      if (!isPlainObject(p)) {
        throw new Error(`manifest case ${caseId}: ${blockName}.runs[${j}].pins[${k}] is not an object`)
      }
      const pin = p as unknown as DisciplinePin
      if (typeof pin.field !== "string" || pin.field.length === 0) {
        throw new Error(`manifest case ${caseId}: ${blockName}.runs[${j}].pins[${k}].field must be a non-empty string`)
      }
      if (pin.value === undefined) {
        throw new Error(`manifest case ${caseId}: ${blockName}.runs[${j}].pins[${k}].value is required`)
      }
      if (typeof pin.derivation !== "string" || pin.derivation.length === 0) {
        throw new Error(`manifest case ${caseId}: ${blockName}.runs[${j}].pins[${k}].derivation is required (ground truth never comes from adapter output)`)
      }
      if (
        pin.relTolerance !== undefined &&
        (typeof pin.relTolerance !== "number" || !Number.isFinite(pin.relTolerance) || pin.relTolerance < 0)
      ) {
        throw new Error(`manifest case ${caseId}: ${blockName}.runs[${j}].pins[${k}].relTolerance must be a non-negative finite number when provided`)
      }
      if (
        pin.absTolerance !== undefined &&
        (typeof pin.absTolerance !== "number" || !Number.isFinite(pin.absTolerance) || pin.absTolerance < 0)
      ) {
        throw new Error(`manifest case ${caseId}: ${blockName}.runs[${j}].pins[${k}].absTolerance must be a non-negative finite number when provided`)
      }
      if (typeof pin.value !== "number" && pin.relTolerance !== undefined) {
        throw new Error(`manifest case ${caseId}: ${blockName}.runs[${j}].pins[${k}] string/boolean pins are compared exactly — no tolerance keys allowed`)
      }
      return pin
    })
    return run
  })
  return block
}

function parseManifest(raw: unknown): CorpusCase[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`corpus manifest must be a non-empty JSON array (got ${typeof raw})`)
  }
  const cases: CorpusCase[] = []
  const seen = new Set<string>()
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (!isPlainObject(c)) {
      throw new Error(`manifest case [${i}] is not an object`)
    }
    const { caseId, adapter, fixture, expect, errorContains, groundTruth, mesh, femesh, powerflow, des, fea, transport, swmm, cpm, libreoffice, sheet, dxf, parametric, ocr, pdf2takeoff } =
      c
    if (typeof caseId !== "string" || caseId.length === 0) {
      throw new Error(`manifest case [${i}] has no caseId`)
    }
    if (seen.has(caseId)) {
      throw new Error(`manifest caseId ${caseId} is not unique`)
    }
    seen.add(caseId)
    const isModelAdapter = adapter === "step" || adapter === "ifc"
    const isDisciplineAdapter =
      adapter === "femesh" ||
      adapter === "powerflow" ||
      adapter === "des" ||
      adapter === "fea" ||
      adapter === "transport" ||
      adapter === "chip" ||
      adapter === "swmm" ||
      adapter === "cpm" ||
      adapter === "libreoffice" ||
      adapter === "sheet" ||
      adapter === "dxf" ||
      adapter === "parametric" ||
      adapter === "ocr"
    if (!isModelAdapter && !isDisciplineAdapter && adapter !== "pdf2takeoff") {
      throw new Error(
        `manifest case ${caseId}: adapter must be "step"|"ifc"|"femesh"|"powerflow"|"des"|"fea"|"transport"|"chip"|"swmm"|"cpm"|"libreoffice"|"sheet"|"dxf"|"parametric"|"ocr"|"pdf2takeoff" (got ${JSON.stringify(adapter)})`,
      )
    }
    if (typeof fixture !== "string" || fixture.length === 0) {
      throw new Error(`manifest case ${caseId}: fixture must be a file name under tests/fixtures/`)
    }
    if (path.isAbsolute(fixture) || fixture.includes("..")) {
      throw new Error(`manifest case ${caseId}: fixture must be a plain file name, not ${fixture}`)
    }
    if (expect !== "success" && expect !== "error") {
      throw new Error(`manifest case ${caseId}: expect must be "success"|"error"`)
    }
    const parsed: CorpusCase = { caseId, adapter, fixture, expect }
    if (adapter === "sheet" || adapter === "dxf") {
      // 16-V: exactly ONE takeoff block, named after the adapter kind
      const blockName = adapter
      const blockRaw = adapter === "sheet" ? sheet : dxf
      if (blockRaw === undefined) {
        throw new Error(`manifest case ${caseId}: adapter "${adapter}" requires a "${blockName}" expectation block`)
      }
      const block = parseTakeoffExpectation(caseId, blockName, blockRaw, adapter)
      // the case-level expectation must agree with the block
      if (block.expect !== expect) {
        throw new Error(
          `manifest case ${caseId}: expect ${JSON.stringify(expect)} disagrees with the ${blockName} block's expect`,
        )
      }
      if (expect === "error") {
        // error cases pin the substring in the block; the case-level key mirrors it
        parsed.errorContains = block.errorContains
      }
      if (adapter === "sheet") parsed.sheet = block
      else parsed.dxf = block
      if (expect === "success") {
        if (typeof groundTruth !== "string" || groundTruth.length === 0) {
          throw new Error(`manifest case ${caseId}: ${adapter} success cases must carry a non-empty groundTruth string (the analytic narrative behind the pins)`)
        }
        parsed.takeoffGroundTruth = groundTruth
      }
      cases.push(parsed)
      continue
    }
    if (adapter === "pdf2takeoff") {
      // ADR-0011 Stage 1: exactly ONE pdf2takeoff block, naming the op
      if (pdf2takeoff === undefined) {
        throw new Error(`manifest case ${caseId}: adapter "pdf2takeoff" requires a "pdf2takeoff" expectation block`)
      }
      const block = parsePdf2takeoffExpectation(caseId, "pdf2takeoff", pdf2takeoff)
      if (block.expect !== expect) {
        throw new Error(
          `manifest case ${caseId}: expect ${JSON.stringify(expect)} disagrees with the pdf2takeoff block's expect`,
        )
      }
      if (expect === "error") {
        parsed.errorContains = block.errorContains ?? block.runs?.find((r) => r.errorContains !== undefined)?.errorContains
      }
      parsed.pdf2takeoff = block
      if (expect === "success") {
        if (typeof groundTruth !== "string" || groundTruth.length === 0) {
          throw new Error(
            `manifest case ${caseId}: pdf2takeoff success cases must carry a non-empty groundTruth string (the analytic narrative behind the pins)`,
          )
        }
        parsed.pdf2takeoffGroundTruth = groundTruth
      }
      cases.push(parsed)
      continue
    }
    if (adapter === "parametric") {
      // 16-P: exactly ONE parametric block, named after the adapter kind
      if (parametric === undefined) {
        throw new Error(`manifest case ${caseId}: adapter "parametric" requires a "parametric" expectation block`)
      }
      const block = parseParametricExpectation(caseId, "parametric", parametric)
      // the case-level expectation must agree with the block
      if (block.expect !== expect) {
        throw new Error(
          `manifest case ${caseId}: expect ${JSON.stringify(expect)} disagrees with the parametric block's expect`,
        )
      }
      if (expect === "error") {
        // per-run substrings carry the refusal pins; the block-level substring
        // (optional common shape) mirrors to the case level when present
        parsed.errorContains = block.errorContains
      }
      parsed.parametric = block
      if (expect === "success") {
        if (typeof groundTruth !== "string" || groundTruth.length === 0) {
          throw new Error(
            `manifest case ${caseId}: parametric success cases must carry a non-empty groundTruth string (the analytic narrative behind the pins)`,
          )
        }
        parsed.parametricGroundTruth = groundTruth
      }
      cases.push(parsed)
      continue
    }
    if (adapter === "ocr") {
      // 16-B: exactly ONE ocr block, named after the adapter kind
      if (ocr === undefined) {
        throw new Error(`manifest case ${caseId}: adapter "ocr" requires an "ocr" expectation block`)
      }
      const block = parseOcrExpectation(caseId, "ocr", ocr)
      if (block.expect !== expect) {
        throw new Error(
          `manifest case ${caseId}: expect ${JSON.stringify(expect)} disagrees with the ocr block's expect`,
        )
      }
      if (expect === "error") {
        parsed.errorContains = block.runs?.find((r) => r.errorContains !== undefined)?.errorContains
      }
      parsed.ocr = block
      if (expect === "success") {
        if (typeof groundTruth !== "string" || groundTruth.length === 0) {
          throw new Error(
            `manifest case ${caseId}: ocr success cases must carry a non-empty groundTruth string (the narrative behind the expectedWords pins)`,
          )
        }
        parsed.ocrGroundTruth = groundTruth
      }
      cases.push(parsed)
      continue
    }
    if (isDisciplineAdapter) {
      // W2-f: exactly ONE per-adapter block, named after the adapter kind
      const blockName = adapter as DisciplineAdapter
      const blockRaw = c[blockName]
      if (blockRaw === undefined) {
        throw new Error(`manifest case ${caseId}: adapter "${adapter}" requires a "${blockName}" expectation block`)
      }
      parsed[blockName] = parseDisciplineExpectation(caseId, blockName, blockRaw)
      // the case-level expectation must agree with the block
      if ((parsed[blockName] as DisciplineExpectation).expect !== expect) {
        throw new Error(
          `manifest case ${caseId}: expect ${JSON.stringify(expect)} disagrees with the ${blockName} block's expect`,
        )
      }
      if (expect === "error") {
        // error cases pin the substring in the block; the case-level key mirrors it
        parsed.errorContains = (parsed[blockName] as DisciplineExpectation).errorContains
      }
      cases.push(parsed)
      continue
    }
    if (expect === "error") {
      if (typeof errorContains !== "string" || errorContains.length === 0) {
        throw new Error(`manifest case ${caseId}: error cases must pin errorContains`)
      }
      parsed.errorContains = errorContains
    } else {
      if (!Array.isArray(groundTruth)) {
        throw new Error(`manifest case ${caseId}: success cases must pin a groundTruth array (may be empty)`)
      }
      parsed.groundTruth = groundTruth.map((g: unknown, j: number) => {
        if (!isPlainObject(g)) {
          throw new Error(`manifest case ${caseId}: groundTruth[${j}] is not an object`)
        }
        const { elementRef, quantityType, value, unit, tolerance, derivation } = g
        if (typeof elementRef !== "string" || elementRef.length === 0) {
          throw new Error(`manifest case ${caseId}: groundTruth[${j}] has no elementRef`)
        }
        if (!isQuantityType(quantityType)) {
          throw new Error(`manifest case ${caseId}: groundTruth[${j}] has unsupported quantityType ${JSON.stringify(quantityType)}`)
        }
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new Error(`manifest case ${caseId}: groundTruth[${j}] value must be a finite number`)
        }
        if (typeof unit !== "string" || unit.length === 0) {
          throw new Error(`manifest case ${caseId}: groundTruth[${j}] has no unit`)
        }
        if (!isToleranceKind(tolerance)) {
          throw new Error(`manifest case ${caseId}: groundTruth[${j}] has unsupported tolerance ${JSON.stringify(tolerance)}`)
        }
        if (typeof derivation !== "string" || derivation.length === 0) {
          throw new Error(`manifest case ${caseId}: groundTruth[${j}] must carry a human-readable derivation`)
        }
        return { elementRef, quantityType, value, unit, tolerance, derivation }
      })
    }
    if (mesh !== undefined) {
      parsed.mesh = parseMeshExpectation(caseId, mesh)
    }
    cases.push(parsed)
  }
  return cases
}

/** Load + validate the committed corpus manifest. */
export function loadManifest(): CorpusCase[] {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(`corpus manifest not found at ${MANIFEST_PATH}`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"))
  } catch (err) {
    throw new Error(`corpus manifest is not valid JSON: ${(err as Error).message}`)
  }
  return parseManifest(raw)
}

// ---------------------------------------------------------------------------
// Tolerance policy (pinned in Contract A)
// ---------------------------------------------------------------------------

/** Maximum |obs − exp| allowed by the tolerance class. */
export function toleranceBound(expected: number, tolerance: ToleranceKind): number {
  return tolerance === "mesh" ? 1e-2 * Math.abs(expected) : 1e-9 * Math.max(1, Math.abs(expected))
}

function withinTolerance(observed: number, expected: number, tolerance: ToleranceKind): boolean {
  return Math.abs(observed - expected) <= toleranceBound(expected, tolerance)
}

// ---------------------------------------------------------------------------
// Set-equality comparison (multiset matching per (elementRef, quantityType))
// ---------------------------------------------------------------------------

function groupKey(elementRef: string, quantityType: string): string {
  return `${elementRef}\u0000${quantityType}`
}

/**
 * Backtracking multiset matcher: each expected entry must be matched by
 * exactly one observed quantity (same unit, value inside its tolerance) and no
 * observed quantity may remain. Groups are tiny (≤ 6 in this corpus), so the
 * exponential search is exact and cheap.
 */
function matchGroup(
  expected: GroundTruthEntry[],
  observed: { value: number; unit: string }[],
): (number | null)[] | null {
  const assignment: (number | null)[] = expected.map(() => null)
  const used = observed.map(() => false)
  const tryFrom = (i: number): boolean => {
    if (i === expected.length) return true
    for (let j = 0; j < observed.length; j++) {
      if (used[j]) continue
      const e = expected[i]
      const o = observed[j]
      if (o.unit !== e.unit) continue
      if (!withinTolerance(o.value, e.value, e.tolerance)) continue
      used[j] = true
      assignment[i] = j
      if (tryFrom(i + 1)) return true
      used[j] = false
      assignment[i] = null
    }
    return false
  }
  return tryFrom(0) ? assignment : null
}

/** Compare adapter output against the pinned ground truth (set equality). */
export function compareQuantities(
  groundTruth: GroundTruthEntry[],
  observed: DerivedQuantity[],
): { comparisons: ComparisonResult[]; ok: boolean } {
  const expectedByGroup = new Map<string, number[]>() // group -> indices into groundTruth
  groundTruth.forEach((g, i) => {
    const key = groupKey(g.elementRef, g.quantityType)
    const list = expectedByGroup.get(key) ?? []
    list.push(i)
    expectedByGroup.set(key, list)
  })
  const observedByGroup = new Map<string, number[]>()
  observed.forEach((q, i) => {
    const key = groupKey(q.elementRef, q.quantityType)
    const list = observedByGroup.get(key) ?? []
    list.push(i)
    observedByGroup.set(key, list)
  })

  const comparisons: ComparisonResult[] = []
  const matchedObserved = new Set<number>()
  let ok = true

  for (const [key, expectedIndices] of expectedByGroup) {
    const observedIndices = observedByGroup.get(key) ?? []
    const expectedEntries = expectedIndices.map((i) => groundTruth[i])
    const observedEntries = observedIndices.map((i) => ({ value: observed[i].value, unit: observed[i].unit }))
    const assignment = matchGroup(expectedEntries, observedEntries)
    if (assignment !== null) {
      expectedIndices.forEach((gtIndex, k) => {
        const oIndex = observedIndices[assignment[k] as number]
        matchedObserved.add(oIndex)
        const e = groundTruth[gtIndex]
        const o = observed[oIndex]
        const absDiff = Math.abs(o.value - e.value)
        comparisons.push({
          elementRef: e.elementRef,
          quantityType: e.quantityType,
          expected: e.value,
          observed: o.value,
          unit: e.unit,
          observedUnit: o.unit,
          tolerance: e.tolerance,
          absDiff,
          observedRelError: absDiff / Math.abs(e.value),
          ok: true,
          problem: "matched",
          derivation: e.derivation,
        })
      })
      continue
    }
    // No perfect matching in this group — describe the failure honestly.
    ok = false
    const usedObserved = new Set<number>()
    for (const gtIndex of expectedIndices) {
      const e = groundTruth[gtIndex]
      // best-effort: nearest unused observed entry in the group by |Δvalue|
      let best: number | null = null
      let bestDiff = Number.POSITIVE_INFINITY
      for (const oIndex of observedIndices) {
        if (usedObserved.has(oIndex)) continue
        const diff = Math.abs(observed[oIndex].value - e.value)
        if (diff < bestDiff) {
          best = oIndex
          bestDiff = diff
        }
      }
      if (best === null) {
        comparisons.push({
          elementRef: e.elementRef,
          quantityType: e.quantityType,
          expected: e.value,
          observed: null,
          unit: e.unit,
          observedUnit: null,
          tolerance: e.tolerance,
          absDiff: null,
          observedRelError: null,
          ok: false,
          problem: "missing",
          derivation: e.derivation,
        })
        continue
      }
      usedObserved.add(best)
      const o = observed[best]
      const absDiff = Math.abs(o.value - e.value)
      const unitMismatch = o.unit !== e.unit
      comparisons.push({
        elementRef: e.elementRef,
        quantityType: e.quantityType,
        expected: e.value,
        observed: o.value,
        unit: e.unit,
        observedUnit: o.unit,
        tolerance: e.tolerance,
        absDiff,
        observedRelError: absDiff / Math.abs(e.value),
        ok: false,
        // a unit mismatch is reported as "unit" (the value deviation stays
        // visible in observed/absDiff/observedRelError on the same row)
        problem: unitMismatch ? "unit" : "value",
        derivation: e.derivation,
      })
    }
    // leftover observed entries in this group are extras
    for (const oIndex of observedIndices) {
      if (usedObserved.has(oIndex) || matchedObserved.has(oIndex)) continue
      const o = observed[oIndex]
      comparisons.push({
        elementRef: o.elementRef,
        quantityType: o.quantityType,
        expected: null,
        observed: o.value,
        unit: o.unit,
        observedUnit: o.unit,
        tolerance: null,
        absDiff: null,
        observedRelError: null,
        ok: false,
        problem: "extra",
        derivation: null,
      })
    }
  }

  // observed entries in groups that have NO expected entries at all → extra
  for (const [key, observedIndices] of observedByGroup) {
    if (expectedByGroup.has(key)) continue
    for (const oIndex of observedIndices) {
      const o = observed[oIndex]
      comparisons.push({
        elementRef: o.elementRef,
        quantityType: o.quantityType,
        expected: null,
        observed: o.value,
        unit: o.unit,
        observedUnit: o.unit,
        tolerance: null,
        absDiff: null,
        observedRelError: null,
        ok: false,
        problem: "extra",
        derivation: null,
      })
    }
    ok = false
  }

  return { comparisons, ok }
}

// ---------------------------------------------------------------------------
// Determinism (bitwise-identical quantity values across two real runs)
// ---------------------------------------------------------------------------

function quantitiesSignature(quantities: DerivedQuantity[]): string {
  // JSON number formatting in JS is shortest-round-trip: two doubles serialize
  // identically iff they are the same value (Object.is semantics for ±0/NaN
  // aside, the bridge guarantees finite values). Order is part of the
  // signature — enumeration order must be stable too.
  return JSON.stringify(quantities.map((q) => [q.elementRef, q.quantityType, q.value, q.unit]))
}

export function isDeterministic(first: DerivedQuantity[], second: DerivedQuantity[]): boolean {
  return quantitiesSignature(first) === quantitiesSignature(second)
}

// ---------------------------------------------------------------------------
// Mesh checks (W2-d — Contract C: refs set equality, pinned counts,
// byte-determinism, divergence-theorem volumes vs closed forms)
// ---------------------------------------------------------------------------

/**
 * Divergence-theorem volume of one closed tessellated element, in m³.
 * Pure math over the returned mesh — the harness-side verifier, independent
 * of the python adapters' own arithmetic. Exact for planar solids; an
 * approximation for curved surfaces (the pinned 1% `mesh` tolerance).
 */
export function meshElementVolume(element: MeshElement): number {
  let vol = 0
  for (const t of element.triangles) {
    const p0 = element.vertices[t[0]]
    const p1 = element.vertices[t[1]]
    const p2 = element.vertices[t[2]]
    vol +=
      (p0[0] * (p1[1] * p2[2] - p1[2] * p2[1]) -
        p0[1] * (p1[0] * p2[2] - p1[2] * p2[0]) +
        p0[2] * (p1[0] * p2[1] - p1[1] * p2[0])) /
      6
  }
  return Math.abs(vol)
}

/**
 * The element-level quantity refs of a case (the mesh cross-reference
 * contract): every IFC quantity ref is an element ref; STEP quantity output
 * additionally carries the aggregate refs `step:solids:all` and
 * `step:model:bbox`, which are NOT mesh elements and are filtered out.
 */
function elementLevelQuantityRefs(adapter: AdapterKind, quantities: DerivedQuantity[]): string[] {
  const refs = new Set(quantities.map((q) => q.elementRef))
  if (adapter === "ifc") return [...refs]
  return [...refs].filter((r) => /^step:solid:[0-9]+$/.test(r))
}

function refsText(refs: string[]): string {
  return [...refs].sort().join(", ")
}

function setsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const setB = new Set(b)
  return a.every((x) => setB.has(x))
}

function meshRow(partial: Omit<MeshComparison, "problem"> & { problem?: MeshComparison["problem"] }): MeshComparison {
  const problem = partial.problem ?? (partial.ok ? "matched" : "value")
  return { ...partial, problem }
}

/** Run the mesh sub-expectation of one corpus case against the REAL bridge. */
async function runMeshChecks(
  c: CorpusCase,
  fixturePath: string,
  quantityFirst: DeriveResult | null,
  report: Pick<HarnessReport, "engineVersions" | "adapterHashes">,
): Promise<MeshCaseResult> {
  const m = c.mesh as MeshExpectation
  const r: MeshCaseResult = {
    expect: m.expect,
    status: "fail",
    determinism: null,
    elementCount: null,
    vertexCount: null,
    triangleCount: null,
    comparisons: [],
    problems: [],
  }

  if (c.adapter !== "step" && c.adapter !== "ifc") {
    // mesh expectations ride the step/ifc quantity cases only (see the guard
    // on the success branch below) — refuse a mis-wired discipline case
    // honestly instead of coercing the kind.
    r.problems.push(
      `mesh expectations are only defined for step/ifc cases (got adapter "${c.adapter}" — harness wiring bug)`,
    )
    r.status = "fail"
    return r
  }

  if (m.expect === "error") {
    let caught: unknown
    try {
      await tessellateFromFile(fixturePath, c.adapter)
    } catch (err) {
      caught = err
    }
    r.errorContains = m.errorContains
    if (caught === undefined) {
      r.problems.push(
        `expected the mesh bridge to throw an EngineUnavailableError containing ${JSON.stringify(m.errorContains)}, but the tessellation succeeded`,
      )
    } else if (!(caught instanceof EngineUnavailableError)) {
      r.problems.push(
        `expected an EngineUnavailableError containing ${JSON.stringify(m.errorContains)}, got ${typeof caught === "object" && caught !== null ? (caught as Error).constructor.name : typeof caught}: ${String(caught)}`,
      )
    } else {
      r.errorObserved = caught.message
      if (!caught.message.includes(m.errorContains ?? "")) {
        r.problems.push(
          `error message does not contain the pinned substring ${JSON.stringify(m.errorContains)}: ${caught.message}`,
        )
      }
    }
    r.status = r.problems.length === 0 ? "pass" : "fail"
    return r
  }

  // expect === "success": run the REAL tessellation bridge TWICE (byte-determinism).
  // Mesh expectations ride the step/ifc quantity cases only — a discipline
  // case reaching this runner would be a manifest/harness wiring bug: refuse
  // honestly instead of coercing the kind (the guard also satisfies the type
  // narrowing; runtime truth beats a cast).
  if (c.adapter !== "step" && c.adapter !== "ifc") {
    r.problems.push(
      `mesh expectations are only defined for step/ifc cases (got adapter "${c.adapter}" — harness wiring bug, refusing to run the tessellator)`,
    )
    r.status = "fail"
    return r
  }
  let first: MeshResult
  let second: MeshResult
  try {
    first = await tessellateFromFile(fixturePath, c.adapter)
    second = await tessellateFromFile(fixturePath, c.adapter)
  } catch (err) {
    r.problems.push(
      `expected a successful tessellation but the bridge threw: ${
        err instanceof EngineUnavailableError ? err.message : String(err)
      }`,
    )
    return r
  }
  report.engineVersions[first.engineKey] = first.engineVersion
  report.adapterHashes[first.adapterScript] = first.adapterHash
  r.engine = {
    engineKey: first.engineKey,
    engineVersion: first.engineVersion,
    adapterScript: first.adapterScript,
    adapterHash: first.adapterHash,
  }

  const mesh = first.mesh
  r.determinism = JSON.stringify(mesh) === JSON.stringify(second.mesh)
  if (!r.determinism) {
    r.problems.push(
      "two consecutive real mesh runs produced different mesh JSON — tessellation is not byte-deterministic (Contract A violation)",
    )
  }
  r.elementCount = mesh.elements.length
  r.vertexCount = mesh.elements.reduce((n, e) => n + e.vertices.length, 0)
  r.triangleCount = mesh.elements.reduce((n, e) => n + e.triangles.length, 0)

  // payload invariants pinned in the manifest
  const upAxisOk = mesh.upAxis === m.upAxis
  r.comparisons.push(
    meshRow({
      kind: "upAxis",
      elementRef: null,
      expected: m.upAxis as string,
      observed: mesh.upAxis,
      tolerance: null,
      absDiff: null,
      observedRelError: null,
      ok: upAxisOk,
      derivation: "pinned payload upAxis (the adapter never rewrites the source up-axis)",
    }),
  )
  if (!upAxisOk) {
    r.problems.push(`mesh payload upAxis ${JSON.stringify(mesh.upAxis)} ≠ pinned ${JSON.stringify(m.upAxis)}`)
  }
  const toleranceOk = mesh.tolerance === m.tolerance
  r.comparisons.push(
    meshRow({
      kind: "tolerance",
      elementRef: null,
      expected: m.tolerance as number,
      observed: mesh.tolerance,
      tolerance: null,
      absDiff: Math.abs(mesh.tolerance - (m.tolerance as number)),
      observedRelError: null,
      ok: toleranceOk,
      derivation: "pinned payload tolerance in meters (the adapter documents its native deflection)",
    }),
  )
  if (!toleranceOk) {
    r.problems.push(
      `mesh payload tolerance ${mesh.tolerance} ≠ pinned ${m.tolerance} (meters)`,
    )
  }

  // elementRefs: set equality with the pinned manifest refs
  const observedRefs = mesh.elements.map((e) => e.elementRef)
  const pinnedRefs = m.elementRefs as string[]
  const refsOk = setsEqual(observedRefs, pinnedRefs)
  r.comparisons.push(
    meshRow({
      kind: "refs",
      elementRef: null,
      expected: refsText(pinnedRefs),
      observed: refsText(observedRefs),
      tolerance: null,
      absDiff: null,
      observedRelError: null,
      ok: refsOk,
      derivation: "pinned manifest mesh.elementRefs (set equality — extras and missing both fail)",
    }),
  )
  if (!refsOk) {
    r.problems.push(
      `mesh elementRefs are not set-equal to the pinned refs: observed [${refsText(observedRefs)}] vs pinned [${refsText(pinnedRefs)}]`,
    )
  }

  // cross-reference contract: mesh refs MUST set-equal the quantity element refs
  if (quantityFirst !== null) {
    const quantityRefs = elementLevelQuantityRefs(c.adapter, quantityFirst.quantities)
    const crossOk = setsEqual(observedRefs, quantityRefs)
    r.comparisons.push(
      meshRow({
        kind: "refs",
        elementRef: null,
        expected: refsText(quantityRefs),
        observed: refsText(observedRefs),
        tolerance: null,
        absDiff: null,
        observedRelError: null,
        ok: crossOk,
        derivation:
          "cross-reference contract with the quantity ledger: mesh elementRefs set-equal the quantity adapter's element-level refs",
      }),
    )
    if (!crossOk) {
      r.problems.push(
        `mesh elementRefs do not set-equal the quantity ledger refs: mesh [${refsText(observedRefs)}] vs quantities [${refsText(quantityRefs)}]`,
      )
    }
  }

  // per-element name + vertex/triangle counts (pinned, exact)
  for (const exp of m.elements ?? []) {
    const obs = mesh.elements.find((e) => e.elementRef === exp.elementRef)
    if (!obs) {
      r.comparisons.push(
        meshRow({
          kind: "name",
          elementRef: exp.elementRef,
          expected: exp.name,
          observed: null,
          tolerance: null,
          absDiff: null,
          observedRelError: null,
          ok: false,
          problem: "missing",
          derivation: "pinned manifest mesh.elements entry",
        }),
      )
      r.problems.push(`pinned mesh element ${exp.elementRef} is missing from the tessellation output`)
      continue
    }
    const nameOk = obs.name === exp.name
    r.comparisons.push(
      meshRow({
        kind: "name",
        elementRef: exp.elementRef,
        expected: exp.name,
        observed: obs.name,
        tolerance: null,
        absDiff: null,
        observedRelError: null,
        ok: nameOk,
        derivation: "pinned element name (STEP 'Solid <i+1>'; IFC element Name with GlobalId fallback)",
      }),
    )
    if (!nameOk) {
      r.problems.push(
        `mesh element ${exp.elementRef} name ${JSON.stringify(obs.name)} ≠ pinned ${JSON.stringify(exp.name)}`,
      )
    }
    for (const [kind, expected, observed] of [
      ["vertexCount", exp.vertexCount, obs.vertices.length],
      ["triangleCount", exp.triangleCount, obs.triangles.length],
    ] as const) {
      const countOk = observed === expected
      r.comparisons.push(
        meshRow({
          kind,
          elementRef: exp.elementRef,
          expected,
          observed,
          tolerance: null,
          absDiff: Math.abs(observed - expected),
          observedRelError: null,
          ok: countOk,
          derivation: `pinned per-element ${kind} (real-engine tessellation pin — changes with the engine pin must update the manifest together)`,
        }),
      )
      if (!countOk) {
        r.problems.push(`mesh element ${exp.elementRef} ${kind} ${observed} ≠ pinned ${expected}`)
      }
    }
  }

  // divergence-theorem mesh volumes vs the pinned closed forms
  for (const v of m.volume ?? []) {
    const el = mesh.elements.find((e) => e.elementRef === v.elementRef)
    if (!el) {
      r.comparisons.push(
        meshRow({
          kind: "volume",
          elementRef: v.elementRef,
          expected: v.value,
          observed: null,
          tolerance: v.tolerance,
          absDiff: null,
          observedRelError: null,
          ok: false,
          problem: "missing",
          derivation: v.derivation,
        }),
      )
      r.problems.push(`pinned mesh volume target ${v.elementRef} has no tessellated element`)
      continue
    }
    const observed = meshElementVolume(el)
    const ok = withinTolerance(observed, v.value, v.tolerance)
    const absDiff = Math.abs(observed - v.value)
    r.comparisons.push(
      meshRow({
        kind: "volume",
        elementRef: v.elementRef,
        expected: v.value,
        observed,
        tolerance: v.tolerance,
        absDiff,
        observedRelError: absDiff / Math.abs(v.value),
        ok,
        derivation: v.derivation,
      }),
    )
    if (!ok) {
      r.problems.push(
        `mesh volume out of tolerance (${v.tolerance}): ${v.elementRef} divergence-theorem ${observed} vs closed form ${v.value} ${v.unit} (|Δ| ${absDiff}, rel ${(absDiff / Math.abs(v.value)).toExponential(3)}) — ${v.derivation}`,
      )
    }
  }

  r.status = r.problems.length === 0 ? "pass" : "fail"
  return r
}

// ---------------------------------------------------------------------------
// Discipline checks (W2-f — the femesh/powerflow/des/cpm/libreoffice case
// kinds; REAL bridges only, hand-derived pins, document-byte determinism)
// ---------------------------------------------------------------------------

/** Resolve a pin's observed value on a femesh result (structural computed
 * fields included — they are pinned in the manifest like any other value). */
function femeshObserved(r: FeMeshResult, pin: DisciplinePin): unknown {
  switch (pin.field) {
    case "nodes":
      return r.nodes.count
    case "elements":
      return r.elements.count
    case "elementType":
      return r.elements.type
    case "engineKey":
      return r.engineKey
    case "engineVersion":
      return r.engineVersion
    case "qualityRangeOk":
      return (
        r.quality.min > 0 &&
        r.quality.min <= 1 &&
        r.quality.mean > 0 &&
        r.quality.mean <= 1 &&
        r.quality.min <= r.quality.mean
      )
    case "solidRefOrderOk":
      return r.solids.every((s, i) => s.ref === `step:solid:${i}`)
    case "tetSumOk":
      return r.solids.reduce((n, s) => n + s.tetCount, 0) === r.elements.count
    default: {
      const solid = pin.ref === null ? undefined : r.solids.find((s) => s.ref === pin.ref)
      if (solid === undefined) return undefined
      if (pin.field === "tetCount") return solid.tetCount
      if (pin.field === "meshVolume") return solid.meshVolume
      if (pin.field === "name") return solid.name ?? null
      return undefined
    }
  }
}

function powerflowObserved(r: PowerflowResult, pin: DisciplinePin): unknown {
  switch (pin.field) {
    case "converged":
      return r.converged
    case "engineKey":
      return r.engineKey
    case "engineVersion":
      return r.engineVersion
    case "lossMw":
      return r.totals.lossMw
    case "loadMw":
      return r.totals.loadMw
    case "busCount":
      return r.buses.length
    case "lineCount":
      return r.lines.length
    default:
      break
  }
  if (pin.ref === null) return undefined
  if (pin.ref.includes(">")) {
    const [from, to] = pin.ref.split(">")
    const line = r.lines.find((l) => l.fromBus === from && l.toBus === to)
    if (line === undefined) return undefined
    if (pin.field === "iKa") return line.iKa
    if (pin.field === "pLossMw") return line.pLossMw
    if (pin.field === "qLossMvar") return line.qLossMvar
    return undefined
  }
  const bus = r.buses.find((b) => b.id === pin.ref)
  if (bus === undefined) return undefined
  const busRecord = bus as unknown as Record<string, unknown>
  return pin.field === "id" ? bus.id : busRecord[pin.field]
}

function desObserved(r: DesResult, pin: DisciplinePin): unknown {
  switch (pin.field) {
    case "policy":
      return r.policy
    case "makespan":
      return r.makespan
    case "engineKey":
      return r.engineKey
    case "engineVersion":
      return r.engineVersion
    case "resourceCount":
      return r.resources.length
    case "jobCount":
      return r.jobs.length
    case "utilizationInvariantOk":
      return r.resources.every((res) => res.utilization === res.busy / r.makespan)
    default:
      break
  }
  if (pin.ref === null) return undefined
  const resource = r.resources.find((x) => x.id === pin.ref)
  if (resource !== undefined) {
    if (pin.field === "busy") return resource.busy
    if (pin.field === "utilization") return resource.utilization
  }
  const job = r.jobs.find((x) => x.id === pin.ref)
  if (job !== undefined) {
    if (pin.field === "startAt") return job.startAt
    if (pin.field === "endAt") return job.endAt
  }
  return undefined
}

/** Resolve a pin's observed value on a FEA result (Slice 22 — the sample
 * locator ref is "<x>x<y>" in mm, e.g. "400x0" for the (400, 0) corner). */
function feaObserved(r: FeaResult, pin: DisciplinePin): unknown {
  switch (pin.field) {
    case "analysis":
      return r.analysis
    case "engineKey":
      return r.engineKey
    case "engineVersion":
      return r.engineVersion
    case "elementType":
      return r.mesh.elementType
    case "refinement":
      return r.mesh.refinement
    case "elementCount":
      return r.mesh.elementCount
    case "nodeCount":
      return r.mesh.nodeCount
    case "maxDisplacementMagnitudeMm":
      return r.maxDisplacementMagnitudeMm
    case "sigmaXxMinMpa":
      return r.stress.sigmaXxMinMpa
    case "sigmaXxMaxMpa":
      return r.stress.sigmaXxMaxMpa
    case "vonMisesMaxMpa":
      return r.stress.vonMisesMaxMpa
    default:
      break
  }
  if (pin.ref === null) return undefined
  const mx = pin.ref.match(/^([-\d.]+)x([-\d.]+)$/)
  if (mx === null) return undefined
  const sample = r.samples.find((s) => s.x === Number(mx[1]) && s.y === Number(mx[2]))
  if (sample === undefined) return undefined
  const sampleRecord = sample as unknown as Record<string, unknown>
  return pin.field === "ux" || pin.field === "uy" ? sampleRecord[pin.field] : undefined
}

/** Resolve a pin's observed value on a transport result (Slice 29 — the
 * sample locator ref is "<x>x<y>" in m, e.g. "0.25x0.25" for the (L/8, H/2)
 * station of the 2×0.5 channel). */
function transportObserved(r: TransportResult, pin: DisciplinePin): unknown {
  switch (pin.field) {
    case "analysis":
      return r.analysis
    case "engineKey":
      return r.engineKey
    case "engineVersion":
      return r.engineVersion
    case "elementType":
      return r.mesh.elementType
    case "approximation":
      return r.mesh.approximation
    case "refinement":
      return r.mesh.refinement
    case "elementCount":
      return r.mesh.elementCount
    case "nodeCount":
      return r.mesh.nodeCount
    case "pecletNumber":
      return r.pecletNumber
    case "meshPecletNumber":
      return r.meshPecletNumber
    case "minConcentration":
      return r.minConcentration
    case "maxConcentration":
      return r.maxConcentration
    default:
      break
  }
  if (pin.ref === null) return undefined
  const mx = pin.ref.match(/^([-\d.]+)x([-\d.]+)$/)
  if (mx === null) return undefined
  const sample = r.samples.find((s) => s.x === Number(mx[1]) && s.y === Number(mx[2]))
  if (sample === undefined) return undefined
  return pin.field === "concentration" ? sample.concentration : undefined
}

/** Resolve a pin's observed value on an RTL synthesis result (Slice 30 —
 * scalar fields plus TWO ref locators: the cell type (e.g. "$_AND_") for
 * cellCount histogram pins, and "cycle<N>" for simulation step pins). */
function chipObserved(r: RtlResult, pin: DisciplinePin): unknown {
  switch (pin.field) {
    case "analysis":
      return r.analysis
    case "engineKey":
      return r.engineKey
    case "engineVersion":
      return r.engineVersion
    case "deviceKind":
      return r.device.kind
    case "widthBits":
      return r.device.widthBits
    case "totalCells":
      return r.netlist.totalCells
    case "flipFlopCount":
      return r.netlist.flipFlopCount
    case "netlistSha256":
      return r.netlist.sha256
    case "rtlilCharCount":
      return r.rtlil.charCount
    case "synthesisEngineKey":
      return r.synthesis.engineKey
    case "synthesisEngineVersion":
      return r.synthesis.engineVersion
    case "stepCount":
      return r.simulation.steps.length
    case "cellTypes":
      return Object.keys(r.netlist.cellHistogram).sort()
    default:
      break
  }
  if (pin.ref === null) return undefined
  if (pin.field === "cellCount") {
    return r.netlist.cellHistogram[pin.ref]
  }
  const mc = pin.ref.match(/^cycle(\d+)$/)
  if (mc === null) return undefined
  const step = r.simulation.steps.find((s) => s.cycle === Number(mc[1]))
  if (step === undefined) return undefined
  if (pin.field === "count") return step.count
  if (pin.field === "enabled") return step.enabled
  return undefined
}

/** Resolve a pin's observed value on a SWMM result (Slice 23 — the depth
 * locator ref is the node/conduit id, e.g. "C1" or "J1"). */
function swmmObserved(r: SwmmResult, pin: DisciplinePin): unknown {
  switch (pin.field) {
    case "analysis":
      return r.analysis
    case "engineKey":
      return r.engineKey
    case "engineVersion":
      return r.engineVersion
    case "routingStepSec":
      return r.routing.routingStepSec
    case "routingModel":
      return r.routing.model
    case "outfallVolumeM3":
      return r.outfallVolumeM3
    case "volumeBalancePct":
      return r.volumeBalancePct
    case "runoffErrorPct":
      return r.continuity.runoffErrorPct
    case "routingErrorPct":
      return r.continuity.routingErrorPct
    case "maxRunoffCms":
      return r.peaks.maxRunoffCms
    case "maxConduitFlowCms":
      return r.peaks.maxConduitFlowCms
    case "rainVolumeM3":
      return r.rain.totalVolumeM3
    case "rainDepthMm":
      return r.rain.totalDepthMm
    default:
      break
  }
  if (pin.ref === null) return undefined
  const entry = r.depths.find((d) => d.id === pin.ref)
  if (entry === undefined) return undefined
  return pin.field === "maxDepthM" ? entry.maxDepthM : undefined
}

function libreOfficeObserved(r: ConversionResult, pin: DisciplinePin): unknown {
  switch (pin.field) {
    case "pdfMagic":
      return r.pdfBytes.subarray(0, 5).toString("latin1")
    case "sizeBytes":
      return r.pdfBytes.byteLength
    case "engineKey":
      return r.engineKey
    case "engineVersion":
      return r.engineVersion
    case "adapterScript":
      return r.adapterScript
    default:
      return undefined
  }
}

/** Compare one pin's observed value against its hand-derived expectation. */
function compareDisciplinePin(pin: DisciplinePin, observed: unknown): DisciplineComparison {
  const row: DisciplineComparison = {
    field: pin.field,
    ref: pin.ref,
    expected: pin.value,
    observed: observed === undefined ? null : (observed as number | string | boolean | (string | number)[]),
    unit: pin.unit ?? null,
    bound: null,
    absDiff: null,
    observedRelError: null,
    ok: false,
    problem: "value",
    derivation: pin.derivation,
  }
  if (observed === undefined) {
    row.problem = "missing"
    return row
  }
  if (typeof pin.value === "number") {
    if (typeof observed !== "number" || !Number.isFinite(observed)) {
      row.problem = "type"
      return row
    }
    row.absDiff = Math.abs(observed - pin.value)
    // relative error is undefined against a zero reference (e.g. the 16-P
    // paramChecksRelErr gate pin, value 0 with an abs bound) — record null
    // instead of Infinity/NaN; the abs bound carries the comparison truth
    const relVsPin = pin.value === 0 ? null : row.absDiff / Math.abs(pin.value)
    if (pin.minBound === true) {
      row.bound = "min"
      row.ok = observed >= pin.value
      return row
    }
    if (pin.relTolerance !== undefined) {
      row.bound = `rel:${pin.relTolerance}`
      row.observedRelError = relVsPin
      row.ok = row.absDiff <= pin.relTolerance * Math.abs(pin.value)
      return row
    }
    const bound = pin.absTolerance ?? 0
    row.bound = `abs:${bound}`
    row.observedRelError = relVsPin
    row.ok = row.absDiff <= bound
    return row
  }
  if (typeof pin.value === "boolean" || typeof pin.value === "string") {
    row.bound = "structural"
    row.ok = observed === pin.value
    return row
  }
  // array pins (e.g. a critical path): JSON deep equality, rendered as text
  row.bound = "structural"
  row.ok = JSON.stringify(observed) === JSON.stringify(pin.value)
  return row
}

function pushDisciplineProblems(r: DisciplineCaseResult): void {
  for (const cmp of r.comparisons) {
    if (cmp.ok) continue
    if (cmp.problem === "missing") {
      r.problems.push(
        `pin ${cmp.ref === null ? "" : `${cmp.ref} `}${cmp.field}: no observed value at that location (expected ${JSON.stringify(cmp.expected)}) — ${cmp.derivation}`,
      )
    } else if (cmp.problem === "type") {
      r.problems.push(
        `pin ${cmp.ref === null ? "" : `${cmp.ref} `}${cmp.field}: observed ${JSON.stringify(cmp.observed)} is not comparable to the pinned ${JSON.stringify(cmp.expected)}`,
      )
    } else {
      r.problems.push(
        `pin ${cmp.ref === null ? "" : `${cmp.ref} `}${cmp.field} observed ${JSON.stringify(cmp.observed)} ≠ pinned ${JSON.stringify(cmp.expected)}${cmp.absDiff !== null ? ` (|Δ| ${cmp.absDiff}, rel ${cmp.observedRelError?.toExponential(3)})` : ""}${cmp.bound !== null ? ` [bound ${cmp.bound}]` : ""} — ${cmp.derivation}`,
      )
    }
  }
}

/** Run the discipline sub-expectation of one corpus case against the REAL bridge. */
async function runDisciplineChecks(
  c: CorpusCase,
  fixturePath: string,
  report: Pick<HarnessReport, "engineVersions" | "adapterHashes">,
): Promise<DisciplineCaseResult> {
  const adapter = c.adapter as DisciplineAdapter | ParametricAdapter | OcrAdapter | Pdf2takeoffAdapter

  // 16-V: the vector-takeoff kinds run their own sub-expectation machinery
  // (runs[] parameter sets, per-run double-execution byte-identity, item/text
  // locators) — hand off BEFORE the Phase-5 discipline dispatch below.
  if (adapter === "sheet" || adapter === "dxf") {
    return runTakeoffChecks(c, fixturePath, report)
  }

  // ADR-0011 Stage 1: the ADOPTED takeoff engine runs its own per-op
  // machinery (compare/annotate/export/fill, per-op determinism policy) —
  // hand off BEFORE the Phase-5 discipline dispatch below.
  if (adapter === "pdf2takeoff") {
    return runPdf2takeoffChecks(c, fixturePath, report)
  }

  // 16-P: the parametric-rebuild kind runs its own sub-expectation machinery
  // (runs[] mode+parameter sets, per-run double-execution with GEOMETRY-
  // PROPERTY determinism — the 16-R3 OCCT-timestamp finding — and per-run
  // refusal substrings on error cases) — hand off BEFORE the Phase-5
  // discipline dispatch below.
  if (adapter === "parametric") {
    return runParametricChecks(c, fixturePath, report)
  }

  // 16-B: the sheet-text OCR kind runs its own sub-expectation machinery
  // (the vendored sha-pinned model, runs[] parameter sets, per-run
  // double-execution word-list identity, ordered expectedWords pins with
  // conf floors + the Ø-rule rows) — hand off BEFORE the Phase-5 dispatch.
  if (adapter === "ocr") {
    return runOcrChecks(c, fixturePath, report)
  }

  const block = c[adapter] as DisciplineExpectation
  const r: DisciplineCaseResult = {
    adapter,
    expect: block.expect,
    status: "fail",
    determinism: null,
    comparisons: [],
    problems: [],
  }

  if (block.expect === "error") {
    let caught: unknown
    try {
      if (adapter === "femesh") {
        await feMeshFromFile(fixturePath, block.kind ?? "step", block.parameters ?? {})
      } else if (adapter === "powerflow") {
        await runPowerflowFromFile(fixturePath)
      } else if (adapter === "des") {
        await runDesFromFile(fixturePath)
      } else if (adapter === "fea") {
        await runFeaFromFile(fixturePath, block.parameters ?? {})
      } else if (adapter === "transport") {
        await runTransportFromFile(fixturePath, block.parameters ?? {})
      } else if (adapter === "chip") {
        await runRtlSynthesisFromFile(fixturePath, {})
      } else if (adapter === "swmm") {
        await runSwmmFromFile(fixturePath, block.parameters ?? {})
      } else {
        r.problems.push(`adapter "${adapter}" has no error-case bridge path (honest harness bug — fix the manifest)`)
        r.status = "fail"
        return r
      }
    } catch (err) {
      caught = err
    }
    r.errorContains = block.errorContains
    if (caught === undefined) {
      r.problems.push(
        `expected the ${adapter} bridge to throw an EngineUnavailableError containing ${JSON.stringify(block.errorContains)}, but the run succeeded`,
      )
    } else if (!(caught instanceof EngineUnavailableError)) {
      r.problems.push(
        `expected an EngineUnavailableError containing ${JSON.stringify(block.errorContains)}, got ${typeof caught === "object" && caught !== null ? (caught as Error).constructor.name : typeof caught}: ${String(caught)}`,
      )
    } else {
      r.errorObserved = caught.message
      if (!caught.message.includes(block.errorContains ?? "")) {
        r.problems.push(
          `error message does not contain the pinned substring ${JSON.stringify(block.errorContains)}: ${caught.message}`,
        )
      }
    }
    r.status = r.problems.length === 0 ? "pass" : "fail"
    return r
  }

  // expect === "success"
  const sourceName = c.fixture
  try {
    if (adapter === "femesh") {
      let params: FeMeshParameters
      try {
        params = block.parameters ? validateFeMeshParameters(block.parameters) : defaultFeMeshParameters()
      } catch (err) {
        r.problems.push(`manifest femesh parameters failed bridge validation: ${(err as Error).message}`)
        r.status = "fail"
        return r
      }
      const first = await feMeshFromFile(fixturePath, block.kind ?? "step", block.parameters ?? {})
      const second = await feMeshFromFile(fixturePath, block.kind ?? "step", block.parameters ?? {})
      report.engineVersions[first.engineKey] = first.engineVersion
      report.adapterHashes[first.adapterScript] = first.adapterHash
      r.engine = {
        engineKey: first.engineKey,
        engineVersion: first.engineVersion,
        adapterScript: first.adapterScript,
        adapterHash: first.adapterHash,
      }
      const documentOf = (res: FeMeshResult) =>
        buildFeMeshDocument(
          sourceName,
          { engineKey: res.engineKey, engineVersion: res.engineVersion, adapterScript: res.adapterScript },
          params,
          res,
        )
      r.determinism = documentOf(first) === documentOf(second)
      if (!r.determinism) {
        r.problems.push("two consecutive real runs produced different eos-femesh/1 document bytes — the stored artifact would not be byte-deterministic")
      }
      for (const pin of block.pins ?? []) {
        r.comparisons.push(compareDisciplinePin(pin, femeshObserved(first, pin)))
      }
    } else if (adapter === "powerflow") {
      const first = await runPowerflowFromFile(fixturePath)
      const second = await runPowerflowFromFile(fixturePath)
      report.engineVersions[first.engineKey] = first.engineVersion
      report.adapterHashes[first.adapterScript] = first.adapterHash
      r.engine = {
        engineKey: first.engineKey,
        engineVersion: first.engineVersion,
        adapterScript: first.adapterScript,
        adapterHash: first.adapterHash,
      }
      const documentOf = (res: PowerflowResult) => buildPowerflowDocument(sourceName, res)
      r.determinism = documentOf(first) === documentOf(second)
      if (!r.determinism) {
        r.problems.push("two consecutive real runs produced different eos-powerflow/1 document bytes — the stored artifact would not be byte-deterministic")
      }
      for (const pin of block.pins ?? []) {
        r.comparisons.push(compareDisciplinePin(pin, powerflowObserved(first, pin)))
      }
    } else if (adapter === "des") {
      const first = await runDesFromFile(fixturePath)
      const second = await runDesFromFile(fixturePath)
      report.engineVersions[first.engineKey] = first.engineVersion
      report.adapterHashes[first.adapterScript] = first.adapterHash
      r.engine = {
        engineKey: first.engineKey,
        engineVersion: first.engineVersion,
        adapterScript: first.adapterScript,
        adapterHash: first.adapterHash,
      }
      const documentOf = (res: DesResult) => buildDesDocument(sourceName, res)
      r.determinism = documentOf(first) === documentOf(second)
      if (!r.determinism) {
        r.problems.push("two consecutive real runs produced different eos-des/1 document bytes — the stored artifact would not be byte-deterministic")
      }
      for (const pin of block.pins ?? []) {
        r.comparisons.push(compareDisciplinePin(pin, desObserved(first, pin)))
      }
    } else if (adapter === "fea") {
      let params: FeaParameters
      try {
        params = validateFeaParameters(block.parameters ?? {})
      } catch (err) {
        r.problems.push(`manifest fea parameters failed bridge validation: ${(err as Error).message}`)
        r.status = "fail"
        return r
      }
      const first = await runFeaFromFile(fixturePath, block.parameters ?? {})
      const second = await runFeaFromFile(fixturePath, block.parameters ?? {})
      report.engineVersions[first.engineKey] = first.engineVersion
      report.adapterHashes[first.adapterScript] = first.adapterHash
      r.engine = {
        engineKey: first.engineKey,
        engineVersion: first.engineVersion,
        adapterScript: first.adapterScript,
        adapterHash: first.adapterHash,
      }
      const documentOf = (res: FeaResult) => buildFeaDocument(sourceName, res)
      r.determinism = documentOf(first) === documentOf(second)
      if (!r.determinism) {
        r.problems.push("two consecutive real runs produced different eos-fea/1 document bytes — the stored artifact would not be byte-deterministic")
      }
      for (const pin of block.pins ?? []) {
        r.comparisons.push(compareDisciplinePin(pin, feaObserved(first, pin)))
      }
    } else if (adapter === "transport") {
      let params: TransportParameters
      try {
        params = validateTransportParameters(block.parameters ?? {})
      } catch (err) {
        r.problems.push(`manifest transport parameters failed bridge validation: ${(err as Error).message}`)
        r.status = "fail"
        return r
      }
      const first = await runTransportFromFile(fixturePath, block.parameters ?? {})
      const second = await runTransportFromFile(fixturePath, block.parameters ?? {})
      report.engineVersions[first.engineKey] = first.engineVersion
      report.adapterHashes[first.adapterScript] = first.adapterHash
      r.engine = {
        engineKey: first.engineKey,
        engineVersion: first.engineVersion,
        adapterScript: first.adapterScript,
        adapterHash: first.adapterHash,
      }
      const documentOf = (res: TransportResult) => buildTransportDocument(sourceName, res)
      r.determinism = documentOf(first) === documentOf(second)
      if (!r.determinism) {
        r.problems.push("two consecutive real runs produced different eos-cfd-transport/1 document bytes — the stored artifact would not be byte-deterministic")
      }
      for (const pin of block.pins ?? []) {
        r.comparisons.push(compareDisciplinePin(pin, transportObserved(first, pin)))
      }
    } else if (adapter === "chip") {
      const first = await runRtlSynthesisFromFile(fixturePath, {})
      const second = await runRtlSynthesisFromFile(fixturePath, {})
      report.engineVersions[first.engineKey] = first.engineVersion
      report.adapterHashes[first.adapterScript] = first.adapterHash
      r.engine = {
        engineKey: first.engineKey,
        engineVersion: first.engineVersion,
        adapterScript: first.adapterScript,
        adapterHash: first.adapterHash,
      }
      const documentOf = (res: RtlResult) => buildRtlDocument(sourceName, res)
      r.determinism = documentOf(first) === documentOf(second)
      if (!r.determinism) {
        r.problems.push("two consecutive real runs produced different eos-chip-netlist/1 document bytes — the stored artifact would not be byte-deterministic")
      }
      for (const pin of block.pins ?? []) {
        r.comparisons.push(compareDisciplinePin(pin, chipObserved(first, pin)))
      }
    } else if (adapter === "swmm") {
      let params: SwmmParameters
      try {
        params = validateSwmmParameters(block.parameters ?? {})
      } catch (err) {
        r.problems.push(`manifest swmm parameters failed bridge validation: ${(err as Error).message}`)
        r.status = "fail"
        return r
      }
      const first = await runSwmmFromFile(fixturePath, block.parameters ?? {})
      const second = await runSwmmFromFile(fixturePath, block.parameters ?? {})
      report.engineVersions[first.engineKey] = first.engineVersion
      report.adapterHashes[first.adapterScript] = first.adapterHash
      r.engine = {
        engineKey: first.engineKey,
        engineVersion: first.engineVersion,
        adapterScript: first.adapterScript,
        adapterHash: first.adapterHash,
      }
      const documentOf = (res: SwmmResult) => buildSwmmDocument(sourceName, res)
      r.determinism = documentOf(first) === documentOf(second)
      if (!r.determinism) {
        r.problems.push("two consecutive real runs produced different eos-swmm/1 document bytes — the stored artifact would not be byte-deterministic")
      }
      for (const pin of block.pins ?? []) {
        r.comparisons.push(compareDisciplinePin(pin, swmmObserved(first, pin)))
      }
    } else if (adapter === "cpm") {
      // The EXACT pure pipeline the analyze_schedule broker core runs — the
      // DB-backed op path stays with the routes/e2e (recorded in the note).
      const doc = JSON.parse(readFileSync(fixturePath, "utf-8"))
      if (!isPlainObject(doc)) {
        r.problems.push(`fixture ${c.fixture} is not a JSON object`)
        r.status = "fail"
        return r
      }
      const schedule = validateScheduleDocument(doc)
      if (!schedule.ok) {
        r.problems.push(`the stored schedule failed the §3.1 defense: ${schedule.error}`)
        r.status = "fail"
        return r
      }
      const analysisFirst = analyzeCpm(schedule.value)
      if (!analysisFirst.ok) {
        r.problems.push(`analyzeCpm refused the schedule: ${analysisFirst.error}`)
        r.status = "fail"
        return r
      }
      const analysisSecond = analyzeCpm(schedule.value)
      if (!analysisSecond.ok) {
        r.problems.push(`analyzeCpm refused the schedule on the second run: ${analysisSecond.error}`)
        r.status = "fail"
        return r
      }
      const first = buildCpmAnalysisDocument(sourceName, analysisFirst.value)
      const second = buildCpmAnalysisDocument(sourceName, analysisSecond.value)
      r.determinism = first === second
      if (!r.determinism) {
        r.problems.push("two consecutive pure-core runs produced different eos-cpm/1 document bytes")
      }
      // the honest record: a platform core ran — NO engine identity exists
      r.engine = null
      const activities = analysisFirst.value
      const activityById = new Map(activities.activities.map((a) => [a.id, a]))
      const cpmObserved = (pin: DisciplinePin): unknown => {
        switch (pin.field) {
          case "durationDays":
            return activities.durationDays
          case "criticalPath":
            return activities.criticalPath
          case "criticalPathCount":
            return activities.criticalPath.length
          case "activityCount":
            return activities.activities.length
          case "formatOk":
            return first.startsWith(`{"format":"eos-cpm/1","sourceArtifactName":"${sourceName}",`)
          case "engineKeyAbsent":
            return !first.includes("engineKey") && !first.includes("adapterScript")
          default: {
            if (pin.ref === null) return undefined
            const activity = activityById.get(pin.ref)
            if (activity === undefined) return undefined
            const record = activity as unknown as Record<string, unknown>
            return record[pin.field]
          }
        }
      }
      for (const pin of block.pins ?? []) {
        r.comparisons.push(compareDisciplinePin(pin, cpmObserved(pin)))
      }
    } else {
      // libreoffice — ONE real conversion; byte-determinism NOT claimed (§5.4:
      // PDFs embed creation timestamps) and honestly reported as null
      const first = await convertDocumentToFile(fixturePath, c.fixture)
      report.engineVersions[first.engineKey] = first.engineVersion
      report.adapterHashes[first.adapterScript] = first.adapterHash
      r.engine = {
        engineKey: first.engineKey,
        engineVersion: first.engineVersion,
        adapterScript: first.adapterScript,
        adapterHash: first.adapterHash,
      }
      r.determinism = null // honest: not asserted, never faked (single run)
      for (const pin of block.pins ?? []) {
        r.comparisons.push(compareDisciplinePin(pin, libreOfficeObserved(first, pin)))
      }
    }
  } catch (err) {
    r.problems.push(
      `expected a successful ${adapter} run but the bridge threw: ${err instanceof EngineUnavailableError ? err.message : String(err)}`,
    )
    r.status = "fail"
    return r
  }

  pushDisciplineProblems(r)
  r.status = r.problems.length === 0 ? "pass" : "fail"
  return r
}

// ---------------------------------------------------------------------------
// Takeoff checks (16-V — Slice 15 vector-takeoff lane; REAL pdfplumber/ezdxf
// bridges, hand-derived pins from the fixture builders' analytic truth,
// per-run byte-determinism on the adapter RESULT payload, fixture-bytes and
// fixture-regen probes)
// ---------------------------------------------------------------------------

/** Parse a takeoff item-locator ref: "<type>@<x>,<y>" → the item's first point. */
function takeoffItem<T extends { type: string; pts: number[][] }>(
  items: T[],
  ref: string,
): T | undefined {
  const at = ref.indexOf("@")
  if (at <= 0) return undefined
  const type = ref.slice(0, at)
  const [xs, ys] = ref.slice(at + 1).split(",")
  const x = Number(xs)
  const y = Number(ys)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined
  return items.find(
    (i) =>
      i.type === type &&
      Math.abs(i.pts[0][0] - x) <= 1e-6 &&
      Math.abs(i.pts[0][1] - y) <= 1e-6,
  )
}

/** Resolve a pin's observed value on a sheet-takeoff result (16-V fields). */
function sheetTakeoffObserved(r: SheetTakeoffResult, pin: DisciplinePin, extras: Record<string, unknown>): unknown {
  switch (pin.field) {
    case "engineKey":
      return r.engineKey
    case "engineVersion":
      return r.engineVersion
    case "pageCount":
      return r.pageCount
    case "pageNo":
      return r.pageNo
    case "scaleMmPerPt":
      return r.scaleMmPerPt
    case "flattenSegments":
      return r.flattenSegments
    case "widthPt":
      return r.page.widthPt
    case "heightPt":
      return r.page.heightPt
    case "linesCount":
      return r.entities.lines.count
    case "rectsCount":
      return r.entities.rects.count
    case "curvesCount":
      return r.entities.curves.count
    case "linesTotalLengthMm":
      return r.entities.lines.totalLengthMm
    case "rectsTotalPerimeterMm":
      return r.entities.rects.totalPerimeterMm
    case "rectsTotalAreaMm2":
      return r.entities.rects.totalAreaMm2
    case "curvesTotalLengthMm":
      return r.entities.curves.totalLengthMm
    case "curvesTotalClosedAreaMm2":
      return r.entities.curves.totalClosedAreaMm2
    case "itemCount":
      return r.items.length
    case "textCount":
      return r.text.length
    case "textContains":
      // pin.ref = the substring (case-insensitive contains, 16-R1(c))
      if (pin.ref === null) return undefined
      return r.text.some((t) =>
        (t as { str?: unknown }).str?.toString().toLowerCase().includes(pin.ref!.toLowerCase()),
      )
    case "fixtureSha256":
      return extras.fixtureSha256
    default: {
      // item-locator fields: "<type>@<x>,<y>" refs into the sorted items array
      if (pin.ref === null) return undefined
      const item = takeoffItem(r.items as Array<{ type: string; pts: number[][] }>, pin.ref)
      if (item === undefined) return undefined
      const record = item as Record<string, unknown>
      if (pin.field === "itemLengthMm") return record.lengthMm
      if (pin.field === "itemPerimeterMm") return record.perimeterMm
      if (pin.field === "itemAreaMm2") return record.areaMm2
      if (pin.field === "itemClosedAreaMm2") return record.closedAreaMm2
      if (pin.field === "itemStroke") return record.stroke
      if (pin.field === "itemFill") return record.fill
      if (pin.field === "itemPtsCount") return (record.pts as number[][]).length
      return undefined
    }
  }
}

/** Resolve a pin's observed value on a dxf-takeoff result (16-V fields). */
function dxfTakeoffObserved(r: DxfTakeoffResult, pin: DisciplinePin, extras: Record<string, unknown>): unknown {
  switch (pin.field) {
    case "engineKey":
      return r.engineKey
    case "engineVersion":
      return r.engineVersion
    case "unitsMm":
      return r.unitsMm
    case "layerCount":
      return r.layerCount
    case "entityCount":
      return r.entityCount
    case "fixtureSha256":
      return extras.fixtureSha256
    case "fixtureRegenByteIdentical":
      return extras.fixtureRegenByteIdentical
    default: {
      // per-layer fields: pin.ref = the layer name
      if (pin.ref === null) return undefined
      const layer = r.layers.find((l) => l.name === pin.ref)
      if (layer === undefined) return undefined
      switch (pin.field) {
        case "layerLinesCount":
          return layer.counts.lines
        case "layerPolylinesCount":
          return layer.counts.polylines
        case "layerArcsCount":
          return layer.counts.arcs
        case "layerCirclesCount":
          return layer.counts.circles
        case "layerOthersCount":
          return layer.counts.others
        case "layerTotalLengthMm":
          return layer.totalLengthMm
        case "layerTotalClosedAreaMm2":
          return layer.totalClosedAreaMm2
        default:
          return undefined
      }
    }
  }
}

/**
 * Compute the case-level takeoff extras LAZILY (only when a pin references
 * them): the committed fixture's sha256, and — for dxf cases — the
 * byte-deterministic REGENERATION probe (run make_fixture_takeoff_room.py
 * twice into temp files, require both outputs byte-identical AND identical
 * to the committed fixture; the probe never touches the committed file).
 */
function takeoffCaseExtras(
  c: CorpusCase,
  fixturePath: string,
  block: TakeoffExpectation,
  problems: string[],
): Record<string, unknown> {
  const needed = new Set<string>()
  for (const run of block.runs ?? []) {
    for (const pin of run.pins ?? []) needed.add(pin.field)
  }
  const extras: Record<string, unknown> = {}
  if (needed.has("fixtureSha256")) {
    extras.fixtureSha256 = createHash("sha256").update(readFileSync(fixturePath)).digest("hex")
  }
  if (needed.has("fixtureRegenByteIdentical")) {
    // dxf only — the committed fixture must be reproducible byte-for-byte
    const generator = adapterScriptPath("make_fixture_takeoff_room.py")
    const tmp = mkdtempSync(path.join(os.tmpdir(), "eos-takeoff-regen-"))
    try {
      const outs: Buffer[] = []
      for (let i = 0; i < 2; i++) {
        const outPath = path.join(tmp, `regen-${i}.dxf`)
        const res = spawnSync(PYTHON_BIN, [generator, "--out", outPath], { timeout: 120_000 })
        if (res.status !== 0) {
          problems.push(
            `fixture regen probe failed (exit ${String(res.status)}): ${String(res.stderr).slice(-300)}`,
          )
          extras.fixtureRegenByteIdentical = false
          return extras
        }
        outs.push(readFileSync(outPath))
      }
      const committed = readFileSync(fixturePath)
      extras.fixtureRegenByteIdentical =
        outs[0].equals(outs[1]) && outs[0].equals(committed)
      if (extras.fixtureRegenByteIdentical !== true) {
        problems.push(
          "fixture regen probe: two fresh make_fixture_takeoff_room.py runs are not byte-identical to each other " +
            "and to the committed fixture — the byte-determinism claim is broken (reconcile the fixture, the " +
            "generator and the engine pin together)",
        )
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }
  return extras
}

/** Run the takeoff sub-expectation of one corpus case against the REAL bridge (16-V). */
async function runTakeoffChecks(
  c: CorpusCase,
  fixturePath: string,
  report: Pick<HarnessReport, "engineVersions" | "adapterHashes">,
): Promise<DisciplineCaseResult> {
  const adapter = c.adapter as TakeoffAdapter
  const block = (adapter === "sheet" ? c.sheet : c.dxf) as TakeoffExpectation
  const r: DisciplineCaseResult = {
    adapter,
    expect: block.expect,
    status: "fail",
    determinism: null,
    comparisons: [],
    problems: [],
  }

  if (block.expect === "error") {
    const runs = block.runs ?? [{ parameters: {} }]
    r.errorContains = block.errorContains
    for (const run of runs) {
      let caught: unknown
      try {
        if (adapter === "sheet") {
          await sheetTakeoffFromStorage(
            fixturePath,
            (run.parameters ?? {}) as { pageNo?: number; scaleMmPerPt?: number; flattenSegments?: number },
          )
        } else {
          await dxfTakeoffFromStorage(fixturePath, (run.parameters ?? {}) as { layerFilter?: string[] })
        }
      } catch (err) {
        caught = err
      }
      if (caught === undefined) {
        r.problems.push(
          `expected the ${adapter} takeoff bridge to throw an EngineUnavailableError containing ${JSON.stringify(block.errorContains)}, but the run succeeded`,
        )
      } else if (!(caught instanceof EngineUnavailableError)) {
        r.problems.push(
          `expected an EngineUnavailableError containing ${JSON.stringify(block.errorContains)}, got ${typeof caught === "object" && caught !== null ? (caught as Error).constructor.name : typeof caught}: ${String(caught)}`,
        )
      } else {
        r.errorObserved = caught.message
        if (!caught.message.includes(block.errorContains ?? "")) {
          r.problems.push(
            `error message does not contain the pinned substring ${JSON.stringify(block.errorContains)}: ${caught.message}`,
          )
        }
      }
    }
    r.status = r.problems.length === 0 ? "pass" : "fail"
    return r
  }

  // expect === "success": every run executes TWICE; the adapter RESULT payload
  // (the exact object the broker would store) must be byte-identical across
  // the two runs — the §2 document builder lands with the TL's broker
  // integration, so the result payload is the honest determinism unit here.
  const extras = takeoffCaseExtras(c, fixturePath, block, r.problems)
  let determinismAll = true
  let engineRecorded = false
  for (const [runIndex, run] of (block.runs ?? []).entries()) {
    const call = () =>
      adapter === "sheet"
        ? sheetTakeoffFromStorage(
            fixturePath,
            (run.parameters ?? {}) as { pageNo?: number; scaleMmPerPt?: number; flattenSegments?: number },
          )
        : dxfTakeoffFromStorage(fixturePath, (run.parameters ?? {}) as { layerFilter?: string[] })
    let first: SheetTakeoffResult | DxfTakeoffResult
    let second: SheetTakeoffResult | DxfTakeoffResult
    try {
      first = await call()
      second = await call()
    } catch (err) {
      r.problems.push(
        `expected a successful ${adapter} takeoff run but the bridge threw: ${err instanceof EngineUnavailableError ? err.message : String(err)}`,
      )
      r.status = "fail"
      return r
    }
    if (!engineRecorded) {
      engineRecorded = true
      report.engineVersions[first.engineKey] = first.engineVersion
      report.adapterHashes[first.adapterScript] = first.adapterHash
      r.engine = {
        engineKey: first.engineKey,
        engineVersion: first.engineVersion,
        adapterScript: first.adapterScript,
        adapterHash: first.adapterHash,
      }
    }
    const runDeterministic = JSON.stringify(first) === JSON.stringify(second)
    if (!runDeterministic) {
      determinismAll = false
      r.problems.push(
        `run ${runIndex} (parameters ${JSON.stringify(run.parameters ?? {})}): two consecutive real runs produced different adapter result JSON — vector takeoff is not byte-deterministic`,
      )
    }
    for (const pin of run.pins ?? []) {
      const observed =
        adapter === "sheet"
          ? sheetTakeoffObserved(first as SheetTakeoffResult, pin, extras)
          : dxfTakeoffObserved(first as DxfTakeoffResult, pin, extras)
      r.comparisons.push(compareDisciplinePin(pin, observed))
    }
  }
  r.determinism = determinismAll
  pushDisciplineProblems(r)
  r.status = r.problems.length === 0 ? "pass" : "fail"
  return r
}

// ---------------------------------------------------------------------------
// pdf2takeoff checks (ADR-0011 Stage 1 — the ADOPTED takeoff engine at the
// pinned commit; the REAL arm's-length bridge over the committed fixtures,
// hand-derived analytic pins from the A-102 closed forms, per-op determinism
// policy: compare = result-JSON identity, export = CSV row identity, fill =
// value/vertices identity, annotate = NOT claimed (creation timestamp — the
// LibreOffice §5.4 convention, structural evidence only))
// ---------------------------------------------------------------------------

/** Resolve a pin's observed value on a compare result. */
function pdf2takeoffCompareObserved(r: Pdf2takeoffCompareResult, pin: DisciplinePin): unknown {
  if (pin.ref !== null && pin.ref.startsWith("page:")) {
    const page = Number(pin.ref.slice(5))
    const sheet = r.sheets.find((s) => s.page === page)
    if (sheet === undefined) return undefined
    if (pin.field === "changedFraction") return sheet.changedFraction
    if (pin.field === "changed") return sheet.changed
    if (pin.field === "regionCount") return sheet.regions.length
    if (pin.field === "vectorIdentical") return sheet.vector?.identical
    return undefined
  }
  switch (pin.field) {
    case "comparedSheets":
      return r.comparedSheets
    case "changedSheetCount":
      return r.changedSheets.length
    case "summary.changed":
      return r.summary.changed
    case "summary.unchanged":
      return r.summary.unchanged
    case "summary.onlyInA":
      return r.summary.onlyInA
    case "summary.onlyInB":
      return r.summary.onlyInB
    default:
      return undefined
  }
}

/** Resolve a pin's observed value on an annotate result. */
function pdf2takeoffAnnotateObserved(r: Pdf2takeoffAnnotateResult, pin: DisciplinePin): unknown {
  switch (pin.field) {
    case "markupCount":
      return r.markupCount
    case "kept":
      return r.kept
    case "isPdf":
      return r.pdfBytes.subarray(0, 5).toString("latin1") === "%PDF-"
    case "sizeBytes":
      return r.pdfBytes.byteLength
    default:
      return undefined
  }
}

/** Resolve a pin's observed value on an export result. */
function pdf2takeoffExportObserved(r: Pdf2takeoffExportResult, pin: DisciplinePin): unknown {
  if (pin.ref !== null && pin.ref.startsWith("label:")) {
    const label = pin.ref.slice(6)
    const row = r.rows.find((row) => row.label === label)
    if (row === undefined) return undefined
    if (pin.field === "value") return row.value
    if (pin.field === "unit") return row.unit
    if (pin.field === "type") return row.type
    return undefined
  }
  switch (pin.field) {
    case "rowCount":
      return r.rows.length
    case "isXlsx":
      return r.xlsxBytes !== null && r.xlsxBytes.subarray(0, 2).toString("latin1") === "PK"
    case "sizeBytes":
      return r.xlsxBytes?.byteLength ?? r.csv?.length ?? undefined
    default:
      return undefined
  }
}

/** Resolve a pin's observed value on a fill result. */
function pdf2takeoffFillObserved(r: Pdf2takeoffFillResult, pin: DisciplinePin): unknown {
  switch (pin.field) {
    case "value":
      return r.value
    case "vertices":
      return r.vertices
    case "unit":
      return r.unit
    case "calibrated":
      return r.calibrated
    case "bboxX0":
      return r.bbox?.[0]
    case "bboxY0":
      return r.bbox?.[1]
    case "bboxX1":
      return r.bbox?.[2]
    case "bboxY1":
      return r.bbox?.[3]
    default:
      return undefined
  }
}

/** The per-op determinism comparison (NEVER full-JSON for annotate/fill). */
function pdf2takeoffDeterminismWitness(
  op: Pdf2takeoffOp,
  a: Pdf2takeoffCompareResult | Pdf2takeoffAnnotateResult | Pdf2takeoffExportResult | Pdf2takeoffFillResult,
  b: Pdf2takeoffCompareResult | Pdf2takeoffAnnotateResult | Pdf2takeoffExportResult | Pdf2takeoffFillResult,
): { deterministic: boolean; witness: string } {
  if (op === "compare") {
    return { deterministic: JSON.stringify(a) === JSON.stringify(b), witness: "compare result JSON identity" }
  }
  if (op === "export") {
    const ra = a as Pdf2takeoffExportResult
    const rb = b as Pdf2takeoffExportResult
    return {
      deterministic: JSON.stringify(ra.rows) === JSON.stringify(rb.rows) && ra.csv === rb.csv,
      witness: "export CSV row identity",
    }
  }
  if (op === "fill") {
    const fa = a as Pdf2takeoffFillResult
    const fb = b as Pdf2takeoffFillResult
    return {
      deterministic:
        fa.value === fb.value && fa.vertices === fb.vertices && JSON.stringify(fa.bbox) === JSON.stringify(fb.bbox),
      witness: "fill value/vertices/bbox identity (the markup id carries a random suffix — excluded honestly)",
    }
  }
  return { deterministic: false, witness: "annotate output embeds a creation timestamp — byte-determinism NOT claimed (§5.4)" }
}

/** Run the pdf2takeoff sub-expectation of one corpus case against the REAL bridge. */
async function runPdf2takeoffChecks(
  c: CorpusCase,
  fixturePath: string,
  report: Pick<HarnessReport, "engineVersions" | "adapterHashes">,
): Promise<DisciplineCaseResult> {
  const block = c.pdf2takeoff as Pdf2takeoffExpectation
  const r: DisciplineCaseResult = {
    adapter: "pdf2takeoff",
    expect: block.expect,
    status: "fail",
    determinism: null,
    comparisons: [],
    problems: [],
  }

  const otherPath = block.op === "compare" ? path.join(FIXTURES_DIR, block.otherFixture as string) : null
  if (otherPath !== null && !existsSync(otherPath)) {
    r.problems.push(`otherFixture file not found: ${block.otherFixture}`)
    r.status = "fail"
    return r
  }

  const callOp = async (
    params: Record<string, unknown>,
  ): Promise<Pdf2takeoffCompareResult | Pdf2takeoffAnnotateResult | Pdf2takeoffExportResult | Pdf2takeoffFillResult> => {
    if (block.op === "compare") {
      return pdf2takeoffCompareRevisions(fixturePath, otherPath as string)
    }
    if (block.op === "annotate") {
      return pdf2takeoffAnnotateTakeoff(fixturePath, {
        markups: params.markups,
        ...(params.keepExisting === true ? { keepExisting: true } : {}),
      })
    }
    if (block.op === "export") {
      // the round-trip product loop: a spec parameter annotates to a temp
      // PDF first, then exports from it — exactly what the broker ops chain
      let sourcePath = fixturePath
      const tmpdir = mkdtempSync(path.join(os.tmpdir(), "eos-p2t-case-"))
      try {
        if (Array.isArray(params.spec)) {
          const annotated = await pdf2takeoffAnnotateTakeoff(fixturePath, { markups: params.spec })
          sourcePath = path.join(tmpdir, "annotated.pdf")
          writeFileSync(sourcePath, annotated.pdfBytes)
        }
        return await pdf2takeoffExportTakeoff(sourcePath, {
          ...(typeof params.scaleRatio === "string" ? { scaleRatio: params.scaleRatio } : {}),
          ...(typeof params.unit === "string" ? { unit: params.unit } : {}),
          ...(params.format === "xlsx" || params.format === "csv" ? { format: params.format } : {}),
        })
      } finally {
        rmSync(tmpdir, { recursive: true, force: true })
      }
    }
    // fill
    return pdf2takeoffFillRoom(fixturePath, {
      ...(typeof params.pageNo === "number" ? { pageNo: params.pageNo } : {}),
      at: params.at as [number, number],
      ...(typeof params.label === "string" ? { label: params.label } : {}),
      scaleMmPerPt: params.scaleMmPerPt as number,
    })
  }

  if (block.expect === "error") {
    for (const run of block.runs ?? []) {
      let caught: unknown
      try {
        await callOp(run.parameters ?? {})
      } catch (err) {
        caught = err
      }
      const wanted = run.errorContains ?? block.errorContains
      if (caught === undefined) {
        r.problems.push(
          `expected the pdf2takeoff ${block.op} bridge to throw an EngineUnavailableError containing ${JSON.stringify(wanted)}, but the run succeeded`,
        )
      } else if (!(caught instanceof EngineUnavailableError)) {
        r.problems.push(
          `expected an EngineUnavailableError containing ${JSON.stringify(wanted)}, got ${typeof caught === "object" && caught !== null ? (caught as Error).constructor.name : typeof caught}: ${String(caught)}`,
        )
      } else {
        r.errorObserved = caught.message
        if (wanted !== undefined && !caught.message.includes(wanted)) {
          r.problems.push(`error message does not contain the pinned substring ${JSON.stringify(wanted)}: ${caught.message}`)
        }
      }
    }
    r.status = r.problems.length === 0 ? "pass" : "fail"
    return r
  }

  // expect === "success": every run executes TWICE under the op's determinism
  // policy (annotate: single run — the double-run would compare timestamps,
  // so structural evidence only, determinism honestly null)
  let determinismAll = true
  let engineRecorded = false
  for (const [runIndex, run] of (block.runs ?? []).entries()) {
    let first: Pdf2takeoffCompareResult | Pdf2takeoffAnnotateResult | Pdf2takeoffExportResult | Pdf2takeoffFillResult
    try {
      first = await callOp(run.parameters ?? {})
    } catch (err) {
      r.problems.push(
        `expected a successful pdf2takeoff ${block.op} run but the bridge threw: ${err instanceof EngineUnavailableError ? err.message : String(err)}`,
      )
      r.status = "fail"
      return r
    }
    if (!engineRecorded) {
      engineRecorded = true
      report.engineVersions[first.engineKey] = first.engineVersion
      report.adapterHashes[first.adapterScript] = first.adapterHash
      r.engine = {
        engineKey: first.engineKey,
        engineVersion: first.engineVersion,
        adapterScript: first.adapterScript,
        adapterHash: first.adapterHash,
      }
    }
    if (block.op === "annotate") {
      // single run — the §5.4 timestamp finding (structural pins only)
      r.determinism = null
    } else {
      let second: Pdf2takeoffCompareResult | Pdf2takeoffAnnotateResult | Pdf2takeoffExportResult | Pdf2takeoffFillResult
      try {
        second = await callOp(run.parameters ?? {})
      } catch (err) {
        r.problems.push(
          `run ${runIndex}: the SECOND determinism execution threw: ${err instanceof EngineUnavailableError ? err.message : String(err)}`,
        )
        determinismAll = false
        second = first
      }
      const witness = pdf2takeoffDeterminismWitness(block.op, first, second)
      if (!witness.deterministic) {
        determinismAll = false
        r.problems.push(
          `run ${runIndex} (parameters ${JSON.stringify(run.parameters ?? {})}): two consecutive real runs broke the determinism policy (${witness.witness})`,
        )
      }
      r.determinism = determinismAll
    }
    for (const pin of run.pins ?? []) {
      const observed =
        block.op === "compare"
          ? pdf2takeoffCompareObserved(first as Pdf2takeoffCompareResult, pin)
          : block.op === "annotate"
            ? pdf2takeoffAnnotateObserved(first as Pdf2takeoffAnnotateResult, pin)
            : block.op === "export"
              ? pdf2takeoffExportObserved(first as Pdf2takeoffExportResult, pin)
              : pdf2takeoffFillObserved(first as Pdf2takeoffFillResult, pin)
      r.comparisons.push(compareDisciplinePin(pin, observed))
    }
  }
  pushDisciplineProblems(r)
  r.status = r.problems.length === 0 ? "pass" : "fail"
  return r
}

// ---------------------------------------------------------------------------
// Parametric checks (16-P — Slice 15 parametric-authoring lane; the REAL
// cadquery bridge over the committed parametric model fixture, hand-derived
// analytic pins from the model's closed forms, per-run double-execution with
// GEOMETRY-PROPERTY determinism — never STEP-byte determinism)
// ---------------------------------------------------------------------------

function parametricIsSchemaResult(r: ParametricSchemaResult | ParametricBuildResult): r is ParametricSchemaResult {
  return "schema" in r && "defaults" in r
}

/**
 * The build-run determinism signature (16-R3 finding, pinned): OCCT stamps an
 * export timestamp into the STEP FILE_NAME header and a per-export counter
 * into PRODUCT(...), so identical parameters NEVER give byte-identical STEPs —
 * byte-comparing the artifact would be a dishonest determinism claim.
 * The signature is therefore the GEOMETRY PROPERTIES (volumeMm3, areaMm2,
 * bboxMm, centerOfMassMm, checks) plus the stable envelope fields, compared
 * for EXACT equality; `stepBytes` is deliberately absent.
 */
function parametricBuildSignature(r: ParametricBuildResult): Record<string, unknown> {
  return {
    engineKey: r.engineKey,
    engineVersion: r.engineVersion,
    adapterScript: r.adapterScript,
    adapterHash: r.adapterHash,
    modelScriptHash: r.modelScriptHash,
    paramsUsed: r.paramsUsed,
    volumeMm3: r.volumeMm3,
    areaMm2: r.areaMm2,
    bboxMm: r.bboxMm,
    centerOfMassMm: r.centerOfMassMm,
    checks: r.checks,
  }
}

/** Resolve a pin's observed value on a parametric schema/build result (16-P fields). */
function parametricObserved(r: ParametricSchemaResult | ParametricBuildResult, pin: DisciplinePin): unknown {
  switch (pin.field) {
    case "engineKey":
      return r.engineKey
    case "engineVersion":
      return r.engineVersion
    case "adapterScript":
      return r.adapterScript
    case "adapterHash":
      return r.adapterHash
    case "modelScriptHash":
      return r.modelScriptHash
    default:
      break
  }
  if (parametricIsSchemaResult(r)) {
    switch (pin.field) {
      case "schemaKeysCount": {
        const schema = r.schema as Record<string, unknown>
        const props = schema?.properties
        return isPlainObject(props) ? Object.keys(props).length : undefined
      }
      case "defaultsCount":
        return Object.keys(r.defaults).length
      default:
        return undefined
    }
  }
  switch (pin.field) {
    case "paramVolumeMm3":
      return r.volumeMm3
    case "paramAreaMm2":
      return r.areaMm2
    case "paramBboxW":
      return r.bboxMm[0]
    case "paramBboxD":
      return r.bboxMm[1]
    case "paramBboxH":
      return r.bboxMm[2]
    case "paramChecksRelErr":
      return r.checks.volumeRelErr
    case "paramChecksPassed":
      return r.checks.passed
    case "paramKeys":
      return Object.keys(r.paramsUsed).sort().join(",")
    case "paramCount":
      return Object.keys(r.paramsUsed).length
    default:
      return undefined
  }
}

/** Run the parametric sub-expectation of one corpus case against the REAL bridge (16-P). */
async function runParametricChecks(
  c: CorpusCase,
  fixturePath: string,
  report: Pick<HarnessReport, "engineVersions" | "adapterHashes">,
): Promise<DisciplineCaseResult> {
  const block = c.parametric as ParametricExpectation
  const r: DisciplineCaseResult = {
    adapter: "parametric",
    expect: block.expect,
    status: "fail",
    determinism: null,
    comparisons: [],
    problems: [],
  }

  if (block.expect === "error") {
    // each error run pins its OWN refusal substring (a parametric error case
    // may exercise several DISTINCT refusal shapes); the optional block-level
    // substring must appear in every message too
    r.errorContains = block.errorContains
    const observed: string[] = []
    for (const [runIndex, run] of (block.runs ?? []).entries()) {
      let caught: unknown
      try {
        if (run.mode === "schema") {
          await parametricSchemaFromStorage(fixturePath)
        } else {
          await parametricRebuildFromStorage(fixturePath, run.parameters ?? {})
        }
      } catch (err) {
        caught = err
      }
      if (caught === undefined) {
        r.problems.push(
          `run ${runIndex} (mode ${run.mode}, parameters ${JSON.stringify(run.parameters ?? {})}): expected the parametric bridge to throw an EngineUnavailableError containing ${JSON.stringify(run.errorContains)}, but the run succeeded`,
        )
        continue
      }
      if (!(caught instanceof EngineUnavailableError)) {
        r.problems.push(
          `run ${runIndex}: expected an EngineUnavailableError containing ${JSON.stringify(run.errorContains)}, got ${typeof caught === "object" && caught !== null ? (caught as Error).constructor.name : typeof caught}: ${String(caught)}`,
        )
        continue
      }
      observed.push(caught.message)
      if (!caught.message.includes(run.errorContains ?? "")) {
        r.problems.push(
          `run ${runIndex} refusal message does not contain the pinned substring ${JSON.stringify(run.errorContains)}: ${caught.message}`,
        )
      }
      if (block.errorContains !== undefined && !caught.message.includes(block.errorContains)) {
        r.problems.push(
          `run ${runIndex} refusal message does not contain the block-level substring ${JSON.stringify(block.errorContains)}: ${caught.message}`,
        )
      }
    }
    if (observed.length > 0) r.errorObserved = observed.join(" | ")
    r.status = r.problems.length === 0 ? "pass" : "fail"
    return r
  }

  // expect === "success": every run executes TWICE. Schema runs are plain
  // JSON — byte-identity across the two runs; build runs compare the
  // GEOMETRY-PROPERTY signature (the 16-R3 OCCT-timestamp finding — the STEP
  // bytes are never compared, see parametricBuildSignature).
  let determinismAll = true
  let engineRecorded = false
  for (const [runIndex, run] of (block.runs ?? []).entries()) {
    const call = () =>
      run.mode === "schema"
        ? parametricSchemaFromStorage(fixturePath)
        : parametricRebuildFromStorage(fixturePath, run.parameters ?? {})
    let first: ParametricSchemaResult | ParametricBuildResult
    let second: ParametricSchemaResult | ParametricBuildResult
    try {
      first = await call()
      second = await call()
    } catch (err) {
      r.problems.push(
        `run ${runIndex} (mode ${run.mode}, parameters ${JSON.stringify(run.parameters ?? {})}): expected a successful parametric run but the bridge threw: ${err instanceof EngineUnavailableError ? err.message : String(err)}`,
      )
      r.status = "fail"
      return r
    }
    if (!engineRecorded) {
      engineRecorded = true
      report.engineVersions[first.engineKey] = first.engineVersion
      report.adapterHashes[first.adapterScript] = first.adapterHash
      r.engine = {
        engineKey: first.engineKey,
        engineVersion: first.engineVersion,
        adapterScript: first.adapterScript,
        adapterHash: first.adapterHash,
      }
    }
    const runDeterministic =
      run.mode === "schema"
        ? JSON.stringify(first) === JSON.stringify(second)
        : JSON.stringify(parametricBuildSignature(first as ParametricBuildResult)) ===
          JSON.stringify(parametricBuildSignature(second as ParametricBuildResult))
    if (!runDeterministic) {
      determinismAll = false
      r.problems.push(
        `run ${runIndex} (mode ${run.mode}, parameters ${JSON.stringify(run.parameters ?? {})}): two consecutive real runs produced different ${run.mode === "schema" ? "schema JSON" : "geometry properties (volume/area/bbox/centerOfMass/checks)"} — the parametric rebuild is not deterministic`,
      )
    }
    for (const pin of run.pins ?? []) {
      r.comparisons.push(compareDisciplinePin(pin, parametricObserved(first, pin)))
    }
  }
  r.determinism = determinismAll
  pushDisciplineProblems(r)
  r.status = r.problems.length === 0 ? "pass" : "fail"
  return r
}

// ---------------------------------------------------------------------------
// 16-B: the OCR sub-expectation machinery (tesseract region reads over the
// COMMITTED PNG fixture with the VENDORED sha-pinned eng model)
// ---------------------------------------------------------------------------

async function runOcrChecks(
  c: CorpusCase,
  fixturePath: string,
  report: Pick<HarnessReport, "engineVersions" | "adapterHashes">,
): Promise<DisciplineCaseResult> {
  const block = c.ocr as OcrExpectation
  const r: DisciplineCaseResult = {
    adapter: "ocr",
    expect: block.expect,
    status: "fail",
    determinism: null,
    comparisons: [],
    problems: [],
  }
  const pngBytes = readFileSync(fixturePath)

  // The model pin: the vendored eng.traineddata sha256 must equal the pinned
  // value — byte-identical CI models (16-R2), recorded as a comparison row.
  const modelSha = createHash("sha256")
    .update(readFileSync(path.join(VENDORED_TESSDATA_DIR, "eng.traineddata")))
    .digest("hex")
  r.comparisons.push({
    field: "tessdata sha256",
    ref: "tests/fixtures/tessdata/eng.traineddata",
    expected: VENDORED_ENG_SHA256,
    observed: modelSha,
    unit: null,
    bound: "exact",
    absDiff: null,
    observedRelError: null,
    ok: modelSha === VENDORED_ENG_SHA256,
    problem: modelSha === VENDORED_ENG_SHA256 ? "matched" : "value",
    derivation: "the vendored eng model — byte-identical reads in CI (16-R2)",
  })
  if (modelSha !== VENDORED_ENG_SHA256) {
    r.problems.push(
      `the vendored eng.traineddata sha256 is ${modelSha}, not the pinned ${VENDORED_ENG_SHA256} — the model drifted`,
    )
  }

  if (block.expect === "error") {
    const observed: string[] = []
    for (const [runIndex, run] of (block.runs ?? []).entries()) {
      let caught: unknown
      try {
        await sheetOcrFromPng(pngBytes, {
          ...(run.parameters?.psm !== undefined ? { psm: run.parameters.psm } : {}),
          tessdataDir: VENDORED_TESSDATA_DIR,
        })
      } catch (err) {
        caught = err
      }
      if (caught === undefined) {
        r.problems.push(
          `run ${runIndex} (parameters ${JSON.stringify(run.parameters ?? {})}): expected the OCR bridge to throw an EngineUnavailableError containing ${JSON.stringify(run.errorContains)}, but the read succeeded`,
        )
        continue
      }
      if (!(caught instanceof EngineUnavailableError)) {
        r.problems.push(
          `run ${runIndex}: expected an EngineUnavailableError containing ${JSON.stringify(run.errorContains)}, got ${typeof caught === "object" && caught !== null ? (caught as Error).constructor.name : typeof caught}: ${String(caught)}`,
        )
        continue
      }
      observed.push(caught.message)
      if (!caught.message.includes(run.errorContains ?? "")) {
        r.problems.push(
          `run ${runIndex} refusal message does not contain the pinned substring ${JSON.stringify(run.errorContains)}: ${caught.message}`,
        )
      }
    }
    if (observed.length > 0) r.errorObserved = observed.join(" | ")
    r.errorContains = block.runs?.find((x) => x.errorContains !== undefined)?.errorContains
    r.status = r.problems.length === 0 ? "pass" : "fail"
    return r
  }

  // expect === "success": every run executes TWICE — the full word list
  // (text+conf+boxes, serialized) must be IDENTICAL (tesseract is
  // deterministic for identical input+model+psm — pinned, not assumed).
  let determinismAll = true
  let engineRecorded = false
  for (const [runIndex, run] of (block.runs ?? []).entries()) {
    const options = {
      ...(run.parameters?.psm !== undefined ? { psm: run.parameters.psm } : {}),
      tessdataDir: VENDORED_TESSDATA_DIR,
    }
    let first: SheetOcrResult
    let second: SheetOcrResult
    try {
      first = await sheetOcrFromPng(pngBytes, options)
      second = await sheetOcrFromPng(pngBytes, options)
    } catch (err) {
      r.problems.push(
        `run ${runIndex} (parameters ${JSON.stringify(run.parameters ?? {})}): expected a successful OCR read but the bridge threw: ${err instanceof EngineUnavailableError ? err.message : String(err)}`,
      )
      r.status = "fail"
      return r
    }
    if (!engineRecorded) {
      engineRecorded = true
      report.engineVersions[first.engineKey] = first.engineVersion
      report.adapterHashes[first.adapterScript] = first.adapterHash
      r.engine = {
        engineKey: first.engineKey,
        engineVersion: first.engineVersion,
        adapterScript: first.adapterScript,
        adapterHash: first.adapterHash,
      }
    }
    const runDeterministic = JSON.stringify(first.words) === JSON.stringify(second.words)
    if (!runDeterministic) {
      determinismAll = false
      r.problems.push(
        `run ${runIndex}: two consecutive reads produced different word lists — tesseract is not deterministic for this input+model+psm`,
      )
    }
    // The ordered expectedWords pins: exact raw text, conf ≥ floor, and the
    // Ø-rule rows must fire with exactly the pinned normalized form.
    const expected = run.expectedWords ?? []
    const observedTexts = first.words.map((w) => w.text)
    if (observedTexts.length !== expected.length) {
      r.problems.push(
        `run ${runIndex}: expected exactly ${expected.length} words (${expected.map((w) => w.text).join(", ")}) but the read produced ${observedTexts.length} (${observedTexts.join(", ")})`,
      )
    }
    for (let k = 0; k < Math.min(expected.length, observedTexts.length); k++) {
      const pin = expected[k]
      const word = first.words[k]
      const okText = word.text === pin.text
      const confFloor = pin.confFloor ?? 0
      const okConf = word.conf >= confFloor
      let okNormalized = true
      let normalizedObserved: string | null = null
      if (pin.normalized !== undefined) {
        const norm = normalizeDiameterToken(word.text)
        normalizedObserved = norm !== null ? norm.normalized : null
        okNormalized = norm !== null && norm.normalized === pin.normalized && norm.raw === word.text
      }
      r.comparisons.push({
        field: "word",
        ref: pin.normalized !== undefined ? `Ø-rule row ${k + 1}` : `word ${k + 1}`,
        expected: pin.normalized !== undefined ? `${pin.text} → ${pin.normalized} (conf ≥ ${confFloor})` : `${pin.text} (conf ≥ ${confFloor})`,
        observed:
          pin.normalized !== undefined
            ? `${word.text}${normalizedObserved !== null ? ` → ${normalizedObserved}` : ""} (conf ${word.conf.toFixed(1)})`
            : `${word.text} (conf ${word.conf.toFixed(1)})`,
        unit: null,
        bound: confFloor > 0 ? `min ${confFloor}` : "exact",
        absDiff: null,
        observedRelError: null,
        ok: okText && okConf && okNormalized,
        problem: okText && okConf && okNormalized ? "matched" : "value",
        derivation: "the live tesseract read of the committed fixture with the vendored model",
      })
      if (!okText) {
        r.problems.push(
          `run ${runIndex} word ${k + 1}: expected raw text ${JSON.stringify(pin.text)} but tesseract emitted ${JSON.stringify(word.text)}`,
        )
      }
      if (!okConf) {
        r.problems.push(
          `run ${runIndex} word ${k + 1} (${word.text}): conf ${word.conf.toFixed(1)} is below the pinned floor ${confFloor}`,
        )
      }
      if (!okNormalized && pin.normalized !== undefined) {
        r.problems.push(
          `run ${runIndex} word ${k + 1} (${word.text}): the Ø rule must produce ${JSON.stringify(pin.normalized)} (raw preserved) but produced ${JSON.stringify(normalizedObserved)}`,
        )
      }
    }
  }
  r.determinism = determinismAll
  pushDisciplineProblems(r)
  r.status = r.problems.length === 0 ? "pass" : "fail"
  return r
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

function recordEngine(result: DeriveResult, report: Pick<HarnessReport, "engineVersions" | "adapterHashes">): void {
  report.engineVersions[result.engineKey] = result.engineVersion
  report.adapterHashes[result.adapterScript] = result.adapterHash
}

/** Run the full validation harness against the REAL production bridge. Pure: no files written. */
export async function runHarness(): Promise<HarnessReport> {
  const manifest = loadManifest()
  const report: HarnessReport = {
    ranAt: new Date().toISOString(),
    pythonBin: PYTHON_BIN,
    manifestPath: path.relative(REPO_ROOT, MANIFEST_PATH),
    caseCount: manifest.length,
    environment: {
      engineAvailability: {
        step: probeEngine("step"),
        ifc: probeEngine("ifc"),
        femesh: probeEngine("femesh"),
        powerflow: probeEngine("powerflow"),
        des: probeEngine("des"),
        fea: probeEngine("fea"),
        transport: probeEngine("transport"),
        chip: probeEngine("chip"),
        swmm: probeEngine("swmm"),
        cpm: probeEngine("cpm"),
        libreoffice: probeEngine("libreoffice"),
        sheet: probeEngine("sheet"),
        dxf: probeEngine("dxf"),
        parametric: probeEngine("parametric"),
        ocr: probeEngine("ocr"),
        pdf2takeoff: probeEngine("pdf2takeoff"),
      },
    },
    engineVersions: {
      cadquery: null,
      ifcopenshell: null,
      gmsh: null,
      pandapower: null,
      simpy: null,
      "scikit-fem": null,
      sfepy: null,
      libreoffice: null,
      pdfplumber: null,
      ezdxf: null,
      pdf2takeoff: null,
    },
    adapterHashes: {
      "step_quantities.py": null,
      "ifc_quantities.py": null,
      "step_mesh.py": null,
      "ifc_mesh.py": null,
      "step_femesh.py": null,
      "powerflow.py": null,
      "des.py": null,
      "convert-document.ts": null,
      "sheet_takeoff.py": null,
      "dxf_takeoff.py": null,
      "parametric_rebuild.py": null,
      "pdf2takeoff.ts": null,
    },
    cases: [],
    summary: { total: manifest.length, pass: 0, fail: 0, skip: 0, ran: 0, notRun: false },
  }

  for (const c of manifest) {
    const fixturePath = path.join(FIXTURES_DIR, c.fixture)
    const result: CaseResult = {
      caseId: c.caseId,
      adapter: c.adapter,
      fixture: c.fixture,
      fixturePath: path.relative(REPO_ROOT, fixturePath),
      expect: c.expect,
      status: "fail",
      determinism: null,
      quantityCount: null,
      groundTruthCount: c.groundTruth ? c.groundTruth.length : null,
      comparisons: null,
      problems: [],
    }

    // Corpus integrity is engine-independent: a missing fixture is always a fail.
    if (!existsSync(fixturePath)) {
      result.problems.push(`fixture file not found: ${result.fixturePath}`)
      report.cases.push(result)
      report.summary.fail += 1
      continue
    }

    const availability = report.environment.engineAvailability[c.adapter]
    if (!availability.available) {
      result.status = "skip"
      result.skipReason = `engine unavailable for the ${c.adapter} adapter: ${availability.reason}`
      report.cases.push(result)
      report.summary.skip += 1
      continue
    }

    // W2-f: the Phase-5 discipline kinds run their own sub-expectation (REAL
    // bridge, hand-derived pins, document determinism) — everything else is
    // the step/ifc quantity+mesh machinery below.
    if (c.adapter !== "step" && c.adapter !== "ifc") {
      const discipline = await runDisciplineChecks(c, fixturePath, report)
      result.discipline = discipline
      if (discipline.status !== "pass") {
        for (const p of discipline.problems) result.problems.push(p)
      }
      result.status = discipline.status === "pass" ? "pass" : "fail"
      report.cases.push(result)
      if (result.status === "pass") report.summary.pass += 1
      else report.summary.fail += 1
      continue
    }

    let quantityOk = false
    let quantityFirst: DeriveResult | null = null
    if (c.expect === "success") {
      let first: DeriveResult
      let second: DeriveResult
      try {
        first = await deriveFromFile(fixturePath, c.adapter)
        second = await deriveFromFile(fixturePath, c.adapter)
      } catch (err) {
        result.problems.push(
          `expected a successful derivation but the bridge threw: ${
            err instanceof EngineUnavailableError ? err.message : String(err)
          }`,
        )
        report.cases.push(result)
        report.summary.fail += 1
        continue
      }
      quantityFirst = first
      recordEngine(first, report)
      result.engine = {
        engineKey: first.engineKey,
        engineVersion: first.engineVersion,
        adapterScript: first.adapterScript,
        adapterHash: first.adapterHash,
      }
      result.quantityCount = first.quantities.length
      result.determinism = isDeterministic(first.quantities, second.quantities)
      if (!result.determinism) {
        result.problems.push(
          "two consecutive real runs produced different quantity values (or a different order) — engine execution is not deterministic",
        )
      }
      const { comparisons, ok } = compareQuantities(c.groundTruth ?? [], first.quantities)
      result.comparisons = comparisons
      if (!ok) {
        for (const cmp of comparisons) {
          if (cmp.problem === "missing") {
            result.problems.push(
              `missing quantity: expected ${cmp.quantityType} ${cmp.expected} ${cmp.unit} on ${cmp.elementRef} (${cmp.derivation}) but the adapter produced none for that slot`,
            )
          } else if (cmp.problem === "extra") {
            result.problems.push(
              `extra quantity: adapter emitted ${cmp.quantityType} ${cmp.observed} ${cmp.unit} on ${cmp.elementRef} which is not in the pinned ground truth (set-equality violation)`,
            )
          } else if (cmp.problem === "value") {
            result.problems.push(
              `value out of tolerance (${cmp.tolerance}): ${cmp.elementRef} ${cmp.quantityType} observed ${cmp.observed} vs expected ${cmp.expected} ${cmp.unit} (|Δ| ${cmp.absDiff}, rel ${cmp.observedRelError?.toExponential(3)}) — ${cmp.derivation}`,
            )
          } else if (cmp.problem === "unit") {
            result.problems.push(
              `unit mismatch: ${cmp.elementRef} ${cmp.quantityType} observed unit ${JSON.stringify(cmp.observedUnit)} vs expected ${JSON.stringify(cmp.unit)}`,
            )
          }
        }
      }
      const allOk = ok && result.determinism
      quantityOk = allOk
    } else {
      // expect === "error": the bridge must throw EngineUnavailableError whose
      // message contains the pinned substring — the honest-failure contract.
      let caught: unknown
      try {
        await deriveFromFile(fixturePath, c.adapter)
      } catch (err) {
        caught = err
      }
      result.errorContains = c.errorContains
      if (caught === undefined) {
        result.problems.push(
          `expected the bridge to throw an EngineUnavailableError containing ${JSON.stringify(c.errorContains)}, but the derivation succeeded`,
        )
      } else if (!(caught instanceof EngineUnavailableError)) {
        result.problems.push(
          `expected an EngineUnavailableError containing ${JSON.stringify(c.errorContains)}, got ${typeof caught === "object" && caught !== null ? (caught as Error).constructor.name : typeof caught}: ${String(caught)}`,
        )
      } else {
        result.errorObserved = caught.message
        if (!caught.message.includes(c.errorContains ?? "")) {
          result.problems.push(
            `error message does not contain the pinned substring ${JSON.stringify(c.errorContains)}: ${caught.message}`,
          )
        }
      }
      quantityOk = result.problems.length === 0
    }

    // W2-d (Contract C): tessellation sub-expectations for this fixture, if pinned.
    let meshOk = true
    if (c.mesh) {
      const meshResult = await runMeshChecks(c, fixturePath, quantityFirst, report)
      result.mesh = meshResult
      if (meshResult.status !== "pass") {
        for (const p of meshResult.problems) {
          result.problems.push(`mesh: ${p}`)
        }
        meshOk = false
      }
    }

    result.status = quantityOk && meshOk ? "pass" : "fail"

    report.cases.push(result)
    if (result.status === "pass") report.summary.pass += 1
    else report.summary.fail += 1
  }

  report.summary.ran = report.summary.pass + report.summary.fail
  report.summary.notRun = report.summary.ran === 0 && report.summary.skip > 0
  if (report.summary.notRun) {
    const reasons = manifest
      .map((c) => report.environment.engineAvailability[c.adapter])
      .filter((a) => !a.available)
      .map((a) => a.reason ?? "unknown reason")
    report.summary.note = `NOT RUN — no case executed (${[...new Set(reasons)].join("; ")})`
  }
  return report
}
