import { IMPACT_RELATIONS, nextStaleness, type StalenessState } from "@/core"
import { detectArtifactKind } from "@/lib/artifact-meta"
import { recordEvent } from "@/lib/audit"
import { jsonOk, ERR } from "@/lib/api-utils"
import { db } from "@/lib/db"
import { newId } from "@/lib/ids"
import { saveRevisionFile } from "@/lib/artifact-store"

import { handler, requireEntityProject } from "../../../_lib/route-helpers"

export const dynamic = "force-dynamic"

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

/**
 * POST /api/artifacts/[id]/revisions — multipart (file, note?) → new revision,
 * sequential numbering, then the staleness cascade: every artifact with an
 * impact relation pointing at this one is marked stale with path evidence
 * (docs/03-data/artifact-graph-schema.md §2).
 */
export const POST = handler<{ id: string }>(async (req, ctx) => {
  const { id } = await ctx.params

  const artifact = await db.artifact.findUnique({ where: { id }, select: { id: true, projectId: true, name: true } })
  if (!artifact) return ERR.notFound("Artifact")

  // Slice 10: project isolation (contract §4)
  const access = await requireEntityProject(artifact, "Artifact", "write")
  if (!access.ok) return access.response

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return ERR.badRequest("body must be multipart/form-data")
  }

  const file = form.get("file")
  if (!(file instanceof File)) {
    return ERR.badRequest("file is required (multipart field 'file')")
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1)
    return ERR.tooLarge(`File is ${mb} MB — uploads above 100 MB are rejected in Phase 1. Keep artifacts under 100 MB.`)
  }
  const noteField = form.get("note")
  const note = typeof noteField === "string" && noteField.trim().length > 0 ? noteField.trim() : null

  const maxRev = await db.artifactRevision.aggregate({
    where: { artifactId: id },
    _max: { revNumber: true },
  })
  const revNumber = (maxRev._max.revNumber ?? 0) + 1

  const filename = file.name && file.name.trim().length > 0 ? file.name.trim() : "untitled"
  const revisionId = newId("rev")
  const buffer = Buffer.from(await file.arrayBuffer())
  const stored = await saveRevisionFile(artifact.projectId, id, revisionId, buffer)

  const revision = await db.artifactRevision.create({
    data: {
      id: revisionId,
      artifactId: id,
      revNumber,
      contentHash: stored.sha256,
      sizeBytes: stored.sizeBytes,
      storageKey: stored.storageKey,
      mimeType: detectArtifactKind(filename).mimeType,
      note,
      uploadedBy: "local-operator",
    },
  })

  await db.artifact.update({
    where: { id },
    data: { latestRevisionId: revisionId },
  })

  // --- Staleness cascade (Journey G seed) -------------------------------------
  const impactLinks = await db.artifactLink.findMany({
    where: { toArtifactId: id, relationType: { in: [...IMPACT_RELATIONS] } },
    include: { fromArtifact: { include: { latestRevision: true } } },
  })

  const staleMarked: Array<{ artifactId: string; name: string; relation: string; path: string[] }> = []
  const seenSources = new Set<string>()

  for (const link of impactLinks) {
    const source = link.fromArtifact
    if (seenSources.has(source.id)) continue
    seenSources.add(source.id)

    const latest = source.latestRevision
    if (!latest) continue

    const next = nextStaleness(latest.staleness as StalenessState, "source-changed")
    if (next === null) continue

    await db.artifactRevision.update({ where: { id: latest.id }, data: { staleness: next } })

    await recordEvent({
      projectId: source.projectId,
      action: "artifact.staled",
      entityType: "artifact",
      entityId: source.id,
      detail: {
        staleArtifactId: source.id,
        because: artifact.id,
        relation: link.relationType,
        path: [artifact.id, source.id],
      },
    })

    staleMarked.push({
      artifactId: source.id,
      name: source.name,
      relation: link.relationType,
      path: [artifact.id, source.id],
    })
  }

  await recordEvent({
    projectId: artifact.projectId,
    action: "artifact.revised",
    entityType: "artifact",
    entityId: id,
    detail: {
      artifactName: artifact.name,
      revNumber,
      sha256: stored.sha256,
      sizeBytes: stored.sizeBytes,
      staleMarked: staleMarked.length,
    },
  })

  return jsonOk({ revision, staleMarked }, { status: 201 })
})
