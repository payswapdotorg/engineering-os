/**
 * Broker unit tests (W2-e lane, Phase 4) — PURE parts only.
 *
 * Covered here: the eos-report/1 document assembly (byte-determinism, pinned
 * key order, verbatim figure copies with source pointers — ADR-0006 §2
 * numerical truth: build_report may only COPY stored verified numbers), the
 * find-or-create matching key, the report stats, the BrokerRefusalError /
 * BrokerRequestError mapping surface and runBrokerOperation's structural
 * input refusals (all thrown BEFORE any DB access).
 *
 * W2-f (Phase 5) additions — the four new pure document builders
 * (eos-femesh/1, eos-powerflow/1, eos-des/1, eos-cpm/1), the pinned 422
 * message maps, the fe_mesh parameter defense, the §3.1 schedule defense,
 * the platform-core outcome honesty and the five new ops' structural
 * refusals. All still pure — no DB path is touched.
 *
 * NOT covered here (deliberately — the real-bridge behavior is already
 * harness-covered by `bun run validate:engines` + the adapter bun tests):
 * the real cadquery/ifcopenshell/gmsh/pandapower/simpy subprocess runs and
 * the DB-scoped write paths. The DB-scoped report path stays thin over the
 * pure functions tested below.
 */

/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { analyzeCpm } from "@/core/cpm"
import type { FeMeshParameters } from "./adapters/femesh"
import {
  ANALYZE_NO_REVISIONS_MESSAGE,
  BrokerRefusalError,
  BrokerRequestError,
  CONVERT_NO_REVISIONS_MESSAGE,
  DES_NO_REVISIONS_MESSAGE,
  FEMESH_NO_REVISIONS_MESSAGE,
  POWERFLOW_NO_REVISIONS_MESSAGE,
  buildCpmAnalysisDocument,
  buildDesDocument,
  buildFeMeshDocument,
  buildPowerflowDocument,
  buildReportDocument,
  feMeshBrokerParameters,
  femeshUnsupportedMessage,
  notAnalysisFormatMessage,
  notJsonDocumentMessage,
  platformCoreOutcome,
  reportMatchesInputs,
  reportStats,
  runBrokerOperation,
  validateScheduleDocument,
  type BrokerContext,
  type DocumentGeneratedBy,
  type ReportFigure,
  type ReportHeader,
  type ReportSource,
} from "./broker"

// ---------------------------------------------------------------------------
// Hand-written fixtures — structural test data, NOT engineering claims
// ---------------------------------------------------------------------------

const ledgerFigures: ReportFigure[] = [
  {
    name: "step:solid:0 volume",
    value: 32983.7,
    unit: "mm³",
    method: "model-derived",
    status: "draft",
    sourceType: "quantity-row",
    sourceId: "qty_1",
  },
  {
    name: "step:solids:all area",
    value: 11507.6,
    unit: "mm²",
    method: "model-derived",
    status: "approved",
    sourceType: "quantity-row",
    sourceId: "qty_2",
  },
]

const meshFigures: ReportFigure[] = [
  { name: "elementCount", value: 1, sourceType: "mesh-meta", sourceId: "rev_mesh_1" },
  { name: "vertexCount", value: 12, sourceType: "mesh-meta", sourceId: "rev_mesh_1" },
  { name: "triangleCount", value: 20, sourceType: "mesh-meta", sourceId: "rev_mesh_1" },
  { name: "contentHash", value: "b".repeat(64), sourceType: "mesh-meta", sourceId: "rev_mesh_1" },
  { name: "engineKey", value: "cadquery", sourceType: "mesh-meta", sourceId: "rev_mesh_1" },
  { name: "engineVersion", value: "2.6.1", sourceType: "mesh-meta", sourceId: "rev_mesh_1" },
  { name: "adapterHash", value: "c".repeat(64), sourceType: "mesh-meta", sourceId: "rev_mesh_1" },
]

const meshSource: ReportSource = {
  kind: "mesh-summary",
  sourceArtifactId: "art_mesh_1",
  sourceArtifactName: "bracket.step — 3D mesh",
  sourceRevisionId: "rev_mesh_1",
  figures: meshFigures,
}

const ledgerSource: ReportSource = {
  kind: "quantity-ledger",
  sourceArtifactId: "art_model_1",
  sourceArtifactName: "bracket.step",
  sourceRevisionId: "rev_model_1",
  figures: ledgerFigures,
}

const header: ReportHeader = { title: "bracket.step — QA report" }

const ctx: BrokerContext = { projectId: "prj_test", actor: "agent:qa-bot" }

// ---------------------------------------------------------------------------
// buildReportDocument — byte-determinism and pinned key order
// ---------------------------------------------------------------------------

describe("buildReportDocument — byte-deterministic eos-report/1 assembly", () => {
  test("same inputs → byte-identical document (two calls, deep string compare)", () => {
    const first = buildReportDocument([meshSource, ledgerSource], header)
    const second = buildReportDocument([meshSource, ledgerSource], header)
    expect(first).toBe(second)
    expect(first.length > 0).toBe(true)
  })

  test("SCRAMBLED key insertion order in every nested object → identical bytes (pinned re-wrapping)", () => {
    // Same data, deliberately different key-insertion order everywhere:
    // the builder must re-wrap in the pinned order, like serializeMeshFile.
    const scrambledMesh: ReportSource = {
      figures: [
        ...meshFigures.map((f) => ({
          sourceId: f.sourceId,
          sourceType: f.sourceType,
          value: f.value,
          name: f.name,
        })),
      ],
      sourceRevisionId: meshSource.sourceRevisionId,
      sourceArtifactName: meshSource.sourceArtifactName,
      sourceArtifactId: meshSource.sourceArtifactId,
      kind: meshSource.kind,
    }
    const scrambledLedger: ReportSource = {
      figures: [
        ...ledgerFigures.map((f) => ({
          sourceId: f.sourceId,
          sourceType: f.sourceType,
          status: f.status,
          method: f.method,
          unit: f.unit,
          value: f.value,
          name: f.name,
        })),
      ],
      kind: ledgerSource.kind,
      sourceRevisionId: ledgerSource.sourceRevisionId,
      sourceArtifactId: ledgerSource.sourceArtifactId,
      sourceArtifactName: ledgerSource.sourceArtifactName,
    }
    expect(buildReportDocument([scrambledMesh, scrambledLedger], header)).toBe(
      buildReportDocument([meshSource, ledgerSource], header),
    )
  })

  test("root key order pinned: format → title → sections (no generatedAt — Contract A)", () => {
    const doc = buildReportDocument([ledgerSource], header)
    expect(doc.startsWith(`{"format":"eos-report/1","title":"bracket.step — QA report","sections":[`)).toBe(true)
    expect(doc.includes("generatedAt")).toBe(false)
    expect(doc.includes("createdAt")).toBe(false)
    // no timestamp anywhere in the bytes: creation time lives in the DB revision row
    expect(doc).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)
  })

  test("workflow block: present in pinned order (workflowId → stepId → actor) when provided", () => {
    const doc = buildReportDocument([ledgerSource], {
      title: "QA",
      workflow: { workflowId: "wfl_1", stepId: "report", actor: "agent:qa-bot" },
    })
    expect(doc).toContain(`"workflow":{"workflowId":"wfl_1","stepId":"report","actor":"agent:qa-bot"}`)
    expect(doc.indexOf('"workflow"')).toBeGreaterThan(doc.indexOf('"title"'))
    expect(doc.indexOf('"sections"')).toBeGreaterThan(doc.indexOf('"workflow"'))
  })

  test("workflow block: only the provided keys are carried (workflowId only)", () => {
    const doc = buildReportDocument([ledgerSource], {
      title: "QA",
      workflow: { workflowId: "wfl_1", actor: "agent:qa-bot" },
    })
    expect(doc).toContain(`"workflow":{"workflowId":"wfl_1","actor":"agent:qa-bot"}`)
  })

  test("workflow block: absent when the header carries none", () => {
    const doc = buildReportDocument([ledgerSource], header)
    expect(doc.includes('"workflow"')).toBe(false)
  })

  test("sections preserve the inputs array order and the pinned section key order", () => {
    const doc = buildReportDocument([meshSource, ledgerSource], header)
    expect(doc).toContain(
      `{"kind":"mesh-summary","sourceArtifactId":"art_mesh_1","sourceArtifactName":"bracket.step — 3D mesh","sourceRevisionId":"rev_mesh_1","figures":[`,
    )
    const parsed = JSON.parse(doc) as { sections: ReportSource[] }
    expect(parsed.sections).toHaveLength(2)
    expect(parsed.sections[0].sourceArtifactId).toBe("art_mesh_1")
    expect(parsed.sections[1].sourceArtifactId).toBe("art_model_1")
    expect(Object.keys(parsed.sections[0])).toEqual([
      "kind",
      "sourceArtifactId",
      "sourceArtifactName",
      "sourceRevisionId",
      "figures",
    ])
  })

  test("quantity-row figure: pinned key order name → value → unit → method → status → sourceType → sourceId", () => {
    const doc = buildReportDocument([ledgerSource], header)
    expect(doc).toContain(
      `{"name":"step:solid:0 volume","value":32983.7,"unit":"mm³","method":"model-derived","status":"draft","sourceType":"quantity-row","sourceId":"qty_1"}`,
    )
  })

  test("mesh-meta figure: pinned key order name → value → sourceType → sourceId; NO unit key", () => {
    const doc = buildReportDocument([meshSource], header)
    expect(doc).toContain(`{"name":"elementCount","value":1,"sourceType":"mesh-meta","sourceId":"rev_mesh_1"}`)
    const parsed = JSON.parse(doc) as { sections: ReportSource[] }
    const figure = parsed.sections[0].figures[0] as unknown as Record<string, unknown>
    expect("unit" in figure).toBe(false)
    expect("method" in figure).toBe(false)
    expect("status" in figure).toBe(false)
  })

  test("figures are VERBATIM copies: value/unit/method/status round-trip exactly (no recomputation)", () => {
    const doc = buildReportDocument([meshSource, ledgerSource], header)
    const parsed = JSON.parse(doc) as { sections: ReportSource[] }
    const rows = parsed.sections[1].figures as ReportFigure[]
    expect(rows).toEqual(ledgerFigures)
    expect(parsed.sections[0].figures).toEqual(meshFigures)
  })

  test("null values are copied verbatim as null (honest absence of engine provenance)", () => {
    const sparse: ReportSource = {
      kind: "mesh-summary",
      sourceArtifactId: "art_mesh_2",
      sourceArtifactName: "hand mesh",
      sourceRevisionId: "rev_mesh_2",
      figures: [{ name: "engineKey", value: null, sourceType: "mesh-meta", sourceId: "rev_mesh_2" }],
    }
    const doc = buildReportDocument([sparse], header)
    expect(doc).toContain(`{"name":"engineKey","value":null,"sourceType":"mesh-meta","sourceId":"rev_mesh_2"}`)
  })
})

// ---------------------------------------------------------------------------
// reportStats — the broker summary's structural counts
// ---------------------------------------------------------------------------

describe("reportStats — section/figure counts and cited sources", () => {
  test("counts sections, figures and distinct source ids in first-citation order", () => {
    const stats = reportStats([meshSource, ledgerSource])
    expect(stats.sectionCount).toBe(2)
    expect(stats.figureCount).toBe(9)
    expect(stats.sourcesCited).toEqual(["rev_mesh_1", "qty_1", "qty_2"])
  })

  test("a source id shared by many figures is cited exactly once", () => {
    const stats = reportStats([meshSource])
    expect(stats.sourcesCited).toEqual(["rev_mesh_1"])
    expect(stats.figureCount).toBe(7)
  })

  test("no inputs → empty stats (honest zero, never fabricated)", () => {
    expect(reportStats([])).toEqual({ sectionCount: 0, figureCount: 0, sourcesCited: [] })
  })
})

// ---------------------------------------------------------------------------
// reportMatchesInputs — the find-or-create matching key (pure)
// ---------------------------------------------------------------------------

describe("reportMatchesInputs — derived_from target-set equality", () => {
  test("exact same set (any order) matches", () => {
    expect(reportMatchesInputs(new Set(["a", "b"]), ["b", "a"])).toBe(true)
    expect(reportMatchesInputs(new Set(["a"]), ["a"])).toBe(true)
  })

  test("a subset of the targets does NOT match (a report citing more inputs is a different report)", () => {
    expect(reportMatchesInputs(new Set(["a", "b", "c"]), ["a", "b"])).toBe(false)
  })

  test("a superset does NOT match (a report citing fewer inputs is a different report)", () => {
    expect(reportMatchesInputs(new Set(["a"]), ["a", "b"])).toBe(false)
  })

  test("disjoint sets never match", () => {
    expect(reportMatchesInputs(new Set(["x"]), ["a"])).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Error surface — the routes' byte-stable mapping classes
// ---------------------------------------------------------------------------

describe("BrokerRefusalError / BrokerRequestError mapping surface", () => {
  test("BrokerRefusalError carries the pinned code union and the verbatim 422 message", () => {
    const refusal = new BrokerRefusalError(
      "unsupported",
      'artifact "site-notes.md" (storage key p/a/r) does not carry a derivable model extension (.step/.stp/.ifc)',
    )
    expect(refusal).toBeInstanceOf(Error)
    expect(refusal.name).toBe("BrokerRefusalError")
    expect(refusal.code).toBe("unsupported")
    expect(refusal.message).toBe(
      'artifact "site-notes.md" (storage key p/a/r) does not carry a derivable model extension (.step/.stp/.ifc)',
    )
  })

  test("BrokerRefusalError engine_unavailable code survives the mapping (routes rebuild jsonError(422, code, message))", () => {
    const refusal = new BrokerRefusalError("engine_unavailable", "cadquery STEP import failed")
    expect(refusal.code).toBe("engine_unavailable")
    expect(refusal.message).toBe("cadquery STEP import failed")
  })

  test("BrokerRequestError not_found carries `what` so routes rebuild ERR.notFound(what) byte-identically", () => {
    const err = new BrokerRequestError("not_found", "Project not found", "Project")
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe("not_found")
    expect(err.what).toBe("Project")
    expect(`${err.what} not found`).toBe("Project not found") // the exact ERR.notFound string
  })

  test("BrokerRequestError bad_request / validation_failed carry the verbatim route messages", () => {
    const bad = new BrokerRequestError("bad_request", "This artifact has no revisions to derive quantities from")
    expect(bad.code).toBe("bad_request")
    expect(bad.message).toBe("This artifact has no revisions to derive quantities from")
    const invalid = new BrokerRequestError("validation_failed", "invalid QuantityRecord: value: must be finite")
    expect(invalid.code).toBe("validation_failed")
    expect(invalid.message).toBe("invalid QuantityRecord: value: must be finite")
    expect(bad.what).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// runBrokerOperation — structural input refusals (thrown BEFORE any DB access)
// ---------------------------------------------------------------------------

describe("runBrokerOperation — structural input refusals (pure; no DB touched)", () => {
  async function expectRefusal(
    promise: Promise<unknown>,
    code: "unsupported" | "engine_unavailable",
    message: string,
  ): Promise<void> {
    let caught: unknown
    try {
      await promise
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(BrokerRefusalError)
    const refusal = caught as BrokerRefusalError
    expect(refusal.code).toBe(code)
    expect(refusal.message).toBe(message)
  }

  test("derive_quantities without inputs.artifactId → pinned refusal", async () => {
    await expectRefusal(
      runBrokerOperation("derive_quantities", ctx, {}, {}),
      "unsupported",
      "derive_quantities requires inputs.artifactId (one model artifact id)",
    )
  })

  test("derive_mesh without inputs.artifactId → pinned refusal", async () => {
    await expectRefusal(
      runBrokerOperation("derive_mesh", ctx, { artifactIds: ["a"] }, {}),
      "unsupported",
      "derive_mesh requires inputs.artifactId (one model artifact id)",
    )
  })

  test("build_report without artifactIds / empty / >4 / non-string entries → the same pinned refusal", async () => {
    const pinned = "build_report requires inputs.artifactIds to be an array of 1..4 artifact ids"
    await expectRefusal(runBrokerOperation("build_report", ctx, {}, {}), "unsupported", pinned)
    await expectRefusal(runBrokerOperation("build_report", ctx, { artifactIds: [] }, {}), "unsupported", pinned)
    await expectRefusal(
      runBrokerOperation("build_report", ctx, { artifactIds: ["a", "b", "c", "d", "e"] }, {}),
      "unsupported",
      pinned,
    )
    // The executor feeds definition JSON (untyped at the boundary) — the
    // broker defends the string-ness invariant at runtime, compile types aside.
    await expectRefusal(
      runBrokerOperation("build_report", ctx, { artifactIds: ["a", 7] as unknown as string[] }, {}),
      "unsupported",
      pinned,
    )
  })

  test("build_report with duplicate artifact ids → pinned duplicates refusal", async () => {
    await expectRefusal(
      runBrokerOperation("build_report", ctx, { artifactIds: ["art_1", "art_1"] }, {}),
      "unsupported",
      "build_report inputs.artifactIds must not contain duplicates",
    )
  })

  test("build_report with a non-string or empty title → pinned title refusal", async () => {
    const pinned = "build_report parameters.title must be a non-empty string when provided"
    await expectRefusal(
      runBrokerOperation("build_report", ctx, { artifactIds: ["art_1"] }, { title: 42 }),
      "unsupported",
      pinned,
    )
    await expectRefusal(
      runBrokerOperation("build_report", ctx, { artifactIds: ["art_1"] }, { title: "   " }),
      "unsupported",
      pinned,
    )
  })

  test("unknown operation → runtime defense refusal with the verbatim operation name", async () => {
    await expectRefusal(
      runBrokerOperation("bogus_op" as never, ctx, {}, {}),
      "unsupported",
      'unsupported broker operation "bogus_op"',
    )
  })

  test("Phase-5 ops without inputs.artifactId → the five pinned structural refusals (thrown before any DB access)", async () => {
    await expectRefusal(
      runBrokerOperation("fe_mesh", ctx, {}, {}),
      "unsupported",
      "fe_mesh requires inputs.artifactId (one model artifact id)",
    )
    // wrong key shape (artifactIds) is defended exactly like a missing id
    await expectRefusal(
      runBrokerOperation("run_powerflow", ctx, { artifactIds: ["x"] }, {}),
      "unsupported",
      "run_powerflow requires inputs.artifactId (one network artifact id)",
    )
    await expectRefusal(
      runBrokerOperation("run_des", ctx, {}, {}),
      "unsupported",
      "run_des requires inputs.artifactId (one scenario artifact id)",
    )
    await expectRefusal(
      runBrokerOperation("convert_document", ctx, {}, {}),
      "unsupported",
      "convert_document requires inputs.artifactId (one document artifact id)",
    )
    await expectRefusal(
      runBrokerOperation("analyze_schedule", ctx, { artifactId: "" }, {}),
      "unsupported",
      "analyze_schedule requires inputs.artifactId (one schedule artifact id)",
    )
  })
})

// ---------------------------------------------------------------------------
// W2-f (Phase 5): the new pure §2 document builders — pinned key order +
// byte-determinism (structural test data, NOT engineering claims — the real
// engine values are pinned by the adapter tests + the validation harness)
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url))
const fixturesDir = path.resolve(here, "..", "..", "tests", "fixtures")

const femeshGeneratedBy: DocumentGeneratedBy = {
  engineKey: "gmsh",
  engineVersion: "4.15.2",
  adapterScript: "step_femesh.py",
}
const femeshParameters: FeMeshParameters = { meshSizeMin: 2.0, meshSizeMax: 4.0, elementOrder: 1 }
const femeshPayload = {
  nodes: { count: 10 },
  elements: { type: "tet4" as const, count: 20 },
  solids: [
    { ref: "step:solid:0", name: "Solid 1", tetCount: 20, meshVolume: 123.5 },
    { ref: "step:solid:1", tetCount: 7, meshVolume: 456.25 },
  ],
  quality: { min: 0.25, mean: 0.8 },
}

const powerflowPayload = {
  converged: true,
  buses: [
    { id: "bus-1", vmPu: 1.0, angleDeg: 0.0, pMw: -2.0, qMvar: -0.01 },
    { id: "bus-2", vmPu: 0.9999874996093545, angleDeg: -0.28648367242832057, pMw: 2.0, qMvar: 0.0 },
  ],
  lines: [{ fromBus: "bus-1", toBus: "bus-2", iKa: 0.057735748638374766, pLossMw: 0.0, qLossMvar: 0.01 }],
  totals: { lossMw: 0.0, loadMw: 2.0 },
}

const desPayload = {
  policy: "fifo" as const,
  makespan: 13,
  resources: [
    { id: "m1", busy: 6, utilization: 6 / 13 },
    { id: "m2", busy: 11, utilization: 11 / 13 },
  ],
  jobs: [
    { id: "j1", startAt: 0, endAt: 6 },
    { id: "j2", startAt: 2, endAt: 8 },
    { id: "j3", startAt: 5, endAt: 13 },
  ],
}

describe("buildFeMeshDocument — byte-deterministic eos-femesh/1 assembly (W2-f)", () => {
  test("pinned root key order: format → sourceArtifactName → units → generatedBy → sizes → nodes → elements → solids → quality; NO timestamps", () => {
    const doc = buildFeMeshDocument("bracket-solid.step", femeshGeneratedBy, femeshParameters, femeshPayload)
    expect(doc).toBe(
      '{"format":"eos-femesh/1","sourceArtifactName":"bracket-solid.step","units":"mm",' +
        '"generatedBy":{"engineKey":"gmsh","engineVersion":"4.15.2","adapterScript":"step_femesh.py"},' +
        '"meshSizeMin":2,"meshSizeMax":4,"elementOrder":1,' +
        '"nodes":{"count":10},"elements":{"type":"tet4","count":20},' +
        '"solids":[{"ref":"step:solid:0","name":"Solid 1","tetCount":20,"meshVolume":123.5},' +
        '{"ref":"step:solid:1","tetCount":7,"meshVolume":456.25}],' +
        '"quality":{"min":0.25,"mean":0.8}}',
    )
    // no timestamp anywhere in the bytes (creation time lives in the DB revision row)
    expect(doc).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)
    // NO adapterHash in the document — §2 pins generatedBy WITHOUT it
    expect(doc).not.toContain("adapterHash")
  })

  test("solid name is optional: omitted when undefined, present when given (same solid object shape otherwise)", () => {
    const doc = buildFeMeshDocument("m.step", femeshGeneratedBy, femeshParameters, {
      nodes: { count: 1 },
      elements: { type: "tet4", count: 1 },
      solids: [{ ref: "step:solid:0", tetCount: 1, meshVolume: 1 }],
      quality: { min: 0.5, mean: 0.6 },
    })
    expect(doc).toContain('"solids":[{"ref":"step:solid:0","tetCount":1,"meshVolume":1}]')
  })

  test("byte-determinism: two calls and a scrambled-key-insertion call produce identical bytes", () => {
    const first = buildFeMeshDocument("m.step", femeshGeneratedBy, femeshParameters, femeshPayload)
    const second = buildFeMeshDocument("m.step", femeshGeneratedBy, femeshParameters, femeshPayload)
    expect(first).toBe(second)
    // scrambled insertion order everywhere — the builder re-wraps in the pinned order
    const scrambled = buildFeMeshDocument(
      "m.step",
      { adapterScript: "step_femesh.py", engineVersion: "4.15.2", engineKey: "gmsh" },
      { elementOrder: 1, meshSizeMax: 4.0, meshSizeMin: 2.0 },
      {
        quality: { mean: 0.8, min: 0.25 },
        solids: femeshPayload.solids.map((s) => ({ meshVolume: s.meshVolume, tetCount: s.tetCount, name: s.name, ref: s.ref })),
        elements: { count: 20, type: "tet4" },
        nodes: { count: 10 },
      },
    )
    expect(scrambled).toBe(first)
  })
})

describe("buildPowerflowDocument — byte-deterministic eos-powerflow/1 assembly (W2-f)", () => {
  test("pinned root key order: format → sourceArtifactName → converged → buses → lines → totals; numerics are VERBATIM copies", () => {
    const doc = buildPowerflowDocument("feeder.json", powerflowPayload)
    expect(doc).toBe(
      '{"format":"eos-powerflow/1","sourceArtifactName":"feeder.json","converged":true,' +
        '"buses":[{"id":"bus-1","vmPu":1,"angleDeg":0,"pMw":-2,"qMvar":-0.01},' +
        '{"id":"bus-2","vmPu":0.9999874996093545,"angleDeg":-0.28648367242832057,"pMw":2,"qMvar":0}],' +
        '"lines":[{"fromBus":"bus-1","toBus":"bus-2","iKa":0.057735748638374766,"pLossMw":0,"qLossMvar":0.01}],' +
        '"totals":{"lossMw":0,"loadMw":2}}',
    )
    // verbatim round-trip: every parsed numeric equals the input double exactly
    const parsed = JSON.parse(doc) as typeof powerflowPayload
    expect(parsed.buses).toEqual(powerflowPayload.buses)
    expect(parsed.lines).toEqual(powerflowPayload.lines)
    expect(parsed.totals).toEqual(powerflowPayload.totals)
    expect(doc).not.toContain("generatedAt")
  })

  test("byte-determinism: two calls → identical bytes (no timestamps anywhere)", () => {
    expect(buildPowerflowDocument("n.json", powerflowPayload)).toBe(
      buildPowerflowDocument("n.json", powerflowPayload),
    )
  })
})

describe("buildDesDocument — byte-deterministic eos-des/1 assembly (W2-f)", () => {
  test("pinned root key order: format → sourceArtifactName → policy → makespan → resources → jobs", () => {
    const doc = buildDesDocument("flowshop.json", desPayload)
    expect(doc).toBe(
      '{"format":"eos-des/1","sourceArtifactName":"flowshop.json","policy":"fifo","makespan":13,' +
        '"resources":[{"id":"m1","busy":6,"utilization":0.46153846153846156},' +
        '{"id":"m2","busy":11,"utilization":0.8461538461538461}],' +
        '"jobs":[{"id":"j1","startAt":0,"endAt":6},{"id":"j2","startAt":2,"endAt":8},{"id":"j3","startAt":5,"endAt":13}]}',
    )
    expect(doc).not.toContain("generatedAt")
  })

  test("byte-determinism: two calls → identical bytes", () => {
    expect(buildDesDocument("f.json", desPayload)).toBe(buildDesDocument("f.json", desPayload))
  })
})

describe("buildCpmAnalysisDocument — byte-deterministic eos-cpm/1 assembly over the real pure core (W2-f)", () => {
  // The committed §3.1 fixture (hand-derived ground truth, contract §6):
  //   a(3)→c(4)→e(3); b(2)→d(5)→f(1)→e  →  duration 11,
  //   critical path b→d→f→e (float 0); a and c carry float 1.
  const scheduleDoc = JSON.parse(
    readFileSync(path.join(fixturesDir, "schedule-cpm.json"), "utf-8"),
  ) as { activities: Array<{ id: string; name: string; durationDays: number; predecessorIds: string[] }> }
  const analysis = analyzeCpm(scheduleDoc.activities)

  test("analyzeCpm on the fixture returns the hand-derived graph (duration 11, critical path b→d→f→e)", () => {
    expect(analysis.ok).toBe(true)
    if (!analysis.ok) return
    expect(analysis.value.durationDays).toBe(11)
    expect(analysis.value.criticalPath).toEqual(["b", "d", "f", "e"])
    const floats = Object.fromEntries(analysis.value.activities.map((a) => [a.id, a.totalFloat]))
    expect(floats).toEqual({ a: 1, b: 0, c: 1, d: 0, f: 0, e: 0 })
  })

  test("pinned root key order: format → sourceArtifactName → activities → criticalPath → durationDays; NO engine fields", () => {
    expect(analysis.ok).toBe(true)
    if (!analysis.ok) return
    const doc = buildCpmAnalysisDocument("Platform rollout schedule", analysis.value)
    expect(doc.startsWith('{"format":"eos-cpm/1","sourceArtifactName":"Platform rollout schedule","activities":[')).toBe(
      true,
    )
    // first activity: the pinned activity key order id → name → durationDays → es → ef → ls → lf → totalFloat → critical
    expect(doc).toContain(
      '{"id":"a","name":"Site preparation","durationDays":3,"es":0,"ef":3,"ls":1,"lf":4,"totalFloat":1,"critical":false}',
    )
    expect(doc.endsWith('"criticalPath":["b","d","f","e"],"durationDays":11}')).toBe(true)
    // the platform core has NO engine identity — the document carries none by design
    expect(doc).not.toContain("engineKey")
    expect(doc).not.toContain("adapterScript")
    expect(doc).not.toContain("generatedAt")
  })

  test("byte-determinism: two calls → identical bytes (pure JSON assembly)", () => {
    expect(analysis.ok).toBe(true)
    if (!analysis.ok) return
    expect(buildCpmAnalysisDocument("s", analysis.value)).toBe(
      buildCpmAnalysisDocument("s", analysis.value),
    )
  })
})

describe("platformCoreOutcome — the analyze_schedule execution-record honesty (W2-f)", () => {
  test("carries NO engine fields at all: engineKey/engineVersion/adapterScript/adapterHash are absent, exitCode 0", () => {
    const outcome = platformCoreOutcome(
      { artifactId: "art_cpm", revisionNumber: 1, durationDays: 11, criticalPath: ["b", "d", "f", "e"] },
      "rev_cpm",
      7,
    )
    const serialized = JSON.stringify(outcome)
    expect(serialized).not.toContain("engineKey")
    expect(serialized).not.toContain("engineVersion")
    expect(serialized).not.toContain("adapterScript")
    expect(serialized).not.toContain("adapterHash")
    expect(outcome.exitCode).toBe(0) // no adapter subprocess ran — but the run did complete
    expect(outcome.durationMs).toBe(7)
    expect(outcome.outputArtifactRevisionId).toBe("rev_cpm")
    // pinned key order: summary → outputArtifactRevisionId → exitCode → durationMs
    expect(Object.keys(outcome)).toEqual(["summary", "outputArtifactRevisionId", "exitCode", "durationMs"])
  })
})

// ---------------------------------------------------------------------------
// W2-f: pinned 422 message maps + the pure input defenses
// ---------------------------------------------------------------------------

describe("Phase-5 pinned 422 message builders (W2-f)", () => {
  test("femeshUnsupportedMessage — the fe_mesh non-model 422, verbatim", () => {
    expect(femeshUnsupportedMessage("site-notes.md", "p/a/r")).toBe(
      'artifact "site-notes.md" (storage key p/a/r) does not carry a meshable model extension (.step/.stp/.ifc)',
    )
  })

  test("notAnalysisFormatMessage / notJsonDocumentMessage — the JSON-gate 422s, verbatim", () => {
    expect(notAnalysisFormatMessage("sched.json", "eos-schedule/1", '"eos-des-scenario/1"')).toBe(
      'artifact "sched.json" is not an eos-schedule/1 document (format "eos-des-scenario/1")',
    )
    expect(notAnalysisFormatMessage("net.json", "eos-powerflow-network/1", "null")).toBe(
      'artifact "net.json" is not an eos-powerflow-network/1 document (format null)',
    )
    expect(notJsonDocumentMessage("site-notes.md", "eos-des-scenario/1")).toBe(
      'artifact "site-notes.md" is not an eos-des-scenario/1 document (content is not valid JSON)',
    )
  })

  test("the five per-op no-revision bad_request texts are pinned verbatim", () => {
    expect(FEMESH_NO_REVISIONS_MESSAGE).toBe("This artifact has no revisions to generate an FE mesh from")
    expect(POWERFLOW_NO_REVISIONS_MESSAGE).toBe("This artifact has no revisions to run a power flow on")
    expect(DES_NO_REVISIONS_MESSAGE).toBe("This artifact has no revisions to simulate")
    expect(CONVERT_NO_REVISIONS_MESSAGE).toBe("This artifact has no revisions to convert")
    expect(ANALYZE_NO_REVISIONS_MESSAGE).toBe("This artifact has no revisions to analyze")
  })
})

describe("feMeshBrokerParameters — validate + default the fe_mesh parameters (pure, W2-f)", () => {
  test("empty parameters → the contract §4 defaults; explicit values pass through", () => {
    expect(feMeshBrokerParameters({})).toEqual({ ok: true, value: { meshSizeMin: 2.0, meshSizeMax: 4.0, elementOrder: 1 } })
    expect(feMeshBrokerParameters({ meshSizeMin: 1.5, meshSizeMax: 3 })).toEqual({
      ok: true,
      value: { meshSizeMin: 1.5, meshSizeMax: 3, elementOrder: 1 },
    })
  })

  test("refuses non-positive sizes, min>max and elementOrder ≠ 1 with the pinned 422 messages", () => {
    expect(feMeshBrokerParameters({ meshSizeMin: 0 })).toEqual({
      ok: false,
      message: "fe_mesh parameters.meshSizeMin must be a positive number when provided",
    })
    expect(feMeshBrokerParameters({ meshSizeMax: -1 })).toEqual({
      ok: false,
      message: "fe_mesh parameters.meshSizeMax must be a positive number when provided",
    })
    expect(feMeshBrokerParameters({ meshSizeMin: 5, meshSizeMax: 4 })).toEqual({
      ok: false,
      message: "fe_mesh parameters.meshSizeMin must be <= parameters.meshSizeMax",
    })
    expect(feMeshBrokerParameters({ elementOrder: 2 })).toEqual({
      ok: false,
      message: "fe_mesh parameters.elementOrder must be 1 (linear tets only in this phase) — got 2",
    })
  })
})

describe("validateScheduleDocument — the §3.1 structural defense (pure, W2-f)", () => {
  const scheduleDoc = JSON.parse(
    readFileSync(path.join(fixturesDir, "schedule-cpm.json"), "utf-8"),
  ) as Record<string, unknown>

  test("the committed fixture parses to the 6 pinned CpmActivity values", () => {
    const parsed = validateScheduleDocument(scheduleDoc)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value).toHaveLength(6)
    expect(parsed.value[0]).toEqual({ id: "a", name: "Site preparation", durationDays: 3, predecessorIds: [] })
    expect(parsed.value[5]).toEqual({ id: "e", name: "Handover", durationDays: 3, predecessorIds: ["c", "f"] })
  })

  test("duplicate activity id → the pinned single-problem verbatim error", () => {
    const dup = {
      activities: [
        { id: "a", name: "A", durationDays: 1, predecessorIds: [] },
        { id: "a", name: "A2", durationDays: 2, predecessorIds: [] },
      ],
    }
    expect(validateScheduleDocument(dup)).toEqual({
      ok: false,
      error: 'invalid schedule: activity id "a" is used more than once',
    })
  })

  test("multiple problems are joined with the ledger-style '; ' separator under one prefix (one problem per activity)", () => {
    // per-activity checks short-circuit at the first failed field (the
    // forEach returns), so each activity contributes at most one problem —
    // two activities with distinct problems exercise the join honestly.
    const bad = {
      activities: [
        { id: "A", name: "upper case id", durationDays: 1, predecessorIds: [] },
        { id: "b", name: "", durationDays: 1, predecessorIds: [] },
      ],
    }
    const result = validateScheduleDocument(bad)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe(
      "invalid schedule: activities[0].id: must match ^[a-z0-9-]{1,32}$; activities[1].name: must be a string of 1..200 characters",
    )
  })

  test("activities outside 1..64 → the pinned bounds error", () => {
    expect(validateScheduleDocument({ activities: [] })).toEqual({
      ok: false,
      error: "invalid schedule: activities: must be an array of 1..64 activities",
    })
    expect(
      validateScheduleDocument({ activities: Array.from({ length: 65 }, (_, i) => ({ id: `a${i}`, name: "x", durationDays: 1, predecessorIds: [] })) }),
    ).toEqual({ ok: false, error: "invalid schedule: activities: must be an array of 1..64 activities" })
  })
})
