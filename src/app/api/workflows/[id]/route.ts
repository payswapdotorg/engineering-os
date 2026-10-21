import { canApprove } from "@/core/workflow"
import { jsonOk, ERR } from "@/lib/api-utils"
import { db } from "@/lib/db"

import { handler } from "../../_lib/route-helpers"

export const dynamic = "force-dynamic"

/**
 * GET /api/workflows/[id] — full detail for the workspace panel (contract §6):
 * the workflow row, its WorkflowStepRun rows in execution order, the newest
 * 200 WorkflowEvent rows (newest first) and `canApprove` (true only while a
 * gate step is awaiting AND the approver is a human actor — the server-side
 * actor is always the user local-operator, and `canApprove` enforces that an
 * agent can never approve, regardless of creator).
 */
export const GET = handler<{ id: string }>(async (_req, ctx) => {
  const { id } = await ctx.params

  const workflow = await db.workflow.findUnique({ where: { id } })
  if (!workflow) return ERR.notFound("Workflow")

  const [steps, events] = await Promise.all([
    db.workflowStepRun.findMany({ where: { workflowId: id }, orderBy: { seq: "asc" } }),
    db.workflowEvent.findMany({ where: { workflowId: id }, orderBy: { seq: "desc" }, take: 200 }),
  ])

  return jsonOk({
    workflow,
    steps,
    events,
    canApprove: workflow.state === "awaiting_approval" && canApprove(workflow.createdBy, "user"),
  })
})
