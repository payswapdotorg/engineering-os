# ADR-0006 — Agent safety & approval gates

Status: accepted · Date: 2025 (Phase 0; runtime ships Phase 4)

## Context

Agents must execute real engineering tools and multi-step workflows, while safety-critical and formally issued changes require human approval. LLMs must not be the source of truth for numerical results.

## Decision

1. **Tool boundary**: agents (LLM-driven) operate only through the workflow runtime, which calls the broker. No agent may construct and run arbitrary local shell commands. The broker enforces per-project, per-tool permissions.
2. **Numerical truth**: every number of record (quantity, rate, simulation result) is produced by a deterministic execution (adapter/solver/ledger math) and stored with provenance (engine version, inputs by hash, logs). An agent may *explain or transcribe* a tool-produced number, and may *propose* parameters — but writing a number requires the tool run that generated it, linked by run ID.
3. **Approval gates**: artifact approval states (`draft → in_review → approved`, with `superseded`) and workflow states (`… → awaiting_approval → …`) are the enforcement points. Configurable review requirements mark sensitive actions (formal issue, cost baseline publication, safety-relevant results) as human-review-required. **An agent can never be the approver of its own output**; approval requires a human identity (Phase 4 auth) distinct from the acting agent.
4. **Baseline protection**: approved artifacts and published deliverables are never silently overwritten. Revisions create new revisions; supersession is explicit and audited.
5. **Audit**: every agent-initiated action emits an `AuditEvent` with `actorType='agent'`, the workflow ID, tool, inputs and outputs. Untraceable outputs are rejected by the acceptance policy.
6. **Phase-1 reality**: the Workflow/`AuditEvent` schema and approval state machines exist now (see `prisma/schema.prisma`, `src/core`); durable execution, agent identities and enforcement middleware ship with Phase 4 — and are documented as such, not faked.

## Consequences

- Agent value (automation breadth) is compatible with professional accountability (evidence + gates).
- The ledger and graph are safe against silent agent mutation by construction; stale-marking + recompute workflows handle change instead of overwrite.
