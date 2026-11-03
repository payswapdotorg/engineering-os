# Workflow Runtime & Agent Execution Contract — Phase 4

Version: 1.0 (binding; implemented this phase) · Owner: TL (contract) + W3 (runtime) + W2 (broker ops) + W1 (UI)
Normative for: prisma/schema.prisma, src/core/workflow.ts, src/core/runtime/**, src/engines/broker.ts, src/app/api/workflows/**, src/components/product/agents-workspace.tsx
ADR hooks: ADR-0005 (broker/execution records), ADR-0006 (agent safety, approval gates), ADR-0002 (pure core)

## 0. Phase-4 exit criteria (release-objectives row 4, verbatim)

Durable tool execution with retries/recovery; real adapter calls; approval gates enforced;
downstream invalidation runs; an agent executes a real multi-step workflow on persisted
artifacts and obtains review before publishing. — Journey F becomes real.

## 1. Data model (Prisma extensions)

### Workflow (existing model, extended)

```
+ createdBy        String   @default("local-operator")   // "local-operator" | "agent:<name>" (W-flow creator actor)
+ currentStateSince DateTime?                            // set on EVERY state change (recovery scan input)
+ failure           String?   // JSON {stepId, attempt, error, at} — set on failed, cleared on retry
+ finishedAt        DateTime?                            // succeeded | failed | cancelled
  definition        String?   // existing; Phase-4 contract below (was free-form)
  state             String    // existing; Phase-4 machine below
```

### WorkflowStepRun (new — one row per (workflow, step), mutated in place per attempt)

```
id, workflowId (cascade), stepId (definition key), seq (execution order)
state              pending | running | succeeded | failed | skipped | awaiting_approval
attempt            Int      // current attempt number (1-based)
maxAttempts        Int      // snapshot from definition at queue time
operation          String   // BROKER_OPERATIONS key
engineKey          String?  // resolved at execution ("cadquery" | "ifcopenshell")
inputRevisionIds   String   // JSON string[] — artifact revision ids locked at queue time
inputHashes        String   // JSON string[] — sha256 of those revisions' content (execution record)
outputArtifactRevisionId String?  // produced artifact revision (report/mesh) — null for ledger-only ops
outputSummary      String?  // JSON — per-op structured summary (§5), NO free-form numbers
stdoutTail         String?  // last 2000 chars, verbatim
stderrTail         String?  // last 2000 chars, verbatim
exitCode           Int?     // adapter subprocess exit code
engineVersion      String?
adapterScript      String?
adapterHash        String?
startedAt, endedAt DateTime?
durationMs         Int?
```

### WorkflowEvent (new — append-only execution log, like AuditEvent)

```
id, workflowId (cascade), seq Int // per-workflow monotonic (1, 2, …) — event order is content
kind               String  // §4 vocabulary
actorType          String  // user | agent | system
actorId            String  // "local-operator" | "agent:<name>" | "system:executor" | "system:recovery"
payload            String? // JSON — kind-specific, always includes verbatim error text on failures
createdAt          DateTime @default(now())
@@unique([workflowId, seq])
```

## 2. Workflow definition (JSON, zod-validated — src/core/workflow.ts)

```jsonc
{
  "steps": [                            // 1..8 steps, seq = array order
    {
      "id": "quantities",               // ^[a-z0-9-]{1,32}$, unique in definition
      "operation": "derive_quantities", // BROKER_OPERATIONS key (§5)
      "inputs": { "artifactId": "art_…" },       // derive ops: exactly one model artifact
      "parameters": {},                  // op-specific, default {}
      "retry": { "maxAttempts": 2, "backoffMs": 400 },  // default {1, 0} = no retry
      "requiresApproval": false,         // true → pause BEFORE publishing (§4)
      "skipOnError": false               // true → step failure marks step skipped, flow continues
    },
    {
      "id": "mesh",
      "operation": "derive_mesh",
      "inputs": { "artifactId": "art_…" },
      "parameters": {},
      "retry": { "maxAttempts": 1, "backoffMs": 0 },
      "requiresApproval": false,
      "skipOnError": false
    },
    {
      "id": "report",
      "operation": "build_report",
      "inputs": { "artifactIds": ["art_…", "art_…"] },   // report op: 1..4 artifacts
      "parameters": { "title": "Model QA report" },       // optional title
      "retry": { "maxAttempts": 1, "backoffMs": 0 },
      "requiresApproval": true,                            // Journey F: human publishes
      "skipOnError": false
    }
  ]
}
```

Validation refuses: unknown operations, unknown input shapes for the op, >8 or 0 steps,
duplicate step ids, bad patterns, `requiresApproval` on a non-publishing op is allowed but
only `build_report` and future publishing ops honor it.

## 3. State machine (src/core/workflow.ts — pure, unit-tested)

```
draft ──mark-ready──▶ ready ──queue──▶ queued ──claim──▶ running
running ──(all steps done)──▶ succeeded
running ──(step exhausted retries, !skipOnError)──▶ failed
running ──(reached requiresApproval step, output written as draft)──▶ awaiting_approval
awaiting_approval ──approve(human)──▶ running   (publish: §4 approval semantics)
awaiting_approval ──reject(human)──▶ cancelled
draft|ready|queued|running|awaiting_approval ──cancel(human)──▶ cancelled
failed ──retry(human)──▶ queued        (resumes from the failed step; earlier outputs kept)
running (orphan found by recovery scan) ──▶ failed + workflow.recovery-marked event
```

Terminal: `succeeded`, `failed`, `cancelled` (failed is retry-able → re-queued; succeeded
and cancelled are absolute). `applyWorkflowAction(state, action) → next | null` is the
single authority; routes AND the executor both call it — no ad-hoc transitions.

## 4. Approval gates (ADR-0006 §3 — the red line)

1. `approve` and `reject` are accepted ONLY with a human actor. The API never accepts an
   actor parameter for these actions: the approver is the **signed-in session user,
   resolved server-side** (Phase-6 auth: `session?.id ?? "local-operator"` — the legacy
   operator identity survives only as the fallback for non-session callers such as
   maintenance scripts; the session gates make it unreachable from request paths), and is
   stamped on the workflow event + audit event (`userName`). An agent actor can never
   approve or reject — there is no code path.
   *(Amendment 2026-10-22, release-truth pass: this section originally pinned the approver
   to `local-operator`; the shipped Phase-6 transition route attributes approval to the
   authenticated user. History preserved per the doc convention.)*
   *(Amendment 2026-10-22, isolation slice 10: the approver must additionally be a project
   member with write access — non-members 404 before any state logic, project-viewers 403,
   owner/editor humans may approve; the global admin remains the pinned superuser. See
   `project-isolation-contract.md` §4 and ADR-0007.)*
2. When `workflow.createdBy` starts with `agent:`, a human approving is by construction a
   distinct identity. When the creator is human (`local-operator`), self-approval is the
   existing Phase-1..3 semantics (humans approve their own submissions) and stays allowed.
3. Publish semantics: a `requiresApproval` step EXECUTES first (real adapter output is
   written as a draft revision + step row `awaiting_approval`), THEN the workflow pauses.
   `approve` publishes: the step's output revision transitions draft → approved (approval
   payload {approvedBy, approvedAt, workflowId} on the revision; `artifact.approved` audit
   event + `workflow.approved` workflow event), and execution continues. `reject` cancels
   the workflow; the draft output REMAINS (auditable, never silently deleted).
4. Every agent-initiated step execution emits its existing audit event
   (`quantity.derived` / `mesh.derived` / `report.built`) with actor `adapter:<engine>`
   or `agent:<name>` — plus the per-workflow WorkflowEvent stream. Untraceable outputs
   are rejected: a step without an output record cannot be marked succeeded.

## 5. Broker operations (src/engines/broker.ts — the ONLY execution path, ADR-0005)

```
BROKER_OPERATIONS = {
  derive_quantities: run the REAL quantity adapter (cadquery/ifcopenshell via
      derive-kind) → QuantityRecord rows (existing provenance, + workflowId) —
      outputSummary {rows, quantityType/value/unit per row, elementRefs}
  derive_mesh: run the REAL tessellation adapter → mesh artifact revision
      (byte-deterministic eos-mesh/1, derived_from link) — outputSummary
      {elementCount, vertexCount, triangleCount, contentHash, revisionNumber}
  build_report: assemble a kind-"report" artifact revision (JSON: Markdown +
      structured sections) from DB-verified rows ONLY (ledger rows on the input
      artifacts + mesh meta + workflow run record). NO new numbers are computed:
      every figure is copied verbatim from stored rows with per-figure source ids.
      Report artifact linked derived_from each input artifact. outputSummary
      {sectionCount, figureCount, sourcesCited}
}
```

Broker execution record (persisted on WorkflowStepRun — ADR-0005 §2, every field
populated by the real run): engineKey, engineVersion, adapterScript, adapterHash,
exitCode, inputRevisionIds + inputHashes, stdoutTail/stderrTail (verbatim, 2000-char
tail), durationMs, outputArtifactRevisionId, outputSummary. The three existing routes
(derive-quantities / derive-mesh route, report-free until now) keep their EXACT
current HTTP behavior — W2 extracts the shared core; routes call the same functions
(byte-stable regression: scripts/e2e-takeoff.sh, e2e-p3-hardening.sh, e2e-p2-modelviewer.sh
must pass unchanged).

## 6. API contract

```
POST   /api/projects/[id]/workflows          {name, definition, createdBy?}
    → 201 {workflow}   — createdBy validated: "local-operator" (default) or ^agent:[a-z0-9-]{1,32}$
GET    /api/projects/[id]/workflows          → {workflows:[…]} (existing shape, rows now real)
GET    /api/workflows/[id]                   → {workflow, steps:[WorkflowStepRun], events:[…200 newest]}
POST   /api/workflows/[id]/transition        {action: mark-ready|queue|cancel|retry|approve|reject, note?}
    → 200 {workflow} | 404 | 409 (state machine null) | 403 (approve/reject with a non-human
       actor — impossible via body, but the route DEFENDS the invariant: actorType must be "user")
       | 422 (validation, verbatim)
POST   /api/admin/storage/scan               → {orphans:[{storageKey, sizeBytes, detectedAt}]}
       (read-only listing of content-store dirs with no DB artifact)
DELETE /api/admin/storage/orphans            {confirm: true} → {removed:[…], kept:[…]}
       (deletes EXACTLY the listed orphans; anything uncertain is kept — never a blind sweep)
```

queue → the executor CLAIMS the workflow (queued→running + events) and runs steps
sequentially in-process. Requeue is idempotent-safe: queue on non-ready state → 409
via the state machine. retry revalidates inputs (the source artifact must still exist).

## 7. Event vocabulary (WorkflowEvent.kind — closed set)

workflow.created, workflow.ready, workflow.queued, workflow.started,
step.started, step.succeeded, step.failed, step.retried, step.skipped,
step.awaiting_approval, workflow.awaiting_approval, workflow.approved,
workflow.rejected, workflow.cancelled, workflow.succeeded, workflow.failed,
workflow.recovery-marked, storage.orphans-listed, storage.orphans-removed.

Every payload carries the actor and — for step events — the stepId; failures carry the
verbatim adapter error (never paraphrased).

## 8. Executor semantics (src/core/runtime/executor.ts)

- Sequential in-process async executor, one workflow at a time (single-operator dev
  reality; no scheduler pretense). Concurrency is a documented exclusion.
- Inputs are locked at queue time (latest revision ids snapshotted into each step row)
  — a mid-run source upload does not change what a queued run reads. The Journey-G
  staleness cascade still marks downstream outputs when sources change (existing
  machinery, zero new code).
- Retry: on step failure with attempt < maxAttempts → sleep backoffMs → re-run (events
  step.retried). Exhausted + !skipOnError → workflow failed (failure JSON recorded).
- Recovery: on module load and on every workflow list API call, rows in `running` with
  currentStateSince older than 5 minutes are marked failed + `workflow.recovery-marked`
  (honest: no auto-resume; recovery IS the explicit `retry` action). `queued` rows are
  claimed normally after a restart.
- Zero side effects on failure: a failed step writes NO output revision (existing
  adapter honesty: derives either produce real bytes + rows or throw before writes);
  already-succeeded earlier steps keep their outputs — visible in the step table, never
  silently deleted.
- Foundation seam (ADR-0010, added 2026-10-30): the claiming/recovery mechanics above
  are reached through the `WorkflowExecutionFoundation` port
  (src/core/runtime/foundation.ts, flag `EOS_WORKFLOW_RUNTIME`, default and today only
  `embedded`). The §4 approval red line, §7 event vocabulary, revision publication and
  broker authorization are PLATFORM-OWNED and are deliberately not expressible through
  the port — a future foundation swap changes this section's mechanics owner, never its
  semantics.

## 9. UI contract (W1 — Agents & Automations workspace)

Un-lock the "Planned · Phase 4" workspace. Components consume ONLY the §6 API.

- List: workflow cards (name, state badge with the full 8-state vocabulary, creator
  actor badge — human vs agent visually distinct, created/finished, step-count summary);
  create dialog with template pick ("Model QA pipeline" — the §2 definition, source
  artifact selector pre-fills both derive steps) and an honest JSON preview.
- Detail (in-page panel or drawer): step timeline (state, attempt/max, engine, duration,
  verbatim error rows), event stream (newest first), state-appropriate actions
  (Mark ready / Queue / Cancel / Retry / Approve / Reject) — approve & reject show the
  "human review required" affordance; when createdBy is an agent, the detail states it.
- Toast verbatim 422/409 messages (existing product pattern). Zero dead buttons: actions
  render only in states where the machine allows them.
- Template source of truth: src/core/workflow.ts exports WORKFLOW_TEMPLATES; the UI
  imports it (no duplicated definitions).

## 10. Explicit exclusions (honest scope, recorded)

- NextAuth/multi-user authN (capability matrix row stays planned — approval identity is
  actor-typed, not authenticated).
- PostgreSQL migration, multi-instance executors, cron scheduling, LLM-driven planning
  (the "agent" is a named deterministic orchestration actor; LLM-as-planner is out of
  scope this phase — ADR-0006 §2 numerical-truth line is untouched: build_report copies
  verified stored numbers only).
- Auto-resume of interrupted runs (explicit retry only), workflow versioning/diffing,
  cross-project templates.

## 11. Acceptance items (TL verifies; each needs command + observed result)

| ID | Item |
|---|---|
| AC-P4-01 | Definition validation: template-shaped definition accepted; bad op / dup ids / >8 steps → 422 verbatim |
| AC-P4-02 | Durable execution: queue → real cadquery+ifcopenshell runs → awaiting_approval at the report step; steps carry engine version, adapterHash, exitCode, inputHashes, tails |
| AC-P4-03 | Retry: failing step (forced via maxAttempts on a geometry-free source) retried then workflow failed with verbatim error; retry action resumes from that step |
| AC-P4-04 | Approval gate: agent-created workflow; approve as human succeeds and publishes (report revision approved + audit); NO actor parameter can make an agent approve (403 by construction, defended in route) |
| AC-P4-05 | Downstream invalidation: new source revision after a succeeded run → report+mesh revisions stale with path evidence (Journey-G reuse, zero new graph code) |
| AC-P4-06 | Recovery: orphan `running` row → recovery-marked failed + event; retry works |
| AC-P4-07 | Orphan cleanup: storage scan lists true orphans; delete removes exactly those; DB↔store consistency asserted |
| AC-P4-08 | build_report figures are verbatim copies of stored rows with per-figure source ids (no recomputation); report linked derived_from every input |
| AC-P4-09 | Regression: e2e-takeoff.sh 27 PASS · e2e-p3-hardening.sh 40 PASS · e2e-p2-modelviewer.sh 67 PASS — routes byte-stable through the broker extraction |
| AC-P4-10 | Browser Journey F end-to-end: create from template as agent actor → ready → queue → watch steps live → awaiting_approval → human approve → succeeded; report visible; verbatim errors surfaced; mobile + footer + a11y per product standard |
