import { jsonError, jsonOk, ERR } from "@/lib/api-utils"
import { readRevisionFile } from "@/lib/artifact-store"
import { db } from "@/lib/db"

import { handler, requireEntityProject } from "../../../_lib/route-helpers"
import { computeStaleSource, extractGeneratedBy, notMeshMessage } from "../../../_lib/mesh-meta"

export const dynamic = "force-dynamic"

/**
 * GET /api/artifacts/[id]/mesh — serve the parsed stored eos-mesh/1 JSON (incl.
 * generatedBy) plus the pinned meta block (Contract D). staleSource is
 * computed LIVE on every read: the mesh's latest revision left "current"
 * (the EXISTING staleness cascade in the revisions route marks it because
 * `derived_from` is an impact relation — zero new graph code here) OR the
 * revision it was derived from is no longer the source's latest revision.
 * The derived-from revision id is recovered from the mesh.derived audit
 * event pinned for this latest revision number (the only durable record of
 * the mesh-revision → source-revision mapping; the schema pins ArtifactRevision
 * with no source column and this lane cannot change it).
 */
export const GET = handler<{ id: string }>(async (_req, ctx) => {
  const { id } = await ctx.params

  const artifact = await db.artifact.findUnique({
    where: { id },
    include: { latestRevision: true },
  })
  if (!artifact) return ERR.notFound("Artifact")

  // Slice 10: project isolation (contract §4)
  const access = await requireEntityProject(artifact, "Artifact", "read")
  if (!access.ok) return access.response

  if (artifact.kind !== "mesh") {
    return jsonError(422, "unsupported", notMeshMessage(artifact.name, artifact.kind))
  }
  const revision = artifact.latestRevision
  if (!revision) {
    // Defensive: mesh artifacts are always born with rev 1 (derive-mesh
    // transaction). Reached only via out-of-band DB edits.
    return ERR.badRequest("This mesh artifact has no revisions to serve")
  }

  const bytes = await readRevisionFile(revision.storageKey)
  let mesh: unknown
  try {
    mesh = JSON.parse(bytes.toString("utf8"))
  } catch (err) {
    throw new Error(`stored mesh revision ${revision.id} is not valid eos-mesh/1 JSON`, { cause: err })
  }

  // Graph truth for the source: the `derived_from` link this mesh was created
  // with (earliest link wins when several exist — deterministic).
  const link = await db.artifactLink.findFirst({
    where: { relationType: "derived_from", fromArtifactId: id },
    orderBy: { createdAt: "asc" },
    include: { toArtifact: { select: { id: true, name: true, latestRevisionId: true } } },
  })

  // Provenance truth: which SOURCE revision this latest mesh revision was
  // derived from — recorded at derive time in the mesh.derived audit detail
  // ({sourceRevisionId, revisionNumber}), append-only and never deleted.
  const deriveEvents = await db.auditEvent.findMany({
    where: { action: "mesh.derived", entityId: id },
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

  const sourceLatestRevisionId = link?.toArtifact.latestRevisionId ?? null
  const staleSource = computeStaleSource(
    revision.staleness,
    derivedFromRevisionId,
    sourceLatestRevisionId,
  )
  const generatedBy = extractGeneratedBy(mesh)

  return jsonOk({
    mesh,
    meta: {
      artifactId: id,
      name: artifact.name,
      revisionNumber: revision.revNumber,
      contentHash: revision.contentHash,
      sizeBytes: revision.sizeBytes,
      staleSource,
      staleness: revision.staleness,
      derivedFromArtifactId: link?.toArtifactId ?? null,
      derivedFromRevisionId,
      sourceLatestRevisionId,
      sourceArtifactName: link?.toArtifact.name ?? null,
      engineKey: generatedBy.engineKey,
      engineVersion: generatedBy.engineVersion,
      adapterScript: generatedBy.adapterScript,
      adapterHash: generatedBy.adapterHash,
      generatedAt: revision.createdAt.toISOString(),
    },
  })
})
