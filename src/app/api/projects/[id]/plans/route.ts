/**
 * Engineering OS — plans API (Slice 11, agent-planning-contract §5.1/§5.2).
 *
 * POST /api/projects/[id]/plans — the LLM round trip. The human's intent
 * (10..2000 chars, verbatim) goes to the planner wire (src/lib/llm.ts — the
 * one server-side SDK import site), the response through the pure core's
 * frozen chain (extract → envelope → canonical definition + existence gate),
 * and ONE AgentPlan row is persisted in ALL cases: the row IS the outcome
 * (persistent, honest task memory — an LLM/validation failure is a reviewable
 * `failed` row with verbatim evidence, never a silent 500).
 *
 * GET /api/projects/[id]/plans — member read, newest first, cap 50 (§5.2).
 *
 * Authz: Slice-10 conventions — project existence probe (404-no-leak) →
 * requireProjectAccess → parseBody. The context handed to the LLM is
 * METADATA-ONLY (§1.2), enforced at the query below: id, name, kind,
 * revision count, latest approval state, latest note — nothing else is ever
 * selected (no description, no sizeBytes, no content).
 */

import { z } from "zod"

import {
  PlannerEnvelopeSchema,
  REVISION_IDENTICAL_REFUSED,
  buildPlannerMessages,
  extractJsonObject,
  isPlanStatus,
  planToJsonText,
  revisionIsSubstantiveChange,
  validatePlanDefinition,
  type PlanStatus,
  type PlannerArtifactContext,
  type PlannerPriorPlan,
} from "@/core/planner"
import type { WorkflowDefinition } from "@/core/workflow"
import { recordEvent } from "@/lib/audit"
import { jsonOk, ERR, parseBody } from "@/lib/api-utils"
import { db } from "@/lib/db"
import { newId } from "@/lib/ids"
import { planWithLlm } from "@/lib/llm"
import { loadArtifactNameMap, toPlanRow } from "@/lib/plan-row"

import { handler, requireProjectAccess } from "../../../_lib/route-helpers"

export const dynamic = "force-dynamic"

const createPlanSchema = z.object({
  intent: z
    .string()
    .min(10, "intent must be between 10 and 2000 characters")
    .max(2000, "intent must be between 10 and 2000 characters"),
  revisesPlanId: z.string().min(1).optional(),
})

/** The §3 frozen chain distilled: one joinable verbatim error or the plan. */
type PlannerValidation =
  | { ok: true; rationale: string; assumptions: string[]; definition: WorkflowDefinition }
  | { ok: false; error: string }

function validatePlannerResponse(
  text: string,
  artifactsById: Map<string, PlannerArtifactContext>,
): PlannerValidation {
  const extracted = extractJsonObject(text)
  if (!extracted.ok) return { ok: false, error: extracted.error }

  const envelope = PlannerEnvelopeSchema.safeParse(extracted.value)
  if (!envelope.success) {
    const issues = envelope.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ")
    return { ok: false, error: `invalid planner response envelope: ${issues}` }
  }

  const validated = validatePlanDefinition(envelope.data.definition, artifactsById)
  if (!validated.ok) return { ok: false, error: validated.error }

  return {
    ok: true,
    rationale: envelope.data.rationale,
    assumptions: envelope.data.assumptions,
    definition: validated.value, // CANONICAL — defaults filled
  }
}

export const POST = handler<{ id: string }>(async (req, ctx) => {
  const { id } = await ctx.params

  const project = await db.project.findUnique({ where: { id }, select: { id: true } })
  if (!project) return ERR.notFound("Project")

  const access = await requireProjectAccess(id, "write")
  if (!access.ok) return access.response

  const parsed = await parseBody(req, createPlanSchema)
  if (!parsed.ok) return parsed.response
  const intent = parsed.data.intent
  const revisesPlanId = parsed.data.revisesPlanId

  // 1. Artifact context (§1.2 metadata-only, enforced AT THE QUERY): the six
  // context keys only — no description, no sizeBytes, no content columns.
  const artifactRows = await db.artifact.findMany({
    where: { projectId: id },
    select: {
      id: true,
      name: true,
      kind: true,
      _count: { select: { revisions: true } },
      latestRevision: { select: { approvalState: true, note: true } },
    },
    orderBy: { createdAt: "asc" },
  })
  const artifacts: PlannerArtifactContext[] = artifactRows.map((artifact) => ({
    id: artifact.id,
    name: artifact.name,
    kind: artifact.kind,
    revisionCount: artifact._count.revisions,
    latestApprovalState: artifact.latestRevision?.approvalState ?? "none",
    latestNote: artifact.latestRevision?.note ?? null, // the core truncates to 200
  }))
  const artifactsById = new Map(artifacts.map((artifact) => [artifact.id, artifact]))
  const artifactNameById = new Map(artifacts.map((a) => [a.id, { name: a.name, kind: a.kind }]))

  // 2. Prior-plan context when re-planning (§5.1): the revised row's parsed
  // plan column (null-safe), the live workflow state, the workflow failure
  // JSON text and the failed step's stderrTail — all VERBATIM (ADR-0008 §5:
  // re-planning is evidence-based). `feedback` is null by design: the UI
  // composes revision guidance into the intent (lane 11-d — the wire field
  // does not exist).
  let prior: PlannerPriorPlan | null = null
  if (revisesPlanId !== undefined) {
    const priorRow = await db.agentPlan.findUnique({ where: { id: revisesPlanId } })
    if (priorRow === null) return ERR.notFound("Plan")
    if (priorRow.projectId !== id) return ERR.invalid("cannot revise a plan from another project")
    if (!isPlanStatus(priorRow.status)) return ERR.server() // corrupt status string — refuse honestly

    let priorRationale: string | null = null
    let priorDefinition: unknown = null
    if (priorRow.plan !== null) {
      try {
        const planJson: unknown = JSON.parse(priorRow.plan)
        if (typeof planJson === "object" && planJson !== null) {
          const record = planJson as { rationale?: unknown; definition?: unknown }
          if (typeof record.rationale === "string") priorRationale = record.rationale
          priorDefinition = record.definition ?? null
        }
      } catch {
        // Corrupt plan column — the prior context degrades honestly to nulls.
      }
    }

    let workflowState: string | null = null
    let workflowFailure: string | null = null
    let failedStepStderr: string | null = null
    if (priorRow.workflowId !== null) {
      const priorWorkflow = await db.workflow.findUnique({
        where: { id: priorRow.workflowId },
        select: { state: true, failure: true },
      })
      workflowState = priorWorkflow?.state ?? null
      workflowFailure = priorWorkflow?.failure ?? null // JSON text, VERBATIM
      const failedStep = await db.workflowStepRun.findFirst({
        where: { workflowId: priorRow.workflowId, state: "failed" },
        orderBy: { seq: "desc" },
        select: { stderrTail: true },
      })
      failedStepStderr = failedStep?.stderrTail ?? null // raw text, VERBATIM
    }

    prior = {
      status: priorRow.status as PlanStatus,
      intent: priorRow.intent,
      rationale: priorRationale,
      definition: priorDefinition,
      workflowState,
      workflowFailure,
      failedStepStderr,
    }
  }

  // 3. Project identity for the messages (existence already probed above).
  const projectFull = await db.project.findUnique({
    where: { id },
    select: { name: true, discipline: true },
  })
  if (projectFull === null) return ERR.notFound("Project")

  const messages = buildPlannerMessages({
    projectName: projectFull.name,
    discipline: projectFull.discipline,
    artifacts,
    prior,
    feedback: null,
  })

  const planId = newId("plan")

  // 4. The LLM round trip (§5.1): a wire failure still persists ONE row —
  // status failed, the honest mapped message, evidence WITHOUT rawResponse
  // (there is none). The planWithLlm error carries durationMs/attempts as own
  // properties for exactly this evidence.
  let result: { text: string; durationMs: number; attempts: number }
  try {
    result = await planWithLlm(messages)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const wire = err as { durationMs?: unknown; attempts?: unknown }
    const failedRow = await db.agentPlan.create({
      data: {
        id: planId,
        projectId: id,
        intent,
        status: "failed",
        revisesPlanId: revisesPlanId ?? null,
        plan: null,
        evidence: JSON.stringify({
          durationMs: typeof wire.durationMs === "number" ? wire.durationMs : 0,
          attempts: typeof wire.attempts === "number" ? wire.attempts : 0,
        }),
        failure: JSON.stringify({ stage: "llm", error: message, at: new Date().toISOString() }),
        createdById: access.session.id,
      },
    })
    await recordEvent({
      projectId: id,
      action: "plan.requested",
      entityType: "AgentPlan",
      entityId: planId,
      detail: { intent, revisesPlanId: revisesPlanId ?? null, status: "failed", stage: "llm" },
    })
    return jsonOk({ plan: toPlanRow(failedRow) }, { status: 201 })
  }

  // 5. The §3 frozen chain: extract → envelope → canonical definition +
  // existence gate. ANY failure persists the row with the single verbatim
  // error and the raw response VERBATIM as evidence.
  const validation = validatePlannerResponse(result.text, artifactsById)
  if (!validation.ok) {
    const failedRow = await db.agentPlan.create({
      data: {
        id: planId,
        projectId: id,
        intent,
        status: "failed",
        revisesPlanId: revisesPlanId ?? null,
        plan: null,
        evidence: JSON.stringify({
          rawResponse: result.text, // VERBATIM
          durationMs: result.durationMs,
          attempts: result.attempts,
        }),
        failure: JSON.stringify({
          stage: "validation",
          error: validation.error,
          at: new Date().toISOString(),
        }),
        createdById: access.session.id,
      },
    })
    await recordEvent({
      projectId: id,
      action: "plan.requested",
      entityType: "AgentPlan",
      entityId: planId,
      detail: { intent, revisesPlanId: revisesPlanId ?? null, status: "failed", stage: "validation" },
    })
    return jsonOk({ plan: toPlanRow(failedRow) }, { status: 201 })
  }

  // 5b. Slice-17 revision-delta backstop (the prompt-quality protocol's
  // deterministic guard — src/core/planner.ts: revisionIsSubstantiveChange):
  // a proposal whose definition is IDENTICAL to its parent's is the live
  // evidence ledger's worst observed LLM failure mode (the requested delta
  // ignored). Refused at the validation stage, persisted honestly as a
  // failed row with the raw response as evidence — the human sees the
  // verbatim reason and can re-ask. Prompt-independent: the prompt carries
  // the rule, the route enforces it.
  if (
    validation.ok &&
    prior !== null &&
    prior.definition !== null &&
    !revisionIsSubstantiveChange(prior.definition, validation.definition)
  ) {
    const failedRow = await db.agentPlan.create({
      data: {
        id: planId,
        projectId: id,
        intent,
        status: "failed",
        revisesPlanId: revisesPlanId ?? null,
        plan: null,
        evidence: JSON.stringify({
          rawResponse: result.text, // VERBATIM — the identical proposal is evidence
          durationMs: result.durationMs,
          attempts: result.attempts,
        }),
        failure: JSON.stringify({
          stage: "validation",
          error: REVISION_IDENTICAL_REFUSED,
          at: new Date().toISOString(),
        }),
        createdById: access.session.id,
      },
    })
    await recordEvent({
      projectId: id,
      action: "plan.requested",
      entityType: "AgentPlan",
      entityId: planId,
      detail: { intent, revisesPlanId: revisesPlanId ?? null, status: "failed", stage: "revision-delta" },
    })
    return jsonOk({ plan: toPlanRow(failedRow) }, { status: 201 })
  }

  // 6. Success: status proposed, the CANONICAL plan JSON (defaults filled),
  // the raw response VERBATIM as evidence.
  const planRow = await db.agentPlan.create({
    data: {
      id: planId,
      projectId: id,
      intent,
      status: "proposed",
      revisesPlanId: revisesPlanId ?? null,
      plan: planToJsonText(validation.rationale, validation.assumptions, validation.definition),
      evidence: JSON.stringify({
        rawResponse: result.text, // VERBATIM
        durationMs: result.durationMs,
        attempts: result.attempts,
      }),
      createdById: access.session.id,
    },
  })
  await recordEvent({
    projectId: id,
    action: "plan.requested",
    entityType: "AgentPlan",
    entityId: planId,
    detail: { intent, revisesPlanId: revisesPlanId ?? null, status: "proposed" },
  })
  return jsonOk({ plan: toPlanRow(planRow, artifactNameById) }, { status: 201 })
})

export const GET = handler<{ id: string }>(async (_req, ctx) => {
  const { id } = await ctx.params

  const project = await db.project.findUnique({ where: { id }, select: { id: true } })
  if (!project) return ERR.notFound("Project")

  const access = await requireProjectAccess(id, "read")
  if (!access.ok) return access.response

  const rows = await db.agentPlan.findMany({
    where: { projectId: id },
    orderBy: { createdAt: "desc" },
    take: 50,
  })
  const artifactNameById = await loadArtifactNameMap(id)
  return jsonOk({ plans: rows.map((row) => toPlanRow(row, artifactNameById)) })
})
