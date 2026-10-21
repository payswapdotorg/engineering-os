# ADR-0002 — Repository & module layout: single app, enforced lane ownership

Status: accepted · Date: 2025 (Phase 0)

## Context

A 4-person build (TL + 3 workers) must write code concurrently without integration chaos. Monorepo workspaces add tooling overhead with only one deployable today; complete freedom of file placement creates competing systems.

## Decision

Single Next.js application with **enforced folder ownership** (see `docs/00-process/ownership-map.md`):

- `src/app/**`, `src/components/**` — Worker 1 (product UI, API routes)
- `src/engines/**`, `docs/02-engines/**` — Worker 2 (registry, probes, inventory)
- `src/core/**` — Worker 3 (graph, impact, staleness, approvals, ledger domain logic)
- `src/lib/**`, `prisma/**`, `docs/**` — TL (shared infra, schema, architecture)
- `tests/fixtures/**` — TL (real representative files)

Cross-lane dependencies are allowed only through **published module contracts** (exported types/functions); workers never edit another lane's files. Extraction of `src/core` / `src/engines` into versioned packages is allowed once a second consumer exists (workflow runtime CLI, desktop packaging) — not before.

## Consequences

- No workspace tooling; bun + Next handle the build; CI runs lint/typecheck/tests on the whole tree.
- Integration risk is concentrated at the TL boundary (contract review + end-to-end verification), which matches the TL mandate.
- Domain logic in `src/core` is pure TypeScript (no DB/network/files) so it is unit-testable with `bun test` without fixtures or engines.
