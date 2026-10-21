# System Architecture

Version: 0.1 (Phase 1 baseline) · Owner: TL · Changes via ADR

## 1. What this product is

Engineering OS is a **local-first engineering workspace**: one installable application that hosts projects, artifacts, tool executions and collaboration for engineering disciplines. It is not a launcher, not a chat wrapper over desktop apps, and not a monolithic rewrite of CAD/BIM/solver engines. Existing open-source engines remain the source of native capability and are integrated through registered adapters.

## 2. Logical components

```
┌────────────────────────────────────────────────────────────────────┐
│  Product shell (src/app)                                            │
│  Next.js 16 App Router · 9 workspaces · command/search · status bar  │
└───────────────┬────────────────────────────────────────────────────┘
                │ typed HTTP API (src/app/api, JSON envelopes)
┌───────────────▼────────────────────────────────────────────────────┐
│  Application services                                              │
│  projects · artifacts/revisions · engine probes · audit events     │
├──────────────┬──────────────────────────────┬──────────────────────┤
│ src/core     │ src/lib (TL infra)           │ src/engines          │
│ artifact     │ ids · hashing · artifact      │ registry (verified   │
│ graph ·      │ store (content-addressed) ·   │ upstream inventory)  │
│ impact ·     │ audit · API utilities         │ detection/probes     │
│ staleness ·  │                               │                      │
│ approvals    │                               │                      │
├──────────────┴──────────────┬───────────────┴──────────────────────┤
│ Prisma data layer           │ PostgreSQL (production target)        │
│                             │ SQLite (Phase-1 dev backend)         │
│                             │ + audit events table (append-only)    │
├─────────────────────────────┴───────────────────────────────────────┤
│ Artifact content store: data/artifacts/<project>/<artifact>/<rev>    │
│ (content-addressed by SHA-256, native formats preserved as-is)       │
└──────────────────────────────────────────────────────────────────────┘
                ▲ engine supervision (Phase 2+)
┌───────────────┴────────────────────────────────────────────────────┐
│  Engine supervisor & integration broker (Phase 2+)                 │
│  adapters: FreeCAD · LibreCAD · Bonsai/IfcOpenShell · That Open    │
│  Engine · QGIS · KiCad · solvers … each with typed contracts,      │
│  process isolation, provenance capture and headless execution      │
└───────────────┬────────────────────────────────────────────────────┘
┌───────────────▼────────────────────────────────────────────────────┐
│  Durable workflow & agent runtime (Phase 4)                        │
│  persisted multi-step workflows · typed steps · retries · approval │
│  gates · artifact lineage · LLM agents as orchestrators only       │
└────────────────────────────────────────────────────────────────────┘
```

## 3. Trust boundaries

| Boundary | Inside (trusted product core) | Outside (untrusted) |
|---|---|---|
| UI ⇄ API | Product shell | Browser session (local-first; auth arrives with Phase 4 collaboration) |
| API ⇄ Engines | Broker (adapter registry, contracts, permission checks, audit) | Native engine processes, their plugins, uploaded source files |
| Graph ⇄ Outputs | Artifact graph + staleness marking | Generated artifacts, solver results (never overwrite upstream without approval) |
| Agents ⇄ Tools | Agent runtime may only propose and request broker executions | No agent may call arbitrary local processes (hard rule, ADR-0006) |

## 4. Key invariants

1. **Native data preserved.** Source files are stored byte-for-byte, content-hashed; neutral exchange formats are derivatives, never replacements.
2. **Downstream is never silently overwritten.** A source change marks derived/depending artifacts `stale` with impact evidence (graph path), then recomputation runs as an explicit, reviewable workflow.
3. **Every mutation is audited.** Project, artifact, revision, link, approval, probe and workflow transitions emit append-only audit events.
4. **Deterministic numbers.** Quantities, estimates and simulation results come from deterministic code paths (ledger math, adapters, solvers). LLM output may name or explain a result, but the number of record is the tool's output, checked against the run log.
5. **Approval gates.** Safety-critical or formally issued changes require human review; agents cannot self-approve.

## 5. Phase mapping

| Component | Phase 1 | Phase 2 | Phase 3 | Phase 4 |
|---|---|---|---|---|
| Product shell (9 workspaces) | 4 implemented, 5 honestly-labeled planned | Design Studio, Models & Drawings editing | Takeoff & Estimating, Controls | Agents & Automations |
| Project & artifact graph | entities, revisions, links, impact/staleness | engine-owned artifacts | quantity ledger entities | workflow lineage |
| Storage | content-addressed FS + SQLite dev | + Postgres migration path verified | large-file handling | retention/compare |
| Engine layer | registry + detection (honest absent states) | first real adapters (FreeCAD/IfcOpenShell) | takeoff adapters | broker-supervised agent execution |
| Workflow runtime | schema + states (no execution claims) | — | — | durable execution, retries, approvals |

Component ownership and file lanes: [ownership map](../00-process/ownership-map.md).
