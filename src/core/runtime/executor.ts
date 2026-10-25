/**
 * Engineering OS — durable workflow executor (Worker 3 lane, Phase 4).
 *
 * Server-side runtime for the workflow state machine in src/core/workflow.ts
 * (the pure single transition authority — this module never invents a
 * transition). Sequential, in-process, one workflow at a time (contract §8:
 * single-operator dev reality; concurrency is a documented exclusion).
 *
 * Honesty rules (ADR-0005/0006, contract §8):
 *  - steps only move when the REAL broker operation runs
 *    (src/engines/broker.ts — W2 lane; no simulated results, ever)
 *  - a failed step writes no output; earlier succeeded outputs are kept,
 *    never silently deleted
 *  - failures record the VERBATIM adapter error (never paraphrased)
 *  - the approval RED LINE: approveWorkflow hard-codes the human actor
 *    {actorType:"user", actorId:"local-operator"} and takes no actor
 *    parameter — an agent can never approve, on any path.
 */

import { applyApproval, type ApprovalState, type WorkflowState } from "@/core"
import {
  applyWorkflowAction,
  parseWorkflowDefinition,
  type WorkflowDefinition,
  type WorkflowStepDefinition,
  type WorkflowTransitionInput,
} from "@/core/workflow"
import { BrokerRefusalError, runBrokerOperation, type BrokerContext } from "@/engines/broker"
import { recordEvent } from "@/lib/audit"
import { db } from "@/lib/db"
import { newId } from "@/lib/ids"

// ---------------------------------------------------------------------------
// Event vocabulary (contract §7 — closed set; storage.* kinds are audit
// events, NOT workflow events: they are not workflow-scoped)
// ---------------------------------------------------------------------------

export const WORKFLOW_EVENT_KINDS = [
  "workflow.created",
  "workflow.ready",
  "workflow.queued",
  "workflow.started",
  "step.started",
  "step.succeeded",
  "step.failed",
  "step.retried",
  "step.skipped",
  "step.awaiting_approval",
  "workflow.awaiting_approval",
  "workflow.approved",
  "workflow.rejected",
  "workflow.cancelled",
  "workflow.succeeded",
  "workflow.failed",
  "workflow.recovery-marked",
] as const
export type WorkflowEventKind = (typeof WORKFLOW_EVENT_KINDS)[number]

export type WorkflowActorType = "user" | "agent" | "system"

/**
 * Append one event to the per-workflow log: seq = (max seq)+1 inside a
 * transaction (the @@unique([workflowId, seq]) constraint is the last line
 * of defense against concurrent appenders — the executor and human route
 * actions do overlap legitimately; on P2002 the whole transaction retries).
 */
export async function recordWorkflowEvent(
  workflowId: string,
  kind: WorkflowEventKind,
  actorType: WorkflowActorType,
  actorId: string,
  payload?: unknown,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await db.$transaction(async (tx) => {
        const max = await tx.workflowEvent.aggregate({ where: { workflowId }, _max: { seq: true } })
        const seq = (max._max.seq ?? 0) + 1
        await tx.workflowEvent.create({
          data: {
            id: newId("wevt"),
            workflowId,
            seq,
            kind,
            actorType,
            actorId,
            payload: payload === undefined ? null : JSON.stringify(payload),
          },
        })
      })
      return
    } catch (err) {
      if (attempt < 3 && isUniqueViolation(err)) continue
      throw err
    }
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "P2002"
  )
}

// ---------------------------------------------------------------------------
// Internals: state-machine guard, sleep, run chain
// ---------------------------------------------------------------------------

/**
 * Rows in `running` older than this are orphaned (server restart / executor
 * death). Default 5 minutes; `EOS_RECOVERY_CUTOFF_MS` overrides it for drills
 * and runbooks (the EOS_PYTHON/EOS_TESSERACT convention — read once at module
 * load, invalid/absent values fall back to the default; a floor of 1000ms
 * keeps the scan from racing its own row writes).
 */
const RECOVERY_CUTOFF_MS = (() => {
  const raw = Number.parseInt(process.env.EOS_RECOVERY_CUTOFF_MS ?? "", 10)
  return Number.isFinite(raw) && raw >= 1000 ? raw : 5 * 60 * 1000
})()

/** stepId recorded in workflow.failure for executor-level failures (no step row involved). */
const EXECUTOR_STEP_ID = "executor"

const EXECUTOR_ACTOR = { actorType: "system", actorId: "system:executor" } as const
const RECOVERY_ACTOR = { actorType: "system", actorId: "system:recovery" } as const

/**
 * Apply the single transition authority and refuse ad-hoc moves loudly.
 * `applyWorkflowAction` returning null is a programming error here — the
 * executor only ever calls transitions the machine allows.
 */
function transition(current: WorkflowState, action: WorkflowTransitionInput): WorkflowState {
  const next = applyWorkflowAction(current, action)
  if (next === null) {
    throw new Error(`[executor] illegal transition: cannot ${action} a workflow in state "${current}"`)
  }
  return next
}

function sleep(ms: number): Promise<void> {
  // Retry backoff (contract §8 retry semantics) — never a simulated engine run.
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * In-process serial run chain: one workflow at a time (contract §8). Runs on
 * the chain NEVER throw — every run carries its own try/catch so the chain
 * survives crashes and keeps serving the next queued workflow.
 */
let runChain: Promise<void> = Promise.resolve()

function enqueueRun(run: () => Promise<void>): void {
  runChain = runChain.then(run).catch((err) => {
    console.error("[executor] run crashed through the chain (this must not happen):", err)
  })
}

// ---------------------------------------------------------------------------
// Queue-time input snapshot (contract §8: inputs are locked at QUEUE time)
// ---------------------------------------------------------------------------

export interface StepSnapshot {
  stepId: string
  seq: number
  operation: string
  maxAttempts: number
  inputRevisionIds: string[]
  inputHashes: string[]
}

export type SnapshotResult =
  | { ok: true; snapshots: StepSnapshot[] }
  | { ok: false; error: string }

/**
 * Resolve every step's input artifacts IN THE SAME PROJECT and snapshot their
 * latestRevisionId + contentHash, in definition order (seq is the ABSOLUTE
 * definition index + 1; `fromIndex` snapshots only the steps a retry resumes,
 * keeping earlier succeeded rows untouched). A mid-run source upload does
 * not change what a queued run reads — the locked ids live on the
 * WorkflowStepRun rows as the execution record. Missing artifacts come
 * back as ONE verbatim-422 message (api-utils style).
 */
export async function snapshotStepInputs(
  projectId: string,
  steps: WorkflowDefinition["steps"],
  fromIndex = 0,
): Promise<SnapshotResult> {
  const snapshots: StepSnapshot[] = []
  for (let i = fromIndex; i < steps.length; i++) {
    const step = steps[i]
    const refs = step.operation === "build_report" ? step.inputs.artifactIds ?? [] : [step.inputs.artifactId ?? ""]
    const artifacts = await db.artifact.findMany({
      where: { id: { in: refs }, projectId },
      include: { latestRevision: true },
    })
    const byId = new Map(artifacts.map((a) => [a.id, a]))
    const inputRevisionIds: string[] = []
    const inputHashes: string[] = []
    for (const ref of refs) {
      const artifact = byId.get(ref)
      if (!artifact) {
        return {
          ok: false,
          error: `step "${step.id}" references artifact "${ref}" which does not exist in this project`,
        }
      }
      if (!artifact.latestRevision) {
        return {
          ok: false,
          error: `step "${step.id}" references artifact "${ref}" which has no revisions`,
        }
      }
      inputRevisionIds.push(artifact.latestRevision.id)
      inputHashes.push(artifact.latestRevision.contentHash)
    }
    snapshots.push({
      stepId: step.id,
      seq: i + 1,
      operation: step.operation,
      maxAttempts: step.retry.maxAttempts,
      inputRevisionIds,
      inputHashes,
    })
  }
  return { ok: true, snapshots }
}

// ---------------------------------------------------------------------------
// Executor entry points
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget execution of a queued workflow — NEVER awaited by routes and
 * never throwing to the caller. Claims the row atomically (queued→running,
 * the "claim" pseudo-action), appends `workflow.started`, then runs steps
 * sequentially. Idempotent: a workflow that is not (or no longer) `queued` is
 * skipped, so the list-route re-claim after a restart is safe.
 */
export function enqueueWorkflow(workflowId: string): void {
  enqueueRun(() => runQueuedWorkflow(workflowId))
}

async function runQueuedWorkflow(workflowId: string): Promise<void> {
  try {
    // Atomic claim: only a row still in `queued` moves to `running`.
    const claimed = await db.workflow.updateMany({
      where: { id: workflowId, state: "queued" },
      data: { state: transition("queued", "claim"), currentStateSince: new Date() },
    })
    if (claimed.count !== 1) {
      return // not queued: already claimed, cancelled or finished — honest no-op
    }
    await recordWorkflowEvent(workflowId, "workflow.started", EXECUTOR_ACTOR.actorType, EXECUTOR_ACTOR.actorId, {
      state: "running",
    })
    await executeSteps(workflowId)
  } catch (err) {
    console.error("[executor] unexpected error while running workflow (marking failed):", workflowId, err)
    await markExecutorCrashQuietly(workflowId, err)
  }
}

/** Continue an already-`running` workflow (approval resume path) — guarded like a fresh run. */
function continueSteps(workflowId: string): Promise<void> {
  return (async () => {
    try {
      await executeSteps(workflowId)
    } catch (err) {
      console.error("[executor] unexpected error while resuming workflow (marking failed):", workflowId, err)
      await markExecutorCrashQuietly(workflowId, err)
    }
  })()
}

async function markExecutorCrashQuietly(workflowId: string, err: unknown): Promise<void> {
  try {
    await failWorkflowExecutor(workflowId, err)
  } catch (inner) {
    console.error("[executor] CRITICAL: could not mark workflow failed after crash:", workflowId, inner)
  }
}

// ---------------------------------------------------------------------------
// Step execution (contract §8)
// ---------------------------------------------------------------------------

type StepFlow = "continue" | "pause" | "stop"

/**
 * Walk the step rows in seq order. Steps already `succeeded`/`skipped` are
 * kept (retry resume: earlier outputs survive, contract §3). Before every
 * step the workflow state is re-checked — a human cancel mid-run wins over
 * the run loop. All steps done → `steps-complete` → succeeded.
 */
async function executeSteps(workflowId: string): Promise<void> {
  const workflow = await db.workflow.findUnique({ where: { id: workflowId } })
  if (!workflow || workflow.state !== "running") return

  const def = parseDefinitionRow(workflow.definition)
  if (!def.ok) {
    await failWorkflowExecutor(workflowId, new Error(`stored definition no longer parses: ${def.error}`))
    return
  }
  const rows = await db.workflowStepRun.findMany({ where: { workflowId }, orderBy: { seq: "asc" } })
  if (rows.length !== def.value.steps.length) {
    await failWorkflowExecutor(
      workflowId,
      new Error(
        `step rows out of sync with the definition (${rows.length} rows for ${def.value.steps.length} steps)`,
      ),
    )
    return
  }

  for (let i = 0; i < rows.length; i++) {
    // Re-check before every step: a human cancel wins over the run loop.
    const current = await db.workflow.findUnique({ where: { id: workflowId }, select: { state: true } })
    if (!current || current.state !== "running") return

    const row = rows[i]
    if (row.state === "succeeded" || row.state === "skipped") continue
    if (row.state === "awaiting_approval") return // defensive: paused rows are never executed

    const flow = await runStep(
      { id: workflow.id, projectId: workflow.projectId, createdBy: workflow.createdBy },
      def.value.steps[i],
      row,
    )
    if (flow !== "continue") return
  }

  const done = await db.workflow.updateMany({
    where: { id: workflowId, state: "running" },
    data: {
      state: transition("running", "steps-complete"),
      currentStateSince: new Date(),
      finishedAt: new Date(),
    },
  })
  if (done.count !== 1) {
    console.warn(`[executor] workflow ${workflowId} changed state before completion — leaving it untouched`)
    return
  }
  await recordWorkflowEvent(workflowId, "workflow.succeeded", EXECUTOR_ACTOR.actorType, EXECUTOR_ACTOR.actorId, {})
}

/**
 * Run ONE step with its retry policy: state running → runBrokerOperation →
 * on success record the execution evidence (ADR-0005) and move to succeeded
 * (or awaiting_approval when the approval gate applies). On failure: retry
 * with backoff while attempts remain, then skipOnError or fail the workflow
 * with the VERBATIM error. Never writes a fake output.
 */
async function runStep(
  workflow: { id: string; projectId: string; createdBy: string },
  step: WorkflowStepDefinition,
  row: { id: string; stepId: string; attempt: number },
): Promise<StepFlow> {
  const workflowId = workflow.id
  const ctx: BrokerContext = {
    projectId: workflow.projectId,
    actor: workflow.createdBy,
    workflowId,
    stepId: row.stepId,
    attempt: row.attempt + 1,
  }
  const inputs =
    step.operation === "build_report"
      ? { artifactIds: step.inputs.artifactIds ?? [] }
      : { artifactId: step.inputs.artifactId ?? "" }

  let attempt = row.attempt
  for (;;) {
    attempt += 1
    const startedAt = new Date()
    await db.workflowStepRun.update({
      where: { id: row.id },
      data: { state: "running", attempt, startedAt },
    })
    await recordWorkflowEvent(workflowId, "step.started", EXECUTOR_ACTOR.actorType, EXECUTOR_ACTOR.actorId, {
      stepId: row.stepId,
      attempt,
      operation: step.operation,
    })

    let outcome
    try {
      outcome = await runBrokerOperation(step.operation, ctx, inputs, step.parameters)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const refusalCode = err instanceof BrokerRefusalError ? err.code : null

      if (attempt < step.retry.maxAttempts) {
        // Record the retry decision first, then back off — the event stream
        // stays accurate even if the process dies mid-backoff.
        await recordWorkflowEvent(workflowId, "step.retried", EXECUTOR_ACTOR.actorType, EXECUTOR_ACTOR.actorId, {
          stepId: row.stepId,
          attempt,
          maxAttempts: step.retry.maxAttempts,
          backoffMs: step.retry.backoffMs,
          error: message,
          refusalCode,
        })
        if (step.retry.backoffMs > 0) await sleep(step.retry.backoffMs)
        continue
      }

      // Attempts exhausted.
      if (step.skipOnError) {
        await db.workflowStepRun.update({
          where: { id: row.id },
          data: { state: "skipped", endedAt: new Date() },
        })
        await recordWorkflowEvent(workflowId, "step.skipped", EXECUTOR_ACTOR.actorType, EXECUTOR_ACTOR.actorId, {
          stepId: row.stepId,
          attempt,
          maxAttempts: step.retry.maxAttempts,
          error: message,
          refusalCode,
        })
        return "continue"
      }

      // Workflow failure (contract §3): failure JSON + step.failed + workflow.failed, STOP.
      await db.workflowStepRun.update({
        where: { id: row.id },
        data: { state: "failed", endedAt: new Date() },
      })
      await recordWorkflowEvent(workflowId, "step.failed", EXECUTOR_ACTOR.actorType, EXECUTOR_ACTOR.actorId, {
        stepId: row.stepId,
        attempt,
        maxAttempts: step.retry.maxAttempts,
        error: message,
        refusalCode,
      })
      const failure = JSON.stringify({
        stepId: row.stepId,
        attempt,
        error: message,
        at: new Date().toISOString(),
      })
      const marked = await db.workflow.updateMany({
        where: { id: workflowId, state: "running" },
        data: {
          state: transition("running", "step-failed"),
          currentStateSince: new Date(),
          finishedAt: new Date(),
          failure,
        },
      })
      if (marked.count !== 1) {
        console.warn(
          `[executor] workflow ${workflowId} changed state before failure marking — leaving it untouched`,
        )
        return "stop"
      }
      await recordWorkflowEvent(workflowId, "workflow.failed", EXECUTOR_ACTOR.actorType, EXECUTOR_ACTOR.actorId, {
        stepId: row.stepId,
        attempt,
        error: message,
      })
      return "stop"
    }

    // Success: record the execution evidence (ADR-0005) — engine meta, tails,
    // exit code, duration and the op-specific summary, all from the real run.
    const endedAt = new Date()
    // Approval gate (contract §4.3): only publishing operations honor it —
    // build_report today (contract §2). The gate runs the step FIRST (its
    // real output is already written as a DRAFT revision), THEN pauses.
    const gate = step.requiresApproval && step.operation === "build_report"
    await db.workflowStepRun.update({
      where: { id: row.id },
      data: {
        state: gate ? "awaiting_approval" : "succeeded",
        outputArtifactRevisionId: outcome.outputArtifactRevisionId ?? null,
        outputSummary: JSON.stringify(outcome.summary),
        engineKey: outcome.engineKey ?? null,
        engineVersion: outcome.engineVersion ?? null,
        adapterScript: outcome.adapterScript ?? null,
        adapterHash: outcome.adapterHash ?? null,
        stdoutTail: outcome.stdoutTail ?? null,
        stderrTail: outcome.stderrTail ?? null,
        exitCode: outcome.exitCode ?? null,
        durationMs: outcome.durationMs,
        endedAt,
      },
    })

    if (gate) {
      await recordWorkflowEvent(
        workflowId,
        "step.awaiting_approval",
        EXECUTOR_ACTOR.actorType,
        EXECUTOR_ACTOR.actorId,
        {
          stepId: row.stepId,
          attempt,
          outputArtifactRevisionId: outcome.outputArtifactRevisionId ?? null,
        },
      )
      const paused = await db.workflow.updateMany({
        where: { id: workflowId, state: "running" },
        data: {
          state: transition("running", "approval-required"),
          currentStateSince: new Date(),
        },
      })
      if (paused.count !== 1) {
        // A human cancelled while the gate step ran — the cancel wins.
        console.warn(`[executor] workflow ${workflowId} changed state under the approval gate — not pausing`)
        return "stop"
      }
      await recordWorkflowEvent(
        workflowId,
        "workflow.awaiting_approval",
        EXECUTOR_ACTOR.actorType,
        EXECUTOR_ACTOR.actorId,
        { stepId: row.stepId },
      )
      return "pause"
    }

    await recordWorkflowEvent(workflowId, "step.succeeded", EXECUTOR_ACTOR.actorType, EXECUTOR_ACTOR.actorId, {
      stepId: row.stepId,
      attempt,
      operation: step.operation,
      outputArtifactRevisionId: outcome.outputArtifactRevisionId ?? null,
      engineKey: outcome.engineKey ?? null,
      exitCode: outcome.exitCode ?? null,
      durationMs: outcome.durationMs,
    })
    return "continue"
  }
}

/** Executor-level crash (no single step to blame): mark the whole run failed honestly. */
async function failWorkflowExecutor(workflowId: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err)
  const failure = JSON.stringify({
    stepId: EXECUTOR_STEP_ID,
    attempt: null,
    error: message,
    at: new Date().toISOString(),
  })
  const marked = await db.workflow.updateMany({
    where: { id: workflowId, state: "running" },
    data: {
      state: transition("running", "step-failed"),
      currentStateSince: new Date(),
      finishedAt: new Date(),
      failure,
    },
  })
  if (marked.count !== 1) {
    console.warn(`[executor] workflow ${workflowId} is not running — crash not marked (state untouched)`)
    return
  }
  await recordWorkflowEvent(workflowId, "workflow.failed", EXECUTOR_ACTOR.actorType, EXECUTOR_ACTOR.actorId, {
    stepId: EXECUTOR_STEP_ID,
    error: message,
  })
}

function parseDefinitionRow(
  definition: string | null,
): { ok: true; value: WorkflowDefinition } | { ok: false; error: string } {
  let raw: unknown = null
  try {
    raw = definition === null ? null : JSON.parse(definition)
  } catch {
    raw = null // falls through to the verbatim parse error below
  }
  return parseWorkflowDefinition(raw)
}

// ---------------------------------------------------------------------------
// Approval gate (contract §4 — THE RED LINE)
// ---------------------------------------------------------------------------

export type ApproveWorkflowResult = { ok: true } | { ok: false; error: string }

/** Human approver identity for `approveWorkflow` (Phase-6 session stamping).
 *
 * The red line is UNCHANGED: this is typed `{ actorId }` only, is set by the
 * server-side route from the signed-in session (never read from any request
 * body), and `canApprove` in the route still enforces actorType "user" —
 * agents can never approve on any path. Omitted → Phase-1..5 "local-operator". */
export interface WorkflowApprover {
  actorId: string
  userName?: string
}

/**
 * Publish + resume an awaiting workflow. THE RED LINE: the approver is a
 * server-side human {actorType:"user"} — the identity comes from the signed-in
 * session via the route (contract §1.3), never from a request body, so no
 * caller can ever make an agent approve (ADR-0006 §3, contract §4.1).
 *
 *  1. atomically claim awaiting_approval → running (approve)
 *  2. publish the gate step's output revision (if any): draft → approved via
 *     the approval state machine, prior approved revision superseded — the
 *     EXACT convention of POST /api/artifacts/[id]/approve — plus the
 *     approval payload {approvedBy, approvedAt, workflowId} on the revision
 *     note and the `artifact.approved` audit event
 *  3. step row awaiting_approval → succeeded; `workflow.approved` event
 *  4. continue the remaining steps (fire-and-forget, never awaited)
 *
 * On reject the ROUTE cancels the workflow instead; the draft output REMAINS
 * (auditable, never silently deleted) and the step row stays
 * awaiting_approval as an honest record.
 */
export async function approveWorkflow(
  workflowId: string,
  note?: string | null,
  approver?: WorkflowApprover,
): Promise<ApproveWorkflowResult> {
  const resumed = await db.workflow.updateMany({
    where: { id: workflowId, state: "awaiting_approval" },
    data: { state: transition("awaiting_approval", "approve"), currentStateSince: new Date() },
  })
  if (resumed.count !== 1) {
    return { ok: false, error: `workflow ${workflowId} is not awaiting approval` }
  }

  const workflow = await db.workflow.findUnique({ where: { id: workflowId } })
  const step = await db.workflowStepRun.findFirst({
    where: { workflowId, state: "awaiting_approval" },
    orderBy: { seq: "asc" },
  })
  if (!workflow || !step) {
    return { ok: false, error: `workflow ${workflowId} has no step awaiting approval` }
  }

  let publishedRevisionId: string | null = null
  if (step.outputArtifactRevisionId) {
    publishedRevisionId = await publishStepRevision(workflow, step, note, approver)
  }

  await db.workflowStepRun.update({ where: { id: step.id }, data: { state: "succeeded" } })
  await recordWorkflowEvent(workflowId, "workflow.approved", "user", approver?.actorId ?? "local-operator", {
    stepId: step.stepId,
    outputArtifactRevisionId: publishedRevisionId,
    note: note ?? null,
  })

  enqueueRun(() => continueSteps(workflowId))
  return { ok: true }
}

/**
 * Draft → approved for the gate step's output revision, reusing the exact
 * approval convention of POST /api/artifacts/[id]/approve (state machine +
 * prior-approved supersede + `artifact.approved` audit event), and storing
 * the workflow approval payload on the revision note so the published
 * revision points back at the workflow that gated it. The approver identity
 * (Phase-6 session stamping) defaults to the Phase-1..5 "local-operator".
 */
async function publishStepRevision(
  workflow: { id: string; projectId: string },
  step: { stepId: string; outputArtifactRevisionId: string | null },
  note?: string | null,
  approver?: WorkflowApprover,
): Promise<string | null> {
  const revisionId = step.outputArtifactRevisionId
  if (!revisionId) return null // defensive — the caller guards this
  const revision = await db.artifactRevision.findUnique({
    where: { id: revisionId },
    include: { artifact: true },
  })
  if (!revision) {
    console.error(
      `[executor] gate step ${step.stepId} output revision ${revisionId} is gone — nothing published`,
    )
    return null
  }

  const next = applyApproval(revision.approvalState as ApprovalState, "approve")
  if (next === null) {
    // Already approved/superseded concurrently (state machine refuses) —
    // leave the revision untouched and continue the workflow honestly.
    console.warn(
      `[executor] revision ${revision.id} is "${revision.approvalState}" — approval state machine refuses, publish skipped`,
    )
    return revision.id
  }

  // Prior approved revision of the same artifact gets superseded (state machine).
  const priorApproved = await db.artifactRevision.findFirst({
    where: { artifactId: revision.artifactId, approvalState: "approved", id: { not: revision.id } },
    orderBy: { revNumber: "desc" },
  })
  let supersededRev: number | null = null
  if (priorApproved && applyApproval("approved", "supersede") === "superseded") {
    await db.artifactRevision.update({
      where: { id: priorApproved.id },
      data: { approvalState: "superseded" },
    })
    supersededRev = priorApproved.revNumber
  }

  await db.artifactRevision.update({
    where: { id: revision.id },
    data: {
      approvalState: next,
      note: JSON.stringify({
        approvedBy: approver?.actorId ?? "local-operator",
        approvedAt: new Date().toISOString(),
        workflowId: workflow.id,
      }),
    },
  })

  await recordEvent({
    projectId: workflow.projectId,
    actorType: "user",
    actorId: approver?.actorId ?? "local-operator",
    userName: approver?.userName ?? null,
    action: "artifact.approved",
    entityType: "artifact",
    entityId: revision.artifactId,
    detail: {
      artifactName: revision.artifact.name,
      revNumber: revision.revNumber,
      supersededRev,
      workflowId: workflow.id,
      note: note ?? null,
    },
  })
  return revision.id
}

// ---------------------------------------------------------------------------
// Recovery scan (contract §8)
// ---------------------------------------------------------------------------

/**
 * Mark orphaned `running` rows failed: rows whose currentStateSince is older
 * than 5 minutes were interrupted by a server restart or an executor death.
 * Honest: no auto-resume — recovery IS the explicit `retry` action. Returns
 * the marked workflow ids. Called on executor module load and from the
 * workflow list route; `queued` rows are re-claimed separately (list route).
 */
export async function recoverOrphanedRuns(): Promise<string[]> {
  const cutoff = new Date(Date.now() - RECOVERY_CUTOFF_MS)
  const stale = await db.workflow.findMany({
    where: { state: "running", currentStateSince: { lt: cutoff } },
    select: { id: true },
  })
  const marked: string[] = []
  for (const { id } of stale) {
    const error = "interrupted: server restarted or executor died (recovery-marked)"
    const failure = JSON.stringify({
      stepId: EXECUTOR_STEP_ID,
      attempt: null,
      error,
      at: new Date().toISOString(),
    })
    const updated = await db.workflow.updateMany({
      where: { id, state: "running", currentStateSince: { lt: cutoff } },
      data: {
        state: transition("running", "step-failed"),
        failure,
        finishedAt: new Date(),
        currentStateSince: new Date(),
      },
    })
    if (updated.count !== 1) continue // the row moved on its own between scan and mark
    await recordWorkflowEvent(id, "workflow.recovery-marked", RECOVERY_ACTOR.actorType, RECOVERY_ACTOR.actorId, {
      error,
      failureStepId: EXECUTOR_STEP_ID,
    })
    marked.push(id)
  }
  return marked
}

// Recovery scan on module load (contract §8): server-restart detection.
// Fire-and-forget — module load must never throw on a transient DB error.
void recoverOrphanedRuns().catch((err) => {
  console.error("[executor] recovery scan on module load failed:", err)
})
