# Acceptance Catalogue

Owner: TL · An item passes only with recorded evidence (command + observed result + verifier). UI tests never substitute for engineering validation.

## Journeys (from handoff §5)

| ID | Journey | Status | Evidence |
|---|---|---|---|
| A | Create & manage project (create → graph → workspace) | ✅ **passed (Phase 1)** | AC-P1-01/02/07; UI creation verified end-to-end (agent-browser) |
| B | Edit & publish CAD artifact | planned Phase 2 | requires installed editor engines (dev host has none — honest) |
| C | BIM model → verified BOQ | planned Phase 3 | |
| D | Drawing → takeoff → estimate | planned Phase 3 | |
| E | Requirements → simulation → report | planned Phase 4/5 | |
| F | Agent proposes & executes change | planned Phase 4 | |
| G | Change impact across delivery | ✅ **seed passed (Phase 1)** | AC-P1-06 — full journey grows with Phases 3–4 |
| H | Reopen & resume | 🚧 Phase 1 partial | SQLite durability verified; full app-restart drill → Phase 6 |

## Phase-1 acceptance items — verified 2026-10-21 (TL, dev host)

| ID | Item | Status | Evidence |
|---|---|---|---|
| AC-P1-01 | App installs & launches; `/` renders product shell | ✅ passed | `bun run dev` → "Ready in 647ms"; `/` HTTP 200 via curl + agent-browser. `install.sh` steps executed individually (bun install, prisma generate, db push, .env). CI runs the same pipeline on clean ubuntu-latest. Full fresh-machine install drill → Phase 6 packaging |
| AC-P1-02 | Create project persists; survives server restart | ✅ passed | "Harbor Outfall Upgrade" created through the real UI dialog (agent-browser); `project.created` audit row; project still served after the dev-server restart that occurred later in the session; data in SQLite on disk |
| AC-P1-03 | Register real file: SHA-256 matches, revision v1 recorded, download round-trip byte-exact | ✅ passed | `tests/fixtures/bracket.step` (443 B): server hash `0db7784e…` == `sha256sum`; download → identical sha256; headers `Content-Type: application/step`, `Content-Length: 443`, `Content-Disposition` (ASCII fallback + RFC 5987 `filename*`), `X-Artifact-Sha256`. **Fix landed during verification:** Unicode artifact names (em dash) previously crashed header serialization — now ASCII-safe + `filename*` |
| AC-P1-04 | New revision: sequential number; approval machine enforces transitions | ✅ passed | rev chain r1→r2; UI approve r1 → `approved`; re-approve → honest 400 "already approved"; approve of newer rev supersedes prior (r4 approved → r3 superseded) |
| AC-P1-05 | Engine discovery: honest installed/not-installed with versions | ✅ passed | `POST /api/engines/probe` → 34 probed, **1 installed: LibreOffice 25.2.3.2 @ /usr/bin/libreoffice** (real detection); 33 absent engines reported "Not installed" with probe timestamp; unit tests use fake executables on a temp PATH (no network, no engines) |
| AC-P1-06 | Impact: downstream marked stale with path evidence; no overwrite | ✅ passed | Independent run: `Deck takeoff (seed)` `derived_from` bracket fixture → new bracket revision → response `staleMarked:[{path:[bracket→takeoff]}]`; takeoff latest revision `staleness: stale`; its own revision content untouched |
| AC-P1-07 | Audit trail: every action recorded and visible | ✅ passed | Feed shows `project.created`, `artifact.registered`, `artifact.revised`, `artifact.staled`, `artifact.approved`, `link.created`, `member.added`, `engine.probe`, `project.updated` with actor/entity/time; `/api/events` verified |
| AC-P1-08 | Planned workspaces labeled honestly; zero dead buttons | ✅ passed | 6 planned workspaces disabled with visible "Planned · Phase N" badges (agent-browser a11y snapshot); every enabled control exercised or smoke-verified |
| AC-P1-09 | lint / typecheck / unit tests green | ✅ passed | `bun run lint` 0 errors; `bun run typecheck` clean; `bun test src/` **75 pass / 0 fail** (4 files, 198 assertions). CI result recorded in implementation-status |

### Verification notes (honest)

- Browser automation of the **file-picker input** was blocked by a tool-level CDP issue in agent-browser (reproducible at the same interaction point); the upload path was therefore verified through the **real HTTP API** (multipart) with byte-level checks, and the register/revision dialogs were verified open/validate/enable-submit in the browser. No product defect was found in the upload path.
- During Phase-1 development, two failed registrations (W1 mid-build import error) left orphaned bytes in the content store; the route logs this loudly, the orphans were cleaned at integration, and storage↔DB consistency was re-verified (`5 DB artifacts == 5 storage dirs`). The file-before-transaction window is documented as a known limitation.
- Known non-issues: none of the 34 registry engines except LibreOffice is installed on this dev host — that absence is true state, not failure.
