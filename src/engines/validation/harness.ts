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
 */

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  deriveFromFile,
  EngineUnavailableError,
  type DerivedQuantity,
  type DeriveResult,
} from "../adapters/quantities"
import { tessellateFromFile, type MeshElement, type MeshResult } from "../adapters/mesh"

// ---------------------------------------------------------------------------
// Corpus manifest types (shape pinned in worklog.md "Contract A — W2-c")
// ---------------------------------------------------------------------------

export type AdapterKind = "ifc" | "step"
export type ToleranceKind = "exact" | "analytic" | "mesh"
export type QuantityType = DerivedQuantity["quantityType"]

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

const ENGINE_MODULES: Record<AdapterKind, string> = { step: "cadquery", ifc: "ifcopenshell" }

/**
 * Real-availability probe (no mocks): is the engine importable in the venv the
 * bridge spawns? Mirrors the pattern proven in quantities.test.ts.
 */
export function probeEngine(kind: AdapterKind): { available: boolean; reason?: string } {
  const mod = ENGINE_MODULES[kind]
  const res = spawnSync(PYTHON_BIN, ["-c", `import ${mod}`], { timeout: 60_000 })
  if (res.error) {
    return { available: false, reason: `python interpreter not runnable at ${PYTHON_BIN} (${res.error.message})` }
  }
  if (res.status !== 0) {
    return { available: false, reason: `${mod} is not importable in ${PYTHON_BIN} (exit code ${res.status})` }
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
    const { caseId, adapter, fixture, expect, errorContains, groundTruth, mesh } = c
    if (typeof caseId !== "string" || caseId.length === 0) {
      throw new Error(`manifest case [${i}] has no caseId`)
    }
    if (seen.has(caseId)) {
      throw new Error(`manifest caseId ${caseId} is not unique`)
    }
    seen.add(caseId)
    if (adapter !== "step" && adapter !== "ifc") {
      throw new Error(`manifest case ${caseId}: adapter must be "step"|"ifc" (got ${JSON.stringify(adapter)})`)
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
      },
    },
    engineVersions: { cadquery: null, ifcopenshell: null },
    adapterHashes: {
      "step_quantities.py": null,
      "ifc_quantities.py": null,
      "step_mesh.py": null,
      "ifc_mesh.py": null,
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
