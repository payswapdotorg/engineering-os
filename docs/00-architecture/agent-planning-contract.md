# Agent Planning Layer Contract — Slice 11 (LLM planner)

Version: 1.0 (binding; implemented this slice) · Owner: TL (contract) + planner lane (core) + routes lane (API) + UI lane (frontend)
Normative for: prisma/schema.prisma, src/core/planner.ts, src/lib/llm.ts, src/app/api/projects/[id]/plans/route.ts, src/app/api/plans/[id]/route.ts, src/app/api/plans/[id]/decision/route.ts, src/components/product/agents-workspace.tsx, scripts/e2e-p7-planner.sh, scripts/dev-seed-plan.ts
ADR hooks: ADR-0008 (this contract), ADR-0006 (agent never approves), ADR-0005 (broker is the only tool path), ADR-0002 (pure core)

## 0. Exit criteria (forward-queue row 1, verbatim)

An LLM planning layer where a human types a natural-language intent, a real LLM
(z-ai-web-dev-sdk, server-side only) proposes a workflow definition wired to
REAL project artifacts, the proposal is validated through the SAME canonical
schema as manual definitions, a HUMAN decides (accept → draft workflow created
by `agent:planner-v1`, then the existing draft → ready → queue → approval path
with NO shortcut), failed runs can be re-planned from verbatim evidence, and
every attempt is persisted as reviewable task memory. The broker remains the
ONLY tool-execution path; the LLM never executes, never approves, and never
computes a numeric result.

## 1. Principle — the planner proposes, a human disposes (ADR-0008)

The LLM is an UNTRUSTED advisor, never an executor:

1. It may only produce: a rationale (string), assumptions (strings), and a
   workflow definition selecting from the pinned `BROKER_OPERATIONS` catalog
   and wiring artifact ids that ALREADY EXIST in the target project.
2. Its context carries NO numeric engineering content — artifact metadata only
   (id, name, kind, revision count, latest approval state, latest revision
   note truncated to 200 chars). No sizes, no geometry, no quantities, no
   rates. The planner cannot be a source of numeric truth BY CONSTRUCTION.
3. Its output is validated through the canonical `parseWorkflowDefinition`
   (contract §2 of workflow-runtime-contract) PLUS an existence gate; every
   failure is persisted verbatim as a `failed` plan row (persistent, honest
   task memory), never silently retried past its budget or faked.
4. Accepting a plan is a HUMAN action that creates a DRAFT workflow with
   `createdBy = "agent:planner-v1"` — the agent-creator callout and the
   human-only approval red line (ADR-0006 §3) apply to it exactly as to any
   agent-created workflow. The planner has NO transition or approval powers.
5. Execution goes through the EXISTING durable runtime and broker — the
   planner adds no tool path, no operation, no shortcut.

## 2. Data model (Prisma — AgentPlan, additive)

```prisma
model AgentPlan {
  id            String     @id @default(cuid())
  projectId     String
  project       Project    @relation(fields: [projectId], references: [id], onDelete: Cascade)
  intent        String     // the human's request, VERBATIM (10..2000 chars enforced at the boundary)
  status        String     @default("proposed") // proposed|accepted|rejected|failed (src/core/planner.ts)
  revisesPlanId String?    // prior plan this proposal revises (same project, any status)
  revises       AgentPlan? @relation("PlanRevisions", fields: [revisesPlanId], references: [id], onDelete: SetNull)
  revisedBy     AgentPlan[] @relation("PlanRevisions")
  plan          String?    // JSON {rationale, assumptions, definition} — CANONICAL post-validation; null when failed
  evidence      String?    // JSON {rawResponse?, durationMs?, attempts?} — the LLM's raw text VERBATIM (honest evidence, like stdout tails)
  failure       String?    // JSON {stage: "llm"|"validation", error, at} — verbatim reason when status failed
  createdById   String?    // session user id of the human who asked (string, AuditEvent precedent — no FK)
  decidedById   String?    // session user id of the acceptor/rejector
  decidedAt     DateTime?
  workflowId    String?    // draft workflow created on accept (SetNull: plans outlive their workflow)
  workflow      Workflow?  @relation("PlanAcceptedWorkflow", fields: [workflowId], references: [id], onDelete: SetNull)
  createdAt     DateTime   @default(now())
  updatedAt     DateTime   @updatedAt

  @@index([projectId, status])
}
```

`Project` gains `plans AgentPlan[]`; `Workflow` gains
`acceptedByPlans AgentPlan[] @relation("PlanAcceptedWorkflow")`. Both additive.

### 2.1 Status machine (frozen)

```
(proposed) ──accept(human)──▶ accepted   (creates the draft workflow; decidedById/At set)
(proposed) ──reject(human)──▶ rejected   (decidedById/At set; no workflow)
(llm or validation failure at creation) ▶ failed   (terminal for that row — re-plan makes a NEW row)
```

`accepted` and `rejected` are terminal per row: a second decision → 409 with
the pinned verbatim message (§5.3). `failed` rows are evidence, never zombies:
the UI offers Regenerate, which creates a NEW plan row with
`revisesPlanId = <the failed row>`.

## 3. Planner core — src/core/planner.ts (pure, ADR-0002; FROZEN exports)

No DB, no network, no filesystem. Imports: zod, `./workflow` only.

```ts
export const PLANNER_ACTOR = "agent:planner-v1"
export const PLAN_STATUSES = ["proposed", "accepted", "rejected", "failed"] as const
export type PlanStatus = (typeof PLAN_STATUSES)[number]
export function isPlanStatus(value: string): boolean

export interface PlannerArtifactContext {
  id: string
  name: string
  kind: string            // model|mesh|drawing|document|dataset|calculation|report|other
  revisionCount: number   // structural count — the ONLY number in the context
  latestApprovalState: string
  latestNote: string | null  // truncated to 200 chars by the builder
}

export interface PlannerPriorPlan {
  status: PlanStatus
  intent: string
  rationale: string | null
  definition: unknown
  workflowState: string | null      // when accepted: the live workflow's state
  workflowFailure: string | null   // workflow.failure JSON text, VERBATIM
  failedStepStderr: string | null  // failed step's stderrTail, VERBATIM
}

export interface PlannerMessagesInput {
  projectName: string
  discipline: string
  artifacts: PlannerArtifactContext[]
  prior: PlannerPriorPlan | null   // the revisesPlanId plan's context, when re-planning
  feedback: string | null          // optional human guidance sent with the revision request
}

/** Builds the exact chat messages (assistant-role system prompt + user content). */
export function buildPlannerMessages(input: PlannerMessagesInput): Array<{ role: "assistant" | "user"; content: string }>

/** Response envelope schema: {rationale, assumptions, definition}. */
export const PlannerEnvelopeSchema = z.object({
  rationale: z.string().min(1).max(2000),
  assumptions: z.array(z.string().min(1).max(300)).max(6).default([]),
  definition: z.unknown(),
})

/** Extracts the first balanced JSON object from LLM text (handles ```json fences and trailing prose). */
export function extractJsonObject(text: string): { ok: true; value: unknown } | { ok: false; error: string }

/**
 * The validation chain (frozen order): envelope parse → canonical
 * parseWorkflowDefinition → existence gate (every referenced artifact id must
 * be a key of artifactsById). Returns the CANONICAL definition on success or
 * ONE joinable verbatim error. Deliberately does NOT re-implement broker
 * content/kind gates — the broker stays the single content authority; a kind
 * mismatch fails at execution with the broker's verbatim error, exactly as a
 * manual workflow would.
 */
export function validatePlanDefinition(
  definition: unknown,
  artifactsById: Map<string, PlannerArtifactContext>,
): { ok: true; value: WorkflowDefinition } | { ok: false; error: string }

/** Human-readable per-step summary lines for review (REAL artifact names, never ids alone). */
export function summarizePlanSteps(
  definition: WorkflowDefinition,
  artifactsById: Map<string, PlannerArtifactContext>,
): string[]

/** Persists-shape helper: {rationale, assumptions, definition} canonical JSON text (sorted keys). */
export function planToJsonText(rationale: string, assumptions: string[], definition: WorkflowDefinition): string
```

Prompt rules pinned by unit test: the serialized context contains NO
`sizeBytes`, no geometry, no quantity values; the instructions demand
output-json ONLY (a single JSON object with the envelope keys), forbid
inventing artifact ids, forbid `requiresApproval: true` outside a publishing
`build_report` step semantics (still schema-allowed — the planner is TOLD to
gate reports on approval per Journey F), and cap at 8 steps.

## 4. LLM wire — src/lib/llm.ts (server-only; z-ai-web-dev-sdk)

```ts
export interface LlmCallResult { text: string; durationMs: number; attempts: number }
/** One planner call: ZAI.create() (cached module-level), thinking disabled, 1 retry on throw/empty, 60s ceiling per attempt (Promise.race). Errors throw with honest one-line messages the route maps to failure.stage "llm". */
export async function planWithLlm(messages: Array<{ role: "assistant" | "user"; content: string }>): Promise<LlmCallResult>
/** Availability probe for e2e Part B (cached 60s): returns true iff a minimal real completion succeeds. NOT used by the routes — they record honest failures instead. */
export async function probePlannerLlm(): Promise<boolean>
```

No other module may import `z-ai-web-dev-sdk`. The wire NEVER parses or
validates content — that is the pure core's job (§3).

## 5. API surface (Slice-10 authz conventions)

### 5.1 POST /api/projects/[id]/plans — create a plan (the LLM round trip)

Auth: `requireProjectAccess(id, "write")` (member editor+; viewer → pinned 403;
non-member → 404 `Project not found`). Body (zod, 422 verbatim):

```jsonc
{ "intent": "10..2000 chars", "revisesPlanId": "optional plan id in THIS project" }
```

Flow: load the project's artifact context (id/name/kind/revisionCount/
latestApprovalState/latestNote — metadata only) → build messages (prior plan
context when revisesPlanId set: prior row + its workflow's live state/failure
JSON + failed step stderrTail, all verbatim) → `planWithLlm` →
`extractJsonObject` → `PlannerEnvelopeSchema` → `validatePlanDefinition` →
persist ONE AgentPlan row in ALL cases:

- success → status `proposed`, plan column = canonical JSON, evidence =
  {rawResponse VERBATIM, durationMs, attempts}
- LLM wire error → status `failed`, failure {stage:"llm", error: mapped
  honest message, at}, evidence {durationMs, attempts} (no rawResponse)
- extraction/envelope/validation error → status `failed`, failure
  {stage:"validation", error: the single verbatim message, at}, evidence
  {rawResponse VERBATIM, durationMs, attempts}

Response: 201 `{ plan: PlanRow }` in every persisted case (the row IS the
outcome — persistent task memory). Audit: `plan.requested` (actorType user).
`revisesPlanId` pointing at another project's plan → 422 `cannot revise a plan from another project`.

### 5.2 GET endpoints

- `GET /api/projects/[id]/plans` — member read; newest first, cap 50; 200 `{plans: PlanRow[]}`.
- `GET /api/plans/[id]` — `requireEntityProject(plan.projectId, "Plan", "read")`; 200 `{plan: PlanRow}`; missing → 404 `Plan not found`.

### 5.3 POST /api/plans/[id]/decision — the HUMAN decision

Auth: load plan (missing → 404 `Plan not found`) → `requireEntityProject(plan.projectId, "Plan", "write")`.
Body: `{ "action": "accept" | "reject" }` (422 verbatim otherwise).

- Non-`proposed` status → 409 `this plan is already <status>` (pinned verbatim).
- `accept`: re-run `validatePlanDefinition` against the LIVE project artifacts
  (defense in depth — artifacts may have been deleted since the proposal).
  Failure → 422 with the verbatim error; the plan STAYS proposed (the human
  may regenerate). Success → create Workflow (state `draft`,
  `createdBy = PLANNER_ACTOR`, name = `intent` truncated to 60 chars +
  `" (AI plan)"`, definition = canonical JSON text), set plan → `accepted`,
  workflowId, decidedById/At; audit `plan.accepted`. Response 200
  `{plan: PlanRow, workflow: WorkflowRow}`.
- `reject`: plan → `rejected`, decidedById/At; audit `plan.rejected`.
  Response 200 `{plan: PlanRow}`.

The route NEVER accepts `actorType`/`approver` fields — acceptance is the
signed-in human's decision by construction; the created workflow remains a
draft the human must `mark-ready` → `queue` (existing routes), and every
approval gate inside it stays human-only (ADR-0006).

### 5.4 PlanRow wire shape (frozen)

```jsonc
{
  "id": "…", "projectId": "…", "intent": "…", "status": "proposed|accepted|rejected|failed",
  "revisesPlanId": null,
  "rationale": "…|null", "assumptions": ["…"],          // null/[] when failed
  "definition": { "steps": [ /* canonical */ ] },        // null when failed
  "stepSummary": ["Derive quantities from 'Harbour Wall' (model)"], // summarizePlanSteps, null when failed
  "evidence": { "rawResponse": "…", "durationMs": 123, "attempts": 1 }, // null-able keys
  "failure": null,                                        // or {stage, error, at}
  "createdById": "…|null", "decidedById": "…|null", "decidedAt": "…|null",
  "workflowId": "…|null", "createdAt": "…"
}
```

## 6. Frontend — agents-workspace.tsx (planner panel)

Position: a new "AI planner" card ABOVE the workflow templates. No dead
buttons; every action hits the real API:

- intent Textarea (10..2000, client mirrors server 422s verbatim under the
  field); optional "revise an earlier plan" Select (prior plans of this
  project, newest first, labeled with status) + optional feedback line when
  revising; submit button with a loading state (the LLM round trip is one
  synchronous request, 60s ceiling worst case).
- Result review card: status badge; for `proposed` — rationale, assumptions
  each prefixed with the honest review note ("assumption — verify before
  accepting"), `stepSummary` lines with REAL artifact names, collapsible
  canonical definition JSON (verbatim), and three real actions: **Accept**
  (POST decision; toast names the created DRAFT workflow + refreshes the
  workflows list), **Regenerate** (POST a new plan with revisesPlanId = this),
  **Reject** (POST decision). For `failed` — the stage + verbatim error and
  the raw LLM evidence (collapsible), with Regenerate.
- Plans history (Collapsible, newest first): intent excerpt, status badge,
  revises chain label, decided-by/at; clicking a proposed row reopens its
  review card.
- Copy states the red line verbatim in spirit: accepting creates a DRAFT
  workflow authored by `agent:planner-v1`; the human still reviews, marks
  ready and queues; approvals stay human-only (ADR-0006).

## 7. Test matrix

### 7.1 Unit — src/core/planner.test.ts (pure; runs everywhere)

- buildPlannerMessages: context JSON contains NO sizeBytes/geometry/quantity
  keys; instructions pin the envelope + "output JSON only" + no invented ids
  + ≤8 steps; prior plan evidence lands VERBATIM (workflow failure JSON +
  stderr tail present); latestNote truncated to 200.
- extractJsonObject: plain object; ```json fenced; fenced with leading
  prose; trailing prose; no JSON → honest error.
- validatePlanDefinition: canonical success (defaults filled); unknown op →
  verbatim schema message; >8 steps; unknown artifact id → the pinned
  existence message; build_report artifactIds shape enforced (schema
  verbatim); duplicate step ids.
- summarizePlanSteps: real names, kind badges, report step lists all inputs.
- planToJsonText: stable sorted-key canonical text.
- isPlanStatus / PLAN_STATUSES pin.

### 7.2 E2E — scripts/e2e-p7-planner.sh (SEVENTH suite; sources e2e-signin.sh)

Two parts, honest split (engine-harness skip precedent):

- **Part A — contract surface (ALWAYS runs, green in CI without the LLM).**
  Fixture: a proposed plan row seeded by `scripts/dev-seed-plan.ts` (test-only
  seam, contract-documented: intent prefixed `[e2e fixture]`, canonical
  modelQA-pipeline-shaped definition wired to a REAL fixture-project artifact).
  - AC-P1 isolation: non-member POST/GET project plans → 404 `Project not
    found`; non-member GET plan detail → 404 `Plan not found` (Slice-10 layering).
  - AC-P2 viewer: Zara POST plans → 403 pinned read-only envelope; her GET stays 200.
  - AC-P3 intent 422s verbatim (too short; too long); bad action 422; double
    decision 409 `this plan is already accepted|rejected`.
  - AC-P4 cross-project revisesPlanId → 422 verbatim.
  - AC-P5 accept the fixture plan → 200 {plan.status=accepted,
    workflow.state=draft, workflow.createdBy=agent:planner-v1, name suffix
    "(AI plan)"}; the workflow then follows the REAL human path: mark-ready
    200 → queue 200 → (single build_report step, no engine needed) →
    terminal state observed; plan.workflowId set; audit `plan.accepted` present.
  - AC-P6 accept-after-artifact-deletion → 422 verbatim; plan STAYS proposed.
  - AC-P7 reject path → rejected; second decision → 409.
  - AC-P8 audit: plan.requested exists for the LLM-live POST (Part B) and
    plan.accepted/plan.rejected for Part A rows.
- **Part B — live LLM round trip (runs only when `probePlannerLlm()` is true;
  otherwise prints `SKIP (llm unavailable)` and passes — CI precedent: engine
  harness honest skips).**
  - AC-P9 POST a real intent naming the fixture model artifact → 201
    plan.status=proposed, definition wires the REAL artifact id, rationale
    non-empty; stepSummary non-empty; evidence.rawResponse non-empty.
  - AC-P10 regenerate → new row with revisesPlanId = prior row id.
  - AC-P11 re-plan from failure: fixture a failed workflow evidence set (Part
    A's AC-P5 run can be reused if it failed, else a scripted revision request
    against the accepted plan) → new proposed row carries revisesPlanId.

Final line `N PASS / M FAIL`, nonzero exit on FAIL; creates/removes its OWN
fixtures; projects removed on success, KEPT on failure.

### 7.3 Fixture script — scripts/dev-seed-plan.ts (test-only, documented)

Args: `projectId`, `artifactId`, optional `--status`. Inserts one AgentPlan
row through Prisma directly (the ONLY proposed-plan source besides the real
LLM — the deliberate, documented seam that lets the CONTRACT surface stay
tested in LLM-less CI). Prints the plan id. Refuses unknown status values.

## 8. CI integration (.github/workflows/ci.yml e2e job)

Add after p6, same pattern: `e2e-p7-planner (Part A + live-LLM Part B, PASS
count reported by the suite)` with the same tee/pipefail discipline. Part B
self-skips honestly when the runner has no LLM. The suite's self-reported
PASS count is asserted non-zero (Part A always contributes).

## 9. Honesty ledger (what the LLM can never do — enforced by tests)

- Never executes anything (no code path: its output is data; only `accept`
  creates a DRAFT, and only a human accepts).
- Never approves (ADR-0006: created workflows carry agent creators; approval
  routes consult actorType only).
- Never a source of numeric results (context is metadata-only by §3's tested
  prompt invariant; numbers can only ever come from broker execution records).
- Never bypasses validation (every proposal passes the canonical schema; failures
  persist as honest `failed` rows with verbatim evidence).
- Never silent (rawResponse stored VERBATIM; every attempt is a reviewable row).

## 10. Prompt-quality iteration protocol (Slice 17 — the §7.2 loop, now repeatable)

The planner's output QUALITY is observable, never assumed. The loop, its
tooling, and its first two measured iterations (2026-10-25):

1. **Evidence ledger.** Propose real plans through the REAL API against a
   persistent project (the demo dataset — NOT a throwaway fixture, whose
   project-cascade would delete the rows). Every attempt is already a
   persisted AgentPlan row with the raw response VERBATIM (§2).
2. **Grade.** `bun scripts/grade-planner-ledger.ts` pulls every row and runs
   the unit-pinned rubric (`src/core/planner-grade.ts` — definition
   validity via the canonical parse; refusal honesty {stage, error, at};
   evidence presence, fixture rows exempt per §7.3). Exit 1 on any invalid
   row — CI- or session-gateable. The rubric grades STRUCTURE.
3. **Qualitative pass.** A human reads the proposals against the intents
   (the rubric cannot judge fidelity). Iteration 1's pass found three real
   defects: named-artifact substitution (the intent said bracket.step, the
   plan wired wall-quantities.ifc), format-blind wiring (takeoff_drawing
   wired to an .svg — a runtime 422 waiting to happen), and revision-delta
   ignored ("skip the mesh" — the revision kept the mesh, reused the prior
   rationale verbatim).
4. **Iterate the prompt.** Each finding became a pinned rule in
   `PLANNER_SYSTEM_PROMPT` (fidelity rules — every string asserted in
   `planner.test.ts`, so the rules cannot silently drift). Iteration 2
   sharpened two of them (the anaphora rule: "the model" resolves to the
   NAMED artifact; the REMOVE rule: a skip request means the step MUST NOT
   appear).
5. **Deterministic backstop.** The worst observed failure (a revision
   byte-identical to its parent) is now REFUSED at the validation stage —
   `revisionIsSubstantiveChange` (pure, unit-pinned) +
   `REVISION_IDENTICAL_REFUSED` persisted as an honest failed row with the
   raw response as evidence. The prompt carries the rule; the ROUTE enforces
   it — prompt-independent.
6. **Re-run live.** Same intents, iterated prompt: the revision now applies
   the requested delta, wires the named artifact, and its rationale states
   WHAT CHANGED (the live evidence is in the ledger; 9/9 rows grade clean).

**Residual (recorded for the next loop):** the DIRECT intent path (no
prior-plan evidence in context) can still substitute a same-kind artifact in
some runs — the worked-example template's pull. Next-loop candidate: put the
request's named artifacts FIRST in the user content, or add a
request-vs-wiring consistency note to the rubric.

The loop is a session of measured work whenever the evidence accumulates;
the tooling above is committed so any future session can run it cold.

### Loop 2 (Slice 18, 2026-10-26) — the named-artifact residual CLOSED deterministically

The recorded next-loop candidates were tried in a different order than
suggested, and the loop closed with the STRONGER of the two shapes:

- **The deterministic backstop shipped first** (`src/core/planner.ts`):
  `namedArtifactsInIntent` (verbatim substring, ≥4 chars, case-sensitive) +
  `wiredArtifactIds` + `namedArtifactsAreWired` + the pinned envelope
  `NAMED_ARTIFACT_SUBSTITUTION_REFUSED`. When the intent names an artifact
  and the plan wires NOTHING to it while a same-kind sibling IS wired, the
  plans route refuses the proposal at the validation stage and persists the
  honest failed row with the raw response as evidence — the
  REVISION_IDENTICAL_REFUSED pattern, extended to the direct path.
  Deliberately narrow: wired-anywhere passes, no-same-kind-sibling passes,
  two-named-of-kind is a legitimate choice the review gate owns. +12 unit
  pins. **Live-verified on its first run** — the two-model probe's LLM
  substituted the sibling on attempts 2–3 and the guard refused each
  verbatim before any accept button could see it.
- **The residual moved, honestly:** the regenerated ledger (2/2 clean) shows
  the remaining prompt-owned class is OP/KIND fidelity (takeoff_drawing
  wired to a named .svg; a Model-QA intent answered with a DXF takeoff —
  name-fidelity HOLDS in both rows, so the deterministic layer correctly
  passes them). The prompt's op↔format rule (Slice 17), the runtime 422,
  and the human review gate own that class; loop 3 owns it only if it
  recurs in the evidence ledger.
