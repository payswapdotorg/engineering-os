# Ownership Map — Parallel Work Lanes

Version: 0.1 · Owner: TL · Rule: **the repository is the single source of truth**; chat summaries are not.

| Lane | Owner | Files (exclusive) | Deliverables |
|---|---|---|---|
| **W1 — Product & installation** | Worker 1 | `src/app/**`, `src/components/product/**` (shadcn `src/components/ui/**` is upstream — extend, don't fork) | Product shell, 9 workspaces (implemented vs. honestly-labeled), API routes, Ubuntu install UX |
| **W2 — Engines & integration** | Worker 2 | `src/engines/**`, `docs/02-engines/**`, engine section of `docs/08-licenses/license-inventory.md` | Source-verified engine inventory, capability matrix, detection/probes + tests |
| **W3 — Graph, collaboration, workflows** | Worker 3 | `src/core/**` | Artifact graph logic, impact propagation, staleness, approvals, quantity-ledger domain model + tests |
| **TL — Architecture & integration** | TL | `docs/**` (except W2 lanes), `prisma/**`, `src/lib/**`, `tests/fixtures/**`, `.github/**`, `install.sh`, package/build config | Contracts, schema, shared infra, merges, end-to-end verification, release decisions |

## Shared contracts (TL-owned, change-controlled)

- Prisma schema: `prisma/schema.prisma` (W1 consumes via `@/lib/db`; W3 keeps domain logic DB-free)
- IDs/hashing/audit/artifact-store/API utilities: `src/lib/*`
- Graph & approval model exports: `src/core/index.ts` (W1 consumes; W3 keeps export signatures stable)
- Engine registry shape + detection API: `src/engines/index.ts`, `src/engines/registry.json` (W1 consumes; W2 keeps exports stable)

Change rule: a worker needing a contract change raises it in their handoff; the TL decides and updates the contract first, then workers adapt. Never edit another lane's files.

## Handoff protocol

Each work item ends with: (1) code in its lane, (2) tests/evidence (commands + observed results), (3) a concise handoff appended to `worklog.md` with Task ID, agent name, work log and stage summary. The TL integrates, verifies end-to-end, and owns the merge and the status docs.

## Status vocabulary (use everywhere)

`planned → installed → available → implemented → tested → verified → production-ready`
Never upgrade a state without linked evidence (test file, command output, acceptance item).
