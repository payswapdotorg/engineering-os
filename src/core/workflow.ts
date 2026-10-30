/**
 * Engineering OS — workflow runtime core (Worker 3 lane, Phase 4).
 *
 * Pure TypeScript: no DB, no network, no filesystem (ADR-0002) → unit-testable
 * with `bun test` without a server, engines or fixtures. Normative semantics:
 * docs/00-architecture/workflow-runtime-contract.md §2 (definition JSON),
 * §3 (state machine), §4 (approval red line) and ADR-0006.
 *
 * `applyWorkflowAction` is the single transition authority: routes AND the
 * executor (src/core/runtime/executor.ts) both call it — no ad-hoc
 * transitions anywhere. The user-facing action vocabulary and the
 * executor-internal pseudo-actions are kept in separate exported lists so the
 * transition route can zod-validate only what a human may send.
 */

import { z } from "zod"

import { WORKFLOW_STATES, isWorkflowState, type WorkflowState } from "./index"

// ---------------------------------------------------------------------------
// Broker operation vocabulary (contract §5)
// ---------------------------------------------------------------------------

/**
 * The only operations a workflow step may request. `src/engines/broker.ts`
 * (W2 lane) is the ONLY execution path (ADR-0005) and runs these keys against
 * the real adapters; this pure-core copy pins the same vocabulary so the
 * definition schema validates without importing the engines.
 *
 * Phase 5 (extended-disciplines contract §4) grows the vocabulary by five ops:
 * fe_mesh / run_powerflow / run_des / solve_fea / run_swmm /
 * convert_document (engine ops — solve_fea is the Slice-22 FEA lane, phase5
 * contract §14.3; run_swmm is the Slice-23 drainage lane, §15.3) and
 * analyze_schedule (platform core — engineKey honestly ABSENT in its
 * execution records). All five take exactly one input artifact.
 *
 * Slice 15 added the takeoff pair; Slice 16 adds `rebuild_parametric` (the
 * roadmap-gap-audit item-2 integration — parametric authoring as a durable,
 * cross-session-capable workflow step; parameters.values carries the edits,
 * absent = the authored defaults). Slice 29 adds `solve_transport` (the CFD
 * lane, phase5 contract §16.3 — steady scalar transport via SfePy).
 * Slice 30 adds `synthesize_rtl` (the chip lane, phase5 contract §17.3 —
 * RTL synthesis via amaranth + yowasp-yosys).
 * ADR-0009 Stage 1 adds the ADOPTED takeoff engine's four ops
 * (`compare_revisions`, `annotate_takeoff`, `export_boq_xlsx`, `fill_area` —
 * pdf2takeoff, Apache-2.0, pinned commit f5a1c08…).
 */
export const BROKER_OPERATIONS = [
  "derive_quantities",
  "derive_mesh",
  "build_report",
  "fe_mesh",
  "run_powerflow",
  "run_des",
  "solve_fea",
  "solve_transport",
  "synthesize_rtl",
  "run_swmm",
  "convert_document",
  "analyze_schedule",
  "takeoff_sheet",
  "takeoff_drawing",
  "rebuild_parametric",
  "compare_revisions",
  "annotate_takeoff",
  "export_boq_xlsx",
  "fill_area",
] as const
export type BrokerOperation = (typeof BROKER_OPERATIONS)[number]

// ---------------------------------------------------------------------------
// State machine (contract §3)
// ---------------------------------------------------------------------------

/** Actions a human may request via POST /api/workflows/[id]/transition. */
export const WORKFLOW_ACTIONS = ["mark-ready", "queue", "cancel", "retry", "approve", "reject"] as const
export type WorkflowAction = (typeof WORKFLOW_ACTIONS)[number]

/**
 * Executor-internal pseudo-actions — NEVER part of the user vocabulary and
 * never accepted from an API body; only src/core/runtime/executor.ts calls
 * them, so that even executor-driven transitions go through the single
 * transition authority:
 *  - claim              queued → running (executor picked the workflow up)
 *  - steps-complete     running → succeeded (every step done)
 *  - approval-required  running → awaiting_approval (gate step ran; its real
 *                       output is written as a DRAFT revision — contract §4.3)
 *  - step-failed        running → failed (step exhausted retries, !skipOnError)
 */
export const WORKFLOW_EXECUTOR_EVENTS = [
  "claim",
  "steps-complete",
  "approval-required",
  "step-failed",
] as const
export type WorkflowExecutorEvent = (typeof WORKFLOW_EXECUTOR_EVENTS)[number]

/** Full input space of `applyWorkflowAction`: user actions + executor events. */
export type WorkflowTransitionInput = WorkflowAction | WorkflowExecutorEvent

/**
 * Pinned transition table (contract §3). Terminal states: `succeeded` and
 * `cancelled` are absolute; `failed` is retry-able (failed → queued, resuming
 * from the failed step). `cancel` is human and allowed from every active
 * state (draft|ready|queued|running|awaiting_approval).
 */
const WORKFLOW_TRANSITIONS: Record<WorkflowState, Partial<Record<WorkflowTransitionInput, WorkflowState>>> = {
  draft: { "mark-ready": "ready", cancel: "cancelled" },
  ready: { queue: "queued", cancel: "cancelled" },
  queued: { claim: "running", cancel: "cancelled" },
  running: {
    "steps-complete": "succeeded",
    "step-failed": "failed",
    "approval-required": "awaiting_approval",
    cancel: "cancelled",
  },
  awaiting_approval: { approve: "running", reject: "cancelled", cancel: "cancelled" },
  failed: { retry: "queued" },
  succeeded: {},
  cancelled: {},
}

/**
 * The single transition authority (contract §3). Legal moves return the next
 * state; EVERY illegal (state, action) pair returns null — the caller (route
 * or executor) must reject the action. Unknown state strings also return
 * null (defensive: DB values are plain strings).
 */
export function applyWorkflowAction(
  current: WorkflowState,
  action: WorkflowTransitionInput,
): WorkflowState | null {
  if (!isWorkflowState(current)) return null
  return WORKFLOW_TRANSITIONS[current][action] ?? null
}

// ---------------------------------------------------------------------------
// Workflow definition (contract §2 — zod-validated)
// ---------------------------------------------------------------------------

const stepIdSchema = z
  .string()
  .regex(/^[a-z0-9-]{1,32}$/, "step id must match ^[a-z0-9-]{1,32}$ (lowercase letters, digits, dashes)")

const retrySchema = z.object({
  maxAttempts: z
    .number()
    .int("retry.maxAttempts must be an integer")
    .min(1, "retry.maxAttempts must be between 1 and 5")
    .max(5, "retry.maxAttempts must be between 1 and 5")
    .default(1),
  backoffMs: z
    .number()
    .int("retry.backoffMs must be an integer")
    .min(0, "retry.backoffMs must be between 0 and 60000")
    .max(60000, "retry.backoffMs must be between 0 and 60000")
    .default(0),
})

/**
 * Inputs carry artifact REFERENCES (definition-time); the executor resolves
 * and locks revision ids at QUEUE time. Strict object: a key that is not part
 * of the op's input shape is a validation error, not a silent ignore.
 */
const stepInputsSchema = z.strictObject({
  artifactId: z.string().min(1, "artifactId must be a non-empty artifact id").optional(),
  artifactIds: z
    .array(z.string().min(1, "artifact ids must be non-empty strings"))
    .min(1, "at least one artifact id is required")
    .max(4, "at most 4 artifact ids are allowed")
    .optional(),
})

const stepSchema = z
  .object({
    id: stepIdSchema,
    operation: z.enum(BROKER_OPERATIONS, {
      message: `operation must be one of: ${BROKER_OPERATIONS.join(", ")}`,
    }),
    inputs: stepInputsSchema,
    parameters: z.record(z.string(), z.unknown()).default({}),
    retry: retrySchema.default({ maxAttempts: 1, backoffMs: 0 }),
    requiresApproval: z.boolean().default(false),
    skipOnError: z.boolean().default(false),
  })
  .superRefine((step, ctx) => {
    // Input shape is per-op (contract §2 + Phase-5 contract §4): build_report
    // takes 1..4 artifact ids; every other operation — the Phase-4 derive ops
    // AND the Phase-5 ops (fe_mesh / run_powerflow / run_des / solve_fea /
    // run_swmm / convert_document / analyze_schedule + the Slice-15/16
    // additions) — takes exactly one input artifact.
    if (step.operation === "build_report") {
      if (step.inputs.artifactIds === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["inputs"],
          message: "inputs.artifactIds is required for build_report (1..4 artifact ids)",
        })
      }
      if (step.inputs.artifactId !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["inputs"],
          message: "inputs.artifactId is not accepted for build_report — use inputs.artifactIds",
        })
      }
    } else {
      if (step.inputs.artifactId === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["inputs"],
          message: `inputs.artifactId is required for ${step.operation} (exactly one input artifact)`,
        })
      }
      if (step.inputs.artifactIds !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["inputs"],
          message: `inputs.artifactIds is not accepted for ${step.operation} — use inputs.artifactId`,
        })
      }
    }
  })

const stepsSchema = z
  .array(stepSchema)
  .min(1, "at least one step is required")
  .max(8, "at most 8 steps are allowed")
  .superRefine((steps, ctx) => {
    const seen = new Set<string>()
    steps.forEach((step, index) => {
      if (seen.has(step.id)) {
        ctx.addIssue({ code: "custom", path: [index, "id"], message: `duplicate step id "${step.id}"` })
      }
      seen.add(step.id)
    })
  })

export const WorkflowDefinitionSchema = z.object({ steps: stepsSchema })

export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>
export type WorkflowStepDefinition = z.infer<typeof stepSchema>

export type ParseWorkflowDefinitionResult =
  | { ok: true; value: WorkflowDefinition }
  | { ok: false; error: string }

/**
 * Parse an unknown value into a canonical WorkflowDefinition (defaults filled:
 * parameters {}, retry {1, 0}, requiresApproval false, skipOnError false).
 * Failures come back as ONE joinable, verbatim message in the established
 * style (ledger-style path prefixes joined by "; "):
 *   `invalid workflow definition: steps.0.operation: operation must be one of: …`
 */
export function parseWorkflowDefinition(input: unknown): ParseWorkflowDefinitionResult {
  const parsed = WorkflowDefinitionSchema.safeParse(input)
  if (parsed.success) return { ok: true, value: parsed.data }
  const issues = parsed.error.issues
    .map((issue) => {
      const at = issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""
      return `${at}${issue.message}`
    })
    .join("; ")
  return { ok: false, error: `invalid workflow definition: ${issues}` }
}

// ---------------------------------------------------------------------------
// Templates (contract §2 — UI source of truth, no duplicated definitions)
// ---------------------------------------------------------------------------

/** A template step: a definition step whose artifact ids are PLACEHOLDERS. */
export interface WorkflowTemplateStep {
  id: string
  operation: BrokerOperation
  inputs: { artifactId?: string; artifactIds?: string[] }
  parameters: Record<string, unknown>
  retry: { maxAttempts: number; backoffMs: number }
  requiresApproval: boolean
  skipOnError: boolean
}

export interface WorkflowTemplate {
  /** Human-readable label (the create dialog pre-fills the workflow name). */
  name: string
  /**
   * The contract §2 definition with PLACEHOLDER artifact ids (""). The UI
   * MUST substitute real artifact ids from the project before POSTing —
   * placeholders intentionally do NOT pass `parseWorkflowDefinition`.
   */
  definition: { steps: WorkflowTemplateStep[] }
}

/** The Model QA pipeline (contract §2, verbatim): quantities + mesh on one
 *  model artifact, then a report built from both, gated on human approval. */
export const WORKFLOW_TEMPLATES: { modelQaPipeline: WorkflowTemplate } = {
  modelQaPipeline: {
    name: "Model QA pipeline",
    definition: {
      steps: [
        {
          id: "quantities",
          operation: "derive_quantities",
          inputs: { artifactId: "" },
          parameters: {},
          retry: { maxAttempts: 2, backoffMs: 400 },
          requiresApproval: false,
          skipOnError: false,
        },
        {
          id: "mesh",
          operation: "derive_mesh",
          inputs: { artifactId: "" },
          parameters: {},
          retry: { maxAttempts: 1, backoffMs: 0 },
          requiresApproval: false,
          skipOnError: false,
        },
        {
          id: "report",
          operation: "build_report",
          inputs: { artifactIds: ["", ""] },
          parameters: { title: "Model QA report" },
          retry: { maxAttempts: 1, backoffMs: 0 },
          requiresApproval: true,
          skipOnError: false,
        },
      ],
    },
  },
}

// ---------------------------------------------------------------------------
// Creator & approver actors (ADR-0006 red line)
// ---------------------------------------------------------------------------

/** Workflow creators: the human operator or a named deterministic agent actor. */
export const CREATOR_ACTOR_RE = /^(local-operator|agent:[a-z0-9-]{1,32})$/

/** True when the actor string is a named agent actor ("agent:<name>"). */
export function isAgentActor(actor: string): boolean {
  return actor.startsWith("agent:")
}

/**
 * Approval red line (ADR-0006 §3, contract §4): an approval is legal ONLY
 * when the approver's actorType is "user" — an agent can NEVER approve,
 * on any path. `workflowCreatedBy` is deliberately part of the signature to
 * state the invariant it documents: when the creator is an agent, the human
 * approver is BY CONSTRUCTION a distinct identity (user ≠ agent); when the
 * creator is the human "local-operator", self-approval is the existing
 * Phase-1..3 semantics (humans approve their own submissions) and stays
 * allowed. Identity separation is enforced by actor TYPE, so the decision
 * below consults only the approver's type.
 */
export function canApprove(
  workflowCreatedBy: string,
  approverActorType: "user" | "agent" | "system",
): boolean {
  void workflowCreatedBy // documented above
  return approverActorType === "user"
}
