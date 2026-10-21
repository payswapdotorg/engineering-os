import { db } from "@/lib/db"
import { jsonOk } from "@/lib/api-utils"

import { handler } from "../_lib/route-helpers"

export const dynamic = "force-dynamic"

/**
 * GET /api/events?projectId=&limit= — append-only audit feed (newest first).
 * `projectId` filters to one project; omit it for the global feed. Includes the
 * project name so the global feed can attribute each event.
 */
export const GET = handler(async (req) => {
  const url = new URL(req.url)

  const projectIdParam = url.searchParams.get("projectId")
  const projectId = projectIdParam && projectIdParam.trim().length > 0 ? projectIdParam.trim() : null

  let limit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10)
  if (!Number.isFinite(limit) || limit <= 0) limit = 50
  limit = Math.min(limit, 200)

  const events = await db.auditEvent.findMany({
    where: projectId ? { projectId } : undefined,
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { project: { select: { name: true, discipline: true } } },
  })

  return jsonOk({ events })
})
