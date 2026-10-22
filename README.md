# Engineering OS

**A unified, open-source-first engineering workspace.** One product in which engineers across civil, architectural, structural, mechanical, electrical, electronic, industrial, computer, marine and related disciplines can collaborate with people and agents, operate real open-source engineering engines, and automate complete workflows — without manually reconstructing project context in every tool.

Engineering OS does not rewrite CAD, BIM or solver engines. It integrates existing open-source engines (FreeCAD, LibreCAD, Bonsai/IfcOpenShell, That Open Engine, QGIS, KiCad, ngspice, OpenFOAM, OpenModelica, and more) through a **registered adapter layer**, and connects them with:

- a common **project & artifact graph** (versioned artifacts, typed relationships, change impact),
- a **shared quantity ledger and estimating model** (drawing-derived and model-derived quantities, kept distinct),
- a **Design Studio with a real 3D model viewer** (STEP/IFC tessellated by registered geometry engines into derived mesh artifacts that go stale with their source),
- a **durable workflow and agent runtime** (broker-supervised tool execution, approval gates, audit events),
- one coherent **product UI** with nine engineering workspaces.

## Status — read this first

This project is in **Phase 2 (CAD/BIM workflows) with Phase 3 (takeoff & estimating) hardened** of a six-phase build plan. The single source of truth for what actually works, what is verified, and what is not, is:

- [docs/07-release/implementation-status.md](docs/07-release/implementation-status.md) — capability-by-capability status with evidence
- [docs/06-qa/acceptance-catalogue.md](docs/06-qa/acceptance-catalogue.md) — acceptance items and their current state
- [docs/01-product/release-objectives.md](docs/01-product/release-objectives.md) — phase exit criteria

We do **not** claim AutoCAD, Archicad, Bluebeam, PlanSwift or universal engineering parity until demonstrated by workflow-level acceptance tests. Mocked adapters, fabricated quantities and dead buttons are explicitly rejected by the acceptance policy (see `docs/06-qa/test-strategy.md`).

## Quickstart (Ubuntu 22.04 / 24.04 — developer install)

```bash
# 1) Bun runtime (https://bun.sh)
curl -fsSL https://bun.sh/install | bash

# 2) clone + install + dev database
git clone https://github.com/payswapdotorg/engineering-os.git
cd engineering-os
bash install.sh

# 3) run (dev mode)
bun run dev
# open http://localhost:3000
```

Requirements and troubleshooting: [docs/07-release/installation-ubuntu.md](docs/07-release/installation-ubuntu.md).

## Ubuntu install (.deb)

For a server-style deployment on Ubuntu 22.04/24.04 — systemd service `eos`, desktop entry, daily orphan-sweep timer:

```bash
sudo dpkg -i engineering-os_<version>_amd64.deb   # or: sudo apt-get install ./engineering-os_<version>_amd64.deb
systemctl status eos                              # then open http://localhost:3000
```

- The package comes from the `packaging` CI job (artifact `engineering-os-deb`), or build it from source with `scripts/build-deb.sh` → `dist/engineering-os_<version>_amd64.deb`.
- Requires `nodejs (>= 18)` (dependency of the package, never bundled). Engineering engines (cadquery, IfcOpenShell, …) are optional and **not** bundled — the product detects what is installed.
- First run opens a setup screen that creates the admin account; `NEXTAUTH_SECRET` is auto-generated at install. Data lives in `/var/lib/engineering-os` and is never deleted by package removal.

Requirements, orphan-sweep service-account setup, troubleshooting, upgrade and data-retention notes: [docs/07-release/installation-ubuntu.md](docs/07-release/installation-ubuntu.md).

## Development

Dev mode runs from the repo with `.env` (gitignored; template `.env.example`): `DATABASE_URL` (SQLite dev backend), `EOS_PYTHON` (interpreter hosting the engineering engines), `NEXTAUTH_SECRET` / `NEXTAUTH_URL` (session signing). Signing in is required in dev too — the first-run setup screen creates your local admin account. The e2e scripts (`scripts/e2e-*.sh`) create and use a demo operator credential that is **dev/e2e-only**: `operator@eos.local` / `operator-demo-2026` — never use it outside development.

## Repository map

| Path | Owner | Contents |
|---|---|---|
| `src/app/` | Worker 1 | Product shell, workspaces, API routes (Next.js 16 App Router) |
| `src/components/ui/` | Worker 1 | shadcn/ui primitives (upstream, New York style) |
| `src/components/product/` | Worker 1 | Engineering OS product components |
| `src/core/` | Worker 3 | Artifact graph, impact propagation, staleness, approval & ledger domain logic |
| `src/engines/` | Worker 2 | Engine registry (verified upstream inventory), detection/probes |
| `src/lib/` | TL | Shared infrastructure: ids, hashing, artifact store, audit, API utilities |
| `prisma/` | TL | Database schema (Prisma; SQLite dev / PostgreSQL production target) |
| `docs/` | TL + workers | Architecture, ADRs, engine inventory, schemas, QA, release docs |
| `tests/fixtures/` | TL | Real representative engineering files for tests and verification |
| `.github/workflows/` | TL | CI: lint, typecheck, unit tests |

## Documentation index

- Product: [requirements](docs/01-product/product-requirements.md) · [release objectives & phases](docs/01-product/release-objectives.md)
- Architecture: [system architecture](docs/00-architecture/system-architecture.md) · [ADRs](docs/adr/)
- Data: [artifact graph schema](docs/03-data/artifact-graph-schema.md) · [quantity ledger schema](docs/03-data/quantity-ledger-schema.md)
- Engines: [engine inventory](docs/02-engines/engine-inventory.md) · [capability matrix](docs/02-engines/capability-matrix.md)
- Workflow & agents: [workflow and agent runtime](docs/04-workflow/workflow-and-agent-runtime.md)
- Security: [security model](docs/05-security/security-model.md)
- QA: [acceptance catalogue](docs/06-qa/acceptance-catalogue.md) · [test strategy](docs/06-qa/test-strategy.md)
- Release: [Ubuntu installation](docs/07-release/installation-ubuntu.md) · [implementation status](docs/07-release/implementation-status.md)
- Licenses: [license inventory](docs/08-licenses/license-inventory.md)
- Process: [ownership map](docs/00-process/ownership-map.md)

## Build phases

| Phase | Focus | Status |
|---|---|---|
| 0 | Source-verified audit, architecture, ADRs, capability matrix | ✅ complete |
| 1 | Working product foundation: projects, artifacts, revisions, engine discovery, Ubuntu dev install | ✅ complete (verified — AC-P1-01…09) |
| 2 | CAD/BIM workflows (FreeCAD, LibreCAD, Bonsai/IfcOpenShell, model viewer) | 🚧 in progress — 3D model viewer shipped & verified on REAL tessellation adapters (Design Studio, mesh artifacts, staleness, AC-P2-01…07); native editor adapters (FreeCAD/Bonsai) honestly planned (see engine-inventory investigation) |
| 3 | Takeoff, estimating, construction controls (shared quantity ledger, BOQ, schedules) | 🚧 in progress — quantity ledger + estimating + REAL STEP/IFC quantity adapters shipped & verified (AC-P3-01…08), hardened with the benchmark validation harness, estimate supersede & BOQ CSV/JSON export (AC-P3-09…11); PDF measurement tools & schedules pending |
| 4 | Collaboration & agent workflows (durable runtime, approvals, impact invalidation) | planned |
| 5 | Broader engineering packs (GIS, E/E, structural, CFD, systems, robotics) | planned |
| 6 | Hardening, packaging, release readiness | planned |

## Verification discipline

- The repository — not chat summaries, screenshots or green badges — is the source of truth.
- Every capability claims one of: `planned`, `installed`, `available`, `implemented`, `tested`, `verified`, `production-ready`. Nothing is marked complete merely because a dependency exists.
- Engineering results come from deterministic tools and validated solvers, never from LLM prose (see `docs/04-workflow/workflow-and-agent-runtime.md`).
- LLM agents never silently approve their own safety-critical outputs.

## License

Apache-2.0 (see [LICENSE](LICENSE)). Copyleft dependencies are integrated at arm's length — process boundaries and license review are governed by [ADR-0004](docs/adr/0004-license-and-copyleft-boundary.md) and the [license inventory](docs/08-licenses/license-inventory.md).
