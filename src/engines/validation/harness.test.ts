import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  loadManifest,
  probeEngine,
  runHarness,
  type CorpusCase,
  type HarnessReport,
} from "./harness"
import { buildMarkdownReport, buildReportJson, writeReports } from "./report"

/**
 * Engine validation harness tests (Worker 2 lane, W2-c, Contract A).
 *
 * The corpus-manifest integrity checks and the report-writer checks run on
 * every host (pure file/string work — they prove the committed evidence is
 * well-formed). The harness execution tests run ONLY when BOTH engines are
 * genuinely importable in the engine venv; otherwise they are skipped with an
 * explicit printed reason (quantities.test.ts pattern): a skipped test with a
 * reason is honest — a fake result is a firing offense (ADR-0006).
 *
 * No ground truth is ever asserted from adapter output: every expected value
 * here comes from the manifest's hand-derived closed forms or from counts of
 * the manifest itself.
 */

const stepAvailable = probeEngine("step").available
const ifcAvailable = probeEngine("ifc").available
const enginesAvailable = stepAvailable && ifcAvailable
if (!stepAvailable) {
  console.log(
    `[harness.test.ts] harness execution tests SKIPPED: cadquery is not importable in the engine venv (recorded honestly — no results are simulated)`,
  )
}
if (!ifcAvailable) {
  console.log(
    `[harness.test.ts] harness execution tests SKIPPED: ifcopenshell is not importable in the engine venv (recorded honestly — no results are simulated)`,
  )
}

const manifest = loadManifest()
const here = path.dirname(fileURLToPath(import.meta.url))
const fixturesDir = path.resolve(here, "..", "..", "..", "tests", "fixtures")

describe("validation corpus manifest (integrity — engine independent)", () => {
  test("parses, pins unique caseIds, and every fixture exists under tests/fixtures/", () => {
    expect(manifest.length).toBeGreaterThanOrEqual(11)
    expect(new Set(manifest.map((c) => c.caseId)).size).toBe(manifest.length)
    for (const c of manifest) {
      const p = path.join(fixturesDir, c.fixture)
      expect(existsSync(p)).toBe(true)
    }
  })

  test("covers the pinned minimum corpus: both adapters, analytic STEP cases, exact IFC readback incl. multi-element, a mesh-fallback curved case, an empty-set case, and honest error probes", () => {
    const stepCases = manifest.filter((c) => c.adapter === "step")
    const ifcCases = manifest.filter((c) => c.adapter === "ifc")
    expect(stepCases.length).toBeGreaterThanOrEqual(5)
    expect(ifcCases.length).toBeGreaterThanOrEqual(6)
    // analytic closed-form STEP success cases (bracket + cylinder + multi-solid)
    const analyticStep = stepCases.filter(
      (c) => c.expect === "success" && (c.groundTruth ?? []).every((g) => g.tolerance === "analytic"),
    )
    expect(analyticStep.length).toBeGreaterThanOrEqual(3)
    // multi-solid STEP case: per-solid volumes for at least 2 solids + total area + bbox
    const multiSolid = manifest.find((c) => c.caseId === "step-two-solids")
    expect(multiSolid?.groundTruth?.filter((g) => g.elementRef.startsWith("step:solid:")).length).toBe(2)
    expect(multiSolid?.groundTruth?.some((g) => g.elementRef === "step:solids:all")).toBe(true)
    expect(multiSolid?.groundTruth?.some((g) => g.elementRef === "step:model:bbox")).toBe(true)
    // exact declared readback (wall-quantities: 10 entries, elementRef pinned)
    const wallQuantities = manifest.find((c) => c.caseId === "ifc-wall-quantities")
    expect(wallQuantities?.groundTruth?.length).toBe(10)
    expect(
      wallQuantities?.groundTruth?.every((g) => g.tolerance === "exact"),
    ).toBe(true)
    // multi-element exact readback (two-elements: 15 mapped quantities over 3 refs)
    const twoElements = manifest.find((c) => c.caseId === "ifc-two-elements")
    expect(twoElements?.groundTruth?.length).toBe(15)
    expect(new Set(twoElements?.groundTruth?.map((g) => g.elementRef) ?? []).size).toBe(3)
    // mesh-fallback curved case pinned at the 1% mesh tolerance
    const cylinderMesh = manifest.find((c) => c.caseId === "ifc-cylinder-geometry-mesh")
    expect(cylinderMesh?.groundTruth?.every((g) => g.tolerance === "mesh")).toBe(true)
    // honest empty-set case
    const empty = manifest.find((c) => c.caseId === "ifc-wall-stripped-empty")
    expect(empty?.groundTruth).toEqual([])
    // honest error probes per adapter (geometry-free STEP + non-model files)
    expect(manifest.filter((c) => c.expect === "error" && c.adapter === "step").length).toBeGreaterThanOrEqual(2)
    expect(manifest.filter((c) => c.expect === "error" && c.adapter === "ifc").length).toBeGreaterThanOrEqual(1)
  })

  test("W2-d: mesh expectations cover the pinned minimum corpus — the 4 mandated fixtures + a curved IFC case + honest mesh error probes, with well-formed pins", () => {
    const meshCases = manifest.filter((c) => c.mesh)
    const meshSuccess = meshCases.filter((c) => c.mesh?.expect === "success")
    const meshError = meshCases.filter((c) => c.mesh?.expect === "error")
    // the 4 mandated fixtures + the curved IFC column (which mirrors the quantity mesh-fallback case)
    expect(meshSuccess.length).toBeGreaterThanOrEqual(5)
    expect(meshError.length).toBeGreaterThanOrEqual(4)
    const meshFixtures = new Set(meshSuccess.map((c) => c.fixture))
    for (const required of ["two-solids.step", "cylinder-solid.step", "two-elements.ifc", "wall-geometry.ifc"]) {
      expect(meshFixtures.has(required)).toBe(true)
    }
    expect(meshFixtures.has("cylinder-geometry.ifc")).toBe(true)
    for (const c of meshSuccess) {
      const m = c.mesh!
      expect(m.upAxis).toBeDefined()
      expect(typeof m.tolerance).toBe("number")
      expect((m.tolerance ?? 0)).toBeGreaterThan(0)
      // elements must cover the pinned ref set exactly (parse-level invariant)
      expect(new Set(m.elements?.map((e) => e.elementRef))).toEqual(new Set(m.elementRefs ?? []))
      for (const e of m.elements ?? []) {
        expect(e.vertexCount).toBeGreaterThanOrEqual(3)
        expect(e.triangleCount).toBeGreaterThanOrEqual(1)
        expect(e.name.length).toBeGreaterThan(0)
      }
      // every pinned volume carries a closed-form derivation + tolerance class
      for (const v of m.volume ?? []) {
        expect(m.elementRefs).toContain(v.elementRef)
        expect(["exact", "analytic", "mesh"]).toContain(v.tolerance)
        expect(v.derivation.length).toBeGreaterThan(0)
        expect(v.value).toBeGreaterThan(0)
      }
      // the curved cases are pinned at the 1% mesh tolerance; planar at analytic
      const curved = manifest.find((x) => x.caseId === "step-cylinder-solid")?.mesh?.volume ?? []
      expect(curved.every((v) => v.tolerance === "mesh")).toBe(true)
      const planar = manifest.find((x) => x.caseId === "ifc-two-elements")?.mesh?.volume ?? []
      expect(planar.every((v) => v.tolerance === "analytic")).toBe(true)
    }
    for (const c of meshError) {
      expect(typeof c.mesh?.errorContains).toBe("string")
      expect((c.mesh?.errorContains ?? "").length).toBeGreaterThan(0)
    }
  })

  test("every ground-truth entry carries a valid tolerance class and a hand-derived audit string", () => {
    const DISCIPLINE_ADAPTERS = new Set(["femesh", "powerflow", "des", "fea", "transport", "chip", "swmm", "cpm", "libreoffice"])
    // 16-V takeoff kinds + the 16-P parametric kind: pins live under runs[]
    // (one pins array per parameter set) — same derivation discipline, nested
    // one level deeper.
    const TAKEOFF_ADAPTERS = new Set(["sheet", "dxf", "parametric"])
    // 16-B OCR kind: the pins are the ordered expectedWords rows (each carries
    // the raw transcript + conf floor + the Ø-rule form); the ground truth is
    // the case-level narrative string, like takeoff/parametric.
    const OCR_ADAPTERS = new Set(["ocr"])
    // ADR-0009 Stage 1 — the ADOPTED takeoff engine: pins live under runs[]
    // (like takeoff/parametric), with the op + otherFixture block shape.
    const P2T_ADAPTERS = new Set(["pdf2takeoff"])
    for (const c of manifest) {
      if (P2T_ADAPTERS.has(c.adapter)) {
        const block = (c as unknown as Record<string, unknown>).pdf2takeoff as
          | { op?: string; otherFixture?: string; errorContains?: string; runs?: Array<{ pins?: Array<{ derivation: string }>; errorContains?: string }> }
          | undefined
        expect(typeof block).toBe("object")
        expect(typeof block?.op).toBe("string")
        expect(["compare", "annotate", "export", "fill"]).toContain(block?.op ?? "")
        if (block?.op === "compare") {
          expect(typeof block.otherFixture).toBe("string")
          expect((block.otherFixture ?? "").length).toBeGreaterThan(0)
        }
        if (c.expect === "error") {
          expect((block?.runs ?? []).length).toBeGreaterThan(0)
          for (const run of block?.runs ?? []) {
            expect(typeof run.errorContains).toBe("string")
            expect((run.errorContains ?? "").length).toBeGreaterThan(0)
          }
          expect(c.groundTruth).toBeUndefined()
          continue
        }
        expect(typeof c.pdf2takeoffGroundTruth).toBe("string")
        expect((c.pdf2takeoffGroundTruth ?? "").length).toBeGreaterThan(0)
        for (const run of block?.runs ?? []) {
          expect((run.pins ?? []).length).toBeGreaterThan(0)
          for (const pin of run.pins ?? []) {
            expect(pin.derivation.length).toBeGreaterThan(0)
          }
        }
        continue
      }
      if (OCR_ADAPTERS.has(c.adapter)) {
        const block = (c as unknown as Record<string, unknown>).ocr as
          | { expect?: string; runs?: Array<{ expectedWords?: Array<{ text: string }>; errorContains?: string }> }
          | undefined
        expect(typeof block).toBe("object")
        if (c.expect === "error") {
          expect((block?.runs ?? []).length).toBeGreaterThan(0)
          for (const run of block?.runs ?? []) {
            expect(typeof run.errorContains).toBe("string")
            expect((run.errorContains ?? "").length).toBeGreaterThan(0)
          }
          expect(c.groundTruth).toBeUndefined()
          continue
        }
        expect(typeof c.ocrGroundTruth).toBe("string")
        expect((c.ocrGroundTruth ?? "").length).toBeGreaterThan(0)
        for (const run of block?.runs ?? []) {
          expect((run.expectedWords ?? []).length).toBeGreaterThan(0)
          for (const w of run.expectedWords ?? []) {
            expect(w.text.length).toBeGreaterThan(0)
          }
        }
        continue
      }
      if (TAKEOFF_ADAPTERS.has(c.adapter)) {
        const block = (c as unknown as Record<string, unknown>)[c.adapter] as
          | { errorContains?: string; runs?: Array<{ pins?: Array<{ derivation: string }>; errorContains?: string }> }
          | undefined
        if (c.expect === "error") {
          if (c.adapter === "parametric") {
            // 16-P: a parametric error case may pin several DISTINCT refusal
            // shapes — every run carries its own substring (the block-level
            // one is an optional common shape)
            expect((block?.runs ?? []).length).toBeGreaterThan(0)
            for (const run of block?.runs ?? []) {
              expect(typeof run.errorContains).toBe("string")
              expect((run.errorContains ?? "").length).toBeGreaterThan(0)
            }
          } else {
            expect(typeof block?.errorContains).toBe("string")
            expect((block?.errorContains ?? "").length).toBeGreaterThan(0)
          }
          expect(c.groundTruth).toBeUndefined()
          continue
        }
        const groundTruthText = c.takeoffGroundTruth ?? c.parametricGroundTruth
        expect(typeof groundTruthText).toBe("string")
        expect((groundTruthText ?? "").length).toBeGreaterThan(0)
        for (const run of block?.runs ?? []) {
          expect((run.pins ?? []).length).toBeGreaterThan(0)
          for (const pin of run.pins ?? []) {
            expect(pin.derivation.length).toBeGreaterThan(0)
          }
        }
        continue
      }
      if (DISCIPLINE_ADAPTERS.has(c.adapter)) {
        // W2-f discipline cases pin hand-derived values in their per-adapter
        // block instead of the quantity-ledger groundTruth shape; every pin
        // must still carry a derivation audit string.
        const block = (c as unknown as Record<string, unknown>)[c.adapter] as
          | { pins?: Array<{ derivation: string }> }
          | undefined
        for (const pin of block?.pins ?? []) {
          expect(pin.derivation.length).toBeGreaterThan(0)
        }
        continue
      }
      if (c.expect === "error") {
        expect(typeof c.errorContains).toBe("string")
        expect((c.errorContains ?? "").length).toBeGreaterThan(0)
        expect(c.groundTruth).toBeUndefined()
        continue
      }
      expect(Array.isArray(c.groundTruth)).toBe(true)
      for (const g of c.groundTruth ?? []) {
        expect(["exact", "analytic", "mesh"]).toContain(g.tolerance)
        expect(g.derivation.length).toBeGreaterThan(0)
        expect(Number.isFinite(g.value)).toBe(true)
        expect(g.unit.length).toBeGreaterThan(0)
      }
    }
  })
})

/** Minimal, honest-shaped report for the pure writer tests (no engine needed). */
function syntheticReport(): HarnessReport {
  const passCase = {
    caseId: "synthetic-step",
    adapter: "step" as const,
    fixture: "bracket-solid.step",
    fixturePath: "tests/fixtures/bracket-solid.step",
    expect: "success" as const,
    status: "pass" as const,
    engine: {
      engineKey: "cadquery",
      engineVersion: "synthetic",
      adapterScript: "step_quantities.py",
      adapterHash: "0".repeat(64),
    },
    determinism: true,
    quantityCount: 3,
    groundTruthCount: 3,
    comparisons: [
      {
        elementRef: "step:solid:0",
        quantityType: "volume" as const,
        expected: 32984.0710525538,
        observed: 32984.07105255332,
        unit: "mm³",
        observedUnit: "mm³",
        tolerance: "analytic" as const,
        absDiff: 4.8e-10,
        observedRelError: 1.45e-14,
        ok: true,
        problem: "matched" as const,
        derivation: "36000 − 960π mm³",
      },
    ],
    problems: [],
    // W2-d: synthetic tessellation sub-result — exercises the mesh rendering
    // in the writers with no engine involvement (numbers are structural).
    mesh: {
      expect: "success" as const,
      status: "pass" as const,
      engine: {
        engineKey: "cadquery",
        engineVersion: "synthetic",
        adapterScript: "step_mesh.py",
        adapterHash: "0".repeat(64),
      },
      determinism: true,
      elementCount: 1,
      vertexCount: 8,
      triangleCount: 12,
      comparisons: [
        {
          kind: "upAxis" as const,
          elementRef: null,
          expected: "z",
          observed: "z",
          tolerance: null,
          absDiff: null,
          observedRelError: null,
          ok: true,
          problem: "matched" as const,
          derivation: "synthetic",
        },
        {
          kind: "volume" as const,
          elementRef: "step:solid:0",
          expected: 1e-6,
          observed: 1.0000000000000002e-6,
          tolerance: "analytic" as const,
          absDiff: 2e-22,
          observedRelError: 2e-16,
          ok: true,
          problem: "matched" as const,
          derivation: "synthetic planar box",
        },
      ],
      problems: [],
    },
  }
  return {
    ranAt: "2026-01-01T00:00:00.000Z",
    pythonBin: "/synthetic/python3",
    manifestPath: "tests/validation/corpus-manifest.json",
    caseCount: 2,
    environment: {
      engineAvailability: {
        step: { available: true },
        ifc: { available: false, reason: "synthetic: engine absent" },
        femesh: { available: false, reason: "synthetic: engine absent" },
        powerflow: { available: false, reason: "synthetic: engine absent" },
        des: { available: false, reason: "synthetic: engine absent" },
        fea: { available: false, reason: "synthetic: engine absent" },
        transport: { available: false, reason: "synthetic: engine absent" },
        chip: { available: false, reason: "synthetic: engine absent" },
        swmm: { available: false, reason: "synthetic: engine absent" },
        cpm: { available: true }, // platform core — always available, no engine
        libreoffice: { available: false, reason: "synthetic: engine absent" },
        sheet: { available: false, reason: "synthetic: engine absent" },
        dxf: { available: false, reason: "synthetic: engine absent" },
        parametric: { available: false, reason: "synthetic: engine absent" },
        ocr: { available: false, reason: "synthetic: engine absent" },
        pdf2takeoff: { available: false, reason: "synthetic: engine absent" },
      },
    },
    engineVersions: { cadquery: "synthetic", ifcopenshell: null },
    adapterHashes: { "step_quantities.py": "0".repeat(64), "ifc_quantities.py": null },
    cases: [
      passCase,
      {
        caseId: "synthetic-ifc-skip",
        adapter: "ifc",
        fixture: "wall-quantities.ifc",
        fixturePath: "tests/fixtures/wall-quantities.ifc",
        expect: "success",
        status: "skip",
        skipReason: "engine unavailable for the ifc adapter: synthetic: engine absent",
        determinism: null,
        quantityCount: null,
        groundTruthCount: 10,
        comparisons: null,
        problems: [],
      },
    ],
    summary: { total: 2, pass: 1, fail: 0, skip: 1, ran: 1, notRun: false },
  }
}

describe("harness report writers (pure — engine independent)", () => {
  test("buildReportJson produces parseable JSON that round-trips the report", () => {
    const report = syntheticReport()
    const json = buildReportJson(report)
    const parsed = JSON.parse(json) as HarnessReport
    expect(parsed.caseCount).toBe(report.caseCount)
    expect(parsed.summary).toEqual(report.summary)
    expect(parsed.cases.map((c) => c.caseId)).toEqual(["synthetic-step", "synthetic-ifc-skip"])
    expect(parsed.cases[0].comparisons?.[0].observedRelError).toBe(1.45e-14)
  })

  test("buildMarkdownReport renders the evidence table, mesh errors and regenerate command", () => {
    const md = buildMarkdownReport(syntheticReport())
    expect(md).toContain("bun run validate:engines")
    expect(md).toContain("synthetic-step")
    expect(md).toContain("1 pass / 0 fail / 1 skip")
    expect(md).toContain("tests/validation/corpus-manifest.json")
    // W2-d: the tessellation section renders with the mesh sub-result + volumes
    expect(md).toContain("Mesh tessellation validation")
    expect(md).toContain("step_mesh.py")
    expect(md).toContain("byte-identical")
    expect(md).toContain("Observed mesh-volume errors")
    expect(md).toContain("synthetic planar box")
    expect(md).toContain("mesh: 1 element(s) / 8 verts / 12 tris")
  })

  test("writeReports writes a parseable report.json + markdown to disk (temp dir — real evidence untouched)", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "eos-harness-report-"))
    try {
      const reportJsonPath = path.join(tmp, "report.json")
      const reportMarkdownPath = path.join(tmp, "nested", "validation-report.md")
      const { reportJsonPath: written1, reportMarkdownPath: written2 } = writeReports(syntheticReport(), {
        reportJsonPath,
        reportMarkdownPath,
      })
      expect(written1).toBe(reportJsonPath)
      expect(written2).toBe(reportMarkdownPath)
      expect(existsSync(reportJsonPath)).toBe(true)
      expect(existsSync(reportMarkdownPath)).toBe(true)
      const parsed = JSON.parse(readFileSync(reportJsonPath, "utf-8")) as HarnessReport
      expect(parsed.summary.pass).toBe(1)
      expect(parsed.cases[0].comparisons?.[0].observedRelError).toBe(1.45e-14)
      const md = readFileSync(reportMarkdownPath, "utf-8")
      expect(md).toContain("synthetic-step")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe.skipIf(!enginesAvailable)("engine validation harness (real engine runs)", () => {
  // The harness now also double-runs the tessellation bridge per mesh case
  // (STEP imports dominate the runtime; observed ~2 min for the full corpus).
  const HARNESS_TIMEOUT_MS = 480_000

  // Memoized across the tests below (bun runs them sequentially): the harness
  // is a real-engine run (~1 min); one run, many assertions.
  let report: HarnessReport | undefined

  test(
    "runHarness: every case passes — fail === 0, pass === manifest case count, no skips",
    async () => {
      report = await runHarness()
      expect(report.summary.total).toBe(manifest.length)
      expect(report.summary.fail).toBe(0)
      expect(report.summary.skip).toBe(0)
      expect(report.summary.pass).toBe(manifest.length)
      expect(report.summary.notRun).toBe(false)
    },
    HARNESS_TIMEOUT_MS,
  )

  test(
    "every success case is deterministic (bitwise-identical values across two real runs) and set-equal to its pinned ground truth",
    async () => {
      report = report ?? (await runHarness())
      const successCases = report.cases.filter((c) => c.expect === "success")
      expect(successCases.length).toBe(manifest.filter((c: CorpusCase) => c.expect === "success").length)
      for (const c of successCases) {
        expect(c.status).toBe("pass")
        if (c.discipline !== undefined) {
          // W2-f discipline cases: determinism lives on the discipline block
          // (null only where byte-determinism is honestly NOT claimed —
          // libreoffice); every pin comparison must be ok.
          if (c.discipline.adapter === "libreoffice") {
            expect(c.discipline.determinism).toBeNull() // PDFs embed timestamps — §5.4
          } else {
            expect(c.discipline.determinism).toBe(true)
          }
          for (const cmp of c.discipline.comparisons) {
            expect(cmp.ok).toBe(true)
          }
          continue
        }
        expect(c.determinism).toBe(true)
        expect(c.comparisons).not.toBeNull()
        for (const cmp of c.comparisons ?? []) {
          expect(cmp.ok).toBe(true)
          expect(cmp.problem).toBe("matched")
          expect(cmp.observed).not.toBeNull()
          expect(cmp.absDiff).not.toBeNull()
          expect(cmp.observedRelError).not.toBeNull()
        }
        expect(c.quantityCount).toBe(c.groundTruthCount)
      }
    },
    HARNESS_TIMEOUT_MS,
  )

  test(
    "every error case threw the honest EngineUnavailableError containing its pinned substring",
    async () => {
      report = report ?? (await runHarness())
      for (const c of report.cases.filter((x) => x.expect === "error")) {
        expect(c.status).toBe("pass")
        if (c.discipline !== undefined) {
          expect(c.discipline.errorObserved).toBeDefined()
          expect(c.discipline.errorObserved ?? "").toContain(c.discipline.errorContains ?? "")
          continue
        }
        expect(c.errorObserved).toBeDefined()
        expect(c.errorObserved).toContain(c.errorContains ?? "")
      }
    },
    HARNESS_TIMEOUT_MS,
  )

  test(
    "W2-d: every mesh case is byte-deterministic, refs-set-equal, count-pinned and volume-checked",
    async () => {
      report = report ?? (await runHarness())
      const meshCases = report.cases.filter((c) => c.mesh)
      expect(meshCases.length).toBe(manifest.filter((c: CorpusCase) => c.mesh).length)
      for (const c of meshCases) {
        expect(c.status).toBe("pass")
        const m = c.mesh!
        expect(m.status).toBe("pass")
        if (m.expect === "error") {
          expect(m.errorObserved).toBeDefined()
          expect(m.errorObserved).toContain(m.errorContains ?? "")
          continue
        }
        expect(m.determinism).toBe(true)
        expect(m.elementCount).toBe((manifest.find((x) => x.caseId === c.caseId)?.mesh?.elementRefs?.length ?? -1))
        for (const cmp of m.comparisons) {
          expect(cmp.ok).toBe(true)
          expect(cmp.problem).toBe("matched")
        }
        // divergence-theorem volumes: planar within the 1e-9 analytic bound,
        // curved within the pinned 1% — and the observed rel error is recorded
        for (const v of m.comparisons.filter((x) => x.kind === "volume")) {
          expect(v.observedRelError).not.toBeNull()
          expect(v.observedRelError!).toBeLessThanOrEqual(v.tolerance === "mesh" ? 1e-2 : 1e-9)
        }
      }
      // the mesh adapters surfaced their real hashes + engine versions
      expect(report.adapterHashes["step_mesh.py"]).toMatch(/^[0-9a-f]{64}$/)
      expect(report.adapterHashes["ifc_mesh.py"]).toMatch(/^[0-9a-f]{64}$/)
    },
    HARNESS_TIMEOUT_MS,
  )

  test(
    "mesh-tolerance comparisons record their observed relative error (the has_occ=False limitation, quantified honestly)",
    async () => {
      report = report ?? (await runHarness())
      const meshComparisons = report.cases
        .flatMap((c) => c.comparisons ?? [])
        .filter((x) => x.tolerance === "mesh")
      // the curved cylinder case pins volume + area at the 1% mesh tolerance
      expect(meshComparisons.length).toBeGreaterThanOrEqual(2)
      for (const m of meshComparisons) {
        expect(m.ok).toBe(true)
        expect(m.observedRelError).not.toBeNull()
        if (m.observedRelError !== null) {
          expect(m.observedRelError).toBeLessThanOrEqual(1e-2)
        }
      }
      // real engine versions surfaced by the adapters (e.g. cadquery 2.6.1 / ifcopenshell 0.9.0.post1)
      expect(report.engineVersions.cadquery).toMatch(/^[0-9]/)
      expect(report.engineVersions.ifcopenshell).toMatch(/^[0-9]/)
    },
    HARNESS_TIMEOUT_MS,
  )

  test(
    "the real harness report serializes to parseable JSON via the report writer",
    async () => {
      report = report ?? (await runHarness())
      const parsed = JSON.parse(buildReportJson(report)) as HarnessReport
      expect(parsed.summary).toEqual(report.summary)
      expect(parsed.cases.length).toBe(manifest.length)
      const md = buildMarkdownReport(report)
      expect(md).toContain(`${report.summary.pass} pass / ${report.summary.fail} fail / ${report.summary.skip} skip`)
      for (const c of report.cases) {
        expect(md).toContain(c.caseId)
      }
    },
    HARNESS_TIMEOUT_MS,
  )
})
