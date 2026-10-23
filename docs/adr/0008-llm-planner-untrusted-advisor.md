# ADR-0008: LLM planner as untrusted advisor (never executor, never approver)

Status: accepted (2026-10-23, Slice 11) · Supersedes: none · Extends: ADR-0005 (broker stays the only tool path), ADR-0006 §3 (approval red line untouched), ADR-0002 (planner core is pure)

## Context

The forward queue names the LLM planning layer as the next capability: a
human types a natural-language intent, and an agent turns it into a real
workflow. The dangerous version of this is the industry default — an LLM
that "runs tools" in a hidden loop, invents numbers, and asks forgiveness.
This repository already has the durable alternative: a pinned operation
catalog, a broker that is the only tool path (ADR-0005), a canonical
definition schema, and human-only approvals (ADR-0006). The design question
is where an LLM can add value WITHOUT becoming a source of truth.

## Decision

1. **The LLM plans; it does not act.** Its only output is a workflow
   definition PROPOSAL: a rationale, assumptions, and steps selecting from
   `BROKER_OPERATIONS` and wiring artifact ids that already exist in the
   target project. Its context is metadata-only (ids, names, kinds, revision
   counts, approval states) — it never sees geometry, sizes, quantities or
   rates, so it cannot be a source of numeric truth BY CONSTRUCTION.
2. **Untrusted by default.** Every proposal passes the SAME canonical
   `parseWorkflowDefinition` used by manual creation, plus an existence gate;
   validation failures persist as honest `failed` plan rows carrying the
   verbatim LLM output and error — task memory, never silently faked.
3. **A human disposes.** `accept` (a member's signed-in action) creates a
   DRAFT workflow authored by `agent:planner-v1`; the human still marks it
   ready, queues it, and approves every gate inside it. The planner has no
   transition, execution or approval powers on any path.
4. **One wire, server-side.** All LLM calls live in `src/lib/llm.ts`
   (z-ai-web-dev-sdk, server-only, thinking disabled, one retry, 60s
   ceiling). No other module may import the SDK; the wire never validates
   content — the pure core does.
5. **Re-planning is evidence-based.** A revision request feeds the prior
   plan, its workflow's live state, failure JSON and failed-step stderr
   (VERBATIM) back to the LLM. The new proposal is a NEW row
   (`revisesPlanId`), so the revision chain is auditable history.
6. **Tested contract, honest skips.** The API contract surface is e2e-tested
   everywhere (fixture-seeded proposed plan — a documented test-only seam);
   the live-LLM round trip runs where the LLM exists and prints an honest
   SKIP elsewhere (engine-harness precedent).

## Consequences

- New `AgentPlan` table (persistent planning ledger: every attempt is a
  reviewable row), one new API surface (plans create/list/detail/decision)
  under the Slice-10 authz conventions, one new workspace panel.
- `createdBy = "agent:planner-v1"` workflows inherit the existing
  agent-creator callout and human-only approvals with zero runtime changes.
- The broker contract, the operation catalog and the executor are untouched —
  the planner adds a producer of definitions, not a new tool path.
- LLM availability becomes an environmental capability, probed honestly;
  CI keeps the enforced gate green via Part A + honest skips.
