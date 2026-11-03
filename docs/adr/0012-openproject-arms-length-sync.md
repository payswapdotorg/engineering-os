# ADR-0012: OpenProject arm's-length project-graph sync (ADR-0011 Stage 3)

> Re-ship note, recorded honestly: this ADR was first authored on 2026-10-31
> and then destroyed — twice — by platform sandbox resets before it was ever
> pushed (the repository's local tree, including two unpushed implementation
> commits, was wiped; the remote never saw them). It is re-authored from the
> preserved session record (the audit dashboard at `/home/z/my-project`, the
> one artifact that survived the resets) plus FIRST-HAND re-verification of
> the load-bearing upstream semantic (the relation direction) against the
> tagged `opf/openproject` v17.9.2 source during this re-ship.

Status: accepted (2026-10-31, ADR-0011 Stage 3 — the reuse-directive INTEGRATE lane for team-PM scheduling: "cpm.ts stays as the deterministic platform core; full scheduling = INTEGRATE OpenProject (GPL-3.0, arm's-length REST)") · Extends: [ADR-0004](0004-license-and-copyleft-boundary.md) (the license boundary — GPL-3.0 is never embedded), [ADR-0005](0005-engine-integration-contract.md) (the arm's-length principle), [ADR-0011](0011-reuse-audit-stages.md) (Stage 3 of the migration plan) · Supersedes: none

## Context

The audit's decision #10 (both lines agree — ADR-0009 D-numbering on main,
ADR-0011 stage plan on the TL line) froze the CPM core: `cpm.ts` (273 LOC,
the textbook passes) stays the platform's deterministic scheduling core and
must not grow calendars, WBS or team-PM features. Full scheduling is
**INTEGRATE OpenProject** — the 16.8k★ GPL-3.0 project-management
application (v17.9.2) — at arm's length only. ProjectLibre remains the
later MS Project/P6 file-compat lane.

The gap this stage closes: the platform computes schedules
(`eos-schedule/1` → `analyzeCpm` → `eos-cpm/1`) but cannot publish the
project graph where teams actually manage work. No deployed OpenProject
instance exists in this sandbox — the registry row therefore honestly stays
`planned`, and promotion to `tested` is gated on the first deployed-instance
run (the pdf2takeoff Stage-1 precedent requires a real run for `tested`).

License reality (ADR-0004): GPL-3.0 code-level reuse in the Apache-2.0
platform is forbidden. REST v3 over HTTPS to a deployed instance is the only
integration surface. Nothing is embedded, vendored or linked.

## Decision

1. **INTEGRATE at arm's length ONLY.** The op talks REST v3 to a deployed
   instance configured via `EOS_OPENPROJECT_URL` + `EOS_OPENPROJECT_APIKEY`;
   unset env is an honest refusal (`engine_unavailable` — nothing pretended).
   The registry row stays `planned` until the first deployed-instance run.

2. **One-way, platform → OpenProject, v1.** The platform schedule is the
   source of truth for the graph — subjects, inclusive day ranges, edges.
   Nothing is imported back (no status, no progress). The frozen platform
   core computes every date: `cpm.ts` runs the passes, the core projects
   onto the UTC calendar (`start = anchor + es`, `due = anchor + ef − 1`;
   a zero-duration milestone clamps `due` to `start`). OpenProject never
   computes a platform date.

3. **The sync is diff-based against the `eos-openproject-sync/1` mapping
   artifact.** Mapped activities become updates (the mapping's lockVersion
   carried); unmapped ones create; activities removed from the schedule
   become recorded orphans — **NEVER deleted** (deletion is a human act on
   the instance, never automated; an orphaned entry revives if its activity
   reappears). Failed items keep their identity — a failed create retries as
   a create, a failed update keeps its workPackageId and retries as an
   update — so a partially-failed run resumes exactly where it stopped (the
   interrupted-partial fold; the wire is collect-never-throw, results fold
   into the next mapping revision). The mapping document is canonical bytes:
   pinned key orders, no timestamps (creation time lives in the DB revision
   row), byte-deterministic by construction.

4. **ONE wire module** (`src/lib/openproject-wire.ts` — the `llm.ts`
   precedent: one wire, server-side, transports only; every semantic lives
   in the pure core `src/core/openproject-sync.ts`). The wire carries, per
   item: the apikey Basic-auth convention on every request; the lockVersion
   PATCH model with ONE self-heal refresh on 409 (a second conflict fails
   honestly, never a blind overwrite); **recreate-on-404** (a work package
   deleted on the instance is re-created — or adopted — and the fold records
   the new id); **adopt-or-create subject idempotency** (a create first
   searches the target project for an exact-subject work package: exactly
   one match adopts it — the crash window between a create and the mapping
   persist can never duplicate work packages — zero matches POSTs, more
   than one refuses honestly, never guesses); and the
   **follows+precedes duplicate healing** (before creating a relation, the
   successor's existing relations are fetched; an equivalent edge in either
   form is reused, never duplicated).

5. **REST v3 semantics source-verified against the tagged upstream v17.9.2
   tree.** The load-bearing direction was re-verified first-hand during this
   re-ship from `app/models/relation.rb`: `of_predecessor → where(to:)`,
   `of_successor → where(from:)` — a `follows` relation reads
   **from = successor, to = predecessor** (the trap that would have inverted
   the graph); upstream auto-reverses `precedes` into `follows`
   (`before_validation :reverse_if_needed`) — exactly why the healer accepts
   both forms. The apikey Basic-auth convention and the lockVersion PATCH
   model are the documented upstream API contract.

6. **Behind the single execution path.** The twentieth broker op
   `openproject_sync` (`BROKER_OPERATIONS` 19 → 20) runs via
   `runBrokerOperation` — the workflow-step surface with the ADR-0006
   approval red line unchanged (an agent can propose a sync workflow, never
   approve one). The outcome honestly leaves the engine fields absent — an
   external GPL application was reached over REST, no engine subprocess ran
   (the `analyze_schedule` platform-core precedent); exactly one
   `schedule.synced` audit event carries the sync stats; and the honest
   all-failed boundary refuses (when every wire operation failed, nothing is
   persisted and the first error leads the refusal).

7. **Unit-tested at the semantic boundary, promoted only by a real run.**
   50 pins: 24 pure-core (the UTC projection incl. the leap/rollover/milestone
   clamp math, the request/mapping zod gates, the diff rules incl.
   orphan/revive/failed-retry, the fold rules incl. the interrupted-partial
   resume, canonical bytes pinned to the exact serialization) + 26 wire pins
   over an in-process fake v3 server (node:http on an ephemeral port) that
   records every request — exact paths, RAW JSON bodies, the auth header,
   recreate-on-404, the 409 self-heal sequence, both duplicate-healing
   forms, collect-never-throw, the per-request timeout. No live instance
   exists in this sandbox: the registry promotion to `tested` is gated on
   the first deployed-instance run, exactly as recorded.

## v1 limitations (deliberate, recorded)

- One Task type: the create payload pins `_links.type = /api/v3/types/1`
  (the default Task type; instances whose Task type has a different id need
  a v2).
- No calendars: pure UTC day arithmetic — no working time, holidays or
  resource calendars; no `estimatedTime` conversion (durationDays projects
  to startDate/dueDate only).
- No deletions ever; one-way only.
- Milestones clamp dueDate to startDate (never an inverted range).
- Relations are follows-only (the CPM predecessor edge); lag and the other
  upstream relation types are out of scope.
- Subject-based adoption is the v1 idempotency key: two activities with the
  same name can collide — the multi-match refusal surfaces that honestly;
  platform activity ids are not written to OpenProject in v1 (custom fields
  are an instance-level setup, deliberately out of scope).

## Consequences

- The scheduling story closes its biggest reuse gap without growing a
  second scheduler: cpm.ts computes, OpenProject presents, the
  `eos-openproject-sync/1` mapping carries the provenance (diffable,
  resumable, auditable, byte-deterministic).
- The broker vocabulary grows to twenty ops; the p4 vocabulary pin
  (`src/core/workflow.test.ts`) and the e2e 422 verbatim pin
  (`scripts/e2e-p4-workflows.sh`) were updated in the same change.
- The two latent test-hardening fixes shipped alongside (the powerflow
  slack-Q ABSOLUTE 1e-6 Mvar pin — OpenBLAS-kernel-dependent relative
  error on a cancellation quantity — and the harness metatest's per-op
  determinism policy mirrored from the manifest: the pdf2takeoff annotate
  op honestly records determinism null alongside libreoffice).
- Teams already running OpenProject get the platform's schedule published
  where they work; the platform stays the single source of truth for the
  graph.
