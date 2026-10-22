import { detectArtifactKind, isArtifactKind } from "@/lib/artifact-meta"
import { recordEvent } from "@/lib/audit"
import { jsonOk, ERR } from "@/lib/api-utils"
import { db } from "@/lib/db"
import { newId } from "@/lib/ids"
import { saveRevisionFile } from "@/lib/artifact-store"

import { handler, requireProjectAccess } from "../../../_lib/route-helpers"

export const dynamic = "force-dynamic"

/** Phase-1 upload limit (bytes) — friendly 413-style error above this. */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

function filenameBase(filename: string): string {
  const idx = filename.lastIndexOf(".")
  const base = idx > 0 ? filename.slice(0, idx) : filename
  return base.trim().length > 0 ? base.trim() : filename
}

/** GET /api/projects/[id]/artifacts — registry table payload. */
export const GET = handler<{ id: string }>(async (_req, ctx) => {
  const { id } = await ctx.params

  const project = await db.project.findUnique({ where: { id }, select: { id: true } })
  if (!project) return ERR.notFound("Project")

  // Slice 10: project isolation (contract §4)
  const access = await requireProjectAccess(id, "read")
  if (!access.ok) return access.response

  const artifacts = await db.artifact.findMany({
    where: { projectId: id },
    orderBy: { updatedAt: "desc" },
    include: { latestRevision: true, _count: { select: { revisions: true } } },
  })

  return jsonOk({ artifacts })
})

/** POST /api/projects/[id]/artifacts — multipart register (rev 1) + audit. */
export const POST = handler<{ id: string }>(async (req, ctx) => {
  const { id } = await ctx.params

  const project = await db.project.findUnique({ where: { id }, select: { id: true } })
  if (!project) return ERR.notFound("Project")

  const access = await requireProjectAccess(id, "write")
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
  const filename = file.name && file.name.trim().length > 0 ? file.name.trim() : "untitled"
  if (file.size > MAX_UPLOAD_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1)
    return ERR.tooLarge(`File is ${mb} MB — uploads above 100 MB are rejected in Phase 1. Keep artifacts under 100 MB.`)
  }

  const declaredKind = form.get("kind")
  const detected = detectArtifactKind(filename)
  const kind =
    typeof declaredKind === "string" && declaredKind.trim().length > 0 && isArtifactKind(declaredKind.trim())
      ? declaredKind.trim()
      : detected.kind

  const nameField = form.get("name")
  const name =
    typeof nameField === "string" && nameField.trim().length > 0 ? nameField.trim() : filenameBase(filename)

  const noteField = form.get("note")
  const note = typeof noteField === "string" && noteField.trim().length > 0 ? noteField.trim() : null

  const buffer = Buffer.from(await file.arrayBuffer())

  const artifactId = newId("art")
  const revisionId = newId("rev")
  const stored = await saveRevisionFile(id, artifactId, revisionId, buffer)

  try {
    // The FK (latestRevisionId) lives on Artifact itself, so Prisma cannot
    // nested-create the revision — write artifact, revision, then link them
    // in one transaction.
    const artifact = await db.$transaction(async (tx) => {
      const created = await tx.artifact.create({
        data: { id: artifactId, projectId: id, kind, name },
      })
      await tx.artifactRevision.create({
        data: {
          id: revisionId,
          artifactId: created.id,
          revNumber: 1,
          contentHash: stored.sha256,
          sizeBytes: stored.sizeBytes,
          storageKey: stored.storageKey,
          mimeType: detected.mimeType,
          note,
          uploadedBy: "local-operator",
        },
      })
      return tx.artifact.update({
        where: { id: created.id },
        data: { latestRevisionId: revisionId },
        include: { latestRevision: true, _count: { select: { revisions: true } } },
      })
    })

    await recordEvent({
      projectId: id,
      action: "artifact.registered",
      entityType: "artifact",
      entityId: artifactId,
      detail: { name, kind, sha256: stored.sha256, sizeBytes: stored.sizeBytes, revNumber: 1 },
    })

    return jsonOk({ artifact }, { status: 201 })
  } catch (err) {
    console.error("[api] artifact register failed after file write — orphaned bytes remain in store:", err)
    throw err
  }
})
