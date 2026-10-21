# Acceptance Catalogue

Owner: TL · An item passes only with recorded evidence (command + observed result + verifier). UI tests never substitute for engineering validation.

## Journeys (from handoff §5)

| ID | Journey | Status | Evidence |
|---|---|---|---|
| A | Create & manage project (create → graph → workspace) | ✅ **passed (Phase 1)** | AC-P1-01/02/07; UI creation verified end-to-end (agent-browser) |
| B | Edit & publish CAD artifact | planned Phase 2 | requires installed editor engines (dev host has none — honest) |
| C | BIM model → verified BOQ | 🚧 partial (Phase 3) | Real IfcOpenShell BaseQuantity extraction verified against authored fixture values (AC-P3-02); full BOQ journey + benchmark corpus pending |
| D | Drawing → takeoff → estimate | 🚧 partial (Phase 3) | Manual drawing-measured ledger rows + deterministic estimate verified (AC-P3-01/03/04/05/06); calibrated PDF measurement tooling pending |
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

## Phase-3 acceptance items — verified 2026-10-21 (TL, dev host; slice = quantity ledger + estimating + first real engine adapters)

| ID | Item | Status | Evidence |
|---|---|---|---|
| AC-P3-01 | Drawing-measured ledger row recorded via real API + UI, sheetRef enforced | ✅ passed | `46.2 m² @ A-101 / zone B` (scale record `1:100 @ A1 (scale bar B)`) created via `POST /api/projects/[id]/quantities`; missing-sheetRef variant → 422 with the exact core zod message; UI ledger renders it with amber drawing badge, source artifact + rev |
| AC-P3-02 | Model-derived quantities from REAL engine adapters, values provenance-tracked | ✅ passed | cadquery 2.6.1/OCC on `tests/fixtures/bracket-solid.step`: volume 32984.071 mm³ == analytic 36000−960π, area 11506.9025 mm² == 10200+416π (rel ~1e-14, test `src/engines/adapters/quantities.test.ts`); IfcOpenShell 0.9.0.post1 on `wall-quantities.ifc`: 10 authored BaseQuantities read back exactly (Volume 1.2 m³, SideArea 12.8 m², Footprint 0.6 m², WallTieCount 2); every derived row carries `provenance {createdBy: adapter:<engine>, adapterHash (sha256), engineVersion}`; audit `quantity.derived` by actor `adapter:<engine>` |
| AC-P3-03 | Honest failures: no geometry → 422, never simulation | ✅ passed | `bracket.step` (0 solids) → 422 `engine_unavailable` "no solid geometry found … simulated values are not an option"; non-model (svg) → 422 `unsupported` |
| AC-P3-04 | Quantity approval machine: draft→in_review→approved, supersede; no shortcuts | ✅ passed | direct draft→approve 422; submit/approve/supersede transitions verified via API; draft STEP row superseded on demand |
| AC-P3-05 | Deterministic server-side estimate math | ✅ passed | line1 46.2 m² × C25 assembly (waste 5%, prod ×1.25) = GHS 10,066.98 (hand-checked: 8,440.74 + 1,626.24); line2 0.6 m² = GHS 130.74 (109.62 + 21.12); totals recomputed on read |
| AC-P3-06 | Estimate totals per pinned formula | ✅ passed | subtotal 10,197.72 · overhead 10% = 1,019.77 · profit 5% of (sub+OH) = 560.87 · tax 0 · grand **GHS 11,778.36** — all match hand computation |
| AC-P3-07 | Approval gate: estimate approve requires every line quantity approved | ✅ passed | approve with quantities in_review → 422 "estimate approve blocked (2 blockers): … is \"in_review\"" (ids + sheet/element refs listed); after approving the quantities → approve 200; approved estimates freeze lines (add/delete → 422) |
| AC-P3-08 | Methods kept distinct + rates never agent-created | ✅ passed | drawing-measured vs model-derived render as distinct badges; adapter creates quantities only — rates are engineer-entered (`createdBy: local-operator` server-set, never accepted from body) |

### Phase-3 verification record (honest notes)

- Golden-path script: `scripts/e2e-takeoff.sh` (gitignored dev tooling) — **26 PASS / 0 FAIL** against the live dev server (its first run surfaced 3 script-side expectation bugs — including a TL hand-arithmetic error where the correct profit is 560.87, not 550.87 — and zero product defects; the corrected run is the recorded result). Demo dataset lives in the dev DB only: project "Harbour View Extension", 4 artifacts (incl. an honest-failure STEP stub and a scale-barred SVG sheet), 14 ledger rows, 1 approved GHS estimate. Worker smoke projects were removed from the dev DB (housekeeping script `scripts/dev-db-cleanup.ts`).
- Browser (agent-browser): takeoff tab deep-link renders 14-row ledger (10 IFC rows with `#GlobalId` refs, 3 cadquery rows with `step:` refs, 1 drawing row); estimate detail shows GHS 10,066.98 / 130.74 / 11,778.36; **real UI mutation verified**: Add-rate dialog → POST → refetch → new "C25 concrete GHS 1,475.00" row; zero console/page errors; dark mode applied; mobile 390×844 responsive; footer sticks to viewport bottom on short pages (bottom==844) and is pushed down naturally on long ones (bottom==scrollH) — no overlay, no gap.
- First-run file-picker automation remained blocked at tool level (unchanged from Phase 1) — the derive/estimate paths were exercised through the real API and then rendered in the browser.

## Phase-3 hardening acceptance items — verified 2026-10-21 (TL, dev host; slice = validation harness + estimate supersede + BOQ export)

| ID | Item | Status | Evidence |
|---|---|---|---|
| AC-P3-09 | Engine validation harness: benchmark corpus, real-bridge execution, determinism, honest skips | ✅ passed | `bun run validate:engines` → **11 cases / 11 pass / 0 fail / 0 skip** (exit 0), driven by committed `tests/validation/corpus-manifest.json` (39 hand-derived ground-truth entries with derivation strings) through the REAL production bridge (`deriveFromFile`); every success case ran twice with `determinism: true`; set-equality enforcement proved skipped IFC NetWeight quantities (2880/6720 kg) genuinely absent; error probes matched pinned substrings ("no solid geometry", "STEP import failed", "Unable to parse IFC SPF header"); all-skip path verified live (`EOS_PYTHON=/nonexistent` → 11 honest skips + NOT RUN, exit 0); reports: `tests/validation/report.json` + `docs/02-engines/validation-report.md`; new fixtures regenerate byte-identically (sha256-stable); covered in CI via `src/engines/validation/harness.test.ts` inside `bun test src/` |
| AC-P3-09b | Mesh-fallback limitation quantified honestly (IfcOpenShell PyPI wheel has_occ=False) | ✅ passed | Ø400×3000 mm column via mesh fallback: volume rel error **3.246e-3 (0.32%)**, area rel error **9.642e-4 (0.10%)** vs closed forms 0.12π m³ / 1.28π m² — inside the pinned 1% engineering tolerance, observed error recorded per comparison in both reports; planar-solid mesh case pinned at analytic tolerance by derivation (divergence-theorem volume/triangle-sum area exact for planar) and observed rel ~1.85e-16 |
| AC-P3-10 | Estimate supersede: draft/in_review/approved → superseded; audit preserved; terminal | ✅ passed | `POST /api/estimates/[id]/transition {action:"supersede"}` from approved → superseded with approval payload byte-identical; audit `estimate.updated {action:"supersede",from,to}` exactly once; re-supersede → 422 `cannot supersede an estimate in status "superseded"` verbatim; lines frozen (add → 422 frozen message); supersede from draft and from in_review verified; UI: confirm dialog (terminal + audit + frozen + stops-export message), superseded detail renders locked with zero actions, toast "kept in the ledger for audit" |
| AC-P3-11 | BOQ export: approved-only, deterministic CSV + structured JSON, read-only | ✅ passed | `GET /api/estimates/[id]/export?format=csv` on the approved demo estimate → 200 `text/csv; charset=utf-8` + `attachment; filename="boq-<id>.csv"`; 17-row pinned layout verified line-by-line incl. real joins (`C25 slab pour — Sheet-A101-GA-plan.svg (A-101 / zone B)`, `wall-quantities.ifc (#2rUnE8CnPHBwLdZzIqZkf1)`), totals `10197.72 / 1019.77 (10%) / 560.87 (5%) / 0 / 11778.36` and determinism note row; LF-only + trailing LF, no BOM, every field quoted; gates: draft → 422 `only approved estimates can be exported as a BOQ (this estimate is "draft")`, superseded → same form verbatim, missing format → 422 `format is required (must be one of: csv, json)`, `format=xml` → 422 `format must be one of: csv, json (got "xml")`, unknown id → 404; `format=json` returns structured BOQ (project join, 2 lines, recomputed totals); export wrote ZERO audit events (read-only); UI: Export button on approved detail → real fetch 200 (browser network log), zero console/page errors |

### Phase-3 hardening verification record (honest notes)

- TL acceptance scripts: `scripts/e2e-takeoff.sh` (golden path regression) **26 PASS / 0 FAIL** and `scripts/e2e-p3-hardening.sh` (hardening) **40 PASS / 0 FAIL** — both run against the live dev server after a full dev-DB cleanup + demo rebuild. All 4 failures observed during acceptance development were script-side (API-shape mismatches, shell-quoting of JSON-escaped quotes, an `od` flag, one half-written line) — **zero product defects**; the corrected runs are the recorded results.
- Full gates at integration: `bun run lint` 0 errors · `bun run typecheck` clean · `bun test src/` **110 pass / 0 fail / 824 assertions** (7 files; grew from 92/297 baseline with W2-c harness tests + W3-c BOQ builder tests).
- Registry evidence: `cadquery` + `ifcopenshell` entries carry additive `validation {harness, cases: 5/6, lastRun: 2026-10-21, result: pass}` fields (state vocabulary unchanged: `tested`); `/api/engines` returns them; Engines page unbroken.
- Out of scope (honest): PDF measurement tools, project schedules, estimate recompute flows (Phase-4 runtime), validation harness coverage for the other 33 registry engines (all remain `planned`).
