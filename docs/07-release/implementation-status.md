# Implementation Status

Updated: 2026-10-21 (third pass) — Phase-3 hardening (validation harness + estimate supersede + BOQ export) integrated and TL-verified · Verifier: TL · Rule: a state is only as good as its evidence link.

## Capability states

Legend: `planned → installed → available → implemented → tested → verified → production-ready` (ownership-map). Nothing is `production-ready`.

| Capability | State | Evidence / notes |
|---|---|---|
| Public repository + CI (install/lint/typecheck/test on ubuntu-latest) | **tested** | CI green on the Phase-1 integration commit (see verification record); first push failed "no tests found" (pre-worker baseline, honest history) |
| Product shell: Project Home, project workspace (Overview/Artifacts/**Takeoff**/Team/Activity), Engines & Discovery, Activity, Status & Roadmap | **verified** | takeoff slice browser-verified (14-row ledger, estimate totals GHS 11,778.36, real Add-rate mutation); earlier Phase-1 golden path re-verified in the same session |
| Product shell: Design Studio, Simulation & Verification, Project Controls, Documents & Deliverables, Agents & Automations | planned (labeled "Planned · Phase N" in UI) | target phases 2/4/5; takeoff workspace shipped with the Phase-3 slice |
| Project CRUD + disciplines + members/roles (local model) | **verified** | AC-P1-02; UI + API evidence |
| Artifact registry: upload → hash → revision → download round-trip | **verified** | AC-P1-03; byte-exact sha256 round-trip; Unicode filename fix (RFC 5987) |
| Revisions: sequential numbering; approval machine | **verified** | AC-P1-04 |
| Artifact links: 8 typed relations, validation | **tested** | `src/core` unit tests + API link creation verified |
| Change impact → stale marking with path evidence (Journey G seed) | **verified** | AC-P1-06 (independent re-run) |
| Engine registry: 35-engine source-verified inventory | **tested** (data) | `src/engines/registry.json` + `docs/02-engines/engine-inventory.md`; every row verified against upstream (GitHub/GitLab/SourceForge/PyPI/npm) with method recorded; cadquery + ifcopenshell entries carry harness `validation` fields (AC-P3-09) |
| Engine detection: PATH/executable + python-module probes | **tested** | 5 unit tests with fake executables; live probe: 34 probed, 1 installed (LibreOffice 25.2.3.2) |
| Real engine adapters: quantity derivation from STEP (cadquery/OCC) and IFC (IfcOpenShell) | **verified** | First REAL adapter execution: `src/engines/adapters/*` via arm's-length python subprocess; bracket-solid.step volume 32984.071 mm³ == analytic 36000−960π (rel ~1e-14); wall-quantities.ifc 10 BaseQuantities read back exactly; honest 422 on geometry-free/non-model inputs; every derived row carries adapterHash + engineVersion provenance. **Benchmark-validated (hardening pass):** 11-case harness (`bun run validate:engines`, AC-P3-09/09b) — set-equality ground truth, per-case determinism double-run, mesh-fallback error quantified (cylinder volume rel 3.246e-3 / area 9.642e-4 vs closed forms, inside pinned 1%); registry carries `validation {cases: 5/6, result: pass}`. Editor/geometry adapters (FreeCAD…) still planned Phase 2 |
| BOQ export (CSV/JSON, approved estimates only) | **verified** | `GET /api/estimates/[id]/export?format=csv\|json`; pure builder `boq-csv.ts` byte-pinned by 7 unit tests; 17-row deterministic layout w/ joined descriptions, recomputed totals, LF/no-BOM/all-quoted; approved-only gate + verbatim 422s; read-only (no audit event); AC-P3-11 incl. browser download |
| Estimate supersede (draft/in_review/approved → superseded, terminal, audit-preserving) | **verified** | Transition map extended; approval payload kept; exactly one `estimate.updated {action: supersede}` event; lines frozen; re-supersede 422 verbatim; UI confirm dialog + locked rendering; AC-P3-10 |
| Quantity ledger + estimating (DB + API + UI) | **verified** | Ledger rows w/ provenance, approval machine, versioned engineer-only rates, deterministic server math, approve gate; AC-P3-01…08 (acceptance catalogue); estimateTotals + 10 core tests; 26/26 golden-path assertions; drawing-measured vs model-derived kept distinct |
| Durable workflow runtime + agent execution | planned (schema only) | Phase 4; no execution simulated |
| Auth & multi-user permissions | planned | Phase 4 (NextAuth available in stack) |
| PostgreSQL production backend | planned | ADR-0003; dev is SQLite — no production claim |
| Ubuntu packaging (.deb/desktop entry/service) | planned | Phase 6; dev install works (AC-P1-01) |

## Known limitations (current, honest)

1. Single-operator local mode; no auth.
2. Dev database is SQLite; PostgreSQL migration defined but **not verified end-to-end**.
3. Editor/geometry engine adapters (FreeCAD, LibreCAD, DWG round-trips) are not implemented — Phase 2. The Engines workspace shows registry + real detection results only. Only LibreOffice (system PATH), cadquery and IfcOpenShell (venv) exist on this dev host — that is a true state.
4. Workflow runtime does not execute (Phase 4); the Agents workspace is disabled with its phase label.
5. Drawing-measured quantities are entered from calibrated-sheet readings; calibrated PDF/vector measurement tools, symbol counting and cutouts are **not implemented yet** — no Bluebeam/PlanSwift parity is claimed. The quantity-derivation validation harness shipped (AC-P3-09); a broader measured-vs-model reference harness can extend it later.
6. IfcOpenShell on this host lacks the OCC geometry backend (PyPI wheel): BaseQuantities are exact; geometry fallback is mesh-based — exact for planar solids (observed rel ~1.9e-16), approximate for curved surfaces (observed rel 3.2e-3 volume / 9.6e-4 area on the Ø400×3000 corpus column, inside the pinned 1%) — recorded per-row in `raw.method` and per-comparison in the harness reports. A future wheel-default deflection change beyond 1% fails the harness loudly rather than passing silently.
7. Estimate lines freeze once approved/superseded. Superseding (draft/in_review/approved → superseded) is terminal and keeps the estimate for audit with its approval payload; superseded estimates are not exportable. Recompute flows arrive with the Phase-4 runtime.
8. Upload writes bytes before the DB transaction; a failed registration can leave orphaned bytes (logged loudly). Cleanup job scheduled with the Phase-4 runtime.
9. Rate resolution prefers effectiveFrom ≤ now, else falls back to the newest rate row — chosen rate ids are always recorded in the line breakdown, but nothing warns about future-dated rates yet.
10. Browser automation of file-picker inputs hit a tool-level (agent-browser/CDP) issue during verification; upload paths verified byte-exact via the real API instead (acceptance catalogue notes).
11. The validation harness covers the quantity-derivation corpus only (11 cases, cadquery + IfcOpenShell); the other 33 registry engines remain `planned` with no harness cases. Harness reports carry `ranAt` — regenerate with `bun run validate:engines`.

## Verification record

**2026-10-21 — Phase-1 integration (TL), dev host:**

- `bun run lint` → 0 errors; `bun run typecheck` → clean; `bun test src/` → **75 pass / 0 fail** (4 files, 198 assertions).
- `bun run dev` → "Ready in 647ms"; `GET /` → 200 (curl + agent-browser; console zero errors).
- UI golden path (agent-browser): project created via dialog → card + `project.created` event; artifact registered (fixture uploaded via real API after tool-level file-input issue; dialog render/validate verified in browser); approve r1 → `approved`; engine discovery → 34 probed, 1 installed (LibreOffice 25.2.3.2 @ /usr/bin/libreoffice); status page renders this document live from the repo; mobile drawer + dark theme + sticky footer verified.
- Byte-exact round-trip: `sha256sum tests/fixtures/bracket.step` == server contentHash == downloaded file hash (`0db7784e…320b`).
- Independent stale cascade: `derived_from` link + new revision → `staleMarked` with path evidence; downstream latest revision `stale`, content untouched.
- **Defect found & fixed during verification:** `Content-Disposition` header serialization crashed on non-ASCII artifact names (em dash) → downloads returned 500. Fix: ASCII fallback filename + RFC 5987 `filename*`. Re-verified byte-exact.
- Storage↔DB consistency: 5 artifacts == 5 content dirs; 3 orphaned dirs (from two logged mid-build failures) removed.
- CI: first run on the bootstrap commit failed (`bun test` → "No tests found!" — baseline had no test files yet); workflow now runs `bun run test`; result on the integration commit recorded in the repo Actions history.

**2026-10-21 (later) — Phase-3 slice integration (TL + workers 1-b/2-b/3-b), dev host:**

- Parallel lanes: W1-b takeoff workspace UI · W2-b real quantity adapters (cadquery STEP, IfcOpenShell IFC — `uv pip install ifcopenshell` succeeded) · W3-b ledger/estimating data plane (5 Prisma models, 10 API routes, `estimateTotals` core fn + 10 tests).
- TL integration: `?tab=takeoff` deep-link wired into the page guard; derivation detection unified in `src/engines/adapters/derive-kind.ts` (route + dialog + bridge share one implementation; `application/x-step → ifc` follows the repo mime convention in `artifact-meta.ts`).
- `bun run lint` → 0 errors · `bun run typecheck` → clean · `bun test src/` → **92 pass / 0 fail** (5 files, 297 assertions).
- Golden path (real API, `scripts/e2e-takeoff.sh`): **26 PASS / 0 FAIL** incl. analytic cross-checks (cadquery vs closed-form at rel ~1e-14; IFC BaseQuantities vs authored values), approval gates (direct draft→approve 422; estimate approve blocked 422 with 2 named blockers; then 200), totals hand-check (GHS 10,066.98 + 130.74 → 1,019.77 OH → 560.87 profit → **11,778.36** grand).
- Browser (agent-browser): takeoff deep-link renders 14-row ledger; estimate detail totals match; real Add-rate mutation (GHS 1,475.00 row appears); zero console/page errors; dark + mobile 390×844; footer sticky-bottom on short pages and naturally pushed on long ones.
- Dev-DB housekeeping: worker smoke projects deleted with their storage dirs (`scripts/dev-db-cleanup.ts`); demo dataset rebuilt through the real API as project "Harbour View Extension".
- **Blocker (environment, not product):** this sandbox instance lost the GitHub push credentials (no token env/file; `git push` → "could not read Username") — Phase-3 commits are local until credentials are restored.

**2026-10-21 (third pass) — Phase-3 hardening integration (TL + workers 1-c/2-c/3-c), dev host:**

- Parallel lanes: W1-c supersede + export UI · W2-c benchmark validation harness (corpus manifest, 4 new deterministic fixtures, pure `runHarness` + CLI `validate:engines` + in-process bun tests, registry/docs evidence) · W3-c supersede transition + BOQ export routes + pure `boq-csv.ts` builder (7 byte-pinned tests).
- Harness run by TL: `bun run validate:engines` → **11 cases / 11 pass / 0 fail / 0 skip**, exit 0, determinism true on every success case (each ran twice); honest all-skip path verified (`EOS_PYTHON=/nonexistent` → 11 skips + NOT RUN, exit 0). Mesh-fallback error quantified: cylinder volume rel **3.246e-3**, area rel **9.642e-4** — inside the pinned 1% tolerance; planar mesh case analytic-exact by derivation (observed ~1.85e-16).
- `bun run lint` → 0 errors · `bun run typecheck` → clean · `bun test src/` → **110 pass / 0 fail** (7 files, 824 assertions).
- TL acceptance scripts (live dev server, full dev-DB cleanup + demo rebuild first): golden-path regression `scripts/e2e-takeoff.sh` **26 PASS / 0 FAIL**; hardening `scripts/e2e-p3-hardening.sh` **40 PASS / 0 FAIL** (AC-P3-10/11 incl. verbatim 422s, audit-event counts, approval-payload preservation, byte-checked 17-row CSV layout with real joins, read-only export). All 4 acceptance-development failures were script-side (API shapes, shell quoting, od flag, one half-written line) — zero product defects.
- Browser (agent-browser): Supersede dialog message verbatim + destructive confirm; full UI supersede flow (draft probe → superseded badge, locked detail, zero action buttons, audit toast); Export BOQ (CSV) real fetch → 200 (network log); Engines page unbroken with validation fields flowing via `/api/engines`; zero console/page errors; mobile 390×844 no horizontal overflow; footer sticks to viewport bottom on the short Team page (844==844) and pushes naturally on long ones.
- Worker smoke + probe data removed (`scripts/dev-db-cleanup.ts --all`); demo dataset rebuilt through the real API ("Harbour View Extension", 26/26 assertions) as the final dev-DB state.
- Push still blocked by missing sandbox credentials (unchanged); commits recorded locally.
