# Workflow & Agent Runtime

Version: 0.1 (target design; execution ships Phase 4) · Owner: W3 (runtime) + TL (safety model)

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

## 4. Phase-1 reality (honest scope)

`prisma/schema.prisma` defines Workflow rows and API routes can list them, but **no durable execution exists yet** — the UI shows an honest empty state pointing to Phase 4. Nothing in Phase 1 simulates workflow execution.
