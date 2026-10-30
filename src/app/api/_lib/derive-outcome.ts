/**
 * Shared derive-outcome serialization for the five Phase-5 derive routes
 * (W3-f lane, contract §8). Private folder: Next.js never maps `_*` to routes.
 *
 * The routes are THIN wrappers: every execution goes through
 * `runBrokerOperation` (ADR-0005 rule 1) and the op core (W2-f) owns
 * persistence + the ONE audit event. This module only SERIALIZES the just-run
 * outcome: it reads back the produced artifact revision, its `derived_from`
 * link and the op's audit detail (the mesh GET precedent: the revision →
 * source-revision mapping is recovered from the `<action>` audit event pinned
 * by `revisionNumber`), and assembles the pinned 201 response object.
 *
 * Response key order is PINNED (mirroring the Phase-2 mesh route's 201 shape,
 * which the regression scripts assert key-by-key):
 *   artifactId → name → kind → revisionNumber → contentHash → sizeBytes →
 *   <op-appropriate summary fields> → engineKey → engineVersion → adapterScript
 *   → adapterHash → durationMs → stdoutTail? → stderrTail? →
 *   derivedFromArtifactId → derivedFromRevisionId → sourceLatestRevisionId →
 *   staleSource → document? (JSON outputs only — the PDF route passes none).
 *
 * Honesty rules:
 *  - `analyze_schedule` leaves the engine fields null in its outcome; the
 *    response shows that verbatim (platform core, never faked as an engine).
 *  - A revision number without a matching audit detail yields
 *    derivedFromRevisionId null — never a guess.
 *  - The produced revision must exist and belong to the route's project; a
 *    violation is an honest 500 (contract breach), never a partial response.
 */

import { readRevisionFile } from "@/lib/artifact-store"
import { db } from "@/lib/db"
import type { BrokerOutcome } from "@/engines/broker"

export interface BuildDeriveResponseOptions {
  projectId: string
  outcome: BrokerOutcome
  /**
   * The ONE audit action the op core writes per run ("femesh.derived",
   * "powerflow.derived", "sim.completed", "document.converted",
   * "schedule.analyzed") — its mesh-convention detail
   * {sourceRevisionId, revisionNumber} is the durable record of which SOURCE
   * revision the output was derived from.
   */
  auditAction: string
  /** Include the parsed stored document as `document` (JSON outputs only). */
  includeDocument?: boolean
  /**
   * Op-appropriate summary fields computed from the parsed document
   * (the meshCounts convention). Absent fields are omitted, never invented.
   */
  summarize?: (document: unknown) => Record<string, unknown>
}

/** Best-effort typed accessor over an untrusted parsed document. */
function field(source: unknown, key: string): unknown {
  if (typeof source !== "object" || source === null) return undefined
  return (source as Record<string, unknown>)[key]
}

function countOf(source: unknown, key: string): number | undefined {
  const value = field(source, key)
  if (Array.isArray(value)) return value.length
  return undefined
}

function numberField(source: unknown, key: string): number | undefined {
  const value = field(source, key)
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/**
 * Structural summaries per §2 output format. Each builder reads only the
 * pinned keys of its format; a missing key omits the response field rather
 * than inventing a number (the full `document` is always alongside).
 */
export const DERIVE_SUMMARIES = {
  /** eos-femesh/1 → nodeCount / elementCount / solidCount */
  femesh(document: unknown): Record<string, unknown> {
    return {
      nodeCount: numberField(field(document, "nodes"), "count"),
      elementCount: numberField(field(document, "elements"), "count"),
      solidCount: countOf(document, "solids"),
    }
  },
  /** eos-powerflow/1 → converged / busCount / lineCount */
  powerflow(document: unknown): Record<string, unknown> {
    const converged = field(document, "converged")
    return {
      converged: typeof converged === "boolean" ? converged : undefined,
      busCount: countOf(document, "buses"),
      lineCount: countOf(document, "lines"),
    }
  },
  /** eos-des/1 → makespan / resourceCount / jobCount */
  sim(document: unknown): Record<string, unknown> {
    return {
      makespan: numberField(document, "makespan"),
      resourceCount: countOf(document, "resources"),
      jobCount: countOf(document, "jobs"),
    }
  },
  /** eos-fea/1 → elementCount / nodeCount / maxDisplacementMagnitudeMm / vonMisesMaxMpa (Slice 22) */
  fea(document: unknown): Record<string, unknown> {
    return {
      elementCount: numberField(field(document, "mesh"), "elementCount"),
      nodeCount: numberField(field(document, "mesh"), "nodeCount"),
      maxDisplacementMagnitudeMm: numberField(document, "maxDisplacementMagnitudeMm"),
      vonMisesMaxMpa: numberField(field(document, "stress"), "vonMisesMaxMpa"),
    }
  },
  /** eos-swmm/1 → outfallVolumeM3 / volumeBalancePct / peak flows (Slice 23) */
  swmm(document: unknown): Record<string, unknown> {
    return {
      outfallVolumeM3: numberField(document, "outfallVolumeM3"),
      volumeBalancePct: numberField(document, "volumeBalancePct"),
      maxRunoffCms: numberField(field(document, "peaks"), "maxRunoffCms"),
      maxConduitFlowCms: numberField(field(document, "peaks"), "maxConduitFlowCms"),
    }
  },
  /** eos-cfd-transport/1 → elementCount / nodeCount / Péclet numbers / min-max concentration (Slice 29) */
  transport(document: unknown): Record<string, unknown> {
    return {
      elementCount: numberField(field(document, "mesh"), "elementCount"),
      nodeCount: numberField(field(document, "mesh"), "nodeCount"),
      pecletNumber: numberField(document, "pecletNumber"),
      meshPecletNumber: numberField(document, "meshPecletNumber"),
      minConcentration: numberField(document, "minConcentration"),
      maxConcentration: numberField(document, "maxConcentration"),
    }
  },
  /** eos-cpm/1 → activityCount / criticalPathCount / durationDays */
  analysis(document: unknown): Record<string, unknown> {
    return {
      activityCount: countOf(document, "activities"),
      criticalPathCount: countOf(document, "criticalPath"),
      durationDays: numberField(document, "durationDays"),
    }
  },
  /**
   * eos-vector-takeoff/1 (sheet) → pageNo / lineCount / rectCount /
   * curveCount / textCount — read from the stored document's result envelope
   * (the op core's audit detail is the durable twin of these fields).
   */
  takeoffSheet(document: unknown): Record<string, unknown> {
    const result = field(document, "result")
    const entities = field(result, "entities")
    return {
      pageNo: numberField(result, "pageNo"),
      lineCount: numberField(field(entities, "lines"), "count"),
      rectCount: numberField(field(entities, "rects"), "count"),
      curveCount: numberField(field(entities, "curves"), "count"),
      textCount: countOf(result, "text"),
    }
  },
  /** eos-vector-takeoff/1 (drawing) → layerCount / entityCount / unitsMm */
  takeoffDrawing(document: unknown): Record<string, unknown> {
    const result = field(document, "result")
    const unitsMm = field(result, "unitsMm")
    return {
      layerCount: numberField(result, "layerCount"),
      entityCount: numberField(result, "entityCount"),
      ...(typeof unitsMm === "boolean" ? { unitsMm } : {}),
    }
  },
} as const

/** Serialize one successful broker derive outcome into the pinned 201 object. */
export async function buildDeriveResponse(
  options: BuildDeriveResponseOptions,
): Promise<Record<string, unknown>> {
  const { projectId, outcome, auditAction } = options

  const revisionId = outcome.outputArtifactRevisionId
  if (revisionId === undefined) {
    throw new Error(
      `broker operation ${auditAction} produced no output artifact revision (contract violation)`,
    )
  }

  const revision = await db.artifactRevision.findUnique({
    where: { id: revisionId },
    include: { artifact: { select: { id: true, name: true, kind: true, projectId: true } } },
  })
  if (!revision || revision.artifact.projectId !== projectId) {
    throw new Error(
      `broker operation ${auditAction} wrote revision ${revisionId} outside project ${projectId} (contract violation)`,
    )
  }

  // Graph truth: the earliest derived_from link of the produced artifact.
  const link = await db.artifactLink.findFirst({
    where: { relationType: "derived_from", fromArtifactId: revision.artifactId },
    orderBy: { createdAt: "asc" },
    include: { toArtifact: { select: { id: true, latestRevisionId: true } } },
  })

  // Provenance truth: which SOURCE revision this output revision was derived
  // from — recorded by the op core in its ONE audit event
  // ({sourceRevisionId, revisionNumber}), append-only and never deleted.
  const deriveEvents = await db.auditEvent.findMany({
    where: { action: auditAction, entityId: revision.artifactId },
    orderBy: { createdAt: "desc" },
    select: { detail: true },
  })
  let derivedFromRevisionId: string | null = null
  for (const event of deriveEvents) {
    let detail: unknown
    try {
      detail = event.detail === null ? null : JSON.parse(event.detail)
    } catch {
      continue // malformed detail row — skip honestly, never guess
    }
    if (
      typeof detail === "object" &&
      detail !== null &&
      "sourceRevisionId" in detail &&
      "revisionNumber" in detail &&
      typeof (detail as { sourceRevisionId?: unknown }).sourceRevisionId === "string" &&
      (detail as { revisionNumber?: unknown }).revisionNumber === revision.revNumber
    ) {
      derivedFromRevisionId = (detail as { sourceRevisionId: string }).sourceRevisionId
      break
    }
  }

  // The stored document (JSON outputs only — the PDF route serves meta only).
  let document: unknown
  if (options.includeDocument) {
    const bytes = await readRevisionFile(revision.storageKey)
    try {
      document = JSON.parse(bytes.toString("utf8"))
    } catch (err) {
      throw new Error(
        `stored ${revision.artifact.kind} revision ${revision.id} is not valid JSON`,
        { cause: err },
      )
    }
  }

  const summary = options.summarize?.(document) ?? {}
  return {
    artifactId: revision.artifactId,
    name: revision.artifact.name,
    kind: revision.artifact.kind,
    revisionNumber: revision.revNumber,
    contentHash: revision.contentHash,
    sizeBytes: revision.sizeBytes,
    ...summary,
    engineKey: outcome.engineKey ?? null,
    engineVersion: outcome.engineVersion ?? null,
    adapterScript: outcome.adapterScript ?? null,
    adapterHash: outcome.adapterHash ?? null,
    durationMs: outcome.durationMs,
    ...(outcome.stdoutTail !== undefined ? { stdoutTail: outcome.stdoutTail } : {}),
    ...(outcome.stderrTail !== undefined ? { stderrTail: outcome.stderrTail } : {}),
    derivedFromArtifactId: link?.toArtifactId ?? null,
    derivedFromRevisionId,
    sourceLatestRevisionId: link?.toArtifact.latestRevisionId ?? null,
    staleSource: false, // fresh derivation: current by construction (mesh 201 precedent)
    ...(options.includeDocument ? { document } : {}),
  }
}
