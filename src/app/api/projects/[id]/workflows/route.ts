import { z } from "zod"

import { CREATOR_ACTOR_RE, isAgentActor, parseWorkflowDefinition } from "@/core/workflow"
import { enqueueWorkflow, recoverOrphanedRuns, recordWorkflowEvent } from "@/core/runtime/executor"
import { recordEvent } from "@/lib/audit"
import { jsonOk, ERR, parseBody } from "@/lib/api-utils"
import { db } from "@/lib/db"
import { newId } from "@/lib/ids"

import { handler } from "../../../_lib/route-helpers"

export const dynamic = "force-dynamic"

const createSchema = z.object({
  name: z.string().min(1, "name is required").max(120, "name must be at most 120 characters"),
  definition: z.unknown(), // validated verbatim via parseWorkflowDefinition below
  createdBy: z.string().optional(),
})

/**
 * GET /api/projects/[id]/workflows — list rows as-is (the UI reads detail
 * from GET /api/workflows/[id]). Housekeeping first (contract §8): the
 * recovery scan marks orphaned `running` rows failed, then every `queued`
 * row is re-claimed (idempotent: the executor's guarded claim skips rows
 * that are no longer queued) — after a server restart the list call is what
 * puts queued work back in motion.
 */
export const GET = handler<{ id: string }>(async (_req, ctx) => {
  const { id } = await ctx.params

  const project = await db.project.findUnique({ where: { id }, select: { id: true } })
  if (!project) return ERR.notFound("Project")

  try {
    await recoverOrphanedRuns()
  } catch (err) {
    // A read must not fail on housekeeping — the scan retries on the next
    // list call / module load.
    console.error("[api] workflow recovery scan failed during list:", err)
  }

  const queued = await db.workflow.findMany({
    where: { projectId: id, state: "queued" },
    select: { id: true },
  })
  for (const wf of queued) {
    enqueueWorkflow(wf.id) // fire-and-forget claim; never awaited here
  }

  const workflows = await db.workflow.findMany({ where: { projectId: id }, orderBy: { createdAt: "desc" } })

  return jsonOk({ workflows })
})

/**
 * POST /api/projects/[id]/workflows — create in state `draft` (contract §6).
 * The definition is validated via `parseWorkflowDefinition` (422 with the
 * joined verbatim message on failure) and stored as CANONICAL JSON (parsed
 * value re-serialized — defaults filled, unknown keys stripped). `createdBy`
 * must match CREATOR_ACTOR_RE: the human operator or a named agent actor.
 * Step rows are NOT created here — they snapshot input revisions at QUEUE
 * time; until then the definition is the only truth.
 */
export const POST = handler<{ id: string }>(async (req, ctx) => {
  const { id } = await ctx.params

  const project = await db.project.findUnique({ where: { id }, select: { id: true } })
  if (!project) return ERR.notFound("Project")

  const parsed = await parseBody(req, createSchema)
  if (!parsed.ok) return parsed.response

  const def = parseWorkflowDefinition(parsed.data.definition)
  if (!def.ok) return ERR.invalid(def.error)

  const createdBy = parsed.data.createdBy ?? "local-operator"
  if (!CREATOR_ACTOR_RE.test(createdBy)) {
    return ERR.invalid(
      'createdBy must be "local-operator" or an agent actor "agent:<name>" (name: ^[a-z0-9-]{1,32}$)',
    )
  }

  const workflow = await db.workflow.create({
    data: {
      id: newId("wfl"),
      projectId: id,
      name: parsed.data.name,
      state: "draft",
      definition: JSON.stringify(def.value),
      createdBy,
      currentStateSince: new Date(),
    },
  })

  const actorType = isAgentActor(createdBy) ? "agent" : "user"
  await recordWorkflowEvent(workflow.id, "workflow.created", actorType, createdBy, {
    name: workflow.name,
    stepCount: def.value.steps.length,
  })
  await recordEvent({
    projectId: id,
    actorType,
    actorId: createdBy,
    action: "workflow.created",
    entityType: "workflow",
    entityId: workflow.id,
    detail: { name: workflow.name, stepCount: def.value.steps.length, createdBy },
  })

  return jsonOk({ workflow }, { status: 201 })
})
