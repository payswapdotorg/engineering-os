# ADR-0003 — Data & storage: Prisma, PostgreSQL target, SQLite dev backend, content-addressed artifact store

Status: accepted · Date: 2025 (Phase 0)

## Context

The mandate: "Use PostgreSQL for structured project data … Do not introduce SQLite as the production project database." Phase 1 must also run as a friction-free developer install (single machine, no server prerequisites). Artifacts are large native CAD/BIM files that must be preserved byte-for-byte.

## Decision

1. **Structured data** goes through Prisma with a schema designed for PostgreSQL: standard column types, no SQLite-only features, JSON stored as text columns, all enums as plain strings with validation at the boundary (zod + `src/core`).
   - **Production target: PostgreSQL.** The dev backend is SQLite behind the same schema. `bun run db:push` works for both providers (`.env` switch).
   - SQLite is **never** claimed as the production database; `implementation-status.md` tracks the Postgres migration as unverified until an end-to-end run is demonstrated.
   - PostGIS: deferred until a workflow needs spatial queries (Phase 5 GIS pack); schema decisions then via new ADR.
2. **Artifact bytes** live in a **content-addressed file store** `data/artifacts/<projectId>/<artifactId>/<revisionId>/content` keyed by the revision row (SHA-256, size, MIME). Git is not the revision system for binaries; the DB is the ledger, the FS (later: object store) is the blob home.
3. **Auditing**: `AuditEvent` rows are append-only. No updates, no deletes; the API never exposes mutation of events.

## Consequences

- Phase-1 install = `bun install && prisma db push` (no server); production deployment story exists and is honest.
- Blob migration (FS → S3/object store) later touches only `src/lib/artifact-store.ts`.
- Repo size stays small: `db/` and `data/` are gitignored; the sample engineering fixtures committed under `tests/fixtures/` are deliberately tiny.

## Addendum (2026-10-22, release-truth pass) — the PostgreSQL path, made concrete and CI-validated

The original decision said "db:push works for both providers (.env switch)" — which was an
assumption: the committed schema pinned `provider = "sqlite"`, so switching `DATABASE_URL`
alone did nothing. This addendum closes that gap without forking the schema:

1. **Single source of truth.** `prisma/schema.prisma` (SQLite dev backend) is canonical.
   `scripts/gen-postgres-schema.mjs` derives `prisma/schema.postgres.prisma`
   (`provider = "postgresql"`) byte-deterministically; the generated file is committed and
   CI fails on any drift (`git diff --exit-code` after regeneration). No hand-maintained twin.
2. **Production init/upgrade procedure** (no shadow database needed):
   - init: `bunx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.postgres.prisma --script > init.sql`
   - upgrade: `bunx prisma migrate diff --from-schema-datasource prisma/schema.postgres.prisma --to-schema-datamodel prisma/schema.postgres.prisma --script > upgrade.sql`
   - apply: `bunx prisma db execute --file <sql> --schema prisma/schema.postgres.prisma --url $DATABASE_URL`
   - verify drift-free: a live-vs-model diff must contain no DDL.
   (When committed migrations are later adopted, `prisma migrate deploy` becomes the
   apply step; the diff-execute path works from day one and is what CI exercises.)
3. **Dev scripts are split so the dangerous flag can never be the default.**
   `db:push` = plain `prisma db push` (fails loudly on destructive changes instead of
   wiping); `db:push:force` = the explicit, loudly-labelled dev-only destructive reset;
   `db:migrate:deploy` = the production apply command. `db:push --accept-data-loss` as a
   convenience default is gone.
4. **CI gate.** The `db-portability` job runs on every push: regenerate + drift check →
   `prisma validate` → `migrate diff --from-empty` (assert CREATE TABLE present) →
   `db execute` against a **live postgres:16 service container** → `db push` against it
   (asserts sync) → live-vs-model diff (asserts no DDL).
5. **Honest boundary.** This validates the schema, the SQL and the deployment procedure
   on real PostgreSQL. The product's unit/e2e runtime suites still run on the SQLite dev
   backend; a full product-runtime-on-PostgreSQL certification remains open until a
   deployment drill exercises it, and `implementation-status.md` tracks that honestly.
