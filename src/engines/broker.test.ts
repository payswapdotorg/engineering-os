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
 * NOT covered here (deliberately — the real-bridge behavior is already
 * harness-covered by `bun run validate:engines` + the adapter bun tests):
 * the real cadquery/ifcopenshell subprocess runs and the DB-scoped write
 * paths. The DB-scoped report path stays thin over the pure functions tested
 * below.
 */

/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test"

import {
  BrokerRefusalError,
  BrokerRequestError,
  buildReportDocument,
  reportMatchesInputs,
  reportStats,
  runBrokerOperation,
  type BrokerContext,
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
})
