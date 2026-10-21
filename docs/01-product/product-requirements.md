# Product Requirements

Version: 0.1 · Owner: TL · Source: TL handoff (product vision §1) — this file is our canonical restatement.

## 1. Product statement

One engineering workspace in which engineers across **civil, architectural, structural, mechanical, electrical, electronic, industrial, computer, marine** and related disciplines collaborate with people and agents, operate specialist tools, and automate complete workflows — moving between design, analysis, verification, estimating and delivery without rebuilding project context per application.

It is explicitly **not**: a launcher of unrelated desktop apps; a chat UI beside CAD tools; a document manager linking third-party software; a wall of mocked screens; or a monolithic rewrite of every engine.

## 2. Requirements (from the handoff, verbatim intent)

1. One coherent product UI — one navigation system, one interaction model.
2. Genuine specialist capability from existing open-source engines or explicitly implemented new functionality. No mocked adapters.
3. A common project & artifact graph linking all disciplines.
4. Collaborative editing, version history, review, permissions, auditable change tracking.
5. Agents that execute real engineering tools and multi-step workflows.
6. Human approval gates for sensitive, safety-critical or formally issued changes.
7. Reproducible install/launch on Ubuntu Linux with documented artifacts.
8. Architecture extensible to more disciplines without a platform rewrite.

## 3. Primary workspaces (product information architecture)

1. **Project Home** — projects, dashboards, activity.
2. **Design Studio** — CAD/BIM editing entry points (Phase 2).
3. **Models & Drawings** — artifact registry: revisions, provenance, relations.
4. **Takeoff & Estimating** — quantity ledger, assemblies, BOQ (Phase 3).
5. **Simulation & Verification** — engine runs, results, logs (Phase 4/5).
6. **Project Controls** — schedules, tasks, controls data (Phase 3+).
7. **Documents & Deliverables** — review and issue states (Phase 3+).
8. **Agents & Automations** — workflows, approvals, execution history (Phase 4).
9. **Team & Administration** — members, roles, permissions.

Rules: every visible control works or is clearly marked unavailable with its target phase; no fabricated success; contextual actions reflect real artifact/engine/workflow state.

## 4. Hard acceptance rules (non-negotiable)

- No parity claims (AutoCAD/Archicad/Bluebeam/PlanSwift/universal) without workflow-level acceptance tests.
- DWG fidelity is a separate engineering program with its own compatibility tests.
- Quantities distinguish measurement method and source (drawing-derived vs model-derived); never silently merged.
- Engineer-approved rates/quantities are never silently replaced by agent-generated assumptions.
- LLMs never produce numbers of record (ADR-0006).
