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
    const { caseId, adapter, fixture, expect, errorContains, groundTruth } = c
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
    adapterHashes: { "step_quantities.py": null, "ifc_quantities.py": null },
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
      result.status = allOk ? "pass" : "fail"
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
      result.status = result.problems.length === 0 ? "pass" : "fail"
    }

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
