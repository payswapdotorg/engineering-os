# Acceptance Catalogue

Owner: TL · An item passes only with recorded evidence (command + observed result + verifier). UI tests never substitute for engineering validation.

## Journeys (from handoff §5)

| ID | Journey | Status | Evidence |
|---|---|---|---|
| A | Create & manage project (create → graph → workspace) | 🚧 Phase 1 | AC-P1-01, AC-P1-02 |
| B | Edit & publish CAD artifact | planned Phase 2 | requires installed editor engines (dev host has none — honest) |
| C | BIM model → verified BOQ | planned Phase 3 | |
| D | Drawing → takeoff → estimate | planned Phase 3 | |
| E | Requirements → simulation → report | planned Phase 4/5 | |
| F | Agent proposes & executes change | planned Phase 4 | |
| G | Change impact across delivery | **seeded Phase 1** | AC-P1-06 (link + new revision ⇒ downstream marked stale with path evidence) |
| H | Reopen & resume | 🚧 Phase 1 | AC-P1-07 (SQLite durability); full app-restart drill → Phase 6 |

## Phase-1 acceptance items

| ID | Item | Status | Evidence |
|---|---|---|---|
| AC-P1-01 | `bash install.sh` + `bun run dev` starts app on Ubuntu; `/` renders product shell | pending verification | — |
| AC-P1-02 | Create project persists (DB row + audit event); survives server restart | pending | — |
| AC-P1-03 | Register real file artifact: SHA-256 matches `sha256sum`, revision v1 recorded, download round-trip byte-identical | pending | — |
| AC-P1-04 | New revision of same artifact: sequential rev number, prior state preserved; approval state machine enforces transitions | pending | — |
| AC-P1-05 | Engine discovery: registry-driven probes return honest installed/not-installed with version when present (unit-tested with fake executables; live host shows real absence) | pending | — |
| AC-P1-06 | Impact: `derived_from`/`depends_on` downstream marked `stale` on upstream revision, with path evidence; no downstream overwrite | pending | — |
| AC-P1-07 | Audit trail: every action listed in Activity with actor, action, entity | pending | — |
| AC-P1-08 | Planned workspaces (Design Studio, Takeoff, Simulation, Controls, Documents, Agents) render explicit "Planned — Phase N" states; zero dead buttons | pending | — |
| AC-P1-09 | `bun run lint`, `bun run typecheck`, `bun test` all green | pending | — |

Evidence is recorded in [implementation-status.md](../07-release/implementation-status.md) when an item passes.
