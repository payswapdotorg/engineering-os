/**
 * Engineering OS — plan decision API (Slice 11, agent-planning-contract §5.3).
 *
 * POST /api/plans/[id]/decision — the HUMAN decision on a proposed plan
 * (ADR-0008 §3: the planner proposes, a human disposes).
 *
 *  - Body is {action: "accept" | "reject"} ONLY — the schema is strict and
 *    the route NEVER reads an actor/approver field: acceptance is the
 *    signed-in member's action by construction (ADR-0006 red line).
 *  - Any non-`proposed` status → 409 `this plan is already <status>` (pinned
 *    verbatim; failed rows get it with their status too — §2.1 terminal).
 *  - `reject`: a guarded move (proposed → rejected) + decidedById/At; audit
 *    `plan.rejected`. 200 {plan}.
 *  - `accept`: FIRST re-run validatePlanDefinition against the LIVE project
 *    artifacts (defense in depth — artifacts may have been deleted since the
 *    proposal; the plan STAYS proposed on failure so the human may
 *    regenerate). Then one transaction: guarded proposed → accepted, create
 *    the DRAFT workflow EXACTLY like POST /api/projects/[id]/workflows does
 *    (state draft, createdBy = PLANNER_ACTOR, canonical definition JSON,
 *    name = intent.slice(0, 60) + " (AI plan)", plus the workflow.created
 *    event + audit parity with the manual route), and link plan.workflowId.
 *    Audit `plan.accepted` AFTER the commit. 200 {plan, workflow}.
 *
 * The created workflow is a DRAFT the human still mark-readies and queues
 * through the existing routes; every approval gate inside it stays
 * human-only (ADR-0006) — the planner has no transition/approval powers.
 */

import { z } from "zod"

import { PLANNER_ACTOR, validatePlanDefinition, type PlannerArtifactContext } from "@/core/planner"
import { recordWorkflowEvent } from "@/core/runtime/executor"
import { recordEvent } from "@/lib/audit"
import { jsonOk, ERR, parseBody } from "@/lib/api-utils"
import { getSessionUser } from "@/lib/auth"
import { db } from "@/lib/db"
import { newId } from "@/lib/ids"
import { loadArtifactNameMap, toPlanRow } from "@/lib/plan-row"

import { handler, requireEntityProject } from "../../../_lib/route-helpers"

export const dynamic = "force-dynamic"

const decisionSchema = z.object({
  action: z.enum(["accept", "reject"], { message: "action must be accept or reject" }),
})

/** Sentinel thrown inside the transaction when the guarded move raced. */
class AlreadyDecided extends Error {}

/** Fresh-status 409 (the row moved between the status check and the write). */
async function conflictFresh(id: string): Promise<Response> {
  const fresh = await db.agentPlan.findUnique({ where: { id }, select: { status: true } })
  return ERR.conflict(`this plan is already ${fresh?.status ?? "unknown"}`)
}

export const POST = handler<{ id: string }>(async (req, ctx) => {
  const { id } = await ctx.params

  // The deciding human: the signed-in session user (the wrapper already 401s
  // without a session; the null fallthrough keeps non-request callers honest).
  // Never read from the body — ADR-0006 red line.
  const session = await getSessionUser()
  const decidedById = session?.id ?? null

  const plan = await db.agentPlan.findUnique({ where: { id } })
  if (!plan) return ERR.notFound("Plan")

  // Slice 10: project isolation (contract §4)
  const access = await requireEntityProject(plan, "Plan", "write")
  if (!access.ok) return access.response

  const parsed = await parseBody(req, decisionSchema)
  if (!parsed.ok) return parsed.response

  if (plan.status !== "proposed") {
    return ERR.conflict(`this plan is already ${plan.status}`)
  }

  if (parsed.data.action === "reject") {
    const moved = await db.agentPlan.updateMany({
      where: { id, status: "proposed" },
      data: { status: "rejected", decidedById, decidedAt: new Date() },
    })
    if (moved.count !== 1) return conflictFresh(id)

    await recordEvent({
      projectId: plan.projectId,
      action: "plan.rejected",
      entityType: "AgentPlan",
      entityId: id,
      detail: { planId: id },
    })

    const fresh = await db.agentPlan.findUnique({ where: { id } })
    const artifactNameById = await loadArtifactNameMap(plan.projectId)
    return jsonOk({ plan: toPlanRow(fresh ?? plan, artifactNameById) })
  }

  // action === "accept" — re-validate against the LIVE project artifacts
  // (§5.3 defense in depth) before anything moves.
  let definition: unknown = null
  if (plan.plan !== null) {
    try {
      const planJson: unknown = JSON.parse(plan.plan)
      if (typeof planJson === "object" && planJson !== null) {
        definition = (planJson as { definition?: unknown }).definition ?? null
      }
    } catch {
      definition = null // falls through to the verbatim 422 below
    }
  }
  if (definition === null) {
    return ERR.invalid("this plan has no valid definition")
  }

  const artifactNameById = await loadArtifactNameMap(plan.projectId)
  const artifactsById = new Map<string, PlannerArtifactContext>()
  for (const [artifactId, meta] of artifactNameById) {
    // validatePlanDefinition's existence gate reads key membership only —
    // the structural context fields are placeholders it never consults.
    artifactsById.set(artifactId, {
      id: artifactId,
      name: meta.name,
      kind: meta.kind,
      revisionCount: 0,
      latestApprovalState: "none",
      latestNote: null,
    })
  }
  const validated = validatePlanDefinition(definition, artifactsById)
  if (!validated.ok) {
    // The plan STAYS proposed — the human may regenerate from the evidence.
    return ERR.invalid(validated.error)
  }

  let workflow
  try {
    workflow = await db.$transaction(async (tx) => {
      const moved = await tx.agentPlan.updateMany({
        where: { id, status: "proposed" },
        data: { status: "accepted", decidedById, decidedAt: new Date() },
      })
      if (moved.count !== 1) throw new AlreadyDecided()

      // The DRAFT workflow, created EXACTLY like POST /api/projects/[id]/workflows:
      // wfl_ id, state draft, canonical definition JSON, currentStateSince set,
      // createdBy = PLANNER_ACTOR (the agent-creator callout applies to it).
      const created = await tx.workflow.create({
        data: {
          id: newId("wfl"),
          projectId: plan.projectId,
          name: plan.intent.slice(0, 60) + " (AI plan)",
          state: "draft",
          definition: JSON.stringify(validated.value),
          createdBy: PLANNER_ACTOR,
          currentStateSince: new Date(),
        },
      })
      await tx.agentPlan.update({ where: { id }, data: { workflowId: created.id } })
      return created
    })
  } catch (err) {
    if (err instanceof AlreadyDecided) return conflictFresh(id)
    throw err
  }

  // AFTER the transaction commits (the workflow exists for real): the audit
  // trail names the plan, the draft and the agent actor it was created by.
  await recordEvent({
    projectId: plan.projectId,
    action: "plan.accepted",
    entityType: "AgentPlan",
    entityId: id,
    detail: { planId: id, workflowId: workflow.id, createdBy: PLANNER_ACTOR },
  })

  // Event parity with POST /api/projects/[id]/workflows: the draft carries
  // its own workflow.created event + audit row with the AGENT actor, so the
  // run's timeline starts exactly like a manually-created workflow's.
  await recordWorkflowEvent(workflow.id, "workflow.created", "agent", PLANNER_ACTOR, {
    name: workflow.name,
    stepCount: validated.value.steps.length,
  })
  await recordEvent({
    projectId: plan.projectId,
    actorType: "agent",
    actorId: PLANNER_ACTOR,
    action: "workflow.created",
    entityType: "workflow",
    entityId: workflow.id,
    detail: { name: workflow.name, stepCount: validated.value.steps.length, createdBy: PLANNER_ACTOR },
  })

  const fresh = await db.agentPlan.findUnique({ where: { id } })
  return jsonOk({ plan: toPlanRow(fresh ?? plan, artifactNameById), workflow })
})
