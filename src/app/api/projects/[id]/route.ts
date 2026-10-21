import { z } from "zod"

import { recordEvent } from "@/lib/audit"
import { jsonOk, ERR, parseBody } from "@/lib/api-utils"
import { db } from "@/lib/db"

import { handler } from "../../_lib/route-helpers"

export const dynamic = "force-dynamic"

const patchSchema = z.object({
  name: z.string().trim().min(1, "name cannot be empty").max(120, "name must be at most 120 characters").optional(),
  description: z
    .string()
    .max(2000, "description must be at most 2000 characters")
    .nullable()
    .optional(),
  status: z.string().trim().min(1, "status cannot be empty").max(30, "status must be at most 30 characters").optional(),
})

/** GET /api/projects/[id] — full project workspace payload. */
export const GET = handler<{ id: string }>(async (_req, ctx) => {
  const { id } = await ctx.params

  const project = await db.project.findUnique({
    where: { id },
    include: {
      members: { orderBy: { addedAt: "asc" } },
      artifacts: {
        orderBy: { updatedAt: "desc" },
        include: { latestRevision: true, _count: { select: { revisions: true } } },
      },
    },
  })
  if (!project) return ERR.notFound("Project")

  const [events, revisionCount] = await Promise.all([
    db.auditEvent.findMany({
      where: { projectId: id },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    db.artifactRevision.count({ where: { artifact: { projectId: id } } }),
  ])

  return jsonOk({
    project,
    events,
    counts: { artifacts: project.artifacts.length, revisions: revisionCount, members: project.members.length },
  })
})

/** PATCH /api/projects/[id] — partial update + audit event. */
export const PATCH = handler<{ id: string }>(async (req, ctx) => {
  const { id } = await ctx.params

  const existing = await db.project.findUnique({ where: { id }, select: { id: true } })
  if (!existing) return ERR.notFound("Project")

  const parsed = await parseBody(req, patchSchema)
  if (!parsed.ok) return parsed.response

  const data = parsed.data
  if (data.name === undefined && data.description === undefined && data.status === undefined) {
    return ERR.badRequest("Provide at least one field to update (name, description, status)")
  }

  const project = await db.project.update({
    where: { id },
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.description !== undefined
        ? { description: data.description?.trim().length ? data.description.trim() : null }
        : {}),
      ...(data.status !== undefined ? { status: data.status } : {}),
    },
  })

  await recordEvent({
    projectId: id,
    action: "project.updated",
    entityType: "project",
    entityId: id,
    detail: { fields: Object.keys(data) },
  })

  return jsonOk({ project })
})
