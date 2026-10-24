# ADR-0007: Project-level authorization model (account-linked roster)

Status: accepted (2026-10-22, Slice 10) · Supersedes: none · Extends: ADR-0006 §2 (untouched), Phase-6 contract §1.3 (closes its recorded future-work item)

## Context

Phase 6 shipped global roles (admin | engineer | viewer) and session gates, but project data stayed un-isolated: any signed-in engineer could read and write EVERY project, and the Team roster was a display list (hand-typed names/emails, no account link, role never enforced). The external review's forward queue names project-level read isolation as gap #1; the members "owner" gate matched by email or display name — an identity match too weak to build on.

Two model options existed: (a) a new parallel `ProjectMember` access table beside the display roster, or (b) extend `TeamMember` with a nullable account link so the ONE roster IS the access model.

## Decision

1. **Account-linked roster (option b).** `TeamMember.userId` (nullable) is the real access grant; rows without a link are display/pending roster entries that grant nothing. One model, one Team tab, no fixture breakage, and the roster-vs-access distinction is visible in data (`userId IS NULL`).
2. **404, not 403, for non-members** on every project- and entity-scoped route: a hidden project and a missing project are indistinguishable in the response envelope. Members learn their status through the UI gates; outsiders learn nothing.
3. **Admin is a superuser** (sees and writes all projects). Single-space product reality: the first-run operator IS the admin. Recorded as a deliberate boundary, not an accident.
4. **Creator auto-ownership**: `POST /api/projects` stamps the linked owner grant (`userId`, `addedBy`).
5. **Need levels**: `read` (any member) · `write` (owner/editor; project-viewer → verbatim 403 `your role on this project is read-only`) · `manage` (owner/admin — project settings + team management; verbatim 403). Global roles layer underneath: the wrapper's global-viewer mutation 403 fires before project logic.
6. **Linked grants carry the account identity**: an email-matched grant overwrites the supplied display name with the account's name — a roster row can never spoof a person.
7. **Last-owner guard**: the project's only linked owner row cannot be deleted (409). Legacy unlinked owner rows stay deletable.
8. **Global surfaces filtered by membership**: the projects list and the events feed show non-admins only their member projects' data (system events with `projectId null` stay visible to every signed-in user); `admin/storage/*` becomes admin-only (it was ungated and cross-project).

## Consequences

- Every project-/entity-scoped API route gains a membership check (exhaustive table in `project-isolation-contract.md` §4); the seam lives in `route-helpers.ts` and the decision core is a pure, unit-tested function (`src/core/authz.ts`).
- Existing e2e suites keep working unchanged: all five sign in as the operator (admin ⇒ superuser bypass). The sixth suite pins every new envelope.
- The pre-slice owner gate's legacy email/name match is RETAINED only as a fallback for pre-slice owner rows; linked rows match on `userId` exactly.
- ~~No signup flow exists, so pending invitation rows cannot self-activate; linking happens when an owner re-adds a member whose email now matches an account (recorded in the contract §9).~~ **CLOSED in Slice 14**: `POST /api/auth/signup` (public) self-activates every matching pending invitation at signup (one per project, earliest row — pure planner `src/lib/signup.ts`; `member.activated {via:"signup"}` audit with the new user as actor), and `PATCH /api/projects/[id]/members/[memberId]` changes roles in one call behind the manage gate with a last-owner demote guard (409 verbatim).
- The workflows list GET keeps its system-maintenance side effects (recovery scan + re-enqueue) and is classified `read` — any member may trigger maintenance; non-members never reach it.
