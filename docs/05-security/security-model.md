# Security Model

Version: 0.1 · Owner: TL

## 1. Trust boundaries (see also system-architecture.md §3)

Browser session → product API → (registry/broker) → engine processes → artifacts. Uploaded files and engine processes are untrusted; the broker is the enforcement point.

## 2. Phase-1 scope (honest)

- **Identity**: local single-operator mode. The project creator is recorded as owner (`TeamMember.role='owner'`); members/roles exist in the data model. Real authentication (NextAuth, external collaboration) is Phase 4 — nothing claims multi-user security today.
- **Storage**: artifact files stored under `data/artifacts/` with SHA-256 verification on read; uploads are size-limited and type-declared.
- **Audit**: all mutations (project, member, artifact, revision, link, approval, engine probe, workflow state) emit append-only `AuditEvent` rows.

## 3. Target model (Phases 2–6)

- Project-scoped RBAC (owner/editor/viewer + tool grants); least-privilege tool execution via broker permission checks.
- Authenticated identities; agents carry distinct, non-approving identities (ADR-0006).
- Secrets in environment/secret store, never in DB or git; `.env` gitignored, `.env.example` documents variables.
- Process isolation for engines; untrusted converters sandboxed where practical (containers/apparmor — Phase 6 hardening).
- Controlled artifact publication: approved-baseline protection, supersession audit.
- Isolation of untrusted input files; virus/zip-bomb checks on import where practical.

## 4. Invariants already enforced

- Append-only audit events (no update/delete paths in the API).
- Downloads stream from the content store keyed by revision `storageKey` — no arbitrary path parameters accepted from clients.
- Engine probe commands come only from the reviewed registry, never from client input.
