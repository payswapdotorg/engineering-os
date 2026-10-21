import { db } from "@/lib/db"
import { jsonOk, ERR } from "@/lib/api-utils"

import { handler } from "../../../_lib/route-helpers"

export const dynamic = "force-dynamic"

/**
 * GET /api/projects/[id]/workflows — honest empty in Phase 1.
 * The Workflow model exists (ADR-0006) but the durable runtime ships in
 * Phase 4; nothing creates rows yet, so the list is queried — never faked.
 */
export const GET = handler<{ id: string }>(async (_req, ctx) => {
  const { id } = await ctx.params

  const project = await db.project.findUnique({ where: { id }, select: { id: true } })
  if (!project) return ERR.notFound("Project")

  const workflows = await db.workflow.findMany({ where: { projectId: id }, orderBy: { createdAt: "desc" } })

  return jsonOk({
    workflows,
    note: "Workflow runtime ships in Phase 4 — schema only (ADR-0006)",
  })
})
