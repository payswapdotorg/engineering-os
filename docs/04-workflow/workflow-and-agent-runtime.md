# Workflow & Agent Runtime

Version: 1.0 (shipped 2026-10-22 — Phase-4 slice) · Owner: W3 (runtime) + W2 (broker) + TL (safety model) · Binding contract: [workflow-runtime-contract.md](../00-architecture/workflow-runtime-contract.md)

## 1. Requirements (from handoff §3E)

Persistent multi-session workflow state; typed task inputs/outputs; dependencies; retry & failure handling; idempotency where appropriate; logs & execution events; artifact lineage; approval/rejection states; cancellation & recovery; notifications & human handoff; reproducible execution parameters.

## 2. Model

- **Workflow**: named, project-scoped, state machine `draft → ready → queued → running → (succeeded | failed | cancelled | awaiting_approval → …)`.
- **Step**: adapter invocation with typed contract (engine key, operation, inputs by artifact-revision id + parameters, outputs), order, retry policy.
- **Execution event**: append-only per workflow (like AuditEvent): state transitions, step starts/ends, stdout/stderr tails, cancel signals.
- **Lineage**: every output artifact revision records `derived_from` links + run id + engine version + input hashes.

## 3. Safety model (ADR-0006 applies)

- Tool calls go through the broker only; agents never build shell commands.
- Approval gates: workflows with `requires_approval` pause at `awaiting_approval`; a human (≠ acting agent) approves.
- Failure handling: no partial silent writes — failed steps leave upstream untouched, affected outputs marked, retry is explicit and audited.
- Cancellation is cooperative and recorded.

## 4. Phase-4 reality (shipped, honest scope)

Durable execution IS the tree (2026-10-22): `src/core/workflow.ts` (state machine + zod definition + template — 41 unit tests), `src/core/runtime/executor.ts` (serial step chain, queue-time input locking, retries, approval pause/publish, recovery scan), `src/engines/broker.ts` (the only execution path — `derive_quantities` / `derive_mesh` / `build_report`), `WorkflowStepRun` + `WorkflowEvent` (append-only, per-workflow monotonic seq), and the Agents & Automations workspace. Verified by `scripts/e2e-p4-workflows.sh` **49 PASS** (AC-P4-01…09) + the browser Journey F (AC-P4-10) — see the acceptance catalogue. Honest boundaries: single-process sequential executor (no scheduler/cron/multi-instance), recovery marks interrupted runs failed (explicit `retry` resumes — no auto-resume), the "agent" is a named deterministic orchestration actor (no LLM planning), approve/reject accept no actor parameter (server-side human only). Exclusions (authN, PostgreSQL, auto-resume, workflow versioning) are recorded in the binding contract §10.
