import type { Prisma } from "@prisma/client"

import { getSessionUser } from "@/lib/auth"
import { jsonOk } from "@/lib/api-utils"
import { db } from "@/lib/db"

import { ERR_SIGN_IN_REQUIRED, handler, requireProjectAccess } from "../_lib/route-helpers"

export const dynamic = "force-dynamic"

/**
 * GET /api/events?projectId=&limit= — append-only audit feed (newest first).
 * `projectId` filters to one project; omit it for the global feed. Includes the
 * project name so the global feed can attribute each event.
 */
export const GET = handler(async (req) => {
  const url = new URL(req.url)

  // Slice 10: project isolation (contract §4)
  const session = await getSessionUser()
  if (!session) return ERR_SIGN_IN_REQUIRED()

  const projectIdParam = url.searchParams.get("projectId")
  const projectId = projectIdParam && projectIdParam.trim().length > 0 ? projectIdParam.trim() : null

  let limit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10)
  if (!Number.isFinite(limit) || limit <= 0) limit = 50
  limit = Math.min(limit, 200)

  let where: Prisma.AuditEventWhereInput | undefined
  if (projectId) {
    const access = await requireProjectAccess(projectId, "read")
    if (!access.ok) return access.response
    where = { projectId }
  } else if (session.role !== "admin") {
    const memberships = await db.teamMember.findMany({
      where: { userId: session.id },
      select: { projectId: true },
    })
    where = {
      OR: [{ projectId: { in: memberships.map((row) => row.projectId) } }, { projectId: null }],
    }
  }

  const events = await db.auditEvent.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { project: { select: { name: true, discipline: true } } },
  })

  return jsonOk({ events })
})
