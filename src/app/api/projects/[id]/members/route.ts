import { z } from "zod"

import { TEAM_ROLES } from "@/core"
import { recordEvent } from "@/lib/audit"
import { jsonOk, ERR, parseBody } from "@/lib/api-utils"
import { db } from "@/lib/db"
import { newId } from "@/lib/ids"

import { handler, stringEnum } from "../../../_lib/route-helpers"

export const dynamic = "force-dynamic"

const memberSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(80, "name must be at most 80 characters"),
  role: stringEnum(TEAM_ROLES, "role").default("editor"),
})

/** GET /api/projects/[id]/members */
export const GET = handler<{ id: string }>(async (_req, ctx) => {
  const { id } = await ctx.params

  const project = await db.project.findUnique({ where: { id }, select: { id: true } })
  if (!project) return ERR.notFound("Project")

  const members = await db.teamMember.findMany({ where: { projectId: id }, orderBy: { addedAt: "asc" } })
  return jsonOk({ members })
})

/** POST /api/projects/[id]/members — local team roster (auth ships Phase 4). */
export const POST = handler<{ id: string }>(async (req, ctx) => {
  const { id } = await ctx.params

  const project = await db.project.findUnique({ where: { id }, select: { id: true } })
  if (!project) return ERR.notFound("Project")

  const parsed = await parseBody(req, memberSchema)
  if (!parsed.ok) return parsed.response
  const { name, role } = parsed.data

  const duplicate = await db.teamMember.findFirst({ where: { projectId: id, name }, select: { id: true } })
  if (duplicate) {
    return ERR.conflict(`A member named "${name}" already exists in this project`)
  }

  const member = await db.teamMember.create({
    data: { id: newId("mem"), projectId: id, name, role },
  })

  await recordEvent({
    projectId: id,
    action: "member.added",
    entityType: "member",
    entityId: member.id,
    detail: { name, role },
  })

  return jsonOk({ member }, { status: 201 })
})
