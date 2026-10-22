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
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { analyzeCpm } from "@/core/cpm"
import {
  deriveFromFile,
  EngineUnavailableError,
  type DerivedQuantity,
  type DeriveResult,
} from "../adapters/quantities"
import { tessellateFromFile, type MeshElement, type MeshResult } from "../adapters/mesh"
import { defaultFeMeshParameters, femeshLdLibraryPath, feMeshFromFile, validateFeMeshParameters, type FeMeshParameters, type FeMeshResult } from "../adapters/femesh"
import { runPowerflowFromFile, type PowerflowResult } from "../adapters/powerflow"
import { runDesFromFile, type DesResult } from "../adapters/des"
import { convertDocumentToFile, type ConversionResult } from "../adapters/convert-document"
import {
  buildCpmAnalysisDocument,
  buildDesDocument,
  buildFeMeshDocument,
  buildPowerflowDocument,
  validateScheduleDocument,
} from "../broker"

// ---------------------------------------------------------------------------
// Corpus manifest types (shape pinned in worklog.md "Contract A — W2-c")
// ---------------------------------------------------------------------------

export type AdapterKind = "ifc" | "step" | "femesh" | "powerflow" | "des" | "cpm" | "libreoffice"
export type ToleranceKind = "exact" | "analytic" | "mesh"
export type QuantityType = DerivedQuantity["quantityType"]

/** The Phase-5 discipline case kinds (W2-f — one shared pin schema). */
export type DisciplineAdapter = "femesh" | "powerflow" | "des" | "cpm" | "libreoffice"

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
  cpm?: DisciplineExpectation
  libreoffice?: DisciplineExpectation
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
  /** femesh only: mesh parameters override (defaults per contract §4) */
  parameters?: { meshSizeMin: number; meshSizeMax: number; elementOrder: number }
  /** success cases only: the pinned expectation set (every entry carries a derivation) */
  pins?: DisciplinePin[]
  /** honest routing/limitation note, rendered into the case notes */
  note?: string
}

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
  adapter: DisciplineAdapter
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

/** Python engines per adapter kind (cpm/libreoffice are probed differently). */
const PYTHON_ENGINE_MODULES: Record<"step" | "ifc" | "femesh" | "powerflow" | "des", string> = {
  step: "cadquery",
  ifc: "ifcopenshell",
  femesh: "gmsh",
  powerflow: "pandapower",
  des: "simpy",
}

/** Human labels for the availability line in the evidence doc. */
export const ADAPTER_LABELS: Record<AdapterKind, string> = {
  step: "cadquery (STEP quantities)",
  ifc: "ifcopenshell (IFC quantities)",
  femesh: "gmsh (FE mesh)",
  powerflow: "pandapower (power flow)",
  des: "simpy (discrete-event)",
  cpm: "platform CPM core (no engine)",
  libreoffice: "libreoffice (document conversion)",
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
  if (!Array.isArray(pins) || pins.length === 0) {
    throw new Error(
      `manifest case ${caseId}: ${blockName} success cases must pin a non-empty pins array (structural pins included)`,
    )
  }
  block.pins = pins.map((p: unknown, j: number) => {
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
    const { caseId, adapter, fixture, expect, errorContains, groundTruth, mesh, femesh, powerflow, des, cpm, libreoffice } =
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
      adapter === "femesh" || adapter === "powerflow" || adapter === "des" || adapter === "cpm" || adapter === "libreoffice"
    if (!isModelAdapter && !isDisciplineAdapter) {
      throw new Error(
        `manifest case ${caseId}: adapter must be "step"|"ifc"|"femesh"|"powerflow"|"des"|"cpm"|"libreoffice" (got ${JSON.stringify(adapter)})`,
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
    if (pin.minBound === true) {
      row.bound = "min"
      row.ok = observed >= pin.value
      return row
    }
    if (pin.relTolerance !== undefined) {
      row.bound = `rel:${pin.relTolerance}`
      row.observedRelError = row.absDiff / Math.abs(pin.value)
      row.ok = row.absDiff <= pin.relTolerance * Math.abs(pin.value)
      return row
    }
    const bound = pin.absTolerance ?? 0
    row.bound = `abs:${bound}`
    row.observedRelError = row.absDiff / Math.abs(pin.value)
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
  const adapter = c.adapter as DisciplineAdapter
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
        cpm: probeEngine("cpm"),
        libreoffice: probeEngine("libreoffice"),
      },
    },
    engineVersions: { cadquery: null, ifcopenshell: null, gmsh: null, pandapower: null, simpy: null, libreoffice: null },
    adapterHashes: {
      "step_quantities.py": null,
      "ifc_quantities.py": null,
      "step_mesh.py": null,
      "ifc_mesh.py": null,
      "step_femesh.py": null,
      "powerflow.py": null,
      "des.py": null,
      "convert-document.ts": null,
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
