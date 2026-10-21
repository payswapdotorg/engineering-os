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
import { deriveKind } from "@/engines/adapters/derive-kind"
import { EngineUnavailableError, deriveFromFile, isPlainObject, type DeriveResult } from "@/engines/adapters/quantities"
import { tessellateFromFile } from "@/engines/adapters/mesh"
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

export type BrokerOperation = "derive_quantities" | "derive_mesh" | "build_report"

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

    default:
      // Type-exhaustive today; the executor stores operation strings from
      // workflow definitions, so the runtime defense stays honest.
      throw new BrokerRefusalError("unsupported", `unsupported broker operation ${JSON.stringify(operation)}`)
  }
}
