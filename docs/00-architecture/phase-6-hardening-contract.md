# Phase-6 Hardening Slice — Binding Contract (frozen 2026-10-22, TL)

Seventh integration pass, lanes **W1-g / W2-g / W3-g**. This document is the
frozen contract: lanes work in parallel against the shapes defined here. Any
deviation must be recorded in your worklog entry with a reason. The red lines
are the project's standing rules: no mocks masquerading as real integrations,
no fake data, no silent drops, no dead buttons, honest limitations recorded.

Scope (from the plan of record — `docs/01-product/release-objectives.md`
Phase 6 + `docs/07-release/implementation-status.md` rows 41–43):

1. **Auth & multi-user permissions** (the last planned product capability;
   known-limitation #1) — NextAuth v4 credentials + JWT sessions, global roles,
   session gates on the API, human-actor attribution on audit + approvals.
2. **Ubuntu packaging** — real `.deb` via `dpkg-deb` (available in this
   sandbox), desktop entry, systemd service, orphan-sweep timer, release docs.
3. **Small honest fixes** — future-dated rate warning (known-limitation #9),
   Studio/Takeoff → Artifacts cache-nudge (known-limitation #13).

Out of scope (recorded, not silently skipped): PostgreSQL production backend
(no postgres binaries in this sandbox, no root — stays planned with an honest
note); ~~project-level read isolation between users~~ **CLOSED in Slice 10**
(2026-10-22: account-linked TeamMember grants, 404-no-leak reads/writes,
project-viewer read-only, admin superuser — frozen in
`project-isolation-contract.md` + ADR-0007, pinned by `e2e-p6-isolation.sh`);
template authoring (Phase-5b), native
editor adapters (Phase-2b, sandbox-blocked).

## 1. Auth & permissions (W3-g backend · W1-g frontend)

### 1.1 Data model (W3-g owns `prisma/schema.prisma`)

```prisma
model User {
  id           String   @id @default(cuid())
  email        String   @unique
  name         String
  passwordHash String
  role         String   @default("engineer") // "admin" | "engineer" | "viewer"
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
}
```

Additive `userName String?` column on `AuditEvent` (schema push; agent/system
events keep it null). No other schema changes. `bun run db:generate` +
`bun run db:push` must be run and committed schema-first.

### 1.2 Password + auth core (W3-g owns `src/lib/password.ts`, `src/lib/auth.ts`)

- `hashPassword(pw): string` — node:crypto **scrypt**, N=16384, r=8, p=1,
  keylen=64, 16-byte random salt. Wire format:
  `scrypt:16384:8:1:<saltB64>:<hashB64>` (B64 = standard base64).
- `verifyPassword(pw, stored): boolean` — parse + `timingSafeEqual`.
  Malformed stored value → `false` (never throw).
- `authOptions: NextAuthOptions` in `src/lib/auth.ts` — Credentials provider
  (email+password, authorize → `{id, name, email, role}` or `null`),
  `session: { strategy: "jwt" }`, jwt+session callbacks carry
  `user.id` / `user.role`; `pages: { signIn: "/signin" }`.
- `getSessionUser(): Promise<SessionUser | null>` where
  `interface SessionUser { id: string; name: string; email: string; role: "admin" | "engineer" | "viewer" }`
  (wraps `getServerSession(authOptions)`).
- Route file `src/app/api/auth/[...nextauth]/route.ts`:
  `const h = NextAuth(authOptions); export { h as GET, h as POST }` (v4
  app-router pattern; next-auth@4.24.13 is already installed — no new deps).
- `NEXTAUTH_SECRET` + `NEXTAUTH_URL=http://localhost:3000` in the
  gitignored `.env`; also added to the `.env`/setup templates where they exist
  (`install.sh`, packaging EnvironmentFile — coordinate via §3).
- First-run bootstrap: `POST /api/auth/setup` `{name, email, password}` →
  201 `{user}` — allowed ONLY while `db.user.count() === 0`; afterwards 422
  verbatim `operator account already exists (setup is first-run only)`.
  Password minimum 8 chars (422 verbatim). This route is PUBLIC (pre-auth by
  definition). `GET /api/auth/setup` → `{needed: boolean}` (public).

### 1.3 API gates (W3-g owns `src/app/api/_lib/route-helpers.ts`, all routes)

- `handler(fn)` gains an optional second argument:
  `handler(fn, { auth: "public" })`. Default (no opts) = **auth required**.
  Unauthenticated → 401 envelope `{"error":{"code":"unauthorized","message":"sign in required"}}`.
- Public routes (the ONLY ones): `/api/auth/*` (NextAuth's own route is not
  wrapped anyway), `/api/auth/setup` (GET+POST), `/api/status` (health for
  watchdogs/CI).
- Role gates on mutating verbs (POST/PUT/PATCH/DELETE):
  - `role === "viewer"` → 403 `{"error":{"code":"forbidden","message":"viewer role is read-only"}}` verbatim, for ALL mutating routes.
  - Team-member mutations (`/api/projects/[id]/members` POST/DELETE) additionally
    require the caller to be the project owner (per TeamMember.role) or `admin`
    → else 403 `{"error":{"code":"forbidden","message":"only the project owner or an admin can manage team members"}}`.
  - Existing domain gates (approval machines, engineer-only rates) keep their
    current 422 semantics — session gates run BEFORE them (401/403 outrank 422).
- GET routes: session required (401), no role check (see out-of-scope note on
  data visibility).
- Workflow approve/reject: keep accepting NO actor parameter (ADR-0006
  red line unchanged) but stamp the audit event + step record with the
  session user (`actorType:"user"`, `actorId:user.id`, `userName:user.name`).

### 1.4 Audit attribution (W3-g owns `src/lib/audit.ts`)

`recordEvent` stays backward-compatible and gains session awareness:
- If `input.actorType` is explicitly provided (system/agent events) → unchanged.
- Otherwise: resolve `getSessionUser()`; if present → `actorType:"user"`,
  `actorId:user.id`, `userName:user.name`; if no session (background/system
  context) → current defaults (`"user"` + `"local-operator"`) so existing
  tests/semantics stay intact.

### 1.5 e2e sign-in helper (W3-g owns `scripts/e2e-signin.sh`, all 5 scripts)

- `scripts/e2e-signin.sh` (sourced by every script): calls
  `GET $BASE/api/auth/setup`; when `{needed:true}` POSTs setup with the
  documented demo operator (`operator@eos.local` / `operator-demo-2026`,
  name `Local Operator`); then signs in via the real NextAuth flow
  (`GET /api/auth/csrf` → `POST /api/auth/callback/credentials` with
  csrfToken/email/password, cookie jar) and exports `EOS_AUTH="-b $JAR -c $JAR"`
  for curl. Signing in when already signed in is idempotent (fresh jar).
- ALL five scripts (`e2e-takeoff`, `e2e-p3-hardening`, `e2e-p2-modelviewer`,
  `e2e-p4-workflows`, `e2e-p5-disciplines`) get the one-line source + use
  `$EOS_AUTH` on every curl (their PASS-count semantics unchanged — update
  in-place, do not fork new scripts).
- `scripts/dev-db-cleanup.ts` must NOT delete users (accounts persist; projects
  and their storage go as today). Demo rebuild = the signed-in takeoff run.

### 1.6 Frontend (W1-g owns `src/components/product/*`, `src/app/page.tsx` shell wiring)

- `SessionProvider` (next-auth/react) mounted once around the shell; a
  `useSessionUser()` hook exposing `SessionUser | null | "loading"`.
- Unauthenticated → full-screen auth surface replaces the shell:
  - zero users (poll `GET /api/auth/setup`) → **setup form** (name/email/
    password, client validation mirroring the 422s, verbatim server errors);
  - otherwise → **sign-in form** (`signIn("credentials", …)` + router refresh
    on success; verbatim error on bad credentials: `CredentialsSignin` →
    friendly copy "wrong email or password").
- Header **user menu**: name + role badge, sign-out (signOut + refresh).
- Role-aware UI: `canMutate = role !== "viewer"` — mutating buttons across all
  workspaces disabled with a tooltip "viewer role is read-only" (never hidden
  dead weight — visible-but-disabled is the honest form); team-member
  management UI disabled unless owner/admin.
- Event feed: actor rendering uses `userName` when present (agent/system
  unchanged), e.g. "Local Operator" instead of "local-operator".
- Future-dated rate warning (with §2 backend): amber chip on affected
  estimate lines + a note in the estimate detail
  (`rate effectiveFrom is in the future — price is provisional`), driven by the
  additive per-line field.
- Cache-nudge (known-limitation #13): Studio + Takeoff derive/regenerate
  actions refresh the project-level caches exactly like
  `AgentsWorkspace.onMutated` does (Artifacts tab updates without reload) —
  mirror the established pattern, no new cache machinery.

### 1.7 Rate warning backend (W3-g owns `src/app/api/_lib/estimate-pricing.ts`)

When a line's resolved rate row has `effectiveFrom > now` (the existing
fallback branch), the line breakdown gains `futureDatedRate: true` (additive —
existing e2e assertions on breakdown contents must be re-checked and stay
green). No 422s added; pricing math unchanged.

### 1.8 Demo accounts (post-Phase-6 addition — slice added 2026-10-22, TL)

Provisionable demo personas with one-click quick sign-in on the auth surface.
Amends §1.1 (additive schema), §1.2 (recorded extension), §1.3 (two public
routes + one pinned 403), §1.4 (system actor), §1.6 (auth-surface panel +
admin menu item):

- `src/lib/demo-accounts.ts` — single source of truth: fixed roster
  (admin "Ama Boateng" / engineer "Kwame Mensah" / viewer "Zara Ahmed",
  `*.demo@eos.local`) + the PUBLIC shared password `demo1234`. Server
  (provisioning route) and client (quick-login panel) import the same
  constants — they cannot drift.
- Schema (§1.1 amendment, additive): `User.isDemo Boolean @default(false)` +
  `User.title String?`.
- `/api/auth/demo-accounts`: GET (public) lists; POST (public) idempotently
  ensures the FIXED roster — accepts no client-supplied fields, so
  provisioning can never mint a privileged non-demo account. DELETE is
  session-gated: viewer → the pinned read-only 403; engineer → 403 `only an
  admin can remove demo accounts`; admin removes ONLY `isDemo=true` rows and
  NEVER the signed-in caller.
- §1.2 extension (recorded deviation from the frozen wording): setup GET+POST
  count NON-DEMO users only — provisioning demo personas never consumes the
  first-run operator bootstrap. The pinned 422 message is unchanged.
- Audit: provision → one `user.demo.provisioned` event, system actor
  (`system:demo-provisioner`, userName null per §1.4); removal → one
  `user.demo.removed` event, session-attributed to the admin human.
- Frontend (§1.6 extension): "Demo accounts" panel on the auth surface in
  every unauthenticated mode — provision button (empty roster) or quick-login
  cards (role badge, title, email; accessible label `Quick sign in as <name>
  (<role>)`). Quick sign-in runs the REAL credentials flow
  (`signIn("credentials", …)` + router refresh — no shortcut session). The
  header user menu gains an admin-only "Remove demo accounts" item.
- Verification standard: live curl contract checks (roster, idempotency,
  §1.2 non-consumption, 401/403/200 layering, self-removal guard, audit
  attribution) + agent-browser journeys per role (viewer disabled states,
  engineer enabled states, admin removal + verbatim toasts, re-provision
  restore) + the five e2e scripts stay green in one session with the §1.2
  extension live (takeoff: 27 PASS). No new unit tests in this slice (session
  constraint, recorded honestly); the shared-constant seam keeps the roster
  single-sourced.

## 2. Packaging (W2-g owns `scripts/build-deb.sh`, `packaging/**`, release docs)

- `scripts/build-deb.sh` → `dist/engineering-os_<version>_amd64.deb` via
  `dpkg-deb --build` on this host (dpkg-deb 1.22.22 available; version read
  from `package.json`):
  - Payload `/opt/engineering-os/`: `bun run build` standalone output
    (`.next/standalone` + `.next/static` + `public/` per the existing build
    script), `prisma/schema.prisma`, `src/engines/adapters/*.py`,
    `scripts/setup-engine-libs.sh`, a **seed SQLite DB** produced by a clean
    `db push` at build time, `eos.env.example`, service/sweep scripts.
  - `/lib/systemd/system/eos.service`: `ExecStart=/usr/bin/node
    /opt/engineering-os/server.js`, `EnvironmentFile=/etc/eos/eos.env`,
    `User=eos`, `After=network.target`; `ExecStartPre` sanity check (node
    present, data dir writable) — no DB mutation at start (seed DB is copied
    to `/var/lib/engineering-os` by postinst on FIRST install only).
  - `/lib/systemd/system/eos-orphan-sweep.{service,timer}`: daily; calls a
    bundled script that runs the real scan + confirm-gated cleanup against
    the local HTTP API (never a blind filesystem sweep — reuses the Phase-4
    admin routes' semantics; closes known-limitation #8's remaining half).
  - `/usr/share/applications/eos.desktop` + icon
    (`/usr/share/icons/hicolor/scalable/apps/eos.svg` from `public/logo.svg`);
    Exec opens `http://localhost:3000`.
  - `postinst`: create system user `eos` if missing; `/var/lib/engineering-os`
    owned by it; copy seed DB only if absent; generate `/etc/eos/eos.env`
    (DATABASE_URL, NEXTAUTH_SECRET, NEXTAUTH_URL, EOS_PYTHON) only if absent;
    `systemctl daemon-reload` + try `enable --now` (guarded for non-systemd).
  - `prerm`/`postrm`: stop/disable service; `/var/lib` data NEVER deleted on
    remove (purge note documented).
- Structural verification IN THIS SANDBOX (no root — honest limit): run
  `dpkg-deb --info`, `dpkg-deb --contents`, `dpkg-deb --ctrl-tarfile`-based
  maintscript syntax checks (`bash -n`), control-field lint (Depends on
  `nodejs (>= 18)`), record output in the worklog + release doc. A CI job
  (ubuntu-latest, which has sudo) additionally runs `sudo dpkg -i` +
  file-presence smoke + `sudo dpkg -r` — write the workflow now; its first
  real run happens on the next push (record that honestly).
- Docs: rewrite `docs/07-release/installation-ubuntu.md` to match (system
  requirements, install steps, the sweep timer, troubleshooting, upgrade +
  data-retention notes); README gets a short "Ubuntu install" section + the
  demo-operator credential note is DEV-ONLY (documented under dev setup).

## 3. Shared-seam ownership (no overlaps)

| Seam | Owner |
|---|---|
| `prisma/schema.prisma`, `src/lib/auth.ts`, `src/lib/password.ts`, `src/lib/audit.ts`, `src/app/api/**`, `scripts/e2e-*.sh`, `scripts/dev-db-cleanup.ts` | W3-g |
| `src/components/product/**`, `src/app/page.tsx`, `src/app/layout.tsx` (SessionProvider mount only) | W1-g |
| `scripts/build-deb.sh`, `packaging/**`, `.github/workflows/*` (additive job), `docs/07-release/**`, README (release + dev-auth sections only) | W2-g |

- `package.json`: NO new dependencies are allowed in any lane (auth stack is
  complete; packaging uses dpkg-deb). If a lane believes it needs one, it
  stops and records the need instead.
- `.env`: W3-g appends NEXTAUTH_* keys (gitignored); W2-g references them in
  `eos.env.example`. Neither edits the other's lines.

## 4. Verification standard (every lane, before handing back)

- `bun run lint` 0 errors · `bun run typecheck` clean · your new unit tests
  green via `bun test <files>`.
- Live-server checks run in YOUR OWN session: start it at the top
  (`setsid bash -c 'exec bun run dev > /home/z/my-project/dev.log 2>&1 < /dev/null' &`,
  wait ~12s, curl `:3000/api/status`) — the sandbox reaps background
  processes ~1–2 min after a session ends, so keep everything in-session.
- W3-g: after your lane, all five e2e scripts must pass IN ONE SESSION
  (server + scripts together) — same PASS counts as the record (27/40/67/49/47)
  or higher with your additions documented.
- W1-g: browser-level checks via the agent-browser skill in-session (sign-in
  journey, disabled-viewer states, user menu, feed names).
- W2-g: `dpkg-deb` structural checks + `bash -n` on all maintscripts + the
  CI workflow YAML valid (actionlint if available, else `python3 -c` yaml parse).
- Dev DB end state: users table has the demo operator (via real setup flow),
  projects cleaned (`bun scripts/dev-db-cleanup.ts`), engine probe fresh.

## 5. Hand-back protocol

Append to `/home/z/my-project/worklog.md` (append, never overwrite):
Task ID (`2-a`/`2-b`/`2-c`), agent, task, work log, stage summary — including
every deviation from this contract with a reason. Do NOT `git commit` — the
TL integrates, runs the full gate suite + acceptance, and commits (push is
credential-blocked in this instance; recorded).
