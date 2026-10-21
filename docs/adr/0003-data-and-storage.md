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
