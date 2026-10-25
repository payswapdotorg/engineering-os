/**
 * Engineering OS — LLM planner core (Slice 11, agent-planning-contract §3).
 *
 * Pure TypeScript: no DB, no network, no filesystem (ADR-0002) → unit-testable
 * with `bun test` without a server, an LLM or fixtures. Normative semantics:
 * docs/00-architecture/agent-planning-contract.md §3 + ADR-0008.
 *
 * The planner PROPOSES; a human disposes. This module never calls an LLM
 * (that is src/lib/llm.ts — the one server-side wire) and never executes
 * anything (the broker stays the only tool path, ADR-0005). It builds the
 * exact chat messages, extracts the first balanced JSON object from the LLM's
 * raw text, and validates the proposed definition through the SAME canonical
 * schema a manual definition goes through — plus an artifact-existence gate.
 *
 * Context discipline (tested invariant): the serialized artifact context is
 * METADATA ONLY — id, name, kind, revision count, latest approval state and
 * the latest note truncated to 200 chars. No sizes, no geometry, no
 * quantities, no rates: the planner cannot be a source of numeric truth BY
 * CONSTRUCTION.
 */

import { z } from "zod"

import {
  BROKER_OPERATIONS,
  WORKFLOW_TEMPLATES,
  parseWorkflowDefinition,
  type WorkflowDefinition,
  type WorkflowTemplate,
} from "./workflow"

// ---------------------------------------------------------------------------
// Actor & plan-status vocabulary (contract §2 / §2.1)
// ---------------------------------------------------------------------------

/** Workflow createdBy recorded when a human accepts a plan (ADR-0008 §3). */
export const PLANNER_ACTOR = "agent:planner-v1"

/** AgentPlan.status vocabulary (contract §2.1). `failed` is terminal per row. */
export const PLAN_STATUSES = ["proposed", "accepted", "rejected", "failed"] as const
export type PlanStatus = (typeof PLAN_STATUSES)[number]

export function isPlanStatus(value: string): boolean {
  return PLAN_STATUSES.some((status) => status === value)
}

// ---------------------------------------------------------------------------
// Context types (contract §3 — frozen)
// ---------------------------------------------------------------------------

export interface PlannerArtifactContext {
  id: string
  name: string
  kind: string // model|mesh|drawing|document|dataset|calculation|report|other
  revisionCount: number // structural count — the ONLY number in the context
  latestApprovalState: string
  latestNote: string | null // truncated to 200 chars by the builder
}

export interface PlannerPriorPlan {
  status: PlanStatus
  intent: string
  rationale: string | null
  definition: unknown
  workflowState: string | null // when accepted: the live workflow's state
  workflowFailure: string | null // workflow.failure JSON text, VERBATIM
  failedStepStderr: string | null // failed step's stderrTail, VERBATIM
}

export interface PlannerMessagesInput {
  projectName: string
  discipline: string
  artifacts: PlannerArtifactContext[]
  prior: PlannerPriorPlan | null // the revisesPlanId plan's context, when re-planning
  feedback: string | null // optional human guidance sent with the revision request
}

// ---------------------------------------------------------------------------
// Prompt construction (contract §3 prompt rules, pinned by unit tests)
// ---------------------------------------------------------------------------

/** The ONE worked example shown to the LLM (contract §3, verbatim template). */
const MODEL_QA_EXAMPLE: WorkflowTemplate = WORKFLOW_TEMPLATES.modelQaPipeline

/**
 * The system prompt. The SDK idiom sends it with the ASSISTANT role.
 * Frozen rules: envelope shape, output-json ONLY, the pinned operation
 * catalog, no invented artifact ids, ≤8 steps, per-op input shapes, the
 * approval gate only on the final build_report step (Journey F), and the
 * single worked example with its placeholder artifact ids explained.
 */
const PLANNER_SYSTEM_PROMPT = [
  "You are the workflow PLANNER for an engineering platform.",
  "You propose workflow definitions for a human to review, accept or reject.",
  "You NEVER execute anything, NEVER compute engineering numbers and NEVER approve anything — acceptance, execution and approvals are human actions.",
  "",
  "Your context is metadata only: artifact ids, names, kinds, revision counts, latest approval states and short notes.",
  "It deliberately contains no geometry, no sizes, no quantities and no rates — you cannot be a source of numeric truth, and you must not invent any.",
  "",
  "Respond with EXACTLY ONE JSON object (no prose, no code fences) with these keys:",
  '- "rationale": a short string (prefer under 500 characters) explaining why this plan fits the request',
  '- "assumptions": an array of at most 6 short strings (each 300 characters or fewer)',
  '- "definition": an object with a "steps" array',
  "",
  "Step rules:",
  `- Each step selects exactly one operation from the pinned catalog: ${BROKER_OPERATIONS.join(", ")}`,
  '- Each step has a short "id" label: lowercase letters, digits and dashes ONLY (pattern ^[a-z0-9-]{1,32}$) — NEVER underscores and NEVER the operation name; use short labels like "quantities", "mesh", "report", "flow"',
  "- Wire ONLY artifact ids that appear in the provided artifact catalog — never invent an id, never guess one",
  "- At most 8 steps",
  '- build_report takes "inputs": {"artifactIds": [...]} with 1 to 4 artifact ids; every other operation takes "inputs": {"artifactId": "<id>"} with exactly one artifact id',
  '- Gate the final build_report step with "requiresApproval": true (a human publishes the report — Journey F). Never set requiresApproval true on any other step',
  "",
  'Worked example — the "Model QA pipeline" template. The empty-string artifact ids are PLACEHOLDERS: replace them with real artifact ids from the catalog, keep the step structure:',
  JSON.stringify(MODEL_QA_EXAMPLE.definition),
].join("\n")

/**
 * Builds the exact chat messages for one planner round trip: an
 * assistant-role system prompt (the SDK idiom) followed by the user content.
 * The user content carries the project name, the discipline, the
 * metadata-only artifact catalog, the prior-plan evidence VERBATIM when
 * re-planning, the optional human feedback line, and the final
 * output-json-only instruction.
 */
export function buildPlannerMessages(
  input: PlannerMessagesInput,
): Array<{ role: "assistant" | "user"; content: string }> {
  // Metadata-only catalog — exactly the six context keys; the note is
  // truncated to 200 chars, null stays null. revisionCount is the ONLY
  // number this builder ever serializes (tested invariant).
  const catalog = input.artifacts.map((artifact) => ({
    id: artifact.id,
    name: artifact.name,
    kind: artifact.kind,
    revisionCount: artifact.revisionCount,
    latestApprovalState: artifact.latestApprovalState,
    latestNote: artifact.latestNote === null ? null : artifact.latestNote.slice(0, 200),
  }))

  const lines: string[] = [
    `Project: ${input.projectName}`,
    `Discipline: ${input.discipline}`,
    "",
    "Artifact catalog (metadata only — these are the ONLY artifact ids you may wire):",
    JSON.stringify(catalog),
  ]

  // Prior-plan evidence, VERBATIM (ADR-0008 §5): re-planning is evidence-based,
  // so the prior intent/rationale/definition, the live workflow state, the
  // workflow failure JSON text and the failed step's stderr tail all ride
  // along unchanged. The failure text is already JSON text and the stderr is
  // already raw text — both are embedded raw, never re-encoded, so the exact
  // substrings the human saw are what the LLM sees.
  if (input.prior !== null) {
    lines.push(
      "",
      `Prior plan this request revises — status: ${input.prior.status}`,
      `intent: ${input.prior.intent}`,
      `rationale: ${input.prior.rationale === null ? "(none)" : input.prior.rationale}`,
      `definition: ${JSON.stringify(input.prior.definition)}`,
      `workflowState: ${input.prior.workflowState === null ? "(none)" : input.prior.workflowState}`,
      `workflowFailure: ${input.prior.workflowFailure === null ? "(none)" : input.prior.workflowFailure}`,
      `failedStepStderr: ${input.prior.failedStepStderr === null ? "(none)" : input.prior.failedStepStderr}`,
    )
  }

  if (input.feedback !== null) {
    lines.push("", `Human feedback on the prior plan: ${input.feedback}`)
  }

  lines.push("", "Return ONLY the JSON object — no prose, no code fences.")

  return [
    { role: "assistant", content: PLANNER_SYSTEM_PROMPT },
    { role: "user", content: lines.join("\n") },
  ]
}

// ---------------------------------------------------------------------------
// Response envelope (contract §3)
// ---------------------------------------------------------------------------

/**
 * The LLM response envelope schema: rationale (1..2000 chars), assumptions
 * (≤6 strings, each 1..300 chars, default []), definition (unknown — handed
 * to `validatePlanDefinition` for the canonical chain). The plans route
 * parses this AFTER `extractJsonObject`; the LLM wire never validates
 * content.
 */
export const PlannerEnvelopeSchema = z.object({
  rationale: z.string().min(1).max(2000),
  assumptions: z.array(z.string().min(1).max(300)).max(6).default([]),
  definition: z.unknown(),
})

// ---------------------------------------------------------------------------
// JSON extraction (contract §3)
// ---------------------------------------------------------------------------

/**
 * Returns the balanced '{'…'}' substring starting at `start`, or null when the
 * object never closes. String/escape aware: braces inside JSON strings do not
 * count toward the nesting depth, and backslash escapes inside strings never
 * close them early.
 */
function balancedObjectAt(text: string, start: number): string | null {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (inString) {
      if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/**
 * Extracts the FIRST balanced JSON object from raw LLM text — handles a bare
 * object, ```json fences, leading prose before a fence, braces in prose,
 * braces inside JSON strings and trailing prose after the object. Balanced
 * brace pairs that are not valid JSON (prose like "{draft, approved}") are
 * skipped honestly, scanning on for the next '{'. No balanced object → the
 * pinned verbatim error.
 */
export function extractJsonObject(
  text: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    const candidate = balancedObjectAt(text, start)
    if (candidate === null) continue
    try {
      return { ok: true, value: JSON.parse(candidate) }
    } catch {
      // Balanced but not JSON — keep scanning (do not guess, do not throw).
    }
  }
  return { ok: false, error: "no JSON object found in the planner response" }
}

// ---------------------------------------------------------------------------
// Validation chain (contract §3, frozen order)
// ---------------------------------------------------------------------------

/**
 * The validation chain for a proposed definition. The caller (plans route)
 * has already extracted and envelope-parsed the LLM response; this function
 * then runs, in order:
 *   (a) the canonical `parseWorkflowDefinition` — the SAME schema a manual
 *       definition goes through; its single joinable verbatim message
 *       propagates unchanged;
 *   (b) the existence gate — every artifact id the canonical definition
 *       references (inputs.artifactId + inputs.artifactIds) must be a key of
 *       `artifactsById`, else the pinned message with the quoted id.
 *
 * Deliberately NO kind/content gates (contract decision): the broker stays
 * the single content authority — a kind mismatch fails at execution with the
 * broker's verbatim error, exactly as a manually-created workflow would.
 * Artifact EXISTENCE is gated here because a plan that wires a deleted (or
 * foreign) artifact id must fail before a human can accept it; accept also
 * re-runs this gate against the live project artifacts — defense in depth.
 */
export function validatePlanDefinition(
  definition: unknown,
  artifactsById: Map<string, PlannerArtifactContext>,
): { ok: true; value: WorkflowDefinition } | { ok: false; error: string } {
  const parsed = parseWorkflowDefinition(definition)
  if (!parsed.ok) return { ok: false, error: parsed.error }

  for (const step of parsed.value.steps) {
    const referenced: string[] = []
    if (step.inputs.artifactId !== undefined) referenced.push(step.inputs.artifactId)
    if (step.inputs.artifactIds !== undefined) referenced.push(...step.inputs.artifactIds)
    for (const id of referenced) {
      if (!artifactsById.has(id)) {
        return { ok: false, error: `plan references unknown artifact "${id}"` }
      }
    }
  }

  // Success returns the CANONICAL definition (defaults filled).
  return { ok: true, value: parsed.value }
}

// ---------------------------------------------------------------------------
// Human-readable step summaries (review card + PlanRow.stepSummary)
// ---------------------------------------------------------------------------

/** The pinned operation vocabulary, derived from the imported catalog. */
type PlannerOperation = (typeof BROKER_OPERATIONS)[number]

/** Human labels for every pinned operation (contract §3 — pinned by tests). */
const OPERATION_LABELS: Record<PlannerOperation, string> = {
  derive_quantities: "Derive quantities",
  derive_mesh: "Derive mesh",
  build_report: "Build report",
  fe_mesh: "Generate FE mesh",
  run_powerflow: "Run power flow",
  run_des: "Run discrete-event simulation",
  convert_document: "Convert document",
  analyze_schedule: "Analyze schedule",
  takeoff_sheet: "Vector-takeoff a PDF sheet",
  takeoff_drawing: "Vector-takeoff a DXF drawing",
  rebuild_parametric: "Parametric rebuild (model)",
}

/**
 * One line per step, seq-ordered, for the human review card — REAL artifact
 * names with kind badges, never ids alone. build_report lists every input
 * artifact; single-input operations name their one artifact. A step gated on
 * approval carries the " [requires approval]" marker (the planner is told to
 * gate the final report — this renders what was actually proposed). If a
 * referenced id is somehow missing from the map (cannot happen after
 * `validatePlanDefinition`), the raw id is rendered honestly instead of
 * guessing a name.
 */
export function summarizePlanSteps(
  definition: WorkflowDefinition,
  artifactsById: Map<string, PlannerArtifactContext>,
): string[] {
  const describeArtifact = (id: string): string => {
    const artifact = artifactsById.get(id)
    if (artifact === undefined) return `'unknown artifact ${id}'`
    return `'${artifact.name}' (${artifact.kind})`
  }

  return definition.steps.map((step) => {
    const label = OPERATION_LABELS[step.operation]
    let line: string
    if (step.operation === "build_report") {
      const ids = step.inputs.artifactIds ?? []
      line = `${label} from ${ids.length} artifact(s): ${ids.map(describeArtifact).join(", ")}`
    } else {
      const artifactId = step.inputs.artifactId
      // Unreachable after canonical validation (per-op input shapes are
      // enforced); rendered defensively as the bare label rather than
      // inventing an id.
      line = artifactId === undefined ? label : `${label} on ${describeArtifact(artifactId)}`
    }
    return step.requiresApproval ? `${line} [requires approval]` : line
  })
}

// ---------------------------------------------------------------------------
// Persisted plan-column format (contract §2)
// ---------------------------------------------------------------------------

/**
 * The AgentPlan.plan column format: one line of JSON with the stable key
 * order rationale, assumptions, definition (the contract §2 column shape).
 * JSON.stringify on an object literal preserves insertion order for string
 * keys, so the text is stable, and it re-parses to the same object.
 */
export function planToJsonText(
  rationale: string,
  assumptions: string[],
  definition: WorkflowDefinition,
): string {
  return JSON.stringify({ rationale, assumptions, definition })
}
