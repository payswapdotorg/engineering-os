import { z } from "zod"

import { TEAM_ROLES } from "@/core"
import { recordEvent } from "@/lib/audit"
import { jsonOk, ERR, parseBody } from "@/lib/api-utils"
import { getSessionUser } from "@/lib/auth"
import { db } from "@/lib/db"
import { newId } from "@/lib/ids"

import { handler, stringEnum, ERR_MEMBER_MANAGEMENT, ERR_SIGN_IN_REQUIRED } from "../../../_lib/route-helpers"

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

/** POST /api/projects/[id]/members — team roster mutation, owner/admin only.
 *
 * Phase-6 (contract §1.3): managing team members additionally requires the
 * caller to be the project owner (TeamMember.role "owner", matched on the
 * session identity: email first, name as the legacy fallback) or a global
 * admin — 403 verbatim otherwise. The project-create route auto-creates the
 * creator's owner row, so a fresh project is never locked out. */
export const POST = handler<{ id: string }>(async (req, ctx) => {
  const { id } = await ctx.params

  const project = await db.project.findUnique({ where: { id }, select: { id: true } })
  if (!project) return ERR.notFound("Project")

  const session = await getSessionUser()
  if (!session) return ERR_SIGN_IN_REQUIRED()
  if (session.role !== "admin") {
    const ownerRow = await db.teamMember.findFirst({
      where: {
        projectId: id,
        role: "owner",
        OR: [{ email: session.email }, { name: session.name }],
      },
      select: { id: true },
    })
    if (!ownerRow) return ERR_MEMBER_MANAGEMENT()
  }

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
