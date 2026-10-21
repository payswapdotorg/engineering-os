# Implementation Status

Updated: Phase 0 → Phase 1 handoff · Verifier: TL · Rule: a state is only as good as its evidence link.

## Capability states

Legend: `planned → installed → available → implemented → tested → verified → production-ready` (ownership-map). Nothing is `production-ready`.

| Capability | State | Evidence / notes |
|---|---|---|
| Public repository + CI (lint/typecheck/test) | implemented | `main` @ <SHA at commit time>; CI workflow `.github/workflows/ci.yml` |
| Product shell: Project Home, Models & Drawings, Engines, Activity, Team, Status | implemented (Phase 1 slice) | browser-verified golden path; see acceptance items |
| Product shell: Design Studio, Takeoff, Simulation, Controls, Documents, Agents | planned (honestly labeled in UI) | target phases 2/3/4/5 |
| Project CRUD + disciplines + members/roles (local model) | implemented | API `/api/projects`; AC-P1-02 |
| Artifact registry: upload → hash → revision v1 → download round-trip | implemented | AC-P1-03 |
| Revisions: sequential numbering, preserve prior, approval machine | implemented | AC-P1-04 |
| Artifact links: 8 typed relations, validation | implemented | `src/core`; unit tests |
| Change impact → stale marking with path evidence (Journey G seed) | implemented | AC-P1-06 |
| Engine registry: source-verified upstream inventory (repo, license, latest stable) | tested (data) | `src/engines/registry.json` + inventory docs; verified via GitHub API at audit date |
| Engine detection: PATH/executable + python-module probes | tested | unit tests with fake executables; live host honestly shows 0 installed |
| Real engine adapters (FreeCAD, IfcOpenShell…) | planned | Phase 2 — dev host has no engines installed; no adapter behavior is claimed |
| Quantity ledger + estimating | planned (schema + domain model only) | Phase 3; docs/03-data |
| Durable workflow runtime + agent execution | planned (schema only) | Phase 4; no execution simulated |
| Auth & multi-user permissions | planned | Phase 4 (NextAuth available in stack) |
| PostgreSQL production backend | planned | ADR-0003; dev is SQLite — no production claim |
| Ubuntu packaging (.deb/desktop entry/service) | planned | Phase 6; dev install works (AC-P1-01) |

## Known limitations (current, honest)

1. Single-operator local mode; no auth.
2. Dev database is SQLite; PostgreSQL migration defined but **not verified end-to-end**.
3. No engine adapters execute yet — engines table shows registry + real detection results only. On this dev host, no engines are installed; "0 installed" is a true state, not a failure.
4. Workflow runtime does not execute (Phase 4); UI shows honest empty state.
5. Quantity/estimating screens are planned placeholders with explicit phase labels — no numbers are shown or computed anywhere in Phase 1.
6. Artifact compare/diff of native CAD formats is not implemented (Phase 2).

## Verification record

(Evidence entries are appended by the TL as acceptance items pass: command → observed result → date.)
