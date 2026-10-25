/**
 * Slice 11 lane — LLM planner core tests (agent-planning-contract §7.1).
 *
 * Pure only: no DB, no network, no filesystem (ADR-0002) — pins the prompt
 * invariants (metadata-only context with the pinned key set, the planner
 * rules, the ONE worked example, VERBATIM prior-plan evidence), the JSON
 * extractor (bare / fenced / prose-wrapped / trailing-prose / no-object),
 * the envelope schema, the canonical validation chain + existence gate with
 * verbatim messages, the human-readable step summaries, the persisted
 * plan-column format and the status vocabulary.
 */

/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test"

import { BROKER_OPERATIONS, WORKFLOW_TEMPLATES, type WorkflowDefinition } from "./workflow"
import {
  PLANNER_ACTOR,
  PLAN_STATUSES,
  PlannerEnvelopeSchema,
  REVISION_IDENTICAL_REFUSED,
  buildPlannerMessages,
  extractJsonObject,
  isPlanStatus,
  planToJsonText,
  revisionIsSubstantiveChange,
  summarizePlanSteps,
  validatePlanDefinition,
  type PlannerArtifactContext,
  type PlannerMessagesInput,
  type PlannerPriorPlan,
} from "./planner"

// ---------------------------------------------------------------------------
// Fixtures (test constants — no engineering claims anywhere in this file)
// ---------------------------------------------------------------------------

const artifacts: PlannerArtifactContext[] = [
  {
    id: "art_model_1",
    name: "Harbour Wall",
    kind: "model",
    revisionCount: 3,
    latestApprovalState: "approved",
    latestNote: "Walls cleaned after the coordination round",
  },
  {
    id: "art_mesh_1",
    name: "Retaining wall mesh",
    kind: "mesh",
    revisionCount: 1,
    latestApprovalState: "draft",
    latestNote: null,
  },
  {
    id: "art_doc_1",
    name: "Site instructions",
    kind: "document",
    revisionCount: 2,
    latestApprovalState: "approved",
    latestNote: "y".repeat(300), // truncated to 200 chars by the builder
  },
]

const artifactsById = new Map(artifacts.map((artifact) => [artifact.id, artifact]))

const buildInput = (): PlannerMessagesInput => ({
  projectName: "Harbour View Tower",
  discipline: "structural",
  artifacts,
  prior: null,
  feedback: null,
})

// ---------------------------------------------------------------------------
// buildPlannerMessages (prompt construction — contract §3 prompt rules)
// ---------------------------------------------------------------------------

describe("buildPlannerMessages (shape & assistant system prompt)", () => {
  test("returns exactly two messages: assistant system prompt first, user content second", () => {
    const messages = buildPlannerMessages(buildInput())
    expect(messages.length).toBe(2)
    expect(messages[0].role).toBe("assistant")
    expect(messages[1].role).toBe("user")
    expect(messages[0].content.length).toBeGreaterThan(0)
    expect(messages[1].content.length).toBeGreaterThan(0)
  })

  test("the assistant prompt pins the planner red lines and the response envelope", () => {
    const system = buildPlannerMessages(buildInput())[0].content
    expect(system).toContain("workflow PLANNER")
    expect(system).toContain("NEVER execute")
    expect(system).toContain("EXACTLY ONE JSON object")
    expect(system).toContain('"rationale"')
    expect(system).toContain('"assumptions"')
    expect(system).toContain('"definition"')
    expect(system).toContain('"steps"')
    expect(system).toContain("no prose, no code fences")
  })

  test("the assistant prompt pins the operation catalog, step rules and approval gate", () => {
    const system = buildPlannerMessages(buildInput())[0].content
    // the pinned catalog, verbatim and complete
    expect(system).toContain(BROKER_OPERATIONS.join(", "))
    // never invent artifact ids; at most 8 steps; per-op input shapes
    expect(system).toContain("never invent")
    expect(system).toContain("At most 8 steps")
    expect(system).toContain("artifactIds")
    expect(system).toContain("exactly one artifact id")
    // step-id format rule — added after the live smoke showed the LLM using
    // operation names (with underscores) as ids; the pin is contract §3's
    // ^[a-z0-9-]{1,32}$ guidance made explicit in the prompt
    expect(system).toContain("^[a-z0-9-]{1,32}$")
    expect(system).toContain("NEVER underscores")
    // Journey F: the final report step is gated on human approval, nothing else
    expect(system).toContain("requiresApproval")
    expect(system).toContain("Never set requiresApproval true on any other step")
    // size preferences for the rationale and the assumptions
    expect(system).toContain("500")
    expect(system).toContain("at most 6")
  })

  test("the assistant prompt carries the ONE worked example — the Model QA pipeline, placeholders explained", () => {
    const system = buildPlannerMessages(buildInput())[0].content
    expect(system).toContain("Model QA pipeline")
    expect(system).toContain("PLACEHOLDERS")
    expect(system).toContain(JSON.stringify(WORKFLOW_TEMPLATES.modelQaPipeline.definition))
  })

  test("the assistant prompt pins the Slice-17 fidelity rules (the prompt-quality pass over the live evidence ledger)", () => {
    // The three live-evidence findings, each turned into a pinned rule:
    // (1) plan1 re-targeted the named artifact → the NAME-fidelity rule
    const system = buildPlannerMessages(buildInput())[0].content
    expect(system).toContain("Wire the artifacts the request NAMES")
    expect(system).toContain("never substitute another artifact")
    // iteration 2: the anaphora rule — "the model" resolves to the NAMED artifact
    expect(system).toContain("resolve it there, not to a different artifact of the same kind")
    // (2) plan2 wired takeoff_drawing to an .svg source → the format rule
    expect(system).toContain("takeoff_sheet needs a PDF sheet")
    expect(system).toContain("takeoff_drawing needs a DXF drawing")
    expect(system).toContain("Never wire an operation to a source whose format it would refuse")
    // scope invention — plan1/plan2 added uninvited steps
    expect(system).toContain("Do only what the request asks")
    expect(system).toContain("scope invention, not thoroughness")
    // (3) plan3 ignored the requested revision delta and reused the prior
    // rationale verbatim → the revision-fidelity rule (iteration 2 made the
    // REMOVE case explicit)
    expect(system).toContain("the requested change is mandatory")
    expect(system).toContain("MUST NOT contain that step")
    expect(system).toContain("A revision that ignores the requested change is invalid")
    expect(system).toContain("WHAT CHANGED relative to the prior plan")
  })
})

describe("revisionIsSubstantiveChange — the Slice-17 revision-delta backstop", () => {
  const parent = { steps: [{ id: "report", operation: "build_report", inputs: { artifactIds: ["a"] }, requiresApproval: true }] }

  test("a byte-identical re-proposal is NOT a substantive change (the refusal fires)", () => {
    expect(revisionIsSubstantiveChange(parent, JSON.parse(JSON.stringify(parent)))).toBe(false)
  })

  test("any real delta IS substantive: a removed step, a swapped id, a new step, a changed gate", () => {
    const removedStep = { steps: [] }
    const swappedId = { steps: [{ ...parent.steps[0], inputs: { artifactIds: ["b"] } }] }
    const newStep = { steps: [...parent.steps, { id: "extra", operation: "derive_mesh", inputs: { artifactId: "m" }, requiresApproval: false }] }
    const changedGate = { steps: [{ ...parent.steps[0], requiresApproval: false }] }
    expect(revisionIsSubstantiveChange(parent, removedStep)).toBe(true)
    expect(revisionIsSubstantiveChange(parent, swappedId)).toBe(true)
    expect(revisionIsSubstantiveChange(parent, newStep)).toBe(true)
    expect(revisionIsSubstantiveChange(parent, changedGate)).toBe(true)
  })

  test("the refusal text is pinned verbatim (the failed-row failure JSON + future e2e rows)", () => {
    expect(REVISION_IDENTICAL_REFUSED).toBe(
      "a revision must differ from the plan it revises (the proposed definition is identical to the parent's — apply the requested change and propose again)",
    )
  })

  test("null prior definitions never compare equal (JSON null text vs any definition — the route guards null before this call)", () => {
    expect(revisionIsSubstantiveChange(null, parent)).toBe(true)
  })
})

describe("buildPlannerMessages (user content — metadata-only context)", () => {
  test("carries the project, the discipline and the artifact catalog serialized with the pinned keys", () => {
    const user = buildPlannerMessages(buildInput())[1].content
    expect(user).toContain("Project: Harbour View Tower")
    expect(user).toContain("Discipline: structural")
    const expectedCatalog = JSON.stringify(
      artifacts.map((artifact) => ({
        id: artifact.id,
        name: artifact.name,
        kind: artifact.kind,
        revisionCount: artifact.revisionCount,
        latestApprovalState: artifact.latestApprovalState,
        latestNote: artifact.latestNote === null ? null : artifact.latestNote.slice(0, 200),
      })),
    )
    expect(user).toContain(expectedCatalog)
    expect(user).toContain('"id":"art_model_1"')
    expect(user).toContain('"name":"Harbour Wall"')
    expect(user).toContain('"kind":"mesh"')
    expect(user).toContain('"revisionCount":3')
    expect(user).toContain("Return ONLY the JSON object")
    expect(user).toContain("no prose, no code fences")
  })

  test("latestNote is truncated to 200 chars and null stays null", () => {
    const user = buildPlannerMessages(buildInput())[1].content
    expect(user).toContain(`"latestNote":"${"y".repeat(200)}"`)
    expect(user).not.toContain(`"latestNote":"${"y".repeat(201)}"`)
    expect(user).toContain('"latestNote":null')
  })

  test("INVARIANT: no numeric engineering content — no sizeBytes / quantityType / value keys in either message", () => {
    const messages = buildPlannerMessages(buildInput())
    for (const message of messages) {
      expect(message.content).not.toContain("sizeBytes")
      expect(message.content).not.toContain("quantityType")
      expect(message.content).not.toContain('"value"')
    }
    // the user content never even mentions the word — metadata only
    expect(messages[1].content).not.toContain("value")
  })

  test("no prior block and no feedback line when prior and feedback are null", () => {
    const user = buildPlannerMessages(buildInput())[1].content
    expect(user).not.toContain("Prior plan")
    expect(user).not.toContain("Human feedback")
  })

  test("a feedback line still renders when feedback is set without a prior plan", () => {
    const user = buildPlannerMessages({
      ...buildInput(),
      feedback: "Prefer the mesh artifact as the report source.",
    })[1].content
    expect(user).toContain("Human feedback on the prior plan: Prefer the mesh artifact as the report source.")
  })
})

describe("buildPlannerMessages (prior-plan evidence — VERBATIM, ADR-0008 §5)", () => {
  const prior: PlannerPriorPlan = {
    status: "failed",
    intent: "Derive quantities and a mesh from the harbour wall model, then publish a QA report",
    rationale: "The standard QA chain on the source model",
    definition: {
      steps: [
        { id: "mesh", operation: "derive_mesh", inputs: { artifactId: "art_model_1" } },
        { id: "report", operation: "build_report", inputs: { artifactIds: ["art_model_1"] }, requiresApproval: true },
      ],
    },
    workflowState: "failed",
    workflowFailure: JSON.stringify({
      failedStepId: "mesh",
      operation: "derive_mesh",
      error: "broker refused: source artifact has no solid geometry",
    }),
    failedStepStderr: "Traceback (most recent call last): IfcOpenShell raised on an empty geometry set",
  }
  const feedback = "The mesh step failed because the model has no solids — plan around the mesh artifact."

  test("status, intent, rationale, definition JSON, workflow state, failure JSON and stderr all land VERBATIM", () => {
    const user = buildPlannerMessages({ ...buildInput(), prior, feedback })[1].content
    expect(user).toContain("Prior plan this request revises")
    expect(user).toContain("status: failed")
    expect(user).toContain(prior.intent)
    expect(user).toContain(prior.rationale!) // fixture guarantees non-null
    expect(user).toContain(JSON.stringify(prior.definition))
    expect(user).toContain("workflowState: failed")
    // the workflowFailure is JSON TEXT embedded raw — the exact substring survives
    expect(user).toContain(prior.workflowFailure!) // fixture guarantees non-null
    expect(user).toContain('"failedStepId":"mesh"')
    // the failed step's stderr tail, VERBATIM
    expect(user).toContain(prior.failedStepStderr!) // fixture guarantees non-null
  })

  test("the human feedback line rides along with the evidence", () => {
    const user = buildPlannerMessages({ ...buildInput(), prior, feedback })[1].content
    expect(user).toContain(`Human feedback on the prior plan: ${feedback}`)
  })

  test("prior evidence stays metadata-only — no numeric engineering keys appear", () => {
    const messages = buildPlannerMessages({ ...buildInput(), prior, feedback })
    for (const message of messages) {
      expect(message.content).not.toContain("sizeBytes")
      expect(message.content).not.toContain("quantityType")
      expect(message.content).not.toContain('"value"')
    }
  })
})

// ---------------------------------------------------------------------------
// extractJsonObject (raw LLM text → first balanced JSON object)
// ---------------------------------------------------------------------------

describe("extractJsonObject", () => {
  const envelope = {
    rationale: "Run the standard QA chain on the source model",
    assumptions: ["the model artifact is the latest revision"],
    definition: { steps: [{ id: "mesh", operation: "derive_mesh", inputs: { artifactId: "art_model_1" } }] },
  }

  test("bare JSON object", () => {
    const result = extractJsonObject(JSON.stringify(envelope))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual(envelope)
  })

  test("```json fenced object", () => {
    const result = extractJsonObject("```json\n" + JSON.stringify(envelope) + "\n```")
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual(envelope)
  })

  test("fenced object with leading prose before the fence", () => {
    const text = `Sure — here is the plan you asked for:\n\`\`\`json\n${JSON.stringify(envelope)}\n\`\`\`\nAnything else, just ask.`
    const result = extractJsonObject(text)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual(envelope)
  })

  test("bare object with trailing prose after it", () => {
    const result = extractJsonObject(JSON.stringify(envelope) + "\nThis plan wires the harbour wall model.")
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual(envelope)
  })

  test("braces inside JSON strings do not close the object early (string/escape aware)", () => {
    const withBraces = {
      rationale: "the set {walls, slabs} is the review scope",
      assumptions: [],
      definition: { steps: [] },
    }
    const result = extractJsonObject(JSON.stringify(withBraces))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect((result.value as { rationale: string }).rationale).toBe(
      "the set {walls, slabs} is the review scope",
    )

    const withEscape = {
      rationale: 'she said "ok" to the broker',
      assumptions: [],
      definition: { steps: [] },
    }
    const escaped = extractJsonObject(JSON.stringify(withEscape))
    expect(escaped.ok).toBe(true)
    if (!escaped.ok) return
    expect((escaped.value as { rationale: string }).rationale).toBe('she said "ok" to the broker')
  })

  test("prose braces that balance but are not JSON are skipped, scanning on", () => {
    const result = extractJsonObject(
      'The set {draft, approved} is not JSON. {"rationale":"ok","assumptions":[],"definition":{"steps":[]}}',
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({ rationale: "ok", assumptions: [], definition: { steps: [] } })
  })

  test("the FIRST object wins when the text contains several", () => {
    const first = { rationale: "first", assumptions: [], definition: { steps: [] } }
    const second = { rationale: "second", assumptions: [], definition: { steps: [] } }
    const result = extractJsonObject(JSON.stringify(first) + " and later " + JSON.stringify(second))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect((result.value as { rationale: string }).rationale).toBe("first")
  })

  test("no balanced object → the pinned verbatim error", () => {
    for (const text of [
      "I cannot plan this right now.",
      "```json\n",
      "{oops",
      "curly } prose { only",
    ]) {
      const result = extractJsonObject(text)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toBe("no JSON object found in the planner response")
      }
    }
  })
})

// ---------------------------------------------------------------------------
// PlannerEnvelopeSchema (contract §3)
// ---------------------------------------------------------------------------

describe("PlannerEnvelopeSchema", () => {
  test("accepts a well-formed envelope and fills the assumptions default", () => {
    const parsed = PlannerEnvelopeSchema.safeParse({ rationale: "Run the QA chain", definition: { steps: [] } })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.rationale).toBe("Run the QA chain")
    expect(parsed.data.assumptions).toEqual([])
    expect(parsed.data.definition).toEqual({ steps: [] })
  })

  test("refuses an empty or over-long rationale and more than 6 or over-long assumptions", () => {
    expect(PlannerEnvelopeSchema.safeParse({ rationale: "", assumptions: [], definition: {} }).success).toBe(false)
    expect(
      PlannerEnvelopeSchema.safeParse({ rationale: "x".repeat(2001), assumptions: [], definition: {} }).success,
    ).toBe(false)
    expect(
      PlannerEnvelopeSchema.safeParse({
        rationale: "ok",
        assumptions: ["a", "b", "c", "d", "e", "f", "g"],
        definition: {},
      }).success,
    ).toBe(false)
    expect(PlannerEnvelopeSchema.safeParse({ rationale: "ok", assumptions: ["x".repeat(301)], definition: {} }).success).toBe(false)
  })

  test("the definition key is unknown-tolerant here — the canonical chain validates it later", () => {
    expect(
      PlannerEnvelopeSchema.safeParse({ rationale: "ok", assumptions: [], definition: "not-a-workflow" }).success,
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// validatePlanDefinition (frozen chain: canonical schema → existence gate)
// ---------------------------------------------------------------------------

describe("validatePlanDefinition (success & schema refusals)", () => {
  test("canonical success — the CANONICAL definition comes back with every default filled", () => {
    const result = validatePlanDefinition(
      {
        steps: [
          { id: "quantities", operation: "derive_quantities", inputs: { artifactId: "art_model_1" } },
          {
            id: "report",
            operation: "build_report",
            inputs: { artifactIds: ["art_model_1", "art_mesh_1"] },
            parameters: { title: "Model QA report" },
            requiresApproval: true,
          },
        ],
      },
      artifactsById,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.steps.length).toBe(2)
    expect(result.value.steps[0].id).toBe("quantities")
    expect(result.value.steps[0].parameters).toEqual({})
    expect(result.value.steps[0].retry).toEqual({ maxAttempts: 1, backoffMs: 0 })
    expect(result.value.steps[0].requiresApproval).toBe(false)
    expect(result.value.steps[0].skipOnError).toBe(false)
    expect(result.value.steps[1].requiresApproval).toBe(true)
    expect(result.value.steps[1].parameters).toEqual({ title: "Model QA report" })
  })

  test("unknown operation → the verbatim schema message (chain order: schema before existence)", () => {
    const result = validatePlanDefinition(
      { steps: [{ id: "s-1", operation: "render_view", inputs: { artifactId: "art_ghost" } }] },
      artifactsById,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toStartWith("invalid workflow definition:")
    expect(result.error).toContain("operation must be one of")
  })

  test("9 steps → the verbatim schema message", () => {
    const result = validatePlanDefinition(
      {
        steps: Array.from({ length: 9 }, (_, i) => ({
          id: `s-${i}`,
          operation: "derive_mesh",
          inputs: { artifactId: "art_model_1" },
        })),
      },
      artifactsById,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe("invalid workflow definition: steps: at most 8 steps are allowed")
  })

  test("duplicate step ids → the verbatim schema message", () => {
    const result = validatePlanDefinition(
      {
        steps: [
          { id: "mesh", operation: "derive_mesh", inputs: { artifactId: "art_model_1" } },
          { id: "mesh", operation: "derive_quantities", inputs: { artifactId: "art_model_1" } },
        ],
      },
      artifactsById,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('invalid workflow definition: steps.1.id: duplicate step id "mesh"')
  })

  test("build_report without artifactIds → the verbatim schema message", () => {
    const result = validatePlanDefinition(
      { steps: [{ id: "report", operation: "build_report", inputs: {} }] },
      artifactsById,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe(
      "invalid workflow definition: steps.0.inputs: inputs.artifactIds is required for build_report (1..4 artifact ids)",
    )
  })

  test("non-object definitions fail honestly with the schema prefix, never a throw", () => {
    for (const bad of [null, undefined, "steps", 42]) {
      const result = validatePlanDefinition(bad, artifactsById)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toStartWith("invalid workflow definition:")
    }
  })

  test("the raw worked-example template never validates (placeholders are refused by the canonical schema)", () => {
    const result = validatePlanDefinition(WORKFLOW_TEMPLATES.modelQaPipeline.definition, artifactsById)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toStartWith("invalid workflow definition:")
  })
})

describe("validatePlanDefinition (existence gate — pinned message)", () => {
  test("unknown artifact id on a single-input op → the verbatim existence message", () => {
    const result = validatePlanDefinition(
      { steps: [{ id: "mesh", operation: "derive_mesh", inputs: { artifactId: "art_ghost" } }] },
      artifactsById,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('plan references unknown artifact "art_ghost"')
  })

  test("unknown artifact id inside build_report artifactIds → the same verbatim message", () => {
    const result = validatePlanDefinition(
      {
        steps: [
          { id: "report", operation: "build_report", inputs: { artifactIds: ["art_model_1", "art_ghost"] } },
        ],
      },
      artifactsById,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('plan references unknown artifact "art_ghost"')
  })

  test("build_report with two known artifact ids passes the gate", () => {
    const result = validatePlanDefinition(
      {
        steps: [{ id: "report", operation: "build_report", inputs: { artifactIds: ["art_model_1", "art_mesh_1"] } }],
      },
      artifactsById,
    )
    expect(result.ok).toBe(true)
  })

  test("an empty artifact map refuses every wired id (the gate is existence, not shape)", () => {
    const result = validatePlanDefinition(
      { steps: [{ id: "mesh", operation: "derive_mesh", inputs: { artifactId: "art_model_1" } }] },
      new Map<string, PlannerArtifactContext>(),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('plan references unknown artifact "art_model_1"')
  })

  test("deliberately NO kind gates — the broker stays the single content authority (contract decision)", () => {
    // derive_mesh wired to a DOCUMENT artifact is accepted here on purpose: a
    // kind mismatch must fail at execution with the broker's verbatim error,
    // exactly as a manually-created workflow would.
    const result = validatePlanDefinition(
      { steps: [{ id: "mesh", operation: "derive_mesh", inputs: { artifactId: "art_doc_1" } }] },
      artifactsById,
    )
    expect(result.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// summarizePlanSteps (review card lines — real names, never ids alone)
// ---------------------------------------------------------------------------

describe("summarizePlanSteps", () => {
  const qaDefinition: WorkflowDefinition = {
    steps: [
      {
        id: "quantities",
        operation: "derive_quantities",
        inputs: { artifactId: "art_model_1" },
        parameters: {},
        retry: { maxAttempts: 1, backoffMs: 0 },
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

  test("3-step QA definition → exactly 3 lines: pinned labels, real names, approval marker ONLY on the report line", () => {
    const lines = summarizePlanSteps(qaDefinition, artifactsById)
    expect(lines.length).toBe(3)
    expect(lines).toEqual([
      "Derive quantities on 'Harbour Wall' (model)",
      "Derive mesh on 'Harbour Wall' (model)",
      "Build report from 2 artifact(s): 'Harbour Wall' (model), 'Retaining wall mesh' (mesh) [requires approval]",
    ])
    expect(lines[0]).not.toContain("[requires approval]")
    expect(lines[1]).not.toContain("[requires approval]")
  })

  test("every single-input operation renders its pinned human label", () => {
    const single = (id: string, operation: WorkflowDefinition["steps"][number]["operation"]) => ({
      id,
      operation,
      inputs: { artifactId: "art_model_1" },
      parameters: {},
      retry: { maxAttempts: 1, backoffMs: 0 },
      requiresApproval: false,
      skipOnError: false,
    })
    const definition: WorkflowDefinition = {
      steps: [
        single("q", "derive_quantities"),
        single("m", "derive_mesh"),
        single("f", "fe_mesh"),
        single("p", "run_powerflow"),
        single("d", "run_des"),
        single("c", "convert_document"),
        single("a", "analyze_schedule"),
      ],
    }
    expect(summarizePlanSteps(definition, artifactsById)).toEqual([
      "Derive quantities on 'Harbour Wall' (model)",
      "Derive mesh on 'Harbour Wall' (model)",
      "Generate FE mesh on 'Harbour Wall' (model)",
      "Run power flow on 'Harbour Wall' (model)",
      "Run discrete-event simulation on 'Harbour Wall' (model)",
      "Convert document on 'Harbour Wall' (model)",
      "Analyze schedule on 'Harbour Wall' (model)",
    ])
  })

  test("a missing artifact id renders honestly as 'unknown artifact <id>' (defensive, post-validation unreachable)", () => {
    const lines = summarizePlanSteps(
      {
        steps: [
          {
            id: "mesh",
            operation: "derive_mesh",
            inputs: { artifactId: "art_ghost" },
            parameters: {},
            retry: { maxAttempts: 1, backoffMs: 0 },
            requiresApproval: false,
            skipOnError: false,
          },
        ],
      },
      new Map<string, PlannerArtifactContext>(),
    )
    expect(lines).toEqual(["Derive mesh on 'unknown artifact art_ghost'"])
  })
})

// ---------------------------------------------------------------------------
// planToJsonText (AgentPlan.plan column format)
// ---------------------------------------------------------------------------

describe("planToJsonText", () => {
  const definition: WorkflowDefinition = {
    steps: [
      {
        id: "mesh",
        operation: "derive_mesh",
        inputs: { artifactId: "art_model_1" },
        parameters: {},
        retry: { maxAttempts: 1, backoffMs: 0 },
        requiresApproval: false,
        skipOnError: false,
      },
    ],
  }
  const rationale = "Run the standard QA chain"
  const assumptions = ["the model is the latest revision", "the report needs human approval"]

  test("round-trips through JSON.parse to the same object", () => {
    const text = planToJsonText(rationale, assumptions, definition)
    expect(JSON.parse(text)).toEqual({ rationale, assumptions, definition })
  })

  test("one line, stable key order: rationale, then assumptions, then definition", () => {
    const text = planToJsonText(rationale, assumptions, definition)
    expect(text).not.toContain("\n")
    expect(text.indexOf('"rationale"')).toBeLessThan(text.indexOf('"assumptions"'))
    expect(text.indexOf('"assumptions"')).toBeLessThan(text.indexOf('"definition"'))
  })
})

// ---------------------------------------------------------------------------
// PLAN_STATUSES / isPlanStatus / PLANNER_ACTOR (contract §2.1 pins)
// ---------------------------------------------------------------------------

describe("plan status vocabulary & planner actor", () => {
  test("PLAN_STATUSES is exactly the four contract states in order", () => {
    expect(PLAN_STATUSES).toEqual(["proposed", "accepted", "rejected", "failed"])
  })

  test("isPlanStatus accepts only the four plan statuses", () => {
    for (const status of PLAN_STATUSES) {
      expect(isPlanStatus(status)).toBe(true)
    }
    for (const bad of ["draft", "queued", "running", "succeeded", "proposals", "", "PROPOSED"]) {
      expect(isPlanStatus(bad)).toBe(false)
    }
  })

  test("PLANNER_ACTOR is the pinned agent actor", () => {
    expect(PLANNER_ACTOR).toBe("agent:planner-v1")
  })
})
