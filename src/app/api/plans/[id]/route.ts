/**
 * Engineering OS — plan detail API (Slice 11, agent-planning-contract §5.2).
 *
 * GET /api/plans/[id] — one plan row as the §5.4 PlanRow. stepSummary is
 * recomputed with the project's artifact names (id→{name,kind}), so the
 * review card shows REAL artifact names, never ids alone. Missing plan →
 * 404 `Plan not found`; Slice-10 isolation via requireEntityProject(read)
 * — a hidden project and a missing plan are indistinguishable.
 */

import { jsonOk, ERR } from "@/lib/api-utils"
import { db } from "@/lib/db"
import { loadArtifactNameMap, toPlanRow } from "@/lib/plan-row"

import { handler, requireEntityProject } from "../../_lib/route-helpers"

export const dynamic = "force-dynamic"

export const GET = handler<{ id: string }>(async (_req, ctx) => {
  const { id } = await ctx.params

  const plan = await db.agentPlan.findUnique({ where: { id } })
  if (!plan) return ERR.notFound("Plan")

  // Slice 10: project isolation (contract §4)
  const access = await requireEntityProject(plan, "Plan", "read")
  if (!access.ok) return access.response

  const artifactNameById = await loadArtifactNameMap(plan.projectId)
  return jsonOk({ plan: toPlanRow(plan, artifactNameById) })
})
