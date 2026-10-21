import path from "node:path"

import { EngineUnavailableError, tessellateFromFile } from "@/engines/adapters/mesh"
import { deriveKind } from "@/engines/adapters/derive-kind"
import { recordEvent } from "@/lib/audit"
import { jsonError, jsonOk, ERR } from "@/lib/api-utils"
import { getStorageRoot, saveRevisionFile } from "@/lib/artifact-store"
import { db } from "@/lib/db"
import { newId } from "@/lib/ids"

import { handler } from "../../../../../_lib/route-helpers"
import { buildMeshFile, meshCounts, serializeMeshFile, unsupportedDeriveMessage } from "../../../../../_lib/mesh-meta"

export const dynamic = "force-dynamic"

/**
 * POST /api/projects/[id]/artifacts/[artifactId]/derive-mesh — run the REAL
 * tessellation adapter (W2 bridge) on the latest revision file and store one
 * eos-mesh/1 revision (Contract A: byte-deterministic, NO timestamps). The
 * mesh lands on its OWN artifact of kind "mesh", linked `derived_from` this
 * source: first derive creates the artifact (rev 1); every later derive
 * appends the NEXT sequential revision to that same artifact. Detection is the
 * canonical multi-signal check (src/engines/adapters/derive-kind.ts). The
 * bridge stub honestly throws until W2-d ships; that surfaces as 422
 * `engine_unavailable`, never a fake mesh. Exactly ONE audit event
 * (`mesh.derived`) per successful derive — failed derives write nothing.
 */
export const POST = handler<{ id: string; artifactId: string }>(async (_req, ctx) => {
  const { id, artifactId } = await ctx.params

  const project = await db.project.findUnique({ where: { id }, select: { id: true } })
  if (!project) return ERR.notFound("Project")

  const artifact = await db.artifact.findUnique({
    where: { id: artifactId },
    include: { latestRevision: true },
  })
  if (!artifact || artifact.projectId !== id) return ERR.notFound("Artifact")
  if (!artifact.latestRevision) {
    return ERR.badRequest("This artifact has no revisions to derive a mesh from")
  }
  const revision = artifact.latestRevision

  const kind = deriveKind(revision.storageKey, artifact.name, revision.mimeType)
  if (!kind) {
    return jsonError(422, "unsupported", unsupportedDeriveMessage(artifact.name, revision.storageKey))
  }

  const absPath = path.join(getStorageRoot(), revision.storageKey, "content")

  const result = await (async () => {
    try {
      return await tessellateFromFile(absPath, kind)
    } catch (err) {
      if (err instanceof EngineUnavailableError) {
        return { unavailable: err } as const
      }
      throw err // unexpected adapter failure → honest 500 via handler, logged
    }
  })()
  if ("unavailable" in result) {
    return jsonError(422, "engine_unavailable", result.unavailable.message)
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
      fromArtifact: { kind: "mesh", projectId: id },
    },
    orderBy: { createdAt: "asc" },
    include: { fromArtifact: { select: { id: true, name: true } } },
  })

  try {
    let meshArtifactId: string
    let meshName: string
    let revisionNumber: number
    let stored: Awaited<ReturnType<typeof saveRevisionFile>>

    if (existingLink) {
      const meshArtifact = existingLink.fromArtifact
      const maxRev = await db.artifactRevision.aggregate({
        where: { artifactId: meshArtifact.id },
        _max: { revNumber: true },
      })
      revisionNumber = (maxRev._max.revNumber ?? 0) + 1
      const meshRevisionId = newId("rev")
      stored = await saveRevisionFile(id, meshArtifact.id, meshRevisionId, bytes)
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
      const meshRevisionId = newId("rev")
      stored = await saveRevisionFile(id, meshArtifactId, meshRevisionId, bytes)
      await db.$transaction(async (tx) => {
        await tx.artifact.create({
          data: {
            id: meshArtifactId,
            projectId: id,
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
    await recordEvent({
      projectId: id,
      actorType: "agent",
      actorId: `adapter:${result.engineKey}`,
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
      },
    })

    return jsonOk(
      {
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
      },
      { status: 201 },
    )
  } catch (err) {
    console.error("[api] mesh derive failed after file write — orphaned bytes remain in store:", err)
    throw err
  }
})
