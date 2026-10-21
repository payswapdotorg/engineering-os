/**
 * Worker 3 lane — workflow runtime core tests (Phase 4, contract §2/§3/§4).
 * Pure only: no DB, no broker, no filesystem (ADR-0002) — pins the full state
 * machine matrix (every legal transition + every illegal pair → null), the
 * definition parser (defaults, bounds, per-op input shapes, verbatim joinable
 * error messages), the actor red line (canApprove / isAgentActor /
 * CREATOR_ACTOR_RE) and the Model QA pipeline template invariants.
 */

/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test"

import { WORKFLOW_STATES, type WorkflowState } from "./index"
import {
  BROKER_OPERATIONS,
  CREATOR_ACTOR_RE,
  WORKFLOW_ACTIONS,
  WORKFLOW_EXECUTOR_EVENTS,
  WORKFLOW_TEMPLATES,
  applyWorkflowAction,
  canApprove,
  isAgentActor,
  parseWorkflowDefinition,
} from "./workflow"

// ---------------------------------------------------------------------------
// applyWorkflowAction (state machine — contract §3)
// ---------------------------------------------------------------------------

describe("applyWorkflowAction (workflow state machine)", () => {
  const LEGAL: Record<string, WorkflowState> = {
    "draft|mark-ready": "ready",
    "draft|cancel": "cancelled",
    "ready|queue": "queued",
    "ready|cancel": "cancelled",
    "queued|claim": "running",
    "queued|cancel": "cancelled",
    "running|steps-complete": "succeeded",
    "running|step-failed": "failed",
    "running|approval-required": "awaiting_approval",
    "running|cancel": "cancelled",
    "awaiting_approval|approve": "running",
    "awaiting_approval|reject": "cancelled",
    "awaiting_approval|cancel": "cancelled",
    "failed|retry": "queued",
  }

  test("full matrix: every legal transition returns the pinned next state", () => {
    for (const [key, expected] of Object.entries(LEGAL)) {
      const [state, action] = key.split("|") as [WorkflowState, (typeof WORKFLOW_ACTIONS)[number]]
      expect(applyWorkflowAction(state, action)).toBe(expected)
    }
  })

  test("full matrix: every other (state, action) pair is rejected with null", () => {
    const allInputs = [...WORKFLOW_ACTIONS, ...WORKFLOW_EXECUTOR_EVENTS] as const
    let checked = 0
    for (const state of WORKFLOW_STATES) {
      for (const action of allInputs) {
        const expected = LEGAL[`${state}|${action}`] ?? null
        expect(applyWorkflowAction(state, action)).toBe(expected)
        checked++
      }
    }
    expect(checked).toBe(WORKFLOW_STATES.length * allInputs.length)
  })

  test("happy path: draft → ready → queued → running → succeeded", () => {
    expect(applyWorkflowAction("draft", "mark-ready")).toBe("ready")
    expect(applyWorkflowAction("ready", "queue")).toBe("queued")
    expect(applyWorkflowAction("queued", "claim")).toBe("running")
    expect(applyWorkflowAction("running", "steps-complete")).toBe("succeeded")
  })

  test("approval gate: running → awaiting_approval, approve → running, reject → cancelled", () => {
    expect(applyWorkflowAction("running", "approval-required")).toBe("awaiting_approval")
    expect(applyWorkflowAction("awaiting_approval", "approve")).toBe("running")
    expect(applyWorkflowAction("awaiting_approval", "reject")).toBe("cancelled")
  })

  test("failure & retry: running → failed → retry re-queues (resumes from the failed step)", () => {
    expect(applyWorkflowAction("running", "step-failed")).toBe("failed")
    expect(applyWorkflowAction("failed", "retry")).toBe("queued")
  })

  test("cancel is allowed from every active state", () => {
    for (const state of ["draft", "ready", "queued", "running", "awaiting_approval"] as const) {
      expect(applyWorkflowAction(state, "cancel")).toBe("cancelled")
    }
  })

  test("terminal states are absolute: succeeded and cancelled reject every action", () => {
    const allInputs = [...WORKFLOW_ACTIONS, ...WORKFLOW_EXECUTOR_EVENTS] as const
    for (const action of allInputs) {
      expect(applyWorkflowAction("succeeded", action)).toBeNull()
      expect(applyWorkflowAction("cancelled", action)).toBeNull()
    }
  })

  test("user actions never claim or complete: queue only from ready, mark-ready only from draft", () => {
    expect(applyWorkflowAction("queued", "queue")).toBeNull()
    expect(applyWorkflowAction("ready", "mark-ready")).toBeNull()
    expect(applyWorkflowAction("ready", "claim")).toBeNull()
    expect(applyWorkflowAction("queued", "mark-ready")).toBeNull()
  })

  test("retry is refused from every non-failed state", () => {
    for (const state of ["draft", "ready", "queued", "running", "awaiting_approval", "succeeded", "cancelled"] as const) {
      expect(applyWorkflowAction(state, "retry")).toBeNull()
    }
  })

  test("unknown state strings are rejected defensively (DB values are plain strings)", () => {
    expect(applyWorkflowAction("paused" as WorkflowState, "cancel")).toBeNull()
    expect(applyWorkflowAction("" as WorkflowState, "queue")).toBeNull()
  })

  test("executor-internal events are not user actions (closed vocabularies)", () => {
    for (const internal of WORKFLOW_EXECUTOR_EVENTS) {
      expect(WORKFLOW_ACTIONS.includes(internal as (typeof WORKFLOW_ACTIONS)[number])).toBe(false)
    }
    expect(WORKFLOW_ACTIONS.length).toBe(6)
  })
})

// ---------------------------------------------------------------------------
// parseWorkflowDefinition (contract §2)
// ---------------------------------------------------------------------------

describe("parseWorkflowDefinition (valid definitions)", () => {
  const valid = {
    steps: [
      {
        id: "quantities",
        operation: "derive_quantities",
        inputs: { artifactId: "art_model_1" },
        parameters: {},
        retry: { maxAttempts: 2, backoffMs: 400 },
        requiresApproval: false,
        skipOnError: false,
      },
      {
        id: "mesh",
        operation: "derive_mesh",
        inputs: { artifactId: "art_model_1" },
        parameters: {},
        retry: { maxAttempts: 1, backoffMs: 0 },
        requiresApproval: false,
        skipOnError: false,
      },
      {
        id: "report",
        operation: "build_report",
        inputs: { artifactIds: ["art_model_1", "art_mesh_1"] },
        parameters: { title: "Model QA report" },
        retry: { maxAttempts: 1, backoffMs: 0 },
        requiresApproval: true,
        skipOnError: false,
      },
    ],
  }

  test("template-shaped definition parses; canonical value keeps order and every field", () => {
    const parsed = parseWorkflowDefinition(valid)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.steps.length).toBe(3)
    expect(parsed.value.steps[0].id).toBe("quantities")
    expect(parsed.value.steps[1].id).toBe("mesh")
    expect(parsed.value.steps[2].id).toBe("report")
    expect(parsed.value.steps[0].retry).toEqual({ maxAttempts: 2, backoffMs: 400 })
    expect(parsed.value.steps[2].requiresApproval).toBe(true)
    expect(parsed.value.steps[2].parameters).toEqual({ title: "Model QA report" })
  })

  test("minimal single-step definition parses with every default filled", () => {
    const parsed = parseWorkflowDefinition({
      steps: [{ id: "mesh", operation: "derive_mesh", inputs: { artifactId: "art_1" } }],
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.steps[0].parameters).toEqual({})
    expect(parsed.value.steps[0].retry).toEqual({ maxAttempts: 1, backoffMs: 0 })
    expect(parsed.value.steps[0].requiresApproval).toBe(false)
    expect(parsed.value.steps[0].skipOnError).toBe(false)
  })

  test("partial retry object fills only the missing key", () => {
    const parsed = parseWorkflowDefinition({
      steps: [{ id: "mesh", operation: "derive_mesh", inputs: { artifactId: "art_1" }, retry: { maxAttempts: 3 } }],
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.steps[0].retry).toEqual({ maxAttempts: 3, backoffMs: 0 })
  })

  test("8 steps parse; 9 steps are refused", () => {
    const step = (i: number) => ({
      id: `s-${i}`,
      operation: "derive_mesh" as const,
      inputs: { artifactId: `art_${i}` },
    })
    expect(parseWorkflowDefinition({ steps: Array.from({ length: 8 }, (_, i) => step(i)) }).ok).toBe(true)
    const nine = parseWorkflowDefinition({ steps: Array.from({ length: 9 }, (_, i) => step(i)) })
    expect(nine.ok).toBe(false)
    if (nine.ok) return
    expect(nine.error).toContain("at most 8 steps are allowed")
  })

  test("requiresApproval is allowed on any operation (contract §2)", () => {
    const parsed = parseWorkflowDefinition({
      steps: [
        { id: "mesh", operation: "derive_mesh", inputs: { artifactId: "art_1" }, requiresApproval: true },
      ],
    })
    expect(parsed.ok).toBe(true)
  })
})

describe("parseWorkflowDefinition (refusals are verbatim + joinable)", () => {
  test("zero steps are refused", () => {
    const parsed = parseWorkflowDefinition({ steps: [] })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toContain("at least one step is required")
    expect(parsed.error).toStartWith("invalid workflow definition:")
  })

  test("unknown operation is refused with the operation vocabulary", () => {
    const parsed = parseWorkflowDefinition({
      steps: [{ id: "mesh", operation: "derive_volumes", inputs: { artifactId: "art_1" } }],
    })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toContain("steps.0.operation")
    expect(parsed.error).toContain(`operation must be one of: ${BROKER_OPERATIONS.join(", ")}`)
  })

  test("duplicate step ids are refused by id with the duplicated key in the message", () => {
    const parsed = parseWorkflowDefinition({
      steps: [
        { id: "mesh", operation: "derive_mesh", inputs: { artifactId: "art_1" } },
        { id: "mesh", operation: "derive_quantities", inputs: { artifactId: "art_1" } },
      ],
    })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toContain('duplicate step id "mesh"')
  })

  test("bad step id patterns are refused", () => {
    for (const bad of ["Mesh", "mesh_1", "mesh!", "m".repeat(33), ""]) {
      const parsed = parseWorkflowDefinition({
        steps: [{ id: bad, operation: "derive_mesh", inputs: { artifactId: "art_1" } }],
      })
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(parsed.error).toContain("step id must match")
    }
  })

  test("derive op without inputs.artifactId is refused", () => {
    const parsed = parseWorkflowDefinition({
      steps: [{ id: "mesh", operation: "derive_mesh", inputs: {} }],
    })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toContain("inputs.artifactId is required for derive_mesh")
  })

  test("derive op with the report input shape is refused", () => {
    const parsed = parseWorkflowDefinition({
      steps: [
        { id: "mesh", operation: "derive_mesh", inputs: { artifactIds: ["art_1"] } },
      ],
    })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toContain("inputs.artifactId is required for derive_mesh")
    expect(parsed.error).toContain("inputs.artifactIds is not accepted for derive_mesh")
  })

  test("derive op carrying both input keys is refused (exactly one model artifact)", () => {
    const parsed = parseWorkflowDefinition({
      steps: [
        { id: "mesh", operation: "derive_mesh", inputs: { artifactId: "art_1", artifactIds: ["art_2"] } },
      ],
    })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toContain("inputs.artifactIds is not accepted for derive_mesh")
  })

  test("build_report with the derive input shape is refused", () => {
    const parsed = parseWorkflowDefinition({
      steps: [{ id: "report", operation: "build_report", inputs: { artifactId: "art_1" } }],
    })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toContain("inputs.artifactIds is required for build_report")
    expect(parsed.error).toContain("inputs.artifactId is not accepted for build_report")
  })

  test("build_report bounds: empty array refused, five ids refused", () => {
    const empty = parseWorkflowDefinition({
      steps: [{ id: "report", operation: "build_report", inputs: { artifactIds: [] } }],
    })
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.error).toContain("at least one artifact id is required")

    const five = parseWorkflowDefinition({
      steps: [
        {
          id: "report",
          operation: "build_report",
          inputs: { artifactIds: ["a1", "a2", "a3", "a4", "a5"] },
        },
      ],
    })
    expect(five.ok).toBe(false)
    if (!five.ok) expect(five.error).toContain("at most 4 artifact ids are allowed")
  })

  test("unknown keys inside inputs are refused (strict input shape)", () => {
    const parsed = parseWorkflowDefinition({
      steps: [{ id: "mesh", operation: "derive_mesh", inputs: { artifactId: "a1", bogus: true } }],
    })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toContain('steps.0.inputs')
    expect(parsed.error).toContain("Unrecognized key")
  })

  test("retry bounds: maxAttempts 0 and 6 refused; backoffMs negative and >60000 refused; non-integers refused", () => {
    const attempt = (maxAttempts: unknown, backoffMs?: unknown) =>
      parseWorkflowDefinition({
        steps: [
          {
            id: "mesh",
            operation: "derive_mesh",
            inputs: { artifactId: "a1" },
            retry: { maxAttempts, backoffMs },
          },
        ],
      })

    const zero = attempt(0, 0)
    expect(zero.ok).toBe(false)
    if (!zero.ok) expect(zero.error).toContain("retry.maxAttempts must be between 1 and 5")

    const six = attempt(6, 0)
    expect(six.ok).toBe(false)
    if (!six.ok) expect(six.error).toContain("retry.maxAttempts must be between 1 and 5")

    const negBackoff = attempt(1, -1)
    expect(negBackoff.ok).toBe(false)
    if (!negBackoff.ok) expect(negBackoff.error).toContain("retry.backoffMs must be between 0 and 60000")

    const bigBackoff = attempt(1, 60001)
    expect(bigBackoff.ok).toBe(false)
    if (!bigBackoff.ok) expect(bigBackoff.error).toContain("retry.backoffMs must be between 0 and 60000")

    const fractional = attempt(1.5, 0)
    expect(fractional.ok).toBe(false)
    if (!fractional.ok) expect(fractional.error).toContain("retry.maxAttempts must be an integer")
  })

  test("non-object definitions fail with a joinable verbatim error, never a throw", () => {
    for (const bad of [null, undefined, 42, "steps", [], { steps: 7 }]) {
      const parsed = parseWorkflowDefinition(bad)
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(typeof parsed.error).toBe("string")
    }
  })

  test("multiple problems are joined into one message with '; '", () => {
    const parsed = parseWorkflowDefinition({
      steps: [
        { id: "a", operation: "nope", inputs: { artifactId: "art_1" } },
        { id: "b", operation: "derive_mesh", inputs: {} },
      ],
    })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toContain("steps.0.operation")
    expect(parsed.error).toContain("operation must be one of")
    expect(parsed.error).toContain("steps.1.inputs")
    expect(parsed.error).toContain("inputs.artifactId is required for derive_mesh")
    expect(parsed.error).toContain("; ")
  })
})

// ---------------------------------------------------------------------------
// Actor red line (ADR-0006 §3, contract §4)
// ---------------------------------------------------------------------------

describe("canApprove (approval red line)", () => {
  test("a human actor can always approve (user is the only legal approver type)", () => {
    expect(canApprove("local-operator", "user")).toBe(true)
    expect(canApprove("agent:qa-bot", "user")).toBe(true)
  })

  test("an agent can NEVER approve — any creator, any path", () => {
    expect(canApprove("local-operator", "agent")).toBe(false)
    expect(canApprove("agent:qa-bot", "agent")).toBe(false)
  })

  test("system actors can never approve either", () => {
    expect(canApprove("local-operator", "system")).toBe(false)
    expect(canApprove("agent:qa-bot", "system")).toBe(false)
  })
})

describe("isAgentActor / CREATOR_ACTOR_RE", () => {
  test("isAgentActor: only agent:<name> actors are agents", () => {
    expect(isAgentActor("agent:qa-bot")).toBe(true)
    expect(isAgentActor("local-operator")).toBe(false)
    expect(isAgentActor("adapter:cadquery")).toBe(false)
    expect(isAgentActor("")).toBe(false)
  })

  test("CREATOR_ACTOR_RE accepts the human operator and well-formed agent actors", () => {
    expect(CREATOR_ACTOR_RE.test("local-operator")).toBe(true)
    expect(CREATOR_ACTOR_RE.test("agent:qa-bot")).toBe(true)
    expect(CREATOR_ACTOR_RE.test("agent:a")).toBe(true)
    expect(CREATOR_ACTOR_RE.test("agent:" + "n".repeat(32))).toBe(true)
  })

  test("CREATOR_ACTOR_RE refuses malformed creators", () => {
    expect(CREATOR_ACTOR_RE.test("")).toBe(false)
    expect(CREATOR_ACTOR_RE.test("agent:")).toBe(false)
    expect(CREATOR_ACTOR_RE.test("agent:QA_Bot")).toBe(false)
    expect(CREATOR_ACTOR_RE.test("agent:n".repeat(33))).toBe(false)
    expect(CREATOR_ACTOR_RE.test("system:executor")).toBe(false)
    expect(CREATOR_ACTOR_RE.test("operator")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Model QA pipeline template (contract §2 — invariants)
// ---------------------------------------------------------------------------

describe("WORKFLOW_TEMPLATES.modelQaPipeline", () => {
  const template = WORKFLOW_TEMPLATES.modelQaPipeline

  test("is the exact 3-step contract §2 definition", () => {
    expect(template.name).toBe("Model QA pipeline")
    expect(template.definition.steps.length).toBe(3)
    expect(template.definition.steps.map((s) => s.id)).toEqual(["quantities", "mesh", "report"])
    expect(template.definition.steps.map((s) => s.operation)).toEqual([
      "derive_quantities",
      "derive_mesh",
      "build_report",
    ])
  })

  test("derive steps target one model artifact; the report takes both outputs", () => {
    expect(template.definition.steps[0].inputs).toEqual({ artifactId: "" })
    expect(template.definition.steps[1].inputs).toEqual({ artifactId: "" })
    expect(template.definition.steps[2].inputs).toEqual({ artifactIds: ["", ""] })
  })

  test("requiresApproval is true ONLY on the report step (Journey F: human publishes)", () => {
    expect(template.definition.steps[0].requiresApproval).toBe(false)
    expect(template.definition.steps[1].requiresApproval).toBe(false)
    expect(template.definition.steps[2].requiresApproval).toBe(true)
  })

  test("retry policy and title match contract §2 verbatim", () => {
    expect(template.definition.steps[0].retry).toEqual({ maxAttempts: 2, backoffMs: 400 })
    expect(template.definition.steps[1].retry).toEqual({ maxAttempts: 1, backoffMs: 0 })
    expect(template.definition.steps[2].retry).toEqual({ maxAttempts: 1, backoffMs: 0 })
    expect(template.definition.steps[2].parameters).toEqual({ title: "Model QA report" })
  })

  test("placeholders are honest: the raw template does NOT pass validation until ids are substituted", () => {
    expect(parseWorkflowDefinition(template.definition).ok).toBe(false)
  })

  test("the template parses once real artifact ids are substituted", () => {
    const substituted = {
      steps: template.definition.steps.map((step) =>
        step.operation === "build_report"
          ? { ...step, inputs: { artifactIds: ["art_model", "art_mesh"] } }
          : { ...step, inputs: { artifactId: "art_model" } },
      ),
    }
    const parsed = parseWorkflowDefinition(substituted)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.value.steps[2].requiresApproval).toBe(true)
    }
  })
})
