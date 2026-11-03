import { z } from "zod"

import { isWorkflowState, type WorkflowState } from "@/core"
import {
  WORKFLOW_ACTIONS,
  applyWorkflowAction,
  canApprove,
  parseWorkflowDefinition,
  type WorkflowAction,
} from "@/core/workflow"
import {
  approveWorkflow,
  recordWorkflowEvent,
  snapshotStepInputs,
  type StepSnapshot,
} from "@/core/runtime/executor"
import { getFoundation } from "@/core/runtime/foundation"
import "@/core/runtime/foundation-embedded" // registers the embedded foundation + fail-fast flag resolution (ADR-0010)
import { recordEvent } from "@/lib/audit"
import { jsonError, jsonOk, ERR, parseBody } from "@/lib/api-utils"
import { getSessionUser } from "@/lib/auth"
import { db } from "@/lib/db"
import { newId } from "@/lib/ids"

import { handler, requireEntityProject } from "../../../_lib/route-helpers"

export const dynamic = "force-dynamic"

const transitionSchema = z.object({
  action: z.enum(WORKFLOW_ACTIONS),
  note: z.string().max(500, "note must be at most 500 characters").optional(),
})

/** Sentinel thrown inside transactions when the guarded state move raced. */
class StateRaceError extends Error {}

type ExtraWorkflowData = { failure?: string | null; finishedAt?: Date | null }

/** Guarded state write: the row only moves when it is still in `expected`. */
async function guardMove(
  id: string,
  expected: WorkflowState,
  to: WorkflowState,
  extra: ExtraWorkflowData = {},
): Promise<boolean> {
  const updated = await db.workflow.updateMany({
    where: { id, state: expected },
    data: { state: to, currentStateSince: new Date(), ...extra },
  })
  return updated.count === 1
}

/** Fresh-state 409 (the row moved between the machine check and the write). */
async function conflictFresh(id: string, action: WorkflowAction): Promise<Response> {
  const fresh = await db.workflow.findUnique({ where: { id }, select: { state: true } })
  return ERR.conflict(`cannot ${action} a workflow in state "${fresh?.state ?? "unknown"}"`)
}

function parseDefinition(definition: string | null): unknown {
  try {
    return definition === null ? null : JSON.parse(definition)
  } catch {
    return null // falls through to the verbatim parse error in the caller
  }
}

function stepRunData(snapshot: StepSnapshot) {
  return {
    state: "pending",
    attempt: 0,
    maxAttempts: snapshot.maxAttempts,
    inputRevisionIds: JSON.stringify(snapshot.inputRevisionIds),
    inputHashes: JSON.stringify(snapshot.inputHashes),
    startedAt: null,
    endedAt: null,
    durationMs: null,
    exitCode: null,
    outputArtifactRevisionId: null,
    outputSummary: null,
    engineKey: null,
    engineVersion: null,
    adapterScript: null,
    adapterHash: null,
    stdoutTail: null,
    stderrTail: null,
  }
}

/**
 * POST /api/workflows/[id]/transition — {action, note?} (contract §6).
 * `applyWorkflowAction` is the single authority: an illegal move is a 409
 * with the verbatim `cannot <action> a workflow in state "<current>"`
 * message. Every state change updates currentStateSince. NO actor is ever
 * read from the body (ADR-0006 red line) — the acting human is the signed-in
 * session user (contract §1.3), stamped on the workflow events and audit
 * events; the `canApprove` defense makes an agent approver impossible by
 * construction (403 if it could ever fail).
 *
 * queue: snapshot every step's input revisions (locked at QUEUE time, §8) —
 * a missing artifact is a 422 verbatim — create the WorkflowStepRun rows and
 * THEN hand the workflow to the executor (fire-and-forget claim).
 *
 * retry: re-snapshots input revisions for the re-run steps ONLY (steps from
 * the failed one onward; earlier succeeded outputs are kept, §3), resets
 * their rows (state pending, attempt 0) and re-queues. `failure` stays on
 * the row for audit; any later failure overwrites it.
 *
 * approve: THE RED LINE — there is no actor parameter; the approver is the
 * signed-in session user resolved server-side (falling back to the
 * Phase-1..5 "local-operator" identity only in non-session contexts), and
 * publishing happens in approveWorkflow (artifact.approved +
 * workflow.approved events).
 *
 * reject: the workflow is cancelled with a workflow.rejected event; the
 * gate step's draft output REMAINS (auditable, never silently deleted) and
 * its row stays awaiting_approval as an honest record.
 */
export const POST = handler<{ id: string }>(async (req, ctx) => {
  const { id } = await ctx.params

  // The acting human: the signed-in session user (session gates guarantee a
  // session exists for this POST; the fallback keeps non-request callers
  // honest). Never read from the body — ADR-0006 red line.
  const session = await getSessionUser()
  const actorId = session?.id ?? "local-operator"
  const actorName = session?.name ?? "local-operator"

  const workflow = await db.workflow.findUnique({ where: { id } })
  if (!workflow) return ERR.notFound("Workflow")

  // Slice 10: project isolation (contract §4)
  const access = await requireEntityProject(workflow, "Workflow", "write")
  if (!access.ok) return access.response

  const parsed = await parseBody(req, transitionSchema)
  if (!parsed.ok) return parsed.response
  const action = parsed.data.action
  const note = parsed.data.note ?? null

  const current = workflow.state as WorkflowState
  if (!isWorkflowState(current)) {
    return ERR.server() // corrupted row: unknown state string — refuse honestly
  }
  const next = applyWorkflowAction(current, action)
  if (next === null) {
    return ERR.conflict(`cannot ${action} a workflow in state "${current}"`)
  }

  if (action === "mark-ready") {
    // Re-parse the stored definition defensively (validated at create).
    const def = parseWorkflowDefinition(parseDefinition(workflow.definition))
    if (!def.ok) return ERR.invalid(def.error)

    if (!(await guardMove(id, current, next))) return conflictFresh(id, action)
    await recordWorkflowEvent(id, "workflow.ready", "user", actorId, {})
    await recordEvent({
      projectId: workflow.projectId,
      action: "workflow.updated",
      entityType: "workflow",
      entityId: id,
      detail: { action, from: current, to: next, note },
    })
    return jsonOk({ workflow: await db.workflow.findUnique({ where: { id } }) })
  }

  if (action === "queue") {
    const def = parseWorkflowDefinition(parseDefinition(workflow.definition))
    if (!def.ok) return ERR.invalid(def.error)

    // Lock inputs at QUEUE time (contract §8): latest revision ids + hashes
    // snapshotted into the step rows the run will read.
    const snap = await snapshotStepInputs(workflow.projectId, def.value.steps)
    if (!snap.ok) return ERR.invalid(snap.error)

    try {
      await db.$transaction(async (tx) => {
        // queue always creates a FRESH snapshot (a leftover partial queue
        // attempt must not leave stale rows behind).
        await tx.workflowStepRun.deleteMany({ where: { workflowId: id } })
        for (const snapshot of snap.snapshots) {
          await tx.workflowStepRun.create({
            data: {
              id: newId("wstep"),
              workflowId: id,
              stepId: snapshot.stepId,
              seq: snapshot.seq,
              operation: snapshot.operation,
              ...stepRunData(snapshot),
            },
          })
        }
        const moved = await tx.workflow.updateMany({
          where: { id, state: current },
          data: { state: next, currentStateSince: new Date() },
        })
        if (moved.count !== 1) throw new StateRaceError()
      })
    } catch (err) {
      if (err instanceof StateRaceError) return conflictFresh(id, action)
      throw err
    }

    await recordWorkflowEvent(id, "workflow.queued", "user", actorId, {
      stepCount: snap.snapshots.length,
    })
    await recordEvent({
      projectId: workflow.projectId,
      action: "workflow.updated",
      entityType: "workflow",
      entityId: id,
      detail: { action, from: current, to: next, note },
    })
    getFoundation().enqueue(id) // fire-and-forget claim; execution is never awaited here
    return jsonOk({ workflow: await db.workflow.findUnique({ where: { id } }) })
  }

  if (action === "cancel") {
    if (!(await guardMove(id, current, next, { finishedAt: new Date() }))) {
      return conflictFresh(id, action)
    }
    await recordWorkflowEvent(id, "workflow.cancelled", "user", actorId, { note })
    await recordEvent({
      projectId: workflow.projectId,
      action: "workflow.updated",
      entityType: "workflow",
      entityId: id,
      detail: { action, from: current, to: next, note },
    })
    return jsonOk({ workflow: await db.workflow.findUnique({ where: { id } }) })
  }

  if (action === "retry") {
    const def = parseWorkflowDefinition(parseDefinition(workflow.definition))
    if (!def.ok) return ERR.invalid(def.error)

    const rows = await db.workflowStepRun.findMany({ where: { workflowId: id }, orderBy: { seq: "asc" } })
    // Resume from the FIRST row that did not finish (the failed one, or a
    // running one stuck by an interrupted run — recovery-marked). Earlier
    // succeeded/skipped rows keep their locked inputs and outputs.
    const firstUnfinished = rows.findIndex((r) => r.state !== "succeeded" && r.state !== "skipped")
    const from = firstUnfinished === -1 ? rows.length : firstUnfinished

    // Re-snapshot the re-run steps against the artifacts' CURRENT latest
    // revisions (the sources must still exist — 422 verbatim otherwise).
    const snap = await snapshotStepInputs(workflow.projectId, def.value.steps, from)
    if (!snap.ok) return ERR.invalid(snap.error)

    try {
      await db.$transaction(async (tx) => {
        for (const snapshot of snap.snapshots) {
          const existing = rows.find((r) => r.seq === snapshot.seq)
          const data = stepRunData(snapshot)
          if (existing) {
            await tx.workflowStepRun.update({ where: { id: existing.id }, data })
          } else {
            await tx.workflowStepRun.create({
              data: {
                id: newId("wstep"),
                workflowId: id,
                stepId: snapshot.stepId,
                seq: snapshot.seq,
                operation: snapshot.operation,
                ...data,
              },
            })
          }
        }
        // failure is KEPT for audit (the new run overwrites it only if it
        // fails again); the step rows from the failed one onward are reset.
        const moved = await tx.workflow.updateMany({
          where: { id, state: current },
          data: { state: next, currentStateSince: new Date() },
        })
        if (moved.count !== 1) throw new StateRaceError()
      })
    } catch (err) {
      if (err instanceof StateRaceError) return conflictFresh(id, action)
      throw err
    }

    await recordWorkflowEvent(id, "workflow.queued", "user", actorId, {
      retry: true,
      resumedFromStepId: def.value.steps[from]?.id ?? null,
    })
    await recordEvent({
      projectId: workflow.projectId,
      action: "workflow.updated",
      entityType: "workflow",
      entityId: id,
      detail: { action, from: current, to: next, note },
    })
    getFoundation().enqueue(id)
    return jsonOk({ workflow: await db.workflow.findUnique({ where: { id } }) })
  }

  if (action === "approve") {
    // THE RED LINE (ADR-0006 §3, contract §4.1): no actor is ever read from
    // the body; the approver is hard-coded server-side. The defense below
    // can never fire with the current single-user reality — it exists so
    // that the invariant is enforced in code, not by convention.
    if (!canApprove(workflow.createdBy, "user")) {
      return jsonError(403, "forbidden", "only a human actor can approve a workflow (agents never approve)")
    }
    const approved = await approveWorkflow(id, note, session ? { actorId, userName: actorName } : undefined)
    if (!approved.ok) return conflictFresh(id, action)
    await recordEvent({
      projectId: workflow.projectId,
      action: "workflow.updated",
      entityType: "workflow",
      entityId: id,
      detail: { action, from: current, to: next, note },
    })
    return jsonOk({ workflow: await db.workflow.findUnique({ where: { id } }) })
  }

  // action === "reject"
  if (!(await guardMove(id, current, next, { finishedAt: new Date() }))) {
    return conflictFresh(id, action)
  }
  await recordWorkflowEvent(id, "workflow.rejected", "user", actorId, { note, by: actorName })
  await recordEvent({
    projectId: workflow.projectId,
    action: "workflow.updated",
    entityType: "workflow",
    entityId: id,
    detail: { action, from: current, to: next, note },
  })
  return jsonOk({ workflow: await db.workflow.findUnique({ where: { id } }) })
})
