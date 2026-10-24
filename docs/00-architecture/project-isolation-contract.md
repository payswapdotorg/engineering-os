# Project Isolation Contract (Slice 10) — FROZEN before dispatch

Date: 2026-10-22 · Status: **binding** (lanes 10-a…10-e code against this document; changes require a TL-amended contract commit BEFORE lane work continues) · Verifier: TL ·
Scope owner: TL · Related: `phase-6-hardening-contract.md` §1.3 (this slice closes its recorded future-work item), ADR-0006 (agent approval gates — untouched), ADR-0003 (schema strategy — additive change only).

**Red lines carried over:** every check is a real check enforced server-side (the client mirror is cosmetic only); no mock/partial wiring ("the route list below is exhaustive — a route that ships unwired fails acceptance"); every refusal envelope below is verbatim and pinned by the new e2e suite; the agent-self-approval rule (ADR-0006) is untouched.

---

## §0 The gap this slice closes

The signed-in session gate (§1.3 of the Phase-6 contract) is enforced everywhere, but **project data is not isolated between users**: any signed-in engineer can read and write EVERY project (audit limitation #1). This slice makes project membership the boundary for data visibility and writes, while keeping the single-space product honest: the global admin (operator) is a superuser, project owners manage their teams, and the existing Team roster becomes the real access model.

## §1 Data model (additive only — no destructive migration)

`TeamMember` (the Team roster) gains the real access link:

```prisma
model TeamMember {
  id        String   @id
  projectId String
  project   Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
  userId    String?               // NEW — linked User account = real access grant; null = display/pending row (NO access)
  user      User?    @relation("ProjectMembership", fields: [userId], references: [id], onDelete: Cascade)
  name      String
  email     String?
  role      String   @default("editor") // owner | editor | viewer (src/core TEAM_ROLES)
  addedBy   String?               // NEW — session user id of the granter (null for legacy rows / auto owner row)
  addedAt   DateTime @default(now())

  @@unique([projectId, name])     // existing
  @@unique([projectId, userId])   // NEW — one grant per user per project; SQLite & PostgreSQL both allow multiple NULL userIds (display rows coexist)
  @@index([userId])               // NEW — membership lookups
}
```

`User` gains the back-relation: `teamMembers TeamMember[] @relation("ProjectMembership")`.

Rules:
1. A row with `userId != null` is a **grant**: the linked user's project access is that row's `role`.
2. A row with `userId == null` is a **display/pending row**: appears in the roster UI, grants NOTHING.
3. Project creation (`POST /api/projects`) stamps the auto-owner row with `userId = session.id` and `addedBy = session.id` (fallback to today's `Local Operator` naming when session is null — defensive only).
4. Dev DB backfill is done through the REAL members API by the TL during verification (no SQL data patching).
5. `bun run db:push` must be non-destructive (additive columns + indexes only); `bun run db:validate:postgres` regenerates the PostgreSQL variant (CI drift-check picks it up — commit the regenerated file).

## §2 Decision core — `src/core/authz.ts` (pure, no db imports)

```ts
import type { TeamRole } from "@/core"   // "owner" | "editor" | "viewer"
export type ProjectAccessNeed = "read" | "write" | "manage"
export interface ProjectAccessInput {
  sessionRole: "admin" | "engineer" | "viewer" // the signed-in user's global role
  memberRole: TeamRole | null                 // linked TeamMember row role; null = not a member
}
export type ProjectAccessDecision = "allow" | "not_found" | "forbidden"
export function resolveProjectAccess(input: ProjectAccessInput, need: ProjectAccessNeed): ProjectAccessDecision
```

Matrix (exhaustive — unit-test all of it):

| sessionRole | memberRole | read | write | manage |
|---|---|---|---|---|
| admin | any (incl. null) | allow | allow | allow |
| * | null (non-member) | not_found | not_found | not_found |
| engineer/viewer | owner | allow | allow | allow |
| engineer/viewer | editor | allow | allow | forbidden |
| engineer/viewer | viewer | allow | forbidden | forbidden |

Notes:
- Global admin = superuser (sees and writes everything; recorded as the single-space product reality).
- A global engineer who is a project **viewer** is read-only IN THAT PROJECT (the wrapper's global-viewer 403 is unchanged and fires first for global viewers).
- `not_found` (never `forbidden`) for non-members: non-members cannot learn the project exists (404, same envelope as a missing project — GitHub private-repo semantics).

## §3 Server seam — additions to `src/app/api/_lib/route-helpers.ts`

```ts
/** 403 verbatim — project-level read-only (distinct from the GLOBAL viewer envelope). */
export const ERR_PROJECT_VIEWER_READ_ONLY = () =>
  jsonError(403, "forbidden", "your role on this project is read-only")

/** 403 verbatim — project settings/identity management (owner or admin). */
export const ERR_PROJECT_MANAGE_ONLY = () =>
  jsonError(403, "forbidden", "only the project owner or an admin can manage this project")

/** 403 verbatim — platform-level storage administration. */
export const ERR_ADMIN_ONLY = () =>
  jsonError(403, "forbidden", "only an admin can manage platform storage")

export type ProjectAccessOk = {
  ok: true
  session: SessionUser                     // non-null (admin bypass may carry member = null)
  member: { id: string; userId: string; role: TeamRole } | null
}
export type ProjectAccessResult = { ok: true } & ProjectAccessOk | { ok: false; response: NextResponse }

/** Membership check for a DIRECT projectId. Resolution order:
 *  1. session = getSessionUser() → null ⇒ ERR_SIGN_IN_REQUIRED() (defensive; wrapper already gates)
 *  2. member = db.teamMember.findFirst({ where: { projectId, userId: session.id } })
 *  3. decision = resolveProjectAccess({ sessionRole: session.role, memberRole: member?.role ?? null }, need)
 *  4. not_found ⇒ ERR.notFound("Project")  ·  forbidden ⇒
 *     need === "manage" ? ERR_PROJECT_MANAGE_ONLY() : ERR_PROJECT_VIEWER_READ_ONLY()
 */
export async function requireProjectAccess(projectId: string, need: ProjectAccessNeed): Promise<ProjectAccessResult>

/** Entity-scoped variant: `entity` is the LOADED parent row carrying projectId
 *  (or null ⇒ ERR.notFound(entityLabel) — same envelope as the missing-entity path,
 *  so a hidden project and a missing entity are indistinguishable).
 *  Delegates to requireProjectAccess(entity.projectId, need).
 */
export async function requireEntityProject(
  entity: { projectId: string } | null,
  entityLabel: string,
  need: ProjectAccessNeed,
): Promise<ProjectAccessResult>
```

Import `ProjectAccessNeed` from `@/core/authz`. The seam is the ONLY place membership is resolved (routes never query TeamMember for access themselves — the members manage-gate in §5 is the documented exception, it keeps its pinned envelope).

## §4 Route wiring table (EXHAUSTIVE — every row ships or acceptance fails)

Need legend: **read** = any member; **write** = owner/editor (project-viewer → `ERR_PROJECT_VIEWER_READ_ONLY`); **manage** = owner/admin (→ `ERR_PROJECT_MANAGE_ONLY`); non-member on ANY need → 404 (same envelope as the route's existing missing-entity 404).

### Group A — direct projectId routes (`src/app/api/projects/...`)

| Route | Method | Need | Wiring |
|---|---|---|---|
| `/api/projects` | GET | list filter | admin ⇒ all; else ONLY projects with a linked TeamMember row (`userId = session.id`) — same shape/fields as today, counts computed over the same filtered set |
| `/api/projects` | POST | unchanged | auto-owner row now also stamps `userId` + `addedBy` (§1.3) |
| `/api/projects/[id]` | GET | read | insert after the project-exists 404 |
| `/api/projects/[id]` | PATCH | **manage** | insert after the project-exists 404 (tightens "any engineer can rename any project") |
| `/api/projects/[id]/members` | GET | read | insert after project-exists 404 |
| `/api/projects/[id]/members` | POST | §5 manage gate | isolation `read` first (non-member 404), then the EXISTING manage gate (admin OR owner row) with its pinned `ERR_MEMBER_MANAGEMENT` — see §5 |
| `/api/projects/[id]/members/[memberId]` | DELETE | §5 manage gate | new route — see §5 |
| `/api/projects/[id]/artifacts` | GET / POST | read / write | insert after project-exists 404 |
| `/api/projects/[id]/schedules` | POST | write | insert after project-exists 404 |
| `/api/projects/[id]/assemblies` | GET / POST | read / write | insert after project-exists 404 |
| `/api/projects/[id]/estimates` | GET / POST | read / write | insert after project-exists 404 |
| `/api/projects/[id]/quantities` | GET / POST | read / write | insert after project-exists 404 |
| `/api/projects/[id]/rates` | GET / POST | read / write | insert after project-exists 404 |
| `/api/projects/[id]/workflows` | GET / POST | read / write | GET is the documented mutating side-effect route (recovery + re-enqueue): any member READ may trigger the system maintenance — freeze this decision |
| `/api/projects/[id]/artifacts/[artifactId]/fe-mesh` | POST | write | after the artifact-pair pre-check |
| `…/derive-mesh` | POST | write | after the artifact-pair pre-check |
| `…/derive-quantities` | POST | write | after the artifact-pair pre-check |
| `…/analyze-schedule` | POST | write | after the artifact-pair pre-check |
| `…/simulate` | POST | write | after the artifact-pair pre-check |
| `…/powerflow` | POST | write | after the artifact-pair pre-check |
| `…/convert-document` | POST | write | after the artifact-pair pre-check |

### Group B — entity-scoped routes (resolve parent row, then `requireEntityProject(row, "<Label>", need)`)

| Route | Method | Need | Label |
|---|---|---|---|
| `/api/artifacts/[id]` | GET | read | "Artifact" |
| `/api/artifacts/[id]/mesh` | GET | read | "Artifact" |
| `/api/artifacts/[id]/approve` | POST | write | "Artifact" |
| `/api/artifacts/[id]/links` | POST | write | "Artifact" (check on the SOURCE artifact; the existing cross-project 400 stays) |
| `/api/artifacts/[id]/revisions` | POST | write | "Artifact" |
| `/api/revisions/[id]/download` | GET | read | "Revision" |
| `/api/estimates/[id]` | GET | read | "Estimate" |
| `/api/estimates/[id]/export` | GET | read | "Estimate" |
| `/api/estimates/[id]/transition` | POST | write | "Estimate" |
| `/api/estimates/[id]/recompute` | POST | write | "Estimate" |
| `/api/estimates/[id]/lines` | POST | write | "Estimate" |
| `/api/estimates/[id]/lines/[lineId]` | DELETE | write | "Estimate" |
| `/api/quantities/[id]/transition` | POST | write | "Quantity" |
| `/api/workflows/[id]` | GET | read | "Workflow" |
| `/api/workflows/[id]/transition` | POST | write | "Workflow" (the ADR-0006 human-approval gate stays; a member owner/editor human may approve, non-members 404 BEFORE any state logic) |

### Group C — global routes touching project data

| Route | Change |
|---|---|
| `GET /api/events` (no `projectId`) | admin ⇒ all; non-admin ⇒ `projectId ∈ memberProjectIds` **OR `projectId = null`** (system events — engine probes, setup, demo provisioning — stay visible to every signed-in user; freeze) |
| `GET /api/events?projectId=X` | insert `requireProjectAccess(X, "read")` → non-member 404 `Project not found` |
| `POST /api/admin/storage/scan` | add in-handler gate: `session.role !== "admin"` ⇒ `ERR_ADMIN_ONLY()` (closes "any engineer can scan cross-project storage") |
| `DELETE /api/admin/storage/orphans` | same `ERR_ADMIN_ONLY` gate (closes the cross-project DESTRUCTIVE gap) |
| `GET /api/engines`, `POST /api/engines/probe` | unchanged (platform registry, not project data) |
| `GET /api/status` | unchanged (public health check) |
| `/api/auth/*` | unchanged |

## §5 Members API (access management)

`POST /api/projects/[id]/members` — schema becomes:

```ts
const memberSchema = z.object({
  name: z.string().trim().min(1).max(80),
  role: stringEnum(TEAM_ROLES, "role").default("editor"),
  email: z.string().trim().toLowerCase().email("email must be a valid address").max(200).optional(),
})
```

Flow (after project-exists 404):
1. **Isolation:** `requireProjectAccess(id, "read")` → non-member 404.
2. **Manage gate (EXISTING, pinned envelope unchanged):** admin bypass OR owner row (`userId = session.id` first; legacy fallback `email === session.email OR name === session.name` retained for pre-slice rows — documented) ⇒ else `ERR_MEMBER_MANAGEMENT()` 403 verbatim `only the project owner or an admin can manage team members`.
3. If `email` present: look up `db.user.findUnique({ where: { email } })`.
   - Account exists ⇒ row is a GRANT: `userId = account.id`, **`name = account.name`** (the account identity wins — a roster row can never spoof a display name over a real user), `email = account.email`. If a grant for that user already exists ⇒ `ERR.conflict(\`"${account.name}" already has access to this project\`)` 409 verbatim.
   - No account ⇒ row is a PENDING invitation: `userId = null`, name/email as supplied. Honest semantics: **a pending row grants nothing**; ~~the general signup flow is out of scope (§9) — the row stays display-only until an account with that email exists AND an owner re-adds/links it~~ **CLOSED in Slice 14**: `POST /api/auth/signup` activates every matching pending row AT SIGNUP (one per project, earliest by addedAt — the pure planner in `src/lib/signup.ts`), linking `userId` without any owner action; the audit records `member.activated {via:"signup"}` with the self-activating user as actor.
   - No `email` ⇒ today's display-only row (unchanged behavior).
4. Duplicate-name conflict (existing 409 verbatim) stays first-in-line among roster checks.
5. `addedBy = session.id` on every new row. Audit `member.added` gains `detail: { name, role, email?, linked: boolean, userId? }`.

`DELETE /api/projects/[id]/members/[memberId]` — NEW route (in `members/[memberId]/route.ts`):
1. Project exists 404 → isolation read (404) → manage gate (step 1–2 above, same `ERR_MEMBER_MANAGEMENT`).
2. Row exists AND belongs to this project ⇒ else 404 `Member not found`.
3. **Last-owner guard:** deleting the project's only `role: "owner"` row with `userId != null` ⇒ `ERR.conflict("cannot remove the only owner of the project")` 409 verbatim. (Deleting display/pending rows and non-owner rows is always allowed; if the only owner row is a legacy UNLINKED row, allow deletion — a linked admin can always re-grant, and legacy rows predate grants.)
4. Success ⇒ 200 `{ removed: memberId }`, row deleted, audit `member.removed` with `detail: { name, role, email?, hadAccess: boolean }`.

## §6 Client mirror (cosmetic only — server is authoritative)

- `api.ts`: `Member` type += `userId: string | null`, `addedBy?: string | null`; `addMember(projectId, {name, role, email?})`; `removeMember(projectId, memberId)`.
- Team tab (project-workspace.tsx `team` section): new **Access** column — linked rows: badge `access · {role}`; unlinked: muted `pending roster row`; per-row Delete (confirm dialog) gated by the EXISTING `isTeamManager` client gate (extend its owner match: `m.userId === session.id` first, email/name fallback retained).
- `AddMemberDialog` (project-dialogs.tsx): optional email input with helper copy: leave empty for a display-only roster row; an email that matches an account grants real access at the chosen role.
- Edit-project (`EditProjectDialog` opener): new `isProjectManager` gate (admin or owner row) — non-owner engineers see the Edit button disabled with the verbatim `ERR_PROJECT_MANAGE_ONLY` text (`only the project owner or an admin can manage this project`) via the GuardedButton reason pattern; viewers keep today's disablement.
- Project workspace non-member direct URL: `GET /api/projects/[id]` now 404s ⇒ the EXISTING `ErrorState` (workspace.error) renders — verify, do not redesign.
- Project Home empty state: when the filtered list is empty AND `session.role === "viewer"`, copy: `No projects you can access yet — ask a project owner to add you to their team.`; engineers keep today's copy.
- No other UI changes: the server-filtered list needs no client filter; existing tabs render only for reachable projects.

## §7 Tests

Unit (`src/core/authz.test.ts`, new file — grows the suite; pattern: every core module has one):
- Full §2 matrix (admin×needs, member roles×needs, non-member×needs), plus the two documented layerings (global viewer member-editor can read; global engineer member-viewer read-only in-project).

E2E (`scripts/e2e-p6-isolation.sh` — the SIXTH suite; sources `scripts/e2e-signin.sh`):
- Operator (admin) signs in via the helper; provisions demo accounts via the real `POST /api/auth/demo-accounts` (idempotent); signs in Kwame (engineer) and Zara (viewer) with a local second-jar helper modeled on the signin helper (csrf → credentials callback), password `demo1234`.
- Fixtures through the REAL API only: Alpha (operator-owned; grants: Kwame editor + Zara viewer via linked email), Beta (Kwame-created ⇒ Kwame owner), Gamma (operator-owned; grant Kwame **viewer** → the project-viewer envelope case).
- `AC-I1` grants: linked POST returns the row with `userId` == the demo user's id; duplicate grant 409 verbatim; pending (unknown email) row `userId` null.
- `AC-I2` list isolation: Kwame sees Alpha+Beta+Gamma exactly; Zara sees Alpha exactly; operator sees ⊇ all (superuser pinned).
- `AC-I3` read isolation: Zara GET Beta project/artifacts/quantities ⇒ 404 verbatim envelopes; Kwame GET Beta ⇒ 200; Zara `GET /api/revisions/<Beta revision>/download` ⇒ 404 `Revision not found`.
- `AC-I4` events: Zara global feed ⇒ every event's projectId ∈ {Alpha, null}; Zara `?projectId=Beta` ⇒ 404; Kwame `?projectId=Alpha` ⇒ 200.
- `AC-I5` project-viewer write: Kwame POST Gamma artifact ⇒ 403 verbatim `your role on this project is read-only`; Kwame GET Gamma ⇒ 200.
- `AC-I6` manage gates: Kwame PATCH Gamma ⇒ 403 verbatim `only the project owner or an admin can manage this project`; Kwame POST Gamma members ⇒ 403 verbatim `only the project owner or an admin can manage team members`; operator DELETE Beta's only owner row ⇒ 409 verbatim `cannot remove the only owner of the project`; operator DELETE Zara's Alpha row ⇒ 200, then Zara GET Alpha ⇒ 404 (revoke works end-to-end).
- `AC-I7` admin storage: Kwame POST scan ⇒ 403 verbatim `only an admin can manage platform storage`; Kwame DELETE orphans ⇒ same.
- `AC-I8` workflows: Kwame creates+queues a workflow on Beta (201/200); Zara GETs it ⇒ 404 `Workflow not found`; Zara's transition POST ⇒ the wrapper's uniform GLOBAL-viewer 403 (documented layering — identical for hidden/missing targets, no leak); the TRUE non-member write-404 is pinned with a non-member ENGINEER (operator revokes Kwame's Alpha grant; Kwame transitions an Alpha workflow ⇒ 404 before any state logic; Kwame GET Alpha ⇒ 404).
  *(TL amendment 2026-10-22, ratified at the first live run: the original second AC-I8 assertion expected the non-member 404 from Zara — a GLOBAL VIEWER — which contradicts this contract's own §2 layering note (the wrapper 403 fires first, by design). The suite now pins BOTH the documented layering AND the stronger engineer-based 404 proof. Suite total 49 PASS.)*
- `AC-I9` audit: `member.added` (with `linked:true` + `userId`) and `member.removed` (with `hadAccess`) present on the projects' feeds.
- `AC-I10` regression inside the suite: operator reaches every fixture route (admin bypass) — pins the superuser rule against future drift.
- Cleanup: `scripts/dev-db-cleanup.ts --project …` for Alpha/Beta/Gamma (established path; no projects DELETE API exists).
- CI: `.github/workflows/ci.yml` e2e job gains the sixth step `e2e-p6-isolation` (run LAST, after e2e-p5 — it creates and removes its own fixtures); expected-PASS counts updated in step names; the five existing suites are UNTOUCHED (operator/admin keeps them green).

## §8 Acceptance (this slice is done when ALL hold)

1. `bun run lint` 0 errors · `bun run typecheck` clean · `bun test src/` all green (suite grows by authz tests).
2. All SIX e2e suites green against the live dev server (five existing = regression proof that admin bypass kept them alive; the new suite pins every envelope).
3. Browser-verified (agent-browser): Zara sees only Alpha in Project Home; Beta deep-link ⇒ honest ErrorState; Team tab grant+revoke live (linked/pending badges, last-owner refusal surfaced); Kwame on Gamma sees read-only UI; operator sees everything; mobile 390px / dark mode / footer standards hold; zero console errors.
4. Dev DB end state: demo project carries real grants (operator owner-linked, Kwame editor, Zara viewer) made through the REAL API.
5. Docs reconciled to one truth at the slice commit (implementation-status 10th pass, acceptance-catalogue, release-objectives, phase-6 contract cross-ref, README CI map with six suites, ADR-0007).
6. Pushed; CI all-green at the pushed SHA (the six-suite e2e job included).

## §9 Out of scope (recorded honestly)

- ~~General account signup (no signup flow exists; first-run setup + demo provisioning only) ⇒ pending rows cannot self-activate.~~ **CLOSED in Slice 14 / fourteenth pass**: `POST /api/auth/signup` (public) creates engineer accounts AND activates every matching pending invitation in the same call (AC-SU-01…03; honest bounds recorded as implementation-status limitation #19 — open signup, no email verification).
- ~~Member role PATCH (re-grant at a new role is the path; recorded).~~ **CLOSED in Slice 14 / fourteenth pass**: `PATCH /api/projects/[id]/members/[memberId]` behind the full manage gate with a last-owner demote guard (AC-RP-01…02).
- Per-field / per-artifact ACLs; cross-project link grants beyond the existing 400 refusal.
- LLM planning layer (forward-queue item #2 — next contract; SHIPPED as Slice 11 / ADR-0008), native editors, pg runtime drill (SHIPPED as Slice 12), persistent sheet markups (SHIPPED as Slice 13).
