import { z } from "zod"

import { RELATION_TYPES } from "@/core"
import { recordEvent } from "@/lib/audit"
import { jsonOk, ERR, parseBody } from "@/lib/api-utils"
import { db } from "@/lib/db"
import { newId } from "@/lib/ids"

import { handler, isUniqueViolation, requireEntityProject, stringEnum } from "../../../_lib/route-helpers"

export const dynamic = "force-dynamic"

const linkSchema = z.object({
  toArtifactId: z.string().trim().min(1, "toArtifactId is required"),
  relationType: stringEnum(RELATION_TYPES, "relationType"),
})

/** POST /api/artifacts/[id]/links — typed edge between artifacts (same project). */
export const POST = handler<{ id: string }>(async (req, ctx) => {
  const { id } = await ctx.params

  const source = await db.artifact.findUnique({ where: { id }, select: { id: true, projectId: true, name: true } })
  if (!source) return ERR.notFound("Source artifact")

  // Slice 10: project isolation (contract §4)
  const access = await requireEntityProject(source, "Artifact", "write")
  if (!access.ok) return access.response

  const parsed = await parseBody(req, linkSchema)
  if (!parsed.ok) return parsed.response
  const { toArtifactId, relationType } = parsed.data

  if (toArtifactId === id) {
    return ERR.badRequest("An artifact cannot be linked to itself")
  }

  const target = await db.artifact.findUnique({
    where: { id: toArtifactId },
    select: { id: true, projectId: true, name: true },
  })
  if (!target) return ERR.notFound("Target artifact")

  if (target.projectId !== source.projectId) {
    return ERR.badRequest("Links must stay within the same project in Phase 1")
  }

  try {
    const link = await db.artifactLink.create({
      data: {
        id: newId("lnk"),
        fromArtifactId: id,
        toArtifactId,
        relationType,
        createdBy: "local-operator",
      },
    })

    await recordEvent({
      projectId: source.projectId,
      action: "link.created",
      entityType: "artifact",
      entityId: id,
      detail: {
        fromArtifactId: id,
        fromArtifactName: source.name,
        toArtifactId,
        toArtifactName: target.name,
        relationType,
        impact: ["derived_from", "analyzes", "quantifies", "validates", "depends_on"].includes(relationType),
      },
    })

    return jsonOk({ link }, { status: 201 })
  } catch (err) {
    if (isUniqueViolation(err)) {
      return ERR.conflict("This relation already exists between the two artifacts")
    }
    throw err
  }
})
