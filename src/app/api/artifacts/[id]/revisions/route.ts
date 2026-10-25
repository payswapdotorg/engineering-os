import { detectArtifactKind } from "@/lib/artifact-meta"
import { recordEvent } from "@/lib/audit"
import { jsonOk, ERR } from "@/lib/api-utils"
import { db } from "@/lib/db"
import { newId } from "@/lib/ids"
import { saveRevisionFile } from "@/lib/artifact-store"
import { markDownstreamStale } from "@/lib/staleness-cascade"

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
  // The shared cascade (src/lib/staleness-cascade.ts — Slice 16 extraction,
  // byte-identical semantics; the parametric-rebuild core rides the same path).
  const staleMarked = await markDownstreamStale(artifact.projectId, id)

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
