/**
 * Engineering OS — the engine BROKER: the ONLY execution path for engine
 * operations (ADR-0005 rule 1; Phase-4 workflow-runtime contract §5).
 *
 * CONTRACT OWNER: TL (frozen interface — W3-e codes against it in parallel):
 *   BrokerOperation / BrokerContext / BrokerOutcome / BrokerRefusalError /
 *   runBrokerOperation. Signatures are FROZEN by docs/00-architecture/
 *   workflow-runtime-contract.md §5; additions to this module are additive
 *   only (the route-core seams below and the pure report builder).
 *
 * IMPLEMENTATION: W2-e — three operations, one execution path:
 *   - derive_quantities → `brokerDeriveQuantitiesCore` (the ENTIRE flow of
 *     the former derive-quantities route, extracted verbatim: same order of
 *     steps, same pinned 404/400/422 messages, same single `quantity.derived`
 *     audit event — the route is now a thin HTTP wrapper, byte-stable).
 *   - derive_mesh → `brokerDeriveMeshCore` (the former derive-mesh route's
 *     flow, same find-or-create + sequential-revision append semantics, same
 *     `mesh.derived` event, same orphan-log line).
 *   - build_report → NEW pure-assembly operation (ADR-0006 §2 numerical
 *     truth): a kind-"report" artifact revision whose figures are VERBATIM
 *     COPIES of DB-verified rows and stored mesh metadata — no number in the
 *     document is ever recomputed; every figure carries its source pointer
 *     (QuantityRecord row id or mesh revision id).
 *
 * Execution-record honesty (ADR-0005 §2): every successful run returns engine
 * identity, adapter hash, verbatim stdout/stderr tails (last 2000 chars) and
 * durationMs. Expected refusals throw `BrokerRefusalError` (422 material);
 * request-shaped input problems throw `BrokerRequestError` (404/400/422
 * material for the routes); everything else propagates — the routes surface
 * it as an honest 500 and the workflow executor records it as a step failure
 * with the verbatim message (contract §7: never paraphrased).
 */

import path from "node:path"

import { LedgerError, makeQuantityRecord, type QuantityRecord } from "@/core"
import { analyzeCpm, type CpmActivity, type CpmActivityResult } from "@/core/cpm"
import { deriveKind } from "@/engines/adapters/derive-kind"
import { EngineUnavailableError, deriveFromFile, isPlainObject, type DeriveResult } from "@/engines/adapters/quantities"
import { tessellateFromFile } from "@/engines/adapters/mesh"
import { feMeshFromFile, type FeMeshParameters, type FeMeshResult } from "@/engines/adapters/femesh"
import { runPowerflowFromFile, type PowerflowBus, type PowerflowLine, type PowerflowTotals } from "@/engines/adapters/powerflow"
import { runDesFromFile, type DesJob, type DesResource } from "@/engines/adapters/des"
import { sheetTakeoffFromStorage, type SheetTakeoffResult } from "@/engines/adapters/sheet_takeoff"
import { dxfTakeoffFromStorage, type DxfTakeoffResult } from "@/engines/adapters/dxf_takeoff"
import {
  parametricRebuildFromStorage,
  parametricSchemaFromStorage,
  resolveParametricParams,
  type ParametricBuildResult,
  type ParametricSchemaResult,
} from "@/engines/adapters/parametric_rebuild"
import {
  normalizeDiameterToken,
  sheetOcrFromPng,
  type SheetOcrResult,
} from "@/engines/adapters/sheet_ocr"
import { markDownstreamStale, type StaleMarkedRow } from "@/lib/staleness-cascade"
import {
  alreadyPdfMessage,
  conversionExtensionKind,
  convertDocumentToFile,
  convertibleSourceName,
  notConvertibleMessage,
} from "@/engines/adapters/convert-document"
import {
  buildMeshFile,
  extractGeneratedBy,
  meshCounts,
  serializeMeshFile,
  unsupportedDeriveMessage,
  type MeshFile,
} from "@/app/api/_lib/mesh-meta"
import type { QuantityDbRow } from "@/app/api/_lib/ledger-rows"
import { getStorageRoot, readRevisionFile, saveRevisionFile, type StoredRevision } from "@/lib/artifact-store"
import { recordEvent } from "@/lib/audit"
import { db } from "@/lib/db"
import { newId } from "@/lib/ids"

// ---------------------------------------------------------------------------
// Frozen broker interface (contract §5 — W3-e executor codes against this)
// ---------------------------------------------------------------------------

/**
 * The operation vocabulary grew additively in Phase 5 (contract §4): the five
 * new disciplines-discipline ops join the frozen three. The workflow core's
 * own pure BROKER_OPERATIONS copy (W3-f) grows to match, and the executor
 * stores operation strings from definitions, so the runtime defense in the
 * switch below stays honest for unknown strings.
 */
export type BrokerOperation =
  | "derive_quantities"
  | "derive_mesh"
  | "build_report"
  | "fe_mesh"
  | "run_powerflow"
  | "run_des"
  | "convert_document"
  | "analyze_schedule"
  | "takeoff_sheet"
  | "takeoff_drawing"
  | "rebuild_parametric"

export interface BrokerContext {
  projectId: string
  actor: string
  workflowId?: string
  stepId?: string
  attempt?: number
}

export interface BrokerOutcome {
  summary: Record<string, unknown> // op-specific structured summary, JSON-safe
  outputArtifactRevisionId?: string // produced artifact revision (mesh/report ops)
  engineKey?: string
  engineVersion?: string
  adapterScript?: string
  adapterHash?: string
  exitCode: number | null // null when no adapter subprocess ran (build_report)
  stdoutTail?: string // last 2000 chars, verbatim
  stderrTail?: string // last 2000 chars, verbatim
  durationMs: number
}

/**
 * Expected refusal — the message is VERBATIM 422 material (the pinned route
 * strings; regression scripts assert them byte-for-byte). Never retried as
 * an internal error: the workflow executor records it as the step's verbatim
 * failure text.
 */
export class BrokerRefusalError extends Error {
  code: "unsupported" | "engine_unavailable"
  constructor(code: "unsupported" | "engine_unavailable", message: string) {
    super(message)
    this.name = "BrokerRefusalError"
    this.code = code
  }
}

/**
 * Request-shaped input failure (404/400/422-validation material). The two
 * derive routes map these onto their EXACT existing responses (byte-stable);
 * through `runBrokerOperation` they propagate as honest step failures with
 * the verbatim message.
 */
export type BrokerRequestCode = "not_found" | "bad_request" | "validation_failed"

export class BrokerRequestError extends Error {
  code: BrokerRequestCode
  /** the 404 subject ("Project" | "Artifact") — routes rebuild ERR.notFound(what) byte-identically */
  what?: string
  constructor(code: BrokerRequestCode, message: string, what?: string) {
    super(message)
    this.name = "BrokerRequestError"
    this.code = code
    this.what = what
  }
}

// ---------------------------------------------------------------------------
// Route-core seams (byte-stable extraction — the thin routes call these)
// ---------------------------------------------------------------------------

/** Workflow context seam: when set, audit actor + provenance carry it. */
export interface BrokerDeriveOptions {
  /** audit actorId override — route path passes nothing (adapter:<engine> stays) */
  actor?: string
  workflowId?: string
  stepId?: string
  attempt?: number
}

export interface BrokerDeriveQuantitiesResult {
  /** created ledger rows (DB order = DerivedQuantity order) — the 201 payload source */
  created: QuantityDbRow[]
  engineKey: string
  engineVersion: string
  adapterScript: string
  adapterHash: string
  stdoutTail?: string
  stderrTail?: string
}

/** Pinned 201 `mesh` response object (exact key order — regression-pinned). */
export interface BrokerMeshResponse {
  artifactId: string
  name: string
  kind: "mesh"
  revisionNumber: number
  contentHash: string
  sizeBytes: number
  elementCount: number
  vertexCount: number
  triangleCount: number
  engineKey: string
  engineVersion: string
  adapterScript: string
  adapterHash: string
  derivedFromArtifactId: string
  derivedFromRevisionId: string
  sourceLatestRevisionId: string
  staleSource: false
}

export interface BrokerDeriveMeshResult {
  mesh: BrokerMeshResponse
  outputArtifactRevisionId: string
  engineKey: string
  engineVersion: string
  adapterScript: string
  adapterHash: string
  stdoutTail?: string
  stderrTail?: string
}

/**
 * Audit actorType for a broker actor string. Route path actors are always
 * `adapter:<engine>` → "agent" (byte-identical to the pinned events); the
 * workflow seam additionally maps `agent:<name>` → "agent" and plain human /
 * system actors honestly ("local-operator" → "user", "system:*" → "system").
 */
function auditActorType(actor: string): "user" | "agent" | "system" {
  if (actor.startsWith("agent:") || actor.startsWith("adapter:")) return "agent"
  if (actor.startsWith("system:")) return "system"
  return "user"
}

/** Shared option → provenance/audit seam extraction (additive JSON fields). */
function provenanceSeam(opts: BrokerDeriveOptions | undefined): Record<string, unknown> {
  if (!opts) return {}
  const seam: Record<string, unknown> = {}
  if (opts.workflowId !== undefined) seam.workflowId = opts.workflowId
  if (opts.stepId !== undefined) seam.stepId = opts.stepId
  if (opts.attempt !== undefined) seam.attempt = opts.attempt
  return seam
}

/** Audit-detail workflow fields (additive; absent on the byte-stable route path). */
function auditDetailSeam(opts: BrokerDeriveOptions | undefined): Record<string, unknown> {
  if (!opts) return {}
  const seam: Record<string, unknown> = {}
  if (opts.workflowId !== undefined) seam.workflowId = opts.workflowId
  if (opts.stepId !== undefined) seam.stepId = opts.stepId
  return seam
}

/**
 * Core of POST /api/projects/[id]/artifacts/[artifactId]/derive-quantities —
 * the ENTIRE former route flow, extracted verbatim (byte-stable contract):
 * project/artifact validation, canonical multi-signal detection, the REAL
 * engine adapter run, one draft ledger row per DerivedQuantity (all validated
 * BEFORE anything is written — no partial derive), exactly ONE
 * `quantity.derived` audit event. `opts` is the workflow seam: when set, the
 * audit actor becomes `opts.actor` and the rows' provenance additionally
 * carries workflowId/stepId/attempt (additive JSON fields — existing fields
 * keep their byte-identical shape and order when no seam is provided).
 */
export async function brokerDeriveQuantitiesCore(
  projectId: string,
  artifactId: string,
  opts?: BrokerDeriveOptions,
): Promise<BrokerDeriveQuantitiesResult> {
  const project = await db.project.findUnique({ where: { id: projectId }, select: { id: true } })
  if (!project) throw new BrokerRequestError("not_found", "Project not found", "Project")

  const artifact = await db.artifact.findUnique({
    where: { id: artifactId },
    include: { latestRevision: true },
  })
  if (!artifact || artifact.projectId !== projectId) {
    throw new BrokerRequestError("not_found", "Artifact not found", "Artifact")
  }
  if (!artifact.latestRevision) {
    throw new BrokerRequestError("bad_request", "This artifact has no revisions to derive quantities from")
  }
  const revision = artifact.latestRevision

  const kind = deriveKind(revision.storageKey, artifact.name, revision.mimeType)
  if (!kind) {
    throw new BrokerRefusalError("unsupported", unsupportedDeriveMessage(artifact.name, revision.storageKey))
  }

  const absPath = path.join(getStorageRoot(), revision.storageKey, "content")

  let result: DeriveResult
  try {
    result = await deriveFromFile(absPath, kind)
  } catch (err) {
    if (err instanceof EngineUnavailableError) {
      throw new BrokerRefusalError("engine_unavailable", err.message)
    }
    throw err // unexpected adapter failure → honest 500 via the route handler, logged
  }

  // One draft ledger row per DerivedQuantity — all validated BEFORE anything is
  // written (no partial derive). Values come from the engine, identity from
  // the adapter: method model-derived, elementRef from the engine, quantity
  // method "<engine> <version> via <adapterScript>", ruleset pinned per kind.
  const rulesetId = kind === "step" ? "step-geometric" : "ifc-base-quantities"
  let records: QuantityRecord[]
  try {
    records = result.quantities.map((dq) =>
      makeQuantityRecord({
        id: newId("qty"),
        projectId,
        sourceArtifactRevisionId: revision.id,
        elementRef: dq.elementRef,
        quantityType: dq.quantityType,
        value: dq.value,
        unit: dq.unit,
        method: "model-derived",
        quantityMethod: `${result.engineKey} ${result.engineVersion} via ${result.adapterScript}`,
        rulesetId,
        rulesetVersion: "0.1",
        createdBy: `adapter:${result.engineKey}`,
      }),
    )
  } catch (err) {
    if (err instanceof LedgerError) throw new BrokerRequestError("validation_failed", err.message)
    throw err
  }

  const created = await db.$transaction(
    records.map((record) =>
      db.quantityRecord.create({
        data: {
          id: record.id,
          projectId: record.projectId,
          sourceArtifactRevisionId: record.sourceArtifactRevisionId,
          sheetRef: record.sheetRef ?? null,
          elementRef: record.elementRef ?? null,
          quantityType: record.quantityType,
          value: record.value,
          unit: record.unit,
          method: record.method,
          scale: record.scale ?? null,
          quantityMethod: record.quantityMethod ?? null,
          rulesetId: record.rulesetId,
          rulesetVersion: record.rulesetVersion,
          status: record.status,
          tradeAssemblyId: record.tradeAssemblyId ?? null,
          verification: JSON.stringify(record.verification),
          reviewer: record.reviewer ?? null,
          approval: record.approval ? JSON.stringify(record.approval) : null,
          // provenance carries adapter evidence (adapterHash + engineVersion
          // next to recomputeHistory) so every derived row is re-traceable;
          // the workflow seam appends workflowId/stepId/attempt when provided
          provenance: JSON.stringify({
            ...record.provenance,
            adapterScript: result.adapterScript,
            adapterHash: result.adapterHash,
            engineKey: result.engineKey,
            engineVersion: result.engineVersion,
            sourceArtifactRevisionId: revision.id,
            ...provenanceSeam(opts),
          }),
        },
      }),
    ),
  )

  const actorId = opts?.actor ? opts.actor : `adapter:${result.engineKey}`
  await recordEvent({
    projectId,
    actorType: auditActorType(actorId),
    actorId,
    action: "quantity.derived",
    entityType: "artifact",
    entityId: artifactId,
    detail: {
      engineKey: result.engineKey,
      engineVersion: result.engineVersion,
      artifactId,
      count: created.length,
      quantityIds: created.map((row) => row.id),
      adapterHash: result.adapterHash,
      ...auditDetailSeam(opts),
    },
  })

  return {
    created,
    engineKey: result.engineKey,
    engineVersion: result.engineVersion,
    adapterScript: result.adapterScript,
    adapterHash: result.adapterHash,
    stdoutTail: result.stdoutTail,
    stderrTail: result.stderrTail,
  }
}

/**
 * Core of POST /api/projects/[id]/artifacts/[artifactId]/derive-mesh — the
 * ENTIRE former route flow, extracted verbatim (byte-stable contract):
 * validation, REAL tessellation adapter run, byte-deterministic eos-mesh/1
 * bytes (Contract A: pinned key order, NO timestamps), find-or-create target
 * (existing kind-"mesh" artifact linked `derived_from` THIS source gets the
 * NEXT sequential revision; otherwise the mesh artifact is created with rev 1
 * + the link), exactly ONE `mesh.derived` audit event, and the pinned
 * orphan-log line when anything fails after the file write. `opts` is the
 * workflow seam (audit actor + additive detail fields; the route passes
 * nothing → byte-identical events).
 */
export async function brokerDeriveMeshCore(
  projectId: string,
  artifactId: string,
  opts?: BrokerDeriveOptions,
): Promise<BrokerDeriveMeshResult> {
  const project = await db.project.findUnique({ where: { id: projectId }, select: { id: true } })
  if (!project) throw new BrokerRequestError("not_found", "Project not found", "Project")

  const artifact = await db.artifact.findUnique({
    where: { id: artifactId },
    include: { latestRevision: true },
  })
  if (!artifact || artifact.projectId !== projectId) {
    throw new BrokerRequestError("not_found", "Artifact not found", "Artifact")
  }
  if (!artifact.latestRevision) {
    throw new BrokerRequestError("bad_request", "This artifact has no revisions to derive a mesh from")
  }
  const revision = artifact.latestRevision

  const kind = deriveKind(revision.storageKey, artifact.name, revision.mimeType)
  if (!kind) {
    throw new BrokerRefusalError("unsupported", unsupportedDeriveMessage(artifact.name, revision.storageKey))
  }

  const absPath = path.join(getStorageRoot(), revision.storageKey, "content")

  let result: Awaited<ReturnType<typeof tessellateFromFile>>
  try {
    result = await tessellateFromFile(absPath, kind)
  } catch (err) {
    if (err instanceof EngineUnavailableError) {
      throw new BrokerRefusalError("engine_unavailable", err.message)
    }
    throw err // unexpected adapter failure → honest 500 via the route handler, logged
  }

  // eos-mesh/1 bytes — pinned key order, zero timestamps (Contract A)
  const meshFile = buildMeshFile(result)
  const bytes = Buffer.from(serializeMeshFile(meshFile), "utf8")
  const counts = meshCounts(meshFile)

  // Find-or-create target: an existing kind-"mesh" artifact linked
  // `derived_from` THIS source gets the NEXT sequential revision appended;
  // otherwise the mesh artifact is created here with rev 1 + the link.
  const existingLink = await db.artifactLink.findFirst({
    where: {
      relationType: "derived_from",
      toArtifactId: artifactId,
      fromArtifact: { kind: "mesh", projectId },
    },
    orderBy: { createdAt: "asc" },
    include: { fromArtifact: { select: { id: true, name: true } } },
  })

  try {
    let meshArtifactId: string
    let meshName: string
    let revisionNumber: number
    let meshRevisionId: string
    let stored: StoredRevision

    if (existingLink) {
      const meshArtifact = existingLink.fromArtifact
      const maxRev = await db.artifactRevision.aggregate({
        where: { artifactId: meshArtifact.id },
        _max: { revNumber: true },
      })
      revisionNumber = (maxRev._max.revNumber ?? 0) + 1
      meshRevisionId = newId("rev")
      stored = await saveRevisionFile(projectId, meshArtifact.id, meshRevisionId, bytes)
      // The FK (latestRevisionId) lives on Artifact itself, so Prisma cannot
      // nested-create the revision — append revision + relink in one transaction.
      await db.$transaction(async (tx) => {
        await tx.artifactRevision.create({
          data: {
            id: meshRevisionId,
            artifactId: meshArtifact.id,
            revNumber: revisionNumber,
            contentHash: stored.sha256,
            sizeBytes: stored.sizeBytes,
            storageKey: stored.storageKey,
            mimeType: "application/json",
            uploadedBy: `adapter:${result.engineKey}`,
            // staleness defaults to "current": this revision was just derived
            // from the source's latest revision, so it starts fresh
          },
        })
        await tx.artifact.update({
          where: { id: meshArtifact.id },
          data: { latestRevisionId: meshRevisionId },
        })
      })
      meshArtifactId = meshArtifact.id
      meshName = meshArtifact.name
    } else {
      meshArtifactId = newId("art")
      meshName = `${artifact.name} — 3D mesh`
      meshRevisionId = newId("rev")
      stored = await saveRevisionFile(projectId, meshArtifactId, meshRevisionId, bytes)
      await db.$transaction(async (tx) => {
        await tx.artifact.create({
          data: {
            id: meshArtifactId,
            projectId,
            kind: "mesh",
            name: meshName,
            description: `Tessellated 3D preview generated by ${result.engineKey}`,
          },
        })
        await tx.artifactRevision.create({
          data: {
            id: meshRevisionId,
            artifactId: meshArtifactId,
            revNumber: 1,
            contentHash: stored.sha256,
            sizeBytes: stored.sizeBytes,
            storageKey: stored.storageKey,
            mimeType: "application/json",
            uploadedBy: `adapter:${result.engineKey}`,
          },
        })
        await tx.artifact.update({
          where: { id: meshArtifactId },
          data: { latestRevisionId: meshRevisionId },
        })
        await tx.artifactLink.create({
          data: {
            id: newId("lnk"),
            fromArtifactId: meshArtifactId,
            toArtifactId: artifactId,
            relationType: "derived_from",
            createdBy: `adapter:${result.engineKey}`,
          },
        })
      })
      revisionNumber = 1
    }

    // Exactly ONE audit event per derive, actor = the engine adapter.
    const actorId = opts?.actor ? opts.actor : `adapter:${result.engineKey}`
    await recordEvent({
      projectId,
      actorType: auditActorType(actorId),
      actorId,
      action: "mesh.derived",
      entityType: "artifact",
      entityId: meshArtifactId,
      detail: {
        engineKey: result.engineKey,
        engineVersion: result.engineVersion,
        adapterScript: result.adapterScript,
        adapterHash: result.adapterHash,
        sourceArtifactId: artifactId,
        sourceRevisionId: revision.id,
        revisionNumber,
        elementCount: counts.elementCount,
        vertexCount: counts.vertexCount,
        triangleCount: counts.triangleCount,
        sha256: stored.sha256,
        ...auditDetailSeam(opts),
      },
    })

    return {
      mesh: {
        artifactId: meshArtifactId,
        name: meshName,
        kind: "mesh",
        revisionNumber,
        contentHash: stored.sha256,
        sizeBytes: stored.sizeBytes,
        elementCount: counts.elementCount,
        vertexCount: counts.vertexCount,
        triangleCount: counts.triangleCount,
        engineKey: result.engineKey,
        engineVersion: result.engineVersion,
        adapterScript: result.adapterScript,
        adapterHash: result.adapterHash,
        derivedFromArtifactId: artifactId,
        derivedFromRevisionId: revision.id,
        sourceLatestRevisionId: revision.id,
        staleSource: false,
      },
      outputArtifactRevisionId: meshRevisionId,
      engineKey: result.engineKey,
      engineVersion: result.engineVersion,
      adapterScript: result.adapterScript,
      adapterHash: result.adapterHash,
      stdoutTail: result.stdoutTail,
      stderrTail: result.stderrTail,
    }
  } catch (err) {
    console.error("[api] mesh derive failed after file write — orphaned bytes remain in store:", err)
    throw err
  }
}

// ---------------------------------------------------------------------------
// build_report — pure assembly (ADR-0006 §2: copies of stored truth ONLY)
// ---------------------------------------------------------------------------

export type ReportFigureSource = "quantity-row" | "mesh-meta"

export type ReportSectionKind = "mesh-summary" | "quantity-ledger" | "run-record"

/**
 * One figure of the report — a VERBATIM copy of a stored number (or stored
 * string of record: hash, engine id) with its source pointer. Nothing here
 * is computed: `value` is the stored QuantityRecord.value / stored mesh-meta
 * field exactly as the DB/file holds it.
 */
export interface ReportFigure {
  name: string
  value: string | number | null
  unit?: string
  /** quantity-row figures carry the row's method/status verbatim (additive) */
  method?: string
  status?: string
  sourceType: ReportFigureSource
  sourceId: string
}

/** One input artifact's contribution: exactly one section per source. */
export interface ReportSource {
  kind: ReportSectionKind
  sourceArtifactId: string
  sourceArtifactName: string
  sourceRevisionId: string
  figures: ReportFigure[]
}

/** Workflow identity carried in the document (when ctx provides one). */
export interface ReportWorkflowRef {
  workflowId?: string
  stepId?: string
  actor: string
}

/** Document header: title + optional workflow identity (no timestamps — byte-determinism). */
export interface ReportHeader {
  title: string
  workflow?: ReportWorkflowRef
}

/** Structural report stats for the broker summary (pure — same sources as the document). */
export interface ReportStats {
  sectionCount: number
  figureCount: number
  sourcesCited: string[]
}

/**
 * Assemble the eos-report/1 document bytes. PURE: no DB, no clock, no node
 * imports — every nested object is re-wrapped in the pinned key order
 * (format → title → workflow? → sections; section: kind → sourceArtifactId →
 * sourceArtifactName → sourceRevisionId → figures), so the bytes depend ONLY
 * on the inputs — never on object-construction order, never on timestamps
 * (Contract A of the mesh lane: creation time lives in the DB revision row).
 */
export function buildReportDocument(inputs: ReportSource[], header: ReportHeader): string {
  const workflow = header.workflow
  return JSON.stringify({
    format: "eos-report/1",
    title: header.title,
    ...(workflow
      ? {
          workflow: {
            ...(workflow.workflowId !== undefined ? { workflowId: workflow.workflowId } : {}),
            ...(workflow.stepId !== undefined ? { stepId: workflow.stepId } : {}),
            actor: workflow.actor,
          },
        }
      : {}),
    sections: inputs.map((source) => ({
      kind: source.kind,
      sourceArtifactId: source.sourceArtifactId,
      sourceArtifactName: source.sourceArtifactName,
      sourceRevisionId: source.sourceRevisionId,
      figures: source.figures.map((figure) =>
        figure.sourceType === "quantity-row"
          ? {
              name: figure.name,
              value: figure.value,
              unit: figure.unit,
              method: figure.method,
              status: figure.status,
              sourceType: figure.sourceType,
              sourceId: figure.sourceId,
            }
          : {
              name: figure.name,
              value: figure.value,
              sourceType: figure.sourceType,
              sourceId: figure.sourceId,
            },
      ),
    })),
  })
}

/** Section/figure counts + the distinct cited source ids (first-citation order). Pure. */
export function reportStats(inputs: ReportSource[]): ReportStats {
  const sourcesCited: string[] = []
  const seen = new Set<string>()
  let figureCount = 0
  for (const source of inputs) {
    for (const figure of source.figures) {
      figureCount += 1
      if (!seen.has(figure.sourceId)) {
        seen.add(figure.sourceId)
        sourcesCited.push(figure.sourceId)
      }
    }
  }
  return { sectionCount: inputs.length, figureCount, sourcesCited }
}

/**
 * Find-or-create matching key (pure): a report artifact belongs to THESE
 * inputs when its `derived_from` TARGET SET equals the input id set exactly
 * — a report citing a superset or subset is a DIFFERENT report (never
 * silently reused). `inputIds` must already be unique (validated upstream).
 */
export function reportMatchesInputs(targetSet: Set<string>, inputIds: string[]): boolean {
  if (targetSet.size !== inputIds.length) return false
  return inputIds.every((id) => targetSet.has(id))
}

/**
 * Read one input artifact's verified content and build its ReportSource:
 *  - mesh input → "mesh-summary" section: elementCount/vertexCount/
 *    triangleCount via meshCounts on the stored eos-mesh/1 file, contentHash
 *    from the revision row, engineKey/engineVersion/adapterHash via
 *    extractGeneratedBy (the same helpers GET /api/artifacts/[id]/mesh serves
 *    meta with) — each figure sourced at the mesh revision id.
 *  - any other input → "quantity-ledger" section: the QuantityRecord rows on
 *    that artifact's LATEST revision (createdAt asc, id tiebreak), value/
 *    unit/method/status copied verbatim — NO recomputation, no aggregation
 *    beyond the structural COUNT in reportStats.
 */
async function assembleReportSource(projectId: string, artifactId: string): Promise<ReportSource> {
  const artifact = await db.artifact.findUnique({
    where: { id: artifactId },
    include: { latestRevision: true },
  })
  if (!artifact || artifact.projectId !== projectId) {
    throw new BrokerRequestError("not_found", `artifact "${artifactId}" not found in project "${projectId}"`)
  }
  if (!artifact.latestRevision) {
    throw new BrokerRequestError("bad_request", `artifact "${artifact.name}" has no revisions to report on`)
  }
  const revision = artifact.latestRevision

  if (artifact.kind === "mesh") {
    const bytes = await readRevisionFile(revision.storageKey)
    let mesh: unknown
    try {
      mesh = JSON.parse(bytes.toString("utf8"))
    } catch (err) {
      throw new Error(`stored mesh revision ${revision.id} is not valid eos-mesh/1 JSON`, { cause: err })
    }
    if (!isPlainObject(mesh) || !Array.isArray((mesh as { elements?: unknown }).elements)) {
      throw new Error(`stored mesh revision ${revision.id} is not a valid eos-mesh/1 document`)
    }
    const counts = meshCounts(mesh as unknown as MeshFile)
    const generatedBy = extractGeneratedBy(mesh)
    const meshFigures: ReportFigure[] = [
      { name: "elementCount", value: counts.elementCount, sourceType: "mesh-meta", sourceId: revision.id },
      { name: "vertexCount", value: counts.vertexCount, sourceType: "mesh-meta", sourceId: revision.id },
      { name: "triangleCount", value: counts.triangleCount, sourceType: "mesh-meta", sourceId: revision.id },
      { name: "contentHash", value: revision.contentHash, sourceType: "mesh-meta", sourceId: revision.id },
      { name: "engineKey", value: generatedBy.engineKey, sourceType: "mesh-meta", sourceId: revision.id },
      { name: "engineVersion", value: generatedBy.engineVersion, sourceType: "mesh-meta", sourceId: revision.id },
      { name: "adapterHash", value: generatedBy.adapterHash, sourceType: "mesh-meta", sourceId: revision.id },
    ]
    return {
      kind: "mesh-summary",
      sourceArtifactId: artifact.id,
      sourceArtifactName: artifact.name,
      sourceRevisionId: revision.id,
      figures: meshFigures,
    }
  }

  // Ledger rows on the artifact's LATEST revision — DB order (createdAt asc,
  // id tiebreak) is the pinned figure order. Values copied verbatim.
  const rows = await db.quantityRecord.findMany({
    where: { sourceArtifactRevisionId: revision.id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  })
  const rowFigures: ReportFigure[] = rows.map((row) => {
    const label = row.elementRef ?? row.sheetRef ?? null
    const name = label !== null && label.length > 0 ? `${label} ${row.quantityType}` : row.quantityType
    return {
      name,
      value: row.value,
      unit: row.unit,
      method: row.method,
      status: row.status,
      sourceType: "quantity-row",
      sourceId: row.id,
    }
  })
  return {
    kind: "quantity-ledger",
    sourceArtifactId: artifact.id,
    sourceArtifactName: artifact.name,
    sourceRevisionId: revision.id,
    figures: rowFigures,
  }
}

/**
 * Find-or-create the target report artifact (mirroring the mesh route's
 * semantics, matched by the derived_from TARGET SET) and append the NEXT
 * sequential revision carrying the assembled document bytes. Existing target
 * → revision + relink in one transaction; new target → artifact + revision +
 * relink + one derived_from link PER input, all in one transaction. Exactly
 * ONE `report.built` audit event (mirroring mesh.derived's shape). The
 * revision starts DRAFT (approvalState default) — build_report NEVER approves
 * anything; the workflow's approve action publishes it.
 */
async function persistReportRevision(
  ctx: BrokerContext,
  artifactIds: string[],
  meta: { title: string; inputCount: number; stats: ReportStats },
  bytes: Buffer,
): Promise<{ artifactId: string; revisionId: string; revisionNumber: number; sha256: string }> {
  // Candidates: kind-"report" artifacts in this project linked derived_from
  // ANY of the inputs; the winner's FULL target set must equal the inputs.
  const seedLinks = await db.artifactLink.findMany({
    where: {
      relationType: "derived_from",
      toArtifactId: { in: artifactIds },
      fromArtifact: { kind: "report", projectId: ctx.projectId },
    },
    select: { fromArtifactId: true },
  })
  const candidateIds = [...new Set(seedLinks.map((link) => link.fromArtifactId))]
  const candidates =
    candidateIds.length > 0
      ? await db.artifact.findMany({
          where: { id: { in: candidateIds } },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { id: true },
        })
      : []
  let targetId: string | null = null
  for (const candidate of candidates) {
    const links = await db.artifactLink.findMany({
      where: { relationType: "derived_from", fromArtifactId: candidate.id },
      select: { toArtifactId: true },
    })
    if (reportMatchesInputs(new Set(links.map((link) => link.toArtifactId)), artifactIds)) {
      targetId = candidate.id
      break
    }
  }

  try {
    let reportArtifactId: string
    let revisionNumber: number
    let revisionId: string
    let stored: StoredRevision

    const existingId = targetId
    if (existingId) {
      const maxRev = await db.artifactRevision.aggregate({
        where: { artifactId: existingId },
        _max: { revNumber: true },
      })
      revisionNumber = (maxRev._max.revNumber ?? 0) + 1
      revisionId = newId("rev")
      stored = await saveRevisionFile(ctx.projectId, existingId, revisionId, bytes)
      await db.$transaction(async (tx) => {
        await tx.artifactRevision.create({
          data: {
            id: revisionId,
            artifactId: existingId,
            revNumber: revisionNumber,
            contentHash: stored.sha256,
            sizeBytes: stored.sizeBytes,
            storageKey: stored.storageKey,
            mimeType: "application/json",
            uploadedBy: ctx.actor,
          },
        })
        await tx.artifact.update({
          where: { id: existingId },
          data: { latestRevisionId: revisionId },
        })
      })
      reportArtifactId = existingId
    } else {
      reportArtifactId = newId("art")
      revisionId = newId("rev")
      stored = await saveRevisionFile(ctx.projectId, reportArtifactId, revisionId, bytes)
      await db.$transaction(async (tx) => {
        await tx.artifact.create({
          data: {
            id: reportArtifactId,
            projectId: ctx.projectId,
            kind: "report",
            name: meta.title,
            description: `QA report assembled from ${meta.inputCount} input artifact(s)`,
          },
        })
        await tx.artifactRevision.create({
          data: {
            id: revisionId,
            artifactId: reportArtifactId,
            revNumber: 1,
            contentHash: stored.sha256,
            sizeBytes: stored.sizeBytes,
            storageKey: stored.storageKey,
            mimeType: "application/json",
            uploadedBy: ctx.actor,
          },
        })
        await tx.artifact.update({
          where: { id: reportArtifactId },
          data: { latestRevisionId: revisionId },
        })
        for (const inputId of artifactIds) {
          await tx.artifactLink.create({
            data: {
              id: newId("lnk"),
              fromArtifactId: reportArtifactId,
              toArtifactId: inputId,
              relationType: "derived_from",
              createdBy: ctx.actor,
            },
          })
        }
      })
      revisionNumber = 1
    }

    // Exactly ONE audit event per build, mirroring mesh.derived's shape.
    await recordEvent({
      projectId: ctx.projectId,
      actorType: auditActorType(ctx.actor),
      actorId: ctx.actor,
      action: "report.built",
      entityType: "artifact",
      entityId: reportArtifactId,
      detail: {
        ...(ctx.workflowId !== undefined ? { workflowId: ctx.workflowId } : {}),
        ...(ctx.stepId !== undefined ? { stepId: ctx.stepId } : {}),
        inputArtifactIds: artifactIds,
        outputRevisionId: revisionId,
        figureCount: meta.stats.figureCount,
        sha256: stored.sha256,
      },
    })

    return { artifactId: reportArtifactId, revisionId, revisionNumber, sha256: stored.sha256 }
  } catch (err) {
    console.error("[api] report build failed after file write — orphaned bytes remain in store:", err)
    throw err
  }
}

// ---------------------------------------------------------------------------
// Phase-5 disciplines ops (contract §4/§2 — W2-f): pure document builders
// first (byte-deterministic, pinned key orders, NO timestamps), then the
// shared derived-artifact persistence, then the five cores.
// ---------------------------------------------------------------------------

/** Pinned 422 `unsupported` text for a non-model artifact handed to fe_mesh. */
export function femeshUnsupportedMessage(artifactName: string, storageKey: string): string {
  return `artifact "${artifactName}" (storage key ${storageKey}) does not carry a meshable model extension (.step/.stp/.ifc)`
}

/** The three per-op no-revision `bad_request` texts (mirror the derive cores' style). */
export const FEMESH_NO_REVISIONS_MESSAGE = "This artifact has no revisions to generate an FE mesh from"
export const POWERFLOW_NO_REVISIONS_MESSAGE = "This artifact has no revisions to run a power flow on"
export const DES_NO_REVISIONS_MESSAGE = "This artifact has no revisions to simulate"
export const CONVERT_NO_REVISIONS_MESSAGE = "This artifact has no revisions to convert"
export const ANALYZE_NO_REVISIONS_MESSAGE = "This artifact has no revisions to analyze"

/** Pinned 422 `unsupported` text for a JSON artifact of the wrong analysis format. */
export function notAnalysisFormatMessage(artifactName: string, expectedFormat: string, got: string): string {
  return `artifact "${artifactName}" is not an ${expectedFormat} document (format ${got})`
}

/** Pinned 422 `unsupported` text for content that is not JSON at all. */
export function notJsonDocumentMessage(artifactName: string, expectedFormat: string): string {
  return `artifact "${artifactName}" is not an ${expectedFormat} document (content is not valid JSON)`
}

/**
 * Read + gate a stored JSON artifact for one of the analysis ops (§3 formats):
 * content must parse as a JSON object whose `format` field equals
 * `expectedFormat`. Refuses honestly (422 `unsupported`) otherwise — never
 * guesses, never hands alien content to an adapter or the platform core.
 */
async function readJsonArtifact(
  projectId: string,
  artifactId: string,
  expectedFormat: string,
  noRevisionsMessage: string,
): Promise<{ artifact: { id: string; name: string }; revision: { id: string; storageKey: string }; json: Record<string, unknown> }> {
  const project = await db.project.findUnique({ where: { id: projectId }, select: { id: true } })
  if (!project) throw new BrokerRequestError("not_found", "Project not found", "Project")

  const artifact = await db.artifact.findUnique({
    where: { id: artifactId },
    include: { latestRevision: true },
  })
  if (!artifact || artifact.projectId !== projectId) {
    throw new BrokerRequestError("not_found", "Artifact not found", "Artifact")
  }
  if (!artifact.latestRevision) {
    throw new BrokerRequestError("bad_request", noRevisionsMessage)
  }
  const revision = artifact.latestRevision

  const bytes = await readRevisionFile(revision.storageKey)
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString("utf8"))
  } catch {
    throw new BrokerRefusalError("unsupported", notJsonDocumentMessage(artifact.name, expectedFormat))
  }
  if (!isPlainObject(parsed)) {
    throw new BrokerRefusalError("unsupported", notJsonDocumentMessage(artifact.name, expectedFormat))
  }
  if (parsed.format !== expectedFormat) {
    throw new BrokerRefusalError(
      "unsupported",
      notAnalysisFormatMessage(artifact.name, expectedFormat, JSON.stringify(parsed.format ?? null)),
    )
  }
  return { artifact: { id: artifact.id, name: artifact.name }, revision: { id: revision.id, storageKey: revision.storageKey }, json: parsed }
}

// ---------------------------------------------------------------------------
// Pure §2 document builders (byte-deterministic: pinned key orders, every
// nested object re-wrapped, NO timestamps — creation time lives in the DB
// revision row; numbers are the engine's verbatim IEEE doubles)
// ---------------------------------------------------------------------------

/** Engine identity block of eos-femesh/1 (NO adapterHash in the document — §2). */
export interface DocumentGeneratedBy {
  engineKey: string
  engineVersion: string
  adapterScript: string
}

/**
 * Assemble the eos-femesh/1 document bytes. PURE: pinned key order
 * format → sourceArtifactName → units → generatedBy → meshSizeMin →
 * meshSizeMax → elementOrder → nodes → elements → solids → quality;
 * solids in the adapter's literal ascending order; name optional (omitted
 * when absent); no timestamps anywhere.
 */
export function buildFeMeshDocument(
  sourceArtifactName: string,
  generatedBy: DocumentGeneratedBy,
  parameters: FeMeshParameters,
  payload: Pick<FeMeshResult, "nodes" | "elements" | "solids" | "quality">,
): string {
  return JSON.stringify({
    format: "eos-femesh/1",
    sourceArtifactName,
    units: "mm",
    generatedBy: {
      engineKey: generatedBy.engineKey,
      engineVersion: generatedBy.engineVersion,
      adapterScript: generatedBy.adapterScript,
    },
    meshSizeMin: parameters.meshSizeMin,
    meshSizeMax: parameters.meshSizeMax,
    elementOrder: parameters.elementOrder,
    nodes: { count: payload.nodes.count },
    elements: { type: payload.elements.type, count: payload.elements.count },
    solids: payload.solids.map((solid) => ({
      ref: solid.ref,
      ...(solid.name !== undefined ? { name: solid.name } : {}),
      tetCount: solid.tetCount,
      meshVolume: solid.meshVolume,
    })),
    quality: { min: payload.quality.min, mean: payload.quality.mean },
  })
}

/**
 * Assemble the eos-powerflow/1 document bytes. PURE: pinned key order
 * format → sourceArtifactName → converged → buses → lines → totals; every
 * numeric is the engine's verbatim result-frame double (ADR-0006 §2 —
 * nobody rounds "for presentation").
 */
export function buildPowerflowDocument(
  sourceArtifactName: string,
  payload: { converged: boolean; buses: PowerflowBus[]; lines: PowerflowLine[]; totals: PowerflowTotals },
): string {
  return JSON.stringify({
    format: "eos-powerflow/1",
    sourceArtifactName,
    converged: payload.converged,
    buses: payload.buses.map((bus) => ({
      id: bus.id,
      vmPu: bus.vmPu,
      angleDeg: bus.angleDeg,
      pMw: bus.pMw,
      qMvar: bus.qMvar,
    })),
    lines: payload.lines.map((line) => ({
      fromBus: line.fromBus,
      toBus: line.toBus,
      iKa: line.iKa,
      pLossMw: line.pLossMw,
      qLossMvar: line.qLossMvar,
    })),
    totals: { lossMw: payload.totals.lossMw, loadMw: payload.totals.loadMw },
  })
}

/**
 * Assemble the eos-des/1 document bytes. PURE: pinned key order
 * format → sourceArtifactName → policy → makespan → resources → jobs; time
 * values verbatim from the deterministic SimPy event record.
 */
export function buildDesDocument(
  sourceArtifactName: string,
  payload: { policy: "fifo"; makespan: number; resources: DesResource[]; jobs: DesJob[] },
): string {
  return JSON.stringify({
    format: "eos-des/1",
    sourceArtifactName,
    policy: payload.policy,
    makespan: payload.makespan,
    resources: payload.resources.map((resource) => ({
      id: resource.id,
      busy: resource.busy,
      utilization: resource.utilization,
    })),
    jobs: payload.jobs.map((job) => ({
      id: job.id,
      startAt: job.startAt,
      endAt: job.endAt,
    })),
  })
}

/**
 * Assemble the eos-cpm/1 document bytes. PURE: pinned key order
 * format → sourceArtifactName → activities → criticalPath → durationDays;
 * activity key order id → name → durationDays → es → ef → ls → lf →
 * totalFloat → critical. The values come from W3-f's pure `analyzeCpm` core
 * (contract §6) — byte-deterministic because the core is.
 */
export function buildCpmAnalysisDocument(sourceArtifactName: string, result: CpmActivityResult): string {
  return JSON.stringify({
    format: "eos-cpm/1",
    sourceArtifactName,
    activities: result.activities.map((activity) => ({
      id: activity.id,
      name: activity.name,
      durationDays: activity.durationDays,
      es: activity.es,
      ef: activity.ef,
      ls: activity.ls,
      lf: activity.lf,
      totalFloat: activity.totalFloat,
      critical: activity.critical,
    })),
    criticalPath: result.criticalPath,
    durationDays: result.durationDays,
  })
}

// ---------------------------------------------------------------------------
// Pure input defenses for the new ops (testable without any DB)
// ---------------------------------------------------------------------------

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
}

/**
 * Validate + default the fe_mesh parameters (contract §4: meshSizeMin 2.0 /
 * meshSizeMax 4.0 / elementOrder 1 — linear tets only this phase). Pure; the
 * pinned 422 `unsupported` messages are returned verbatim for the routes.
 */
export function feMeshBrokerParameters(
  parameters: Record<string, unknown>,
): { ok: true; value: FeMeshParameters } | { ok: false; message: string } {
  const min = parameters.meshSizeMin ?? 2.0
  const max = parameters.meshSizeMax ?? 4.0
  const order = parameters.elementOrder ?? 1
  if (!isPositiveFinite(min)) {
    return { ok: false, message: "fe_mesh parameters.meshSizeMin must be a positive number when provided" }
  }
  if (!isPositiveFinite(max)) {
    return { ok: false, message: "fe_mesh parameters.meshSizeMax must be a positive number when provided" }
  }
  if (min > max) {
    return { ok: false, message: "fe_mesh parameters.meshSizeMin must be <= parameters.meshSizeMax" }
  }
  if (order !== 1) {
    return {
      ok: false,
      message: `fe_mesh parameters.elementOrder must be 1 (linear tets only in this phase) — got ${JSON.stringify(parameters.elementOrder)}`,
    }
  }
  return { ok: true, value: { meshSizeMin: min, meshSizeMax: max, elementOrder: 1 } }
}

/** Pinned §3.1 activity id pattern (a-z0-9-, 1..32 — the zod's pattern). */
const SCHEDULE_ID_RE = /^[a-z0-9-]{1,32}$/

/**
 * Structural §3.1 defense for analyze_schedule (pure; the create-route zod is
 * the primary gate, the platform core owns the graph errors — cycles and
 * unknown predecessors surface from `analyzeCpm` with the §3.1 messages). This
 * defense owns the joined `invalid schedule: path: msg; …` style plus the
 * pinned duplicate-id message, because stored bytes are never trusted.
 */
export function validateScheduleDocument(
  json: Record<string, unknown>,
): { ok: true; value: CpmActivity[] } | { ok: false; error: string } {
  const problems: string[] = []
  const failWith = (messages: string[]): { ok: false; error: string } => ({
    ok: false,
    error: messages.length === 1 ? `invalid schedule: ${messages[0]}` : `invalid schedule: ${messages.join("; ")}`,
  })

  const activities = json.activities
  if (!Array.isArray(activities) || activities.length < 1 || activities.length > 64) {
    return failWith(["activities: must be an array of 1..64 activities"])
  }

  const seen = new Set<string>()
  const value: CpmActivity[] = []
  activities.forEach((raw, i) => {
    if (!isPlainObject(raw)) {
      problems.push(`activities[${i}]: must be an object`)
      return
    }
    const id = raw.id
    if (typeof id !== "string" || !SCHEDULE_ID_RE.test(id)) {
      problems.push(`activities[${i}].id: must match ^[a-z0-9-]{1,32}$`)
      return
    }
    if (seen.has(id)) {
      problems.push(`activity id "${id}" is used more than once`)
      return
    }
    seen.add(id)
    const name = raw.name
    if (typeof name !== "string" || name.length < 1 || name.length > 200) {
      problems.push(`activities[${i}].name: must be a string of 1..200 characters`)
      return
    }
    const durationDays = raw.durationDays
    if (typeof durationDays !== "number" || !Number.isInteger(durationDays) || durationDays < 0 || durationDays > 10000) {
      problems.push(`activities[${i}].durationDays: must be an integer between 0 and 10000`)
      return
    }
    const predecessorIds = raw.predecessorIds
    if (!Array.isArray(predecessorIds) || predecessorIds.some((p) => typeof p !== "string" || p.length === 0)) {
      problems.push(`activities[${i}].predecessorIds: must be an array of activity id strings`)
      return
    }
    value.push({ id, name, durationDays, predecessorIds: predecessorIds as string[] })
  })

  if (problems.length > 0) return failWith(problems)
  return { ok: true, value }
}

/**
 * The analyze_schedule outcome builder (pure): a platform-core BrokerOutcome
 * carries NO engine fields — engineKey/engineVersion/adapterScript/adapterHash
 * are ABSENT (visible as nulls in the workflow execution record), exitCode is
 * 0 (no adapter subprocess ran; build_report uses null for the same reason).
 */
export function platformCoreOutcome(
  summary: Record<string, unknown>,
  outputArtifactRevisionId: string,
  durationMs: number,
): BrokerOutcome {
  return {
    summary,
    outputArtifactRevisionId,
    exitCode: 0,
    durationMs,
  }
}

// ---------------------------------------------------------------------------
// Shared derived-artifact persistence for the Phase-5 ops (the build_report
// find-or-create semantics, generalized per-op; contract §4)
// ---------------------------------------------------------------------------

interface DerivedPersistSpec {
  /** log label for the honest orphan-log line */
  opLabel: string
  kind: "fe-mesh" | "analysis" | "pdf" | "model"
  /** stored-content discriminator (the JSON `format` field); null = binary (pdf, STEP) */
  format: string | null
  name: string
  description: string
  bytes: Buffer
  mimeType: string
  /** revision uploadedBy + link createdBy — `adapter:<engine>` or ctx.actor (report precedent) */
  contentAuthor: string
  inputIds: string[]
  audit: { actor: string; action: string; detail: Record<string, unknown> }
}

/** Parse a stored revision's content and return its JSON `format` field (or null). */
async function storedJsonFormat(storageKey: string): Promise<string | null> {
  try {
    const parsed = JSON.parse((await readRevisionFile(storageKey)).toString("utf8"))
    if (isPlainObject(parsed) && typeof parsed.format === "string") return parsed.format
    return null
  } catch {
    return null // unparseable content is not this op's target (conservative, honest)
  }
}

/**
 * Find-or-create the derived artifact (matched by the derived_from TARGET SET
 * — the build_report precedent — plus the stored `format` discriminator,
 * which keeps the three kind-"analysis" ops' outputs distinct on the same
 * source), then append the NEXT sequential revision (DRAFT — publishing stays
 * a human act, ADR-0006), and record exactly ONE audit event.
 */
async function persistDerivedArtifactRevision(
  projectId: string,
  opts: BrokerDeriveOptions | undefined,
  sourceArtifactId: string,
  sourceRevisionId: string,
  spec: DerivedPersistSpec,
): Promise<{ artifactId: string; revisionId: string; revisionNumber: number; sha256: string; sizeBytes: number; name: string }> {
  const seedLinks = await db.artifactLink.findMany({
    where: {
      relationType: "derived_from",
      toArtifactId: { in: spec.inputIds },
      fromArtifact: { kind: spec.kind, projectId },
    },
    orderBy: { createdAt: "asc" },
    include: { fromArtifact: { include: { latestRevision: { select: { storageKey: true } } } } },
  })

  let targetId: string | null = null
  for (const link of [...new Map(seedLinks.map((l) => [l.fromArtifactId, l])).values()]) {
    if (spec.format !== null) {
      const fmt = link.fromArtifact.latestRevision
        ? await storedJsonFormat(link.fromArtifact.latestRevision.storageKey)
        : null
      if (fmt !== spec.format) continue
    }
    targetId = link.fromArtifactId
    break
  }

  try {
    let artifactId: string
    let revisionNumber: number
    let revisionId: string
    let stored: StoredRevision

    if (targetId) {
      const maxRev = await db.artifactRevision.aggregate({
        where: { artifactId: targetId },
        _max: { revNumber: true },
      })
      revisionNumber = (maxRev._max.revNumber ?? 0) + 1
      revisionId = newId("rev")
      stored = await saveRevisionFile(projectId, targetId, revisionId, spec.bytes)
      await db.$transaction(async (tx) => {
        await tx.artifactRevision.create({
          data: {
            id: revisionId,
            artifactId: targetId as string,
            revNumber: revisionNumber,
            contentHash: stored.sha256,
            sizeBytes: stored.sizeBytes,
            storageKey: stored.storageKey,
            mimeType: spec.mimeType,
            uploadedBy: spec.contentAuthor,
          },
        })
        await tx.artifact.update({
          where: { id: targetId as string },
          data: { latestRevisionId: revisionId },
        })
      })
      artifactId = targetId
    } else {
      artifactId = newId("art")
      revisionId = newId("rev")
      stored = await saveRevisionFile(projectId, artifactId, revisionId, spec.bytes)
      await db.$transaction(async (tx) => {
        await tx.artifact.create({
          data: {
            id: artifactId,
            projectId,
            kind: spec.kind,
            name: spec.name,
            description: spec.description,
          },
        })
        await tx.artifactRevision.create({
          data: {
            id: revisionId,
            artifactId,
            revNumber: 1,
            contentHash: stored.sha256,
            sizeBytes: stored.sizeBytes,
            storageKey: stored.storageKey,
            mimeType: spec.mimeType,
            uploadedBy: spec.contentAuthor,
          },
        })
        await tx.artifact.update({
          where: { id: artifactId },
          data: { latestRevisionId: revisionId },
        })
        for (const inputId of spec.inputIds) {
          await tx.artifactLink.create({
            data: {
              id: newId("lnk"),
              fromArtifactId: artifactId,
              toArtifactId: inputId,
              relationType: "derived_from",
              createdBy: spec.contentAuthor,
            },
          })
        }
      })
      revisionNumber = 1
    }

    // Exactly ONE audit event per run; the workflow seam appends the additive
    // detail fields on the executor path (route path: byte-stable).
    await recordEvent({
      projectId,
      actorType: auditActorType(spec.audit.actor),
      actorId: spec.audit.actor,
      action: spec.audit.action,
      entityType: "artifact",
      entityId: artifactId,
      detail: {
        ...spec.audit.detail,
        sourceArtifactId,
        sourceRevisionId,
        revisionNumber,
        sha256: stored.sha256,
        ...auditDetailSeam(opts),
      },
    })

    return { artifactId, revisionId, revisionNumber, sha256: stored.sha256, sizeBytes: stored.sizeBytes, name: spec.name }
  } catch (err) {
    console.error(`[broker] ${spec.opLabel} failed after file write — orphaned bytes remain in store:`, err)
    throw err
  }
}

// ---------------------------------------------------------------------------
// The five Phase-5 cores (route wrappers call these — contract §8)
// ---------------------------------------------------------------------------

/** Pinned 201 `femesh` response object (exact key order — mirror of the mesh 201). */
export interface BrokerFeMeshResponse {
  artifactId: string
  name: string
  kind: "fe-mesh"
  revisionNumber: number
  contentHash: string
  sizeBytes: number
  format: "eos-femesh/1"
  units: "mm"
  nodeCount: number
  elementCount: number
  solidCount: number
  meshSizeMin: number
  meshSizeMax: number
  elementOrder: number
  engineKey: string
  engineVersion: string
  adapterScript: string
  adapterHash: string
  derivedFromArtifactId: string
  derivedFromRevisionId: string
  sourceLatestRevisionId: string
  staleSource: false
}

export interface BrokerFeMeshResult {
  femesh: BrokerFeMeshResponse
  outputArtifactRevisionId: string
  engineKey: string
  engineVersion: string
  adapterScript: string
  adapterHash: string
  stdoutTail?: string
  stderrTail?: string
}

/**
 * Core of POST …/fe-mesh — the REAL gmsh linear-tet FE-mesh run (contract §4/§5.1):
 * gate the artifact as a model (canonical multi-signal detection), run the
 * bridge (gmsh + system-library bootstrap via LD_LIBRARY_PATH), assemble the
 * byte-deterministic eos-femesh/1 document, find-or-create the kind-"fe-mesh"
 * artifact (DRAFT revision appended per run), exactly ONE `femesh.derived`
 * audit event. `opts` is the workflow seam (route path: `adapter:gmsh` actor).
 */
export async function brokerFeMeshCore(
  projectId: string,
  artifactId: string,
  parameters: Record<string, unknown>,
  opts?: BrokerDeriveOptions,
): Promise<BrokerFeMeshResult> {
  const params = feMeshBrokerParameters(parameters)
  if (!params.ok) throw new BrokerRefusalError("unsupported", params.message)

  const project = await db.project.findUnique({ where: { id: projectId }, select: { id: true } })
  if (!project) throw new BrokerRequestError("not_found", "Project not found", "Project")

  const artifact = await db.artifact.findUnique({
    where: { id: artifactId },
    include: { latestRevision: true },
  })
  if (!artifact || artifact.projectId !== projectId) {
    throw new BrokerRequestError("not_found", "Artifact not found", "Artifact")
  }
  if (!artifact.latestRevision) {
    throw new BrokerRequestError("bad_request", FEMESH_NO_REVISIONS_MESSAGE)
  }
  const revision = artifact.latestRevision

  const kind = deriveKind(revision.storageKey, artifact.name, revision.mimeType)
  if (!kind) {
    throw new BrokerRefusalError("unsupported", femeshUnsupportedMessage(artifact.name, revision.storageKey))
  }

  const absPath = path.join(getStorageRoot(), revision.storageKey, "content")

  let result: Awaited<ReturnType<typeof feMeshFromFile>>
  try {
    result = await feMeshFromFile(absPath, kind, parameters)
  } catch (err) {
    if (err instanceof EngineUnavailableError) {
      throw new BrokerRefusalError("engine_unavailable", err.message)
    }
    throw err // unexpected adapter failure → honest 500 via the route handler, logged
  }

  const document = buildFeMeshDocument(
    artifact.name,
    { engineKey: result.engineKey, engineVersion: result.engineVersion, adapterScript: result.adapterScript },
    params.value,
    result,
  )
  const bytes = Buffer.from(document, "utf8")
  const stored = await persistDerivedArtifactRevision(projectId, opts, artifactId, revision.id, {
    opLabel: "fe_mesh",
    kind: "fe-mesh",
    format: "eos-femesh/1",
    name: `${artifact.name} — FE mesh`,
    description: `Linear tetrahedral FE mesh generated by ${result.engineKey}`,
    bytes,
    mimeType: "application/json",
    contentAuthor: `adapter:${result.engineKey}`,
    inputIds: [artifactId],
    audit: {
      actor: opts?.actor ?? `adapter:${result.engineKey}`,
      action: "femesh.derived",
      detail: {
        engineKey: result.engineKey,
        engineVersion: result.engineVersion,
        adapterScript: result.adapterScript,
        adapterHash: result.adapterHash,
        nodeCount: result.nodes.count,
        elementCount: result.elements.count,
        solidCount: result.solids.length,
      },
    },
  })

  return {
    femesh: {
      artifactId: stored.artifactId,
      name: stored.name,
      kind: "fe-mesh",
      revisionNumber: stored.revisionNumber,
      contentHash: stored.sha256,
      sizeBytes: stored.sizeBytes,
      format: "eos-femesh/1",
      units: "mm",
      nodeCount: result.nodes.count,
      elementCount: result.elements.count,
      solidCount: result.solids.length,
      meshSizeMin: params.value.meshSizeMin,
      meshSizeMax: params.value.meshSizeMax,
      elementOrder: params.value.elementOrder,
      engineKey: result.engineKey,
      engineVersion: result.engineVersion,
      adapterScript: result.adapterScript,
      adapterHash: result.adapterHash,
      derivedFromArtifactId: artifactId,
      derivedFromRevisionId: revision.id,
      sourceLatestRevisionId: revision.id,
      staleSource: false,
    },
    outputArtifactRevisionId: stored.revisionId,
    engineKey: result.engineKey,
    engineVersion: result.engineVersion,
    adapterScript: result.adapterScript,
    adapterHash: result.adapterHash,
    stdoutTail: result.stdoutTail,
    stderrTail: result.stderrTail,
  }
}

// ---------------------------------------------------------------------------
// Vector takeoff (Slice 15, roadmap-gap-audit item 1): the pdfplumber/ezdxf
// adapters (16-R1 research; harness cases sheet-vector-* / dxf-takeoff-room)
// extract REAL vector geometry from PDF sheets and DXF drawings. The ops
// persist the extraction as a byte-deterministic eos-vector-takeoff/1
// document on a find-or-create kind-"calculation" artifact derived_from the
// source revision (the femesh precedent). Ledger rows stay HUMAN-disposed:
// the extraction artifact is the evidence; recording quantities from it goes
// through the existing quantities contract (the Sheet Measure discipline).
// ---------------------------------------------------------------------------

/** Pinned 422 for a sheet op handed a non-PDF revision. */
function takeoffSheetUnsupportedMessage(name: string): string {
  return `takeoff_sheet requires a PDF sheet revision — "${name}" carries no PDF signal (.pdf name or application/pdf MIME)`
}

/**
 * Pinned 422 for the drawing op handed a DWG — the honest boundary from the
 * 16-R1 research: no open, CI-pinnable DWG path exists (LibreDWG is not on
 * PyPI or in any Debian/Ubuntu suite; ODA File Converter is proprietary
 * freeware). DXF-native takeoff + documented operator-side conversion.
 */
const TAKEOFF_DWG_REFUSAL_MESSAGE =
  "DWG is not supported for vector takeoff — convert the drawing to DXF first (ODA File Converter, or LibreDWG's dwg2dxf; both are operator-installed external tools, the LibreOffice probe-path pattern) and register the converted file as a new revision"

/** Pinned 422 for the drawing op handed a non-DXF revision. */
function takeoffDrawingUnsupportedMessage(name: string): string {
  return `takeoff_drawing requires a DXF drawing revision — "${name}" carries no DXF signal (.dxf name or image/vnd.dxf MIME)`
}

function isPdfSignal(name: string, mimeType: string | null | undefined): boolean {
  return name.toLowerCase().endsWith(".pdf") || mimeType === "application/pdf"
}

function isDxfSignal(name: string, mimeType: string | null | undefined): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith(".dxf") || mimeType === "image/vnd.dxf" || mimeType === "application/dxf"
}

function isDwgSignal(name: string, mimeType: string | null | undefined): boolean {
  return name.toLowerCase().endsWith(".dwg") || mimeType === "image/vnd.dwg"
}

/**
 * Validate + default the sheet-takeoff parameters (the bridge re-validates —
 * defense in depth, the femesh §4 pattern). PURE.
 */
export function takeoffSheetBrokerParameters(
  raw: Record<string, unknown>,
): { ok: true; value: { pageNo: number; flattenSegments: number } } | { ok: false; message: string } {
  let pageNo = 1
  if (raw.pageNo !== undefined) {
    if (typeof raw.pageNo !== "number" || !Number.isInteger(raw.pageNo) || raw.pageNo < 1) {
      return { ok: false, message: "takeoff_sheet parameters.pageNo must be a positive integer when provided" }
    }
    pageNo = raw.pageNo
  }
  let flattenSegments = 32
  if (raw.flattenSegments !== undefined) {
    if (
      typeof raw.flattenSegments !== "number" ||
      !Number.isInteger(raw.flattenSegments) ||
      raw.flattenSegments < 4 ||
      raw.flattenSegments > 256
    ) {
      return {
        ok: false,
        message: "takeoff_sheet parameters.flattenSegments must be an integer 4..256 when provided",
      }
    }
    flattenSegments = raw.flattenSegments
  }
  return { ok: true, value: { pageNo, flattenSegments } }
}

/**
 * Validate the drawing-takeoff layer filter: an optional array of strings,
 * deduplicated + sorted (the bridge normalizes identically). PURE.
 */
export function takeoffDrawingLayerFilter(
  raw: Record<string, unknown>,
): { ok: true; value: string[] | undefined } | { ok: false; message: string } {
  if (raw.layerFilter === undefined) return { ok: true, value: undefined }
  if (!Array.isArray(raw.layerFilter) || raw.layerFilter.some((l) => typeof l !== "string" || l.length === 0)) {
    return { ok: false, message: "takeoff_drawing parameters.layerFilter must be an array of non-empty layer names when provided" }
  }
  return { ok: true, value: [...new Set(raw.layerFilter as string[])].sort() }
}

/** Byte-deterministic eos-vector-takeoff/1 document (the harness pins this). */
export function buildVectorTakeoffDocument(
  sourceName: string,
  sourceKind: "sheet" | "drawing",
  engine: { engineKey: string; engineVersion: string; adapterScript: string },
  provenance: Record<string, unknown>,
  result: SheetTakeoffResult | DxfTakeoffResult,
): string {
  return JSON.stringify({
    format: "eos-vector-takeoff/1",
    source: { name: sourceName, kind: sourceKind },
    engine,
    provenance,
    result,
  })
}

/** Pinned 201 `takeoff_sheet` result object (the femesh shape, takeoff fields). */
export interface BrokerTakeoffSheetResult {
  takeoff: {
    artifactId: string
    name: string
    kind: "analysis"
    revisionNumber: number
    contentHash: string
    sizeBytes: number
    format: "eos-vector-takeoff/1"
    pageNo: number
    pageCount: number
    scaleMmPerPt: number
    scaleSource: "explicit-parameter" | "calibration-markup"
    lineCount: number
    rectCount: number
    curveCount: number
    textCount: number
    engineKey: "pdfplumber"
    engineVersion: string
    adapterScript: string
    adapterHash: string
    derivedFromArtifactId: string
    derivedFromRevisionId: string
    sourceLatestRevisionId: string
    staleSource: boolean
  }
  outputArtifactRevisionId: string
  engineKey: "pdfplumber"
  engineVersion: string
  adapterScript: string
  adapterHash: string
  stdoutTail?: string
  stderrTail?: string
}

export async function brokerTakeoffSheetCore(
  projectId: string,
  artifactId: string,
  parameters: Record<string, unknown>,
  opts?: BrokerDeriveOptions,
): Promise<BrokerTakeoffSheetResult> {
  const params = takeoffSheetBrokerParameters(parameters)
  if (!params.ok) throw new BrokerRefusalError("unsupported", params.message)

  let scaleMmPerPt: number | undefined
  if (parameters.scaleMmPerPt !== undefined) {
    if (
      typeof parameters.scaleMmPerPt !== "number" ||
      !Number.isFinite(parameters.scaleMmPerPt) ||
      parameters.scaleMmPerPt <= 0
    ) {
      throw new BrokerRefusalError(
        "unsupported",
        "takeoff_sheet parameters.scaleMmPerPt must be a positive number when provided",
      )
    }
    scaleMmPerPt = parameters.scaleMmPerPt
  }
  let scaleSource: "explicit-parameter" | "calibration-markup" = "explicit-parameter"

  const project = await db.project.findUnique({ where: { id: projectId }, select: { id: true } })
  if (!project) throw new BrokerRequestError("not_found", "Project not found", "Project")

  const artifact = await db.artifact.findUnique({
    where: { id: artifactId },
    include: { latestRevision: true },
  })
  if (!artifact || artifact.projectId !== projectId) {
    throw new BrokerRequestError("not_found", "Artifact not found", "Artifact")
  }
  if (!artifact.latestRevision) {
    throw new BrokerRequestError("bad_request", "This artifact has no revisions to take off from")
  }
  const revision = artifact.latestRevision

  if (!isPdfSignal(artifact.name, revision.mimeType) && !isPdfSignal(revision.storageKey, revision.mimeType)) {
    throw new BrokerRefusalError("unsupported", takeoffSheetUnsupportedMessage(artifact.name))
  }

  // Scale resolution: explicit parameter first; else the revision's latest
  // calibration markup (the Sheet Measure machinery — a click calibration
  // carries the recorded ~0.35% browser bias, limitation #16, so the
  // scaleSource provenance records WHICH value produced these numbers).
  if (scaleMmPerPt === undefined) {
    const calibration = await db.sheetMarkup.findFirst({
      where: { revisionId: revision.id, kind: "calibration" },
      orderBy: { createdAt: "desc" },
      select: { value: true },
    })
    if (!calibration || !Number.isFinite(calibration.value) || calibration.value <= 0) {
      throw new BrokerRefusalError(
        "unsupported",
        "no calibration for this revision — calibrate the sheet in Sheet Measure first, or pass parameters.scaleMmPerPt explicitly",
      )
    }
    scaleMmPerPt = calibration.value
    scaleSource = "calibration-markup"
  }

  const absPath = path.join(getStorageRoot(), revision.storageKey, "content")

  let result: SheetTakeoffResult
  try {
    result = await sheetTakeoffFromStorage(absPath, {
      pageNo: params.value.pageNo,
      scaleMmPerPt,
      flattenSegments: params.value.flattenSegments,
    })
  } catch (err) {
    if (err instanceof EngineUnavailableError) {
      throw new BrokerRefusalError("engine_unavailable", err.message)
    }
    throw err // unexpected adapter failure → honest 500 via the route handler, logged
  }

  const document = buildVectorTakeoffDocument(
    artifact.name,
    "sheet",
    { engineKey: result.engineKey, engineVersion: result.engineVersion, adapterScript: result.adapterScript },
    {
      pageNo: params.value.pageNo,
      flattenSegments: params.value.flattenSegments,
      scaleMmPerPt,
      scaleSource,
    },
    result,
  )
  const bytes = Buffer.from(document, "utf8")
  const stored = await persistDerivedArtifactRevision(projectId, opts, artifactId, revision.id, {
    opLabel: "takeoff_sheet",
    kind: "analysis",
    format: "eos-vector-takeoff/1",
    name: `${artifact.name} — vector takeoff (p${params.value.pageNo})`,
    description: `Vector sheet takeoff extracted by ${result.engineKey} (real drawn path operators, no simulation)`,
    bytes,
    mimeType: "application/json",
    contentAuthor: `adapter:${result.engineKey}`,
    inputIds: [artifactId],
    audit: {
      actor: opts?.actor ?? `adapter:${result.engineKey}`,
      action: "takeoff.vectorDerived",
      detail: {
        engineKey: result.engineKey,
        engineVersion: result.engineVersion,
        adapterScript: result.adapterScript,
        adapterHash: result.adapterHash,
        pageNo: result.pageNo,
        pageCount: result.pageCount,
        scaleMmPerPt,
        scaleSource,
        lineCount: result.entities.lines.count,
        rectCount: result.entities.rects.count,
        curveCount: result.entities.curves.count,
        textCount: result.text.length,
      },
    },
  })

  return {
    takeoff: {
      artifactId: stored.artifactId,
      name: stored.name,
      kind: "analysis",
      revisionNumber: stored.revisionNumber,
      contentHash: stored.sha256,
      sizeBytes: stored.sizeBytes,
      format: "eos-vector-takeoff/1",
      pageNo: result.pageNo,
      pageCount: result.pageCount,
      scaleMmPerPt,
      scaleSource,
      lineCount: result.entities.lines.count,
      rectCount: result.entities.rects.count,
      curveCount: result.entities.curves.count,
      textCount: result.text.length,
      engineKey: result.engineKey,
      engineVersion: result.engineVersion,
      adapterScript: result.adapterScript,
      adapterHash: result.adapterHash,
      derivedFromArtifactId: artifactId,
      derivedFromRevisionId: revision.id,
      sourceLatestRevisionId: revision.id,
      staleSource: false,
    },
    outputArtifactRevisionId: stored.revisionId,
    engineKey: result.engineKey,
    engineVersion: result.engineVersion,
    adapterScript: result.adapterScript,
    adapterHash: result.adapterHash,
  }
}

/** Pinned 201 `takeoff_drawing` result object. */
export interface BrokerTakeoffDrawingResult {
  takeoff: {
    artifactId: string
    name: string
    kind: "analysis"
    revisionNumber: number
    contentHash: string
    sizeBytes: number
    format: "eos-vector-takeoff/1"
    layerCount: number
    entityCount: number
    unitsMm: boolean
    layerFilter?: string[]
    engineKey: "ezdxf"
    engineVersion: string
    adapterScript: string
    adapterHash: string
    derivedFromArtifactId: string
    derivedFromRevisionId: string
    sourceLatestRevisionId: string
    staleSource: boolean
  }
  outputArtifactRevisionId: string
  engineKey: "ezdxf"
  engineVersion: string
  adapterScript: string
  adapterHash: string
  stdoutTail?: string
  stderrTail?: string
}

export async function brokerTakeoffDrawingCore(
  projectId: string,
  artifactId: string,
  parameters: Record<string, unknown>,
  opts?: BrokerDeriveOptions,
): Promise<BrokerTakeoffDrawingResult> {
  const layerFilter = takeoffDrawingLayerFilter(parameters)
  if (!layerFilter.ok) throw new BrokerRefusalError("unsupported", layerFilter.message)

  const project = await db.project.findUnique({ where: { id: projectId }, select: { id: true } })
  if (!project) throw new BrokerRequestError("not_found", "Project not found", "Project")

  const artifact = await db.artifact.findUnique({
    where: { id: artifactId },
    include: { latestRevision: true },
  })
  if (!artifact || artifact.projectId !== projectId) {
    throw new BrokerRequestError("not_found", "Artifact not found", "Artifact")
  }
  if (!artifact.latestRevision) {
    throw new BrokerRequestError("bad_request", "This artifact has no revisions to take off from")
  }
  const revision = artifact.latestRevision

  if (isDwgSignal(artifact.name, revision.mimeType)) {
    throw new BrokerRefusalError("unsupported", TAKEOFF_DWG_REFUSAL_MESSAGE)
  }
  if (!isDxfSignal(artifact.name, revision.mimeType) && !isDxfSignal(revision.storageKey, revision.mimeType)) {
    throw new BrokerRefusalError("unsupported", takeoffDrawingUnsupportedMessage(artifact.name))
  }

  const absPath = path.join(getStorageRoot(), revision.storageKey, "content")

  let result: DxfTakeoffResult
  try {
    result = await dxfTakeoffFromStorage(absPath, { layerFilter: layerFilter.value })
  } catch (err) {
    if (err instanceof EngineUnavailableError) {
      throw new BrokerRefusalError("engine_unavailable", err.message)
    }
    throw err // unexpected adapter failure → honest 500 via the route handler, logged
  }

  const document = buildVectorTakeoffDocument(
    artifact.name,
    "drawing",
    { engineKey: result.engineKey, engineVersion: result.engineVersion, adapterScript: result.adapterScript },
    { layerFilter: layerFilter.value ?? null },
    result,
  )
  const bytes = Buffer.from(document, "utf8")
  const stored = await persistDerivedArtifactRevision(projectId, opts, artifactId, revision.id, {
    opLabel: "takeoff_drawing",
    kind: "analysis",
    format: "eos-vector-takeoff/1",
    name: `${artifact.name} — DXF takeoff`,
    description: `Per-layer DXF takeoff extracted by ${result.engineKey} (declared mm units, exact arc/circle math)`,
    bytes,
    mimeType: "application/json",
    contentAuthor: `adapter:${result.engineKey}`,
    inputIds: [artifactId],
    audit: {
      actor: opts?.actor ?? `adapter:${result.engineKey}`,
      action: "takeoff.dxfDerived",
      detail: {
        engineKey: result.engineKey,
        engineVersion: result.engineVersion,
        adapterScript: result.adapterScript,
        adapterHash: result.adapterHash,
        layerCount: result.layerCount,
        entityCount: result.entityCount,
        unitsMm: result.unitsMm,
        layerFilter: layerFilter.value ?? null,
      },
    },
  })

  return {
    takeoff: {
      artifactId: stored.artifactId,
      name: stored.name,
      kind: "analysis",
      revisionNumber: stored.revisionNumber,
      contentHash: stored.sha256,
      sizeBytes: stored.sizeBytes,
      format: "eos-vector-takeoff/1",
      layerCount: result.layerCount,
      entityCount: result.entityCount,
      unitsMm: result.unitsMm,
      ...(layerFilter.value ? { layerFilter: layerFilter.value } : {}),
      engineKey: result.engineKey,
      engineVersion: result.engineVersion,
      adapterScript: result.adapterScript,
      adapterHash: result.adapterHash,
      derivedFromArtifactId: artifactId,
      derivedFromRevisionId: revision.id,
      sourceLatestRevisionId: revision.id,
      staleSource: false,
    },
    outputArtifactRevisionId: stored.revisionId,
    engineKey: result.engineKey,
    engineVersion: result.engineVersion,
    adapterScript: result.adapterScript,
    adapterHash: result.adapterHash,
  }
}

// ---------------------------------------------------------------------------
// Parametric rebuild (Slice 16 — the roadmap-gap-audit item-2 integration; the
// 16-P adapter landed smoke-verified in Slice 15 and these cores wire it to
// the broker/route/UI). Two cores over ONE adapter (ADR-0005: the broker is
// the only engine path):
//   - brokerParametricSchemaCore — the READ side (the Studio form source): a
//     live adapter schema-mode run; no persistence, no audit event (the mesh
//     GET precedent — reads don't write trails).
//   - brokerRebuildParametricCore — the AUTHORING side: schema run → pure
//     mirror validation (pinned 422s BEFORE any build spawn) → build run →
//     analytic ground-truth gate → STEP persisted on a find-or-create kind-
//     "model" artifact derived_from the script artifact (sequential revisions
//     per rebuild) → downstream staleness cascade (meshes of the rebuilt
//     model go stale — the shared revisions-route semantics) → ONE
//     `parametric.rebuilt` audit event carrying the parameters used.
// ---------------------------------------------------------------------------

/** The parameter-edits carrier: `parameters.values` (absent → all defaults). */
export function rebuildParametricBrokerValues(
  parameters: Record<string, unknown>,
): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  const raw = parameters.values
  if (raw === undefined) return { ok: true, value: {} }
  if (!isPlainObject(raw)) {
    return { ok: false, message: "rebuild_parametric parameters.values must be a JSON object of parameter edits when provided" }
  }
  return { ok: true, value: raw }
}

/** Multi-signal detection for a parametric-model script (the derive-kind pattern). */
export function isParametricModelSignal(name: string, mimeType: string | null | undefined): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith(".py") || mimeType === "text/x-python" || mimeType === "application/x-python"
}

export function parametricUnsupportedMessage(artifactName: string): string {
  return `rebuild_parametric requires a parametric model script (.py) — "${artifactName}" carries no python-script signal (.py name or text/x-python MIME)`
}

/** Shared route-core gates: project → artifact-in-project → revision → signal.
 * Throws the pinned BrokerRequestError/BrokerRefusalError on any refusal. */
async function parametricSourceOrRefusal(
  projectId: string,
  artifactId: string,
): Promise<{
  artifact: { id: string; name: string }
  revision: { id: string; storageKey: string; mimeType: string | null }
}> {
  const project = await db.project.findUnique({ where: { id: projectId }, select: { id: true } })
  if (!project) throw new BrokerRequestError("not_found", "Project not found", "Project")

  const artifact = await db.artifact.findUnique({
    where: { id: artifactId },
    include: { latestRevision: true },
  })
  if (!artifact || artifact.projectId !== projectId) {
    throw new BrokerRequestError("not_found", "Artifact not found", "Artifact")
  }
  if (!artifact.latestRevision) {
    throw new BrokerRequestError("bad_request", "This artifact has no revisions to rebuild from")
  }
  if (!isParametricModelSignal(artifact.name, artifact.latestRevision.mimeType)) {
    throw new BrokerRefusalError("unsupported", parametricUnsupportedMessage(artifact.name))
  }
  return {
    artifact: { id: artifact.id, name: artifact.name },
    revision: {
      id: artifact.latestRevision.id,
      storageKey: artifact.latestRevision.storageKey,
      mimeType: artifact.latestRevision.mimeType,
    },
  }
}

/** Pinned GET result — the Studio parameter-form source. */
export interface BrokerParametricSchemaResult {
  schema: ParametricSchemaResult["schema"]
  defaults: Record<string, number>
  modelScriptHash: string
  engineKey: "cadquery"
  engineVersion: string
  adapterScript: string
  adapterHash: string
  sourceArtifactId: string
  sourceRevisionId: string
}

/** The read side: a live adapter schema-mode run (no persistence, no audit). */
export async function brokerParametricSchemaCore(
  projectId: string,
  artifactId: string,
): Promise<BrokerParametricSchemaResult> {
  const source = await parametricSourceOrRefusal(projectId, artifactId)

  const absPath = path.join(getStorageRoot(), source.revision.storageKey, "content")
  let schema: ParametricSchemaResult
  try {
    schema = await parametricSchemaFromStorage(absPath)
  } catch (err) {
    if (err instanceof EngineUnavailableError) {
      throw new BrokerRefusalError("engine_unavailable", err.message)
    }
    throw err
  }
  return {
    schema: schema.schema,
    defaults: schema.defaults,
    modelScriptHash: schema.modelScriptHash,
    engineKey: schema.engineKey,
    engineVersion: schema.engineVersion,
    adapterScript: schema.adapterScript,
    adapterHash: schema.adapterHash,
    sourceArtifactId: source.artifact.id,
    sourceRevisionId: source.revision.id,
  }
}

/** Pinned 201 `rebuild_parametric` response object (the femesh shape, STEP fields). */
export interface BrokerRebuildParametricResult {
  model: {
    artifactId: string
    name: string
    kind: "model"
    revisionNumber: number
    contentHash: string
    sizeBytes: number
    mimeType: "application/step"
    paramsUsed: Record<string, number>
    volumeMm3: number
    areaMm2: number
    bboxMm: number[]
    centerOfMassMm: number[]
    checks: { volumeRelErr: number; passed: boolean }
    engineKey: "cadquery"
    engineVersion: string
    adapterScript: string
    adapterHash: string
    derivedFromArtifactId: string
    derivedFromRevisionId: string
    sourceLatestRevisionId: string
    staleSource: false
    staleMarked: StaleMarkedRow[]
  }
  outputArtifactRevisionId: string
  engineKey: "cadquery"
  engineVersion: string
  adapterScript: string
  adapterHash: string
  durationMs: number
}

export async function brokerRebuildParametricCore(
  projectId: string,
  artifactId: string,
  parameters: Record<string, unknown>,
  opts?: BrokerDeriveOptions,
): Promise<BrokerRebuildParametricResult> {
  const startedAt = Date.now()
  const values = rebuildParametricBrokerValues(parameters)
  if (!values.ok) throw new BrokerRefusalError("unsupported", values.message)

  const source = await parametricSourceOrRefusal(projectId, artifactId)

  const absPath = path.join(getStorageRoot(), source.revision.storageKey, "content")

  // Step 1 — the schema (live adapter run; also the honest gate for a
  // well-formed parametric model: a plain .py without PARAM_SCHEMA refuses).
  let schema: ParametricSchemaResult
  try {
    schema = await parametricSchemaFromStorage(absPath)
  } catch (err) {
    if (err instanceof EngineUnavailableError) {
      throw new BrokerRefusalError("engine_unavailable", err.message)
    }
    throw err
  }

  // Step 2 — the pure mirror pre-validation: schema violations get the pinned
  // 422 BEFORE any build spawn (the adapter re-checks with identical messages).
  const resolved = resolveParametricParams(schema.schema, values.value)
  if (!resolved.ok) throw new BrokerRefusalError("unsupported", resolved.message)

  // Step 3 — the real build (cadquery; analytic ground-truth gate inside the
  // adapter; the adapter's verbatim refusal surfaces as engine_unavailable).
  let built: ParametricBuildResult
  try {
    built = await parametricRebuildFromStorage(absPath, resolved.value)
  } catch (err) {
    if (err instanceof EngineUnavailableError) {
      throw new BrokerRefusalError("engine_unavailable", err.message)
    }
    throw err
  }

  // Step 4 — persist the STEP on the find-or-create kind-"model" artifact
  // derived_from the script artifact (binary content — format discriminator
  // null, the pdf precedent; sequential revisions per rebuild).
  const stored = await persistDerivedArtifactRevision(projectId, opts, artifactId, source.revision.id, {
    opLabel: "rebuild_parametric",
    kind: "model",
    format: null,
    name: `${source.artifact.name} — rebuilt model`,
    description: `Parametric rebuild by ${built.engineKey} from ${source.artifact.name} (analytic ground-truth gate ${built.checks.volumeRelErr.toExponential(2)} rel)`,
    bytes: built.stepBytes,
    mimeType: "application/step",
    contentAuthor: `adapter:${built.engineKey}`,
    inputIds: [artifactId],
    audit: {
      actor: opts?.actor ?? `adapter:${built.engineKey}`,
      action: "parametric.rebuilt",
      detail: {
        engineKey: built.engineKey,
        engineVersion: built.engineVersion,
        adapterScript: built.adapterScript,
        adapterHash: built.adapterHash,
        modelScriptHash: built.modelScriptHash,
        paramsUsed: built.paramsUsed,
        volumeMm3: built.volumeMm3,
        volumeRelErr: built.checks.volumeRelErr,
        bboxMm: built.bboxMm,
      },
    },
  })

  // Step 5 — the staleness cascade: the rebuilt model artifact just gained a
  // revision, so its downstream (meshes, analyses) goes stale — the shared
  // revisions-route semantics (Slice 16 extraction), evidence rows returned.
  const staleMarked = await markDownstreamStale(projectId, stored.artifactId)

  return {
    model: {
      artifactId: stored.artifactId,
      name: stored.name,
      kind: "model",
      revisionNumber: stored.revisionNumber,
      contentHash: stored.sha256,
      sizeBytes: stored.sizeBytes,
      mimeType: "application/step",
      paramsUsed: built.paramsUsed,
      volumeMm3: built.volumeMm3,
      areaMm2: built.areaMm2,
      bboxMm: built.bboxMm,
      centerOfMassMm: built.centerOfMassMm,
      checks: built.checks,
      engineKey: built.engineKey,
      engineVersion: built.engineVersion,
      adapterScript: built.adapterScript,
      adapterHash: built.adapterHash,
      derivedFromArtifactId: artifactId,
      derivedFromRevisionId: source.revision.id,
      sourceLatestRevisionId: source.revision.id,
      staleSource: false,
      staleMarked,
    },
    outputArtifactRevisionId: stored.revisionId,
    engineKey: built.engineKey,
    engineVersion: built.engineVersion,
    adapterScript: built.adapterScript,
    adapterHash: built.adapterHash,
    durationMs: Date.now() - startedAt,
  }
}

// ---------------------------------------------------------------------------
// Sheet-text OCR (Slice 16-B — roadmap-gap-audit item 3, the 16-R2 research):
// a READ-side core (no persistence, no audit — the schema-read precedent):
// the Sheet Measure client renders the operator's picked region at a fixed 4×
// and POSTs the PNG; this core gates the source as a PDF sheet revision (the
// takeoff_sheet signal), decodes the base64, runs the real tesseract bridge,
// and returns the words (raw transcript + the documented Ø normalization, raw
// always preserved). The ACCEPT of a transcript as a kind-"text-hits" markup
// goes through the EXISTING markups contract — OCR itself writes nothing.
// ---------------------------------------------------------------------------

/** Decode + gate the `imageBase64` parameter. Pinned 422s; no partial reads. */
function ocrImageBytes(parameters: Record<string, unknown>): Buffer {
  const raw = parameters.imageBase64
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new BrokerRefusalError(
      "unsupported",
      "sheet_ocr requires parameters.imageBase64 (the base64 PNG of the picked region, rendered by Sheet Measure)",
    )
  }
  let bytes: Buffer
  try {
    bytes = Buffer.from(raw, "base64")
  } catch {
    throw new BrokerRefusalError("unsupported", "sheet_ocr parameters.imageBase64 is not valid base64")
  }
  // PNG magic checked by the adapter too — the broker gives the friendlier,
  // earlier refusal (base64 that decodes but is not a PNG).
  if (bytes.length < 8 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
    throw new BrokerRefusalError(
      "unsupported",
      "sheet_ocr parameters.imageBase64 does not decode to a PNG (magic bytes missing) — Sheet Measure renders PNG regions",
    )
  }
  const MAX_OCR_PNG_BYTES = 12 * 1024 * 1024
  if (bytes.length > MAX_OCR_PNG_BYTES) {
    throw new BrokerRefusalError(
      "unsupported",
      `sheet_ocr region image is ${Math.round(bytes.length / 1024 / 1024)} MB — pick a smaller region (the cap is 12 MB)`,
    )
  }
  return bytes
}

/** Pinned OCR read result (the words carry the raw transcript; Ø normalized). */
export interface BrokerSheetOcrResult {
  engineKey: "tesseract"
  engineVersion: string
  adapterScript: string
  adapterHash: string
  tessdataDir: string | null
  psm: number
  words: Array<{
    text: string
    conf: number
    /** raster box in the region image, px, y-down (provenance) */
    box: { x: number; y: number; width: number; height: number }
    /** the Ø normalization when the rule fires — raw ALWAYS preserved above */
    normalized?: { raw: string; normalized: string; rule: "diameter-glyph" }
  }>
  sourceArtifactId: string
  sourceRevisionId: string
}

export async function brokerSheetOcrCore(
  projectId: string,
  artifactId: string,
  parameters: Record<string, unknown>,
): Promise<BrokerSheetOcrResult> {
  const project = await db.project.findUnique({ where: { id: projectId }, select: { id: true } })
  if (!project) throw new BrokerRequestError("not_found", "Project not found", "Project")

  const artifact = await db.artifact.findUnique({
    where: { id: artifactId },
    include: { latestRevision: true },
  })
  if (!artifact || artifact.projectId !== projectId) {
    throw new BrokerRequestError("not_found", "Artifact not found", "Artifact")
  }
  if (!artifact.latestRevision) {
    throw new BrokerRequestError("bad_request", "This artifact has no revisions to read text from")
  }
  if (
    !isPdfSignal(artifact.name, artifact.latestRevision.mimeType) &&
    !isPdfSignal(artifact.latestRevision.storageKey, artifact.latestRevision.mimeType)
  ) {
    throw new BrokerRefusalError(
      "unsupported",
      takeoffSheetUnsupportedMessage(artifact.name),
    )
  }

  const bytes = ocrImageBytes(parameters)

  let psm: number | undefined
  if (parameters.psm !== undefined) {
    if (typeof parameters.psm !== "number" || !Number.isInteger(parameters.psm) || parameters.psm < 0 || parameters.psm > 13) {
      throw new BrokerRefusalError("unsupported", "sheet_ocr parameters.psm must be an integer 0..13 when provided")
    }
    psm = parameters.psm
  }

  let result: SheetOcrResult
  try {
    result = await sheetOcrFromPng(bytes, psm !== undefined ? { psm } : {})
  } catch (err) {
    if (err instanceof EngineUnavailableError) {
      throw new BrokerRefusalError("engine_unavailable", err.message)
    }
    throw err
  }

  return {
    engineKey: result.engineKey,
    engineVersion: result.engineVersion,
    adapterScript: result.adapterScript,
    adapterHash: result.adapterHash,
    tessdataDir: result.tessdataDir,
    psm: result.psm,
    words: result.words.map((w) => {
      const normalized = normalizeDiameterToken(w.text)
      return {
        text: w.text,
        conf: w.conf,
        box: { x: w.x, y: w.y, width: w.width, height: w.height },
        ...(normalized !== null ? { normalized } : {}),
      }
    }),
    sourceArtifactId: artifactId,
    sourceRevisionId: artifact.latestRevision.id,
  }
}

/** Pinned 201 `powerflow` response object (exact key order — mirror of the mesh 201). */
export interface BrokerPowerflowResponse {
  artifactId: string
  name: string
  kind: "analysis"
  revisionNumber: number
  contentHash: string
  sizeBytes: number
  format: "eos-powerflow/1"
  converged: boolean
  busCount: number
  lineCount: number
  engineKey: string
  engineVersion: string
  adapterScript: string
  adapterHash: string
  derivedFromArtifactId: string
  derivedFromRevisionId: string
  sourceLatestRevisionId: string
  staleSource: false
}

export interface BrokerPowerflowResult {
  powerflow: BrokerPowerflowResponse
  outputArtifactRevisionId: string
  engineKey: string
  engineVersion: string
  adapterScript: string
  adapterHash: string
  stdoutTail?: string
  stderrTail?: string
}

/**
 * Core of POST …/powerflow — the REAL pandapower Newton-Raphson run (contract
 * §4/§5.2): gate the stored JSON as an eos-powerflow-network/1 document, run
 * the bridge (init="flat", every numeric verbatim from the result frames),
 * assemble the byte-deterministic eos-powerflow/1 document, find-or-create
 * the kind-"analysis" artifact (DRAFT revision per run), exactly ONE
 * `powerflow.derived` audit event.
 */
export async function brokerRunPowerflowCore(
  projectId: string,
  artifactId: string,
  opts?: BrokerDeriveOptions,
): Promise<BrokerPowerflowResult> {
  const source = await readJsonArtifact(projectId, artifactId, "eos-powerflow-network/1", POWERFLOW_NO_REVISIONS_MESSAGE)
  const absPath = path.join(getStorageRoot(), source.revision.storageKey, "content")

  let result: Awaited<ReturnType<typeof runPowerflowFromFile>>
  try {
    result = await runPowerflowFromFile(absPath)
  } catch (err) {
    if (err instanceof EngineUnavailableError) {
      throw new BrokerRefusalError("engine_unavailable", err.message)
    }
    throw err // unexpected adapter failure → honest 500 via the route handler, logged
  }

  const document = buildPowerflowDocument(source.artifact.name, result)
  const bytes = Buffer.from(document, "utf8")
  const stored = await persistDerivedArtifactRevision(projectId, opts, artifactId, source.revision.id, {
    opLabel: "run_powerflow",
    kind: "analysis",
    format: "eos-powerflow/1",
    name: `${source.artifact.name} — power flow analysis`,
    description: `Newton-Raphson power flow (${result.engineKey})`,
    bytes,
    mimeType: "application/json",
    contentAuthor: `adapter:${result.engineKey}`,
    inputIds: [artifactId],
    audit: {
      actor: opts?.actor ?? `adapter:${result.engineKey}`,
      action: "powerflow.derived",
      detail: {
        engineKey: result.engineKey,
        engineVersion: result.engineVersion,
        adapterScript: result.adapterScript,
        adapterHash: result.adapterHash,
        converged: result.converged,
        busCount: result.buses.length,
        lineCount: result.lines.length,
      },
    },
  })

  return {
    powerflow: {
      artifactId: stored.artifactId,
      name: stored.name,
      kind: "analysis",
      revisionNumber: stored.revisionNumber,
      contentHash: stored.sha256,
      sizeBytes: stored.sizeBytes,
      format: "eos-powerflow/1",
      converged: result.converged,
      busCount: result.buses.length,
      lineCount: result.lines.length,
      engineKey: result.engineKey,
      engineVersion: result.engineVersion,
      adapterScript: result.adapterScript,
      adapterHash: result.adapterHash,
      derivedFromArtifactId: artifactId,
      derivedFromRevisionId: source.revision.id,
      sourceLatestRevisionId: source.revision.id,
      staleSource: false,
    },
    outputArtifactRevisionId: stored.revisionId,
    engineKey: result.engineKey,
    engineVersion: result.engineVersion,
    adapterScript: result.adapterScript,
    adapterHash: result.adapterHash,
    stdoutTail: result.stdoutTail,
    stderrTail: result.stderrTail,
  }
}

/** Pinned 201 `sim` response object (exact key order — mirror of the mesh 201). */
export interface BrokerSimResponse {
  artifactId: string
  name: string
  kind: "analysis"
  revisionNumber: number
  contentHash: string
  sizeBytes: number
  format: "eos-des/1"
  policy: "fifo"
  makespan: number
  resourceCount: number
  jobCount: number
  engineKey: string
  engineVersion: string
  adapterScript: string
  adapterHash: string
  derivedFromArtifactId: string
  derivedFromRevisionId: string
  sourceLatestRevisionId: string
  staleSource: false
}

export interface BrokerSimResult {
  sim: BrokerSimResponse
  outputArtifactRevisionId: string
  engineKey: string
  engineVersion: string
  adapterScript: string
  adapterHash: string
  stdoutTail?: string
  stderrTail?: string
}

/**
 * Core of POST …/simulate — the REAL SimPy FIFO discrete-event run (contract
 * §4/§5.3): gate the stored JSON as an eos-des-scenario/1 document, run the
 * deterministic bridge, assemble the byte-deterministic eos-des/1 document,
 * find-or-create the kind-"analysis" artifact (DRAFT revision per run),
 * exactly ONE `sim.completed` audit event.
 */
export async function brokerRunDesCore(
  projectId: string,
  artifactId: string,
  opts?: BrokerDeriveOptions,
): Promise<BrokerSimResult> {
  const source = await readJsonArtifact(projectId, artifactId, "eos-des-scenario/1", DES_NO_REVISIONS_MESSAGE)
  const absPath = path.join(getStorageRoot(), source.revision.storageKey, "content")

  let result: Awaited<ReturnType<typeof runDesFromFile>>
  try {
    result = await runDesFromFile(absPath)
  } catch (err) {
    if (err instanceof EngineUnavailableError) {
      throw new BrokerRefusalError("engine_unavailable", err.message)
    }
    throw err // unexpected adapter failure → honest 500 via the route handler, logged
  }

  const document = buildDesDocument(source.artifact.name, result)
  const bytes = Buffer.from(document, "utf8")
  const stored = await persistDerivedArtifactRevision(projectId, opts, artifactId, source.revision.id, {
    opLabel: "run_des",
    kind: "analysis",
    format: "eos-des/1",
    name: `${source.artifact.name} — discrete-event simulation`,
    description: `Deterministic FIFO discrete-event simulation (${result.engineKey})`,
    bytes,
    mimeType: "application/json",
    contentAuthor: `adapter:${result.engineKey}`,
    inputIds: [artifactId],
    audit: {
      actor: opts?.actor ?? `adapter:${result.engineKey}`,
      action: "sim.completed",
      detail: {
        engineKey: result.engineKey,
        engineVersion: result.engineVersion,
        adapterScript: result.adapterScript,
        adapterHash: result.adapterHash,
        makespan: result.makespan,
        resourceCount: result.resources.length,
        jobCount: result.jobs.length,
      },
    },
  })

  return {
    sim: {
      artifactId: stored.artifactId,
      name: stored.name,
      kind: "analysis",
      revisionNumber: stored.revisionNumber,
      contentHash: stored.sha256,
      sizeBytes: stored.sizeBytes,
      format: "eos-des/1",
      policy: result.policy,
      makespan: result.makespan,
      resourceCount: result.resources.length,
      jobCount: result.jobs.length,
      engineKey: result.engineKey,
      engineVersion: result.engineVersion,
      adapterScript: result.adapterScript,
      adapterHash: result.adapterHash,
      derivedFromArtifactId: artifactId,
      derivedFromRevisionId: source.revision.id,
      sourceLatestRevisionId: source.revision.id,
      staleSource: false,
    },
    outputArtifactRevisionId: stored.revisionId,
    engineKey: result.engineKey,
    engineVersion: result.engineVersion,
    adapterScript: result.adapterScript,
    adapterHash: result.adapterHash,
    stdoutTail: result.stdoutTail,
    stderrTail: result.stderrTail,
  }
}

/** Pinned 201 `pdf` response object (exact key order — mirror of the mesh 201). */
export interface BrokerPdfResponse {
  artifactId: string
  name: string
  kind: "pdf"
  revisionNumber: number
  contentHash: string
  sizeBytes: number
  mimeType: "application/pdf"
  engineKey: string
  engineVersion: string
  adapterScript: string
  adapterHash: string
  derivedFromArtifactId: string
  derivedFromRevisionId: string
  sourceLatestRevisionId: string
  staleSource: false
}

export interface BrokerConvertResult {
  pdf: BrokerPdfResponse
  outputArtifactRevisionId: string
  engineKey: string
  engineVersion: string
  adapterScript: string
  adapterHash: string
  stdoutTail?: string
  stderrTail?: string
}

/**
 * Core of POST …/convert-document — the REAL headless LibreOffice conversion
 * (contract §4/§5.4): the convertible-extension gate (pinned 422s for
 * non-convertible kinds and already-PDF inputs), the conversion in a fresh
 * tmpdir, the raw `application/pdf` bytes stored verbatim as the DRAFT
 * revision content of a kind-"pdf" artifact (find-or-create; byte-determinism
 * is NOT claimed — PDFs embed creation timestamps), exactly ONE
 * `document.converted` audit event. Download flows through the existing
 * artifact download route.
 */
export async function brokerConvertDocumentCore(
  projectId: string,
  artifactId: string,
  opts?: BrokerDeriveOptions,
): Promise<BrokerConvertResult> {
  const project = await db.project.findUnique({ where: { id: projectId }, select: { id: true } })
  if (!project) throw new BrokerRequestError("not_found", "Project not found", "Project")

  const artifact = await db.artifact.findUnique({
    where: { id: artifactId },
    include: { latestRevision: true },
  })
  if (!artifact || artifact.projectId !== projectId) {
    throw new BrokerRequestError("not_found", "Artifact not found", "Artifact")
  }
  if (!artifact.latestRevision) {
    throw new BrokerRequestError("bad_request", CONVERT_NO_REVISIONS_MESSAGE)
  }
  const revision = artifact.latestRevision

  // Two-signal convertibility gate: the artifact name (uploads usually register
  // WITHOUT an extension) and the recorded revision MIME resolve to an
  // extension-bearing source name for LO's extension-dispatched filters.
  // Neither signal mappable → the pinned 422s (already-PDF vs no filter).
  const sourceName = convertibleSourceName(artifact.name, revision.mimeType)
  if (sourceName === null) {
    if (revision.mimeType === "application/pdf" || conversionExtensionKind(artifact.name) === "pdf") {
      throw new BrokerRefusalError("unsupported", alreadyPdfMessage(artifact.name))
    }
    throw new BrokerRefusalError("unsupported", notConvertibleMessage(artifact.name))
  }

  const absPath = path.join(getStorageRoot(), revision.storageKey, "content")

  let result: Awaited<ReturnType<typeof convertDocumentToFile>>
  try {
    result = await convertDocumentToFile(absPath, sourceName)
  } catch (err) {
    if (err instanceof EngineUnavailableError) {
      throw new BrokerRefusalError("engine_unavailable", err.message)
    }
    throw err // unexpected adapter failure → honest 500 via the route handler, logged
  }

  const stored = await persistDerivedArtifactRevision(projectId, opts, artifactId, revision.id, {
    opLabel: "convert_document",
    kind: "pdf",
    format: null, // binary content — the kind is unique to this op (§2)
    name: `${artifact.name} — PDF`,
    description: `PDF converted from the source document by ${result.engineKey}`,
    bytes: result.pdfBytes,
    mimeType: "application/pdf",
    contentAuthor: `adapter:${result.engineKey}`,
    inputIds: [artifactId],
    audit: {
      actor: opts?.actor ?? `adapter:${result.engineKey}`,
      action: "document.converted",
      detail: {
        engineKey: result.engineKey,
        engineVersion: result.engineVersion,
        adapterScript: result.adapterScript,
        adapterHash: result.adapterHash,
        sizeBytes: result.pdfBytes.byteLength,
      },
    },
  })

  return {
    pdf: {
      artifactId: stored.artifactId,
      name: stored.name,
      kind: "pdf",
      revisionNumber: stored.revisionNumber,
      contentHash: stored.sha256,
      sizeBytes: stored.sizeBytes,
      mimeType: "application/pdf",
      engineKey: result.engineKey,
      engineVersion: result.engineVersion,
      adapterScript: result.adapterScript,
      adapterHash: result.adapterHash,
      derivedFromArtifactId: artifactId,
      derivedFromRevisionId: revision.id,
      sourceLatestRevisionId: revision.id,
      staleSource: false,
    },
    outputArtifactRevisionId: stored.revisionId,
    engineKey: result.engineKey,
    engineVersion: result.engineVersion,
    adapterScript: result.adapterScript,
    adapterHash: result.adapterHash,
    stdoutTail: result.stdoutTail,
    stderrTail: result.stderrTail,
  }
}

/** Pinned 201 `analysis` response object (CPM — NO engine fields, honestly absent). */
export interface BrokerCpmResponse {
  artifactId: string
  name: string
  kind: "analysis"
  revisionNumber: number
  contentHash: string
  sizeBytes: number
  format: "eos-cpm/1"
  activityCount: number
  durationDays: number
  criticalPath: string[]
  derivedFromArtifactId: string
  derivedFromRevisionId: string
  sourceLatestRevisionId: string
  staleSource: false
}

export interface BrokerCpmResult {
  analysis: BrokerCpmResponse
  outputArtifactRevisionId: string
}

/**
 * Core of POST …/analyze-schedule — the PLATFORM core operation (contract
 * §4/§6): gate the stored JSON as an eos-schedule/1 document, structurally
 * defend §3.1, run W3-f's pure `analyzeCpm` (graph errors surface with the
 * §3.1 verbatim messages as 422s), assemble the byte-deterministic eos-cpm/1
 * document, find-or-create the kind-"analysis" artifact (DRAFT revision per
 * run), exactly ONE `schedule.analyzed` audit event. NO engine runs: the
 * audit event carries no engine fields and the BrokerOutcome leaves them
 * absent (null in the workflow execution record) — the honest record.
 */
export async function brokerAnalyzeScheduleCore(
  projectId: string,
  artifactId: string,
  opts?: BrokerDeriveOptions,
): Promise<BrokerCpmResult> {
  const source = await readJsonArtifact(projectId, artifactId, "eos-schedule/1", ANALYZE_NO_REVISIONS_MESSAGE)
  const json = source.json

  const schedule = validateScheduleDocument(json)
  if (!schedule.ok) {
    throw new BrokerRequestError("validation_failed", schedule.error)
  }

  const analysis = analyzeCpm(schedule.value)
  if (!analysis.ok) {
    throw new BrokerRequestError("validation_failed", analysis.error)
  }
  const cpm = analysis.value

  const document = buildCpmAnalysisDocument(source.artifact.name, cpm)
  const bytes = Buffer.from(document, "utf8")
  const actor = opts?.actor ?? "local-operator"
  const stored = await persistDerivedArtifactRevision(projectId, opts, artifactId, source.revision.id, {
    opLabel: "analyze_schedule",
    kind: "analysis",
    format: "eos-cpm/1",
    name: `${source.artifact.name} — CPM analysis`,
    description: "Critical-path analysis of the schedule (platform core — no engine)",
    bytes,
    mimeType: "application/json",
    contentAuthor: actor,
    inputIds: [artifactId],
    audit: {
      actor,
      action: "schedule.analyzed",
      // deliberately NO engineKey/engineVersion/adapterScript/adapterHash —
      // a platform core ran, and the event records that honestly
      detail: {
        activityCount: cpm.activities.length,
        durationDays: cpm.durationDays,
        criticalPath: cpm.criticalPath,
      },
    },
  })

  return {
    analysis: {
      artifactId: stored.artifactId,
      name: stored.name,
      kind: "analysis",
      revisionNumber: stored.revisionNumber,
      contentHash: stored.sha256,
      sizeBytes: stored.sizeBytes,
      format: "eos-cpm/1",
      activityCount: cpm.activities.length,
      durationDays: cpm.durationDays,
      criticalPath: cpm.criticalPath,
      derivedFromArtifactId: artifactId,
      derivedFromRevisionId: source.revision.id,
      sourceLatestRevisionId: source.revision.id,
      staleSource: false,
    },
    outputArtifactRevisionId: stored.revisionId,
  }
}

// ---------------------------------------------------------------------------
// The broker dispatch — the single entry point (ADR-0005 rule 1)
// ---------------------------------------------------------------------------

function deriveOptsFromCtx(ctx: BrokerContext): BrokerDeriveOptions {
  return {
    actor: ctx.actor,
    workflowId: ctx.workflowId,
    stepId: ctx.stepId,
    attempt: ctx.attempt,
  }
}

/**
 * Run one broker operation. THE only execution path for engine operations —
 * the two derive routes and the workflow executor (W3-e) both end up here.
 * Never throws for expected refusals: those surface as `BrokerRefusalError`
 * (verbatim 422 material). Unexpected errors propagate honestly (500-class
 * at the routes; step failure with verbatim text in the executor). Every
 * successful run records durationMs and the ADR-0005 execution-record
 * fields; `exitCode` is null when no adapter subprocess ran (build_report).
 */
export async function runBrokerOperation(
  operation: BrokerOperation,
  ctx: BrokerContext,
  inputs: { artifactId?: string; artifactIds?: string[] },
  parameters: Record<string, unknown>,
): Promise<BrokerOutcome> {
  const startedAt = Date.now()

  switch (operation) {
    case "derive_quantities": {
      if (typeof inputs.artifactId !== "string" || inputs.artifactId.length === 0) {
        throw new BrokerRefusalError(
          "unsupported",
          "derive_quantities requires inputs.artifactId (one model artifact id)",
        )
      }
      const core = await brokerDeriveQuantitiesCore(ctx.projectId, inputs.artifactId, deriveOptsFromCtx(ctx))
      return {
        summary: {
          rows: core.created.length,
          rowIds: core.created.map((row) => row.id),
          rowsDetail: core.created.map((row) => ({
            id: row.id,
            elementRef: row.elementRef,
            quantityType: row.quantityType,
            value: row.value,
            unit: row.unit,
            method: row.method,
          })),
        },
        engineKey: core.engineKey,
        engineVersion: core.engineVersion,
        adapterScript: core.adapterScript,
        adapterHash: core.adapterHash,
        exitCode: 0,
        stdoutTail: core.stdoutTail,
        stderrTail: core.stderrTail,
        durationMs: Date.now() - startedAt,
      }
    }

    case "derive_mesh": {
      if (typeof inputs.artifactId !== "string" || inputs.artifactId.length === 0) {
        throw new BrokerRefusalError("unsupported", "derive_mesh requires inputs.artifactId (one model artifact id)")
      }
      const core = await brokerDeriveMeshCore(ctx.projectId, inputs.artifactId, deriveOptsFromCtx(ctx))
      return {
        summary: {
          artifactId: core.mesh.artifactId,
          revisionNumber: core.mesh.revisionNumber,
          contentHash: core.mesh.contentHash,
          elementCount: core.mesh.elementCount,
          vertexCount: core.mesh.vertexCount,
          triangleCount: core.mesh.triangleCount,
          derivedFromArtifactId: core.mesh.derivedFromArtifactId,
          derivedFromRevisionId: core.mesh.derivedFromRevisionId,
        },
        outputArtifactRevisionId: core.outputArtifactRevisionId,
        engineKey: core.engineKey,
        engineVersion: core.engineVersion,
        adapterScript: core.adapterScript,
        adapterHash: core.adapterHash,
        exitCode: 0,
        stdoutTail: core.stdoutTail,
        stderrTail: core.stderrTail,
        durationMs: Date.now() - startedAt,
      }
    }

    case "build_report": {
      // Structural input validation (the executor's definition zod already
      // enforces this; the broker defends the invariant independently).
      const ids = inputs.artifactIds
      if (
        !Array.isArray(ids) ||
        ids.length < 1 ||
        ids.length > 4 ||
        ids.some((id) => typeof id !== "string" || id.length === 0)
      ) {
        throw new BrokerRefusalError(
          "unsupported",
          "build_report requires inputs.artifactIds to be an array of 1..4 artifact ids",
        )
      }
      if (new Set(ids).size !== ids.length) {
        throw new BrokerRefusalError("unsupported", "build_report inputs.artifactIds must not contain duplicates")
      }
      const rawTitle = parameters.title
      if (rawTitle !== undefined && (typeof rawTitle !== "string" || rawTitle.trim().length === 0)) {
        throw new BrokerRefusalError(
          "unsupported",
          "build_report parameters.title must be a non-empty string when provided",
        )
      }

      // Read the DB-verified content of every input (zero side effects on
      // failure — nothing is written before every source resolves).
      const sources: ReportSource[] = []
      for (const artifactId of ids) {
        sources.push(await assembleReportSource(ctx.projectId, artifactId))
      }
      const stats = reportStats(sources)
      const title =
        typeof rawTitle === "string" ? rawTitle : `${sources[0].sourceArtifactName} — QA report`
      const workflow =
        ctx.workflowId !== undefined || ctx.stepId !== undefined
          ? {
              ...(ctx.workflowId !== undefined ? { workflowId: ctx.workflowId } : {}),
              ...(ctx.stepId !== undefined ? { stepId: ctx.stepId } : {}),
              actor: ctx.actor,
            }
          : undefined

      const document = buildReportDocument(sources, { title, workflow })
      const bytes = Buffer.from(document, "utf8")
      const stored = await persistReportRevision(ctx, ids, { title, inputCount: ids.length, stats }, bytes)

      return {
        summary: {
          artifactId: stored.artifactId,
          revisionNumber: stored.revisionNumber,
          contentHash: stored.sha256,
          sectionCount: stats.sectionCount,
          figureCount: stats.figureCount,
          sourcesCited: stats.sourcesCited,
        },
        outputArtifactRevisionId: stored.revisionId,
        exitCode: null,
        durationMs: Date.now() - startedAt,
      }
    }

    case "fe_mesh": {
      if (typeof inputs.artifactId !== "string" || inputs.artifactId.length === 0) {
        throw new BrokerRefusalError("unsupported", "fe_mesh requires inputs.artifactId (one model artifact id)")
      }
      const core = await brokerFeMeshCore(ctx.projectId, inputs.artifactId, parameters, deriveOptsFromCtx(ctx))
      return {
        summary: {
          artifactId: core.femesh.artifactId,
          revisionNumber: core.femesh.revisionNumber,
          contentHash: core.femesh.contentHash,
          nodeCount: core.femesh.nodeCount,
          elementCount: core.femesh.elementCount,
          solidCount: core.femesh.solidCount,
        },
        outputArtifactRevisionId: core.outputArtifactRevisionId,
        engineKey: core.engineKey,
        engineVersion: core.engineVersion,
        adapterScript: core.adapterScript,
        adapterHash: core.adapterHash,
        exitCode: 0,
        stdoutTail: core.stdoutTail,
        stderrTail: core.stderrTail,
        durationMs: Date.now() - startedAt,
      }
    }

    case "takeoff_sheet": {
      if (typeof inputs.artifactId !== "string" || inputs.artifactId.length === 0) {
        throw new BrokerRefusalError("unsupported", "takeoff_sheet requires inputs.artifactId (one PDF sheet artifact id)")
      }
      const core = await brokerTakeoffSheetCore(ctx.projectId, inputs.artifactId, parameters, deriveOptsFromCtx(ctx))
      return {
        summary: {
          artifactId: core.takeoff.artifactId,
          revisionNumber: core.takeoff.revisionNumber,
          contentHash: core.takeoff.contentHash,
          pageNo: core.takeoff.pageNo,
          lineCount: core.takeoff.lineCount,
          rectCount: core.takeoff.rectCount,
          curveCount: core.takeoff.curveCount,
          textCount: core.takeoff.textCount,
        },
        outputArtifactRevisionId: core.outputArtifactRevisionId,
        engineKey: core.engineKey,
        engineVersion: core.engineVersion,
        adapterScript: core.adapterScript,
        adapterHash: core.adapterHash,
        exitCode: 0,
        durationMs: Date.now() - startedAt,
      }
    }

    case "takeoff_drawing": {
      if (typeof inputs.artifactId !== "string" || inputs.artifactId.length === 0) {
        throw new BrokerRefusalError("unsupported", "takeoff_drawing requires inputs.artifactId (one DXF drawing artifact id)")
      }
      const core = await brokerTakeoffDrawingCore(ctx.projectId, inputs.artifactId, parameters, deriveOptsFromCtx(ctx))
      return {
        summary: {
          artifactId: core.takeoff.artifactId,
          revisionNumber: core.takeoff.revisionNumber,
          contentHash: core.takeoff.contentHash,
          layerCount: core.takeoff.layerCount,
          entityCount: core.takeoff.entityCount,
        },
        outputArtifactRevisionId: core.outputArtifactRevisionId,
        engineKey: core.engineKey,
        engineVersion: core.engineVersion,
        adapterScript: core.adapterScript,
        adapterHash: core.adapterHash,
        exitCode: 0,
        durationMs: Date.now() - startedAt,
      }
    }

    case "rebuild_parametric": {
      if (typeof inputs.artifactId !== "string" || inputs.artifactId.length === 0) {
        throw new BrokerRefusalError(
          "unsupported",
          "rebuild_parametric requires inputs.artifactId (one parametric model script artifact id)",
        )
      }
      const core = await brokerRebuildParametricCore(ctx.projectId, inputs.artifactId, parameters, deriveOptsFromCtx(ctx))
      return {
        summary: {
          artifactId: core.model.artifactId,
          revisionNumber: core.model.revisionNumber,
          contentHash: core.model.contentHash,
          volumeMm3: core.model.volumeMm3,
          staleMarked: core.model.staleMarked.length,
        },
        outputArtifactRevisionId: core.outputArtifactRevisionId,
        engineKey: core.engineKey,
        engineVersion: core.engineVersion,
        adapterScript: core.adapterScript,
        adapterHash: core.adapterHash,
        exitCode: 0,
        durationMs: Date.now() - startedAt,
      }
    }

    case "run_powerflow": {
      if (typeof inputs.artifactId !== "string" || inputs.artifactId.length === 0) {
        throw new BrokerRefusalError("unsupported", "run_powerflow requires inputs.artifactId (one network artifact id)")
      }
      const core = await brokerRunPowerflowCore(ctx.projectId, inputs.artifactId, deriveOptsFromCtx(ctx))
      return {
        summary: {
          artifactId: core.powerflow.artifactId,
          revisionNumber: core.powerflow.revisionNumber,
          contentHash: core.powerflow.contentHash,
          converged: core.powerflow.converged,
          busCount: core.powerflow.busCount,
          lineCount: core.powerflow.lineCount,
        },
        outputArtifactRevisionId: core.outputArtifactRevisionId,
        engineKey: core.engineKey,
        engineVersion: core.engineVersion,
        adapterScript: core.adapterScript,
        adapterHash: core.adapterHash,
        exitCode: 0,
        stdoutTail: core.stdoutTail,
        stderrTail: core.stderrTail,
        durationMs: Date.now() - startedAt,
      }
    }

    case "run_des": {
      if (typeof inputs.artifactId !== "string" || inputs.artifactId.length === 0) {
        throw new BrokerRefusalError("unsupported", "run_des requires inputs.artifactId (one scenario artifact id)")
      }
      const core = await brokerRunDesCore(ctx.projectId, inputs.artifactId, deriveOptsFromCtx(ctx))
      return {
        summary: {
          artifactId: core.sim.artifactId,
          revisionNumber: core.sim.revisionNumber,
          contentHash: core.sim.contentHash,
          makespan: core.sim.makespan,
          resourceCount: core.sim.resourceCount,
          jobCount: core.sim.jobCount,
        },
        outputArtifactRevisionId: core.outputArtifactRevisionId,
        engineKey: core.engineKey,
        engineVersion: core.engineVersion,
        adapterScript: core.adapterScript,
        adapterHash: core.adapterHash,
        exitCode: 0,
        stdoutTail: core.stdoutTail,
        stderrTail: core.stderrTail,
        durationMs: Date.now() - startedAt,
      }
    }

    case "convert_document": {
      if (typeof inputs.artifactId !== "string" || inputs.artifactId.length === 0) {
        throw new BrokerRefusalError("unsupported", "convert_document requires inputs.artifactId (one document artifact id)")
      }
      const core = await brokerConvertDocumentCore(ctx.projectId, inputs.artifactId, deriveOptsFromCtx(ctx))
      return {
        summary: {
          artifactId: core.pdf.artifactId,
          revisionNumber: core.pdf.revisionNumber,
          contentHash: core.pdf.contentHash,
          sizeBytes: core.pdf.sizeBytes,
        },
        outputArtifactRevisionId: core.outputArtifactRevisionId,
        engineKey: core.engineKey,
        engineVersion: core.engineVersion,
        adapterScript: core.adapterScript,
        adapterHash: core.adapterHash,
        exitCode: 0,
        stdoutTail: core.stdoutTail,
        stderrTail: core.stderrTail,
        durationMs: Date.now() - startedAt,
      }
    }

    case "analyze_schedule": {
      if (typeof inputs.artifactId !== "string" || inputs.artifactId.length === 0) {
        throw new BrokerRefusalError("unsupported", "analyze_schedule requires inputs.artifactId (one schedule artifact id)")
      }
      const core = await brokerAnalyzeScheduleCore(ctx.projectId, inputs.artifactId, deriveOptsFromCtx(ctx))
      // Platform core: NO engine fields on the outcome — engineKey/
      // engineVersion/adapterScript/adapterHash are absent (honestly null in
      // the execution record); exitCode 0 (no adapter subprocess ran).
      return platformCoreOutcome(
        {
          artifactId: core.analysis.artifactId,
          revisionNumber: core.analysis.revisionNumber,
          contentHash: core.analysis.contentHash,
          activityCount: core.analysis.activityCount,
          durationDays: core.analysis.durationDays,
          criticalPath: core.analysis.criticalPath,
        },
        core.outputArtifactRevisionId,
        Date.now() - startedAt,
      )
    }

    default:
      // Type-exhaustive today; the executor stores operation strings from
      // workflow definitions, so the runtime defense stays honest.
      throw new BrokerRefusalError("unsupported", `unsupported broker operation ${JSON.stringify(operation)}`)
  }
}
