# Implementation Status

Updated: 2026-10-21 (later same day) — Phase-3 slice (quantity ledger + estimating + first real engine adapters) integrated and TL-verified · Verifier: TL · Rule: a state is only as good as its evidence link.

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
| Engine registry: 34-engine source-verified inventory | **tested** (data) | `src/engines/registry.json` + `docs/02-engines/engine-inventory.md`; every row verified against upstream (GitHub/GitLab/SourceForge/PyPI/npm) on 2026-10-21 with method recorded |
| Engine detection: PATH/executable + python-module probes | **tested** | 5 unit tests with fake executables; live probe: 34 probed, 1 installed (LibreOffice 25.2.3.2) |
| Real engine adapters: quantity derivation from STEP (cadquery/OCC) and IFC (IfcOpenShell) | **tested** | First REAL adapter execution: `src/engines/adapters/*` via arm's-length python subprocess; bracket-solid.step volume 32984.071 mm³ == analytic 36000−960π (rel ~1e-14); wall-quantities.ifc 10 BaseQuantities read back exactly (IfcOpenShell 0.9.0.post1 installed via uv this session); honest 422 on geometry-free/non-model inputs; every derived row carries adapterHash + engineVersion provenance. Editor/geometry adapters (FreeCAD…) still planned Phase 2 |
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
5. Drawing-measured quantities are entered from calibrated-sheet readings; calibrated PDF/vector measurement tools, symbol counting and cutouts are **not implemented yet** — no Bluebeam/PlanSwift parity is claimed. The validation harness against reference datasets (measured + model-derived) is planned next.
6. IfcOpenShell on this host lacks the OCC geometry backend (PyPI wheel): BaseQuantities are exact; geometry fallback is mesh-based (exact planar, approximate curved) — recorded per-row in `raw.method`.
7. Estimate lines freeze once approved/superseded; approved estimates are terminal (no supersede action yet — pinned transition map). Recompute flows arrive with the Phase-4 runtime.
8. Upload writes bytes before the DB transaction; a failed registration can leave orphaned bytes (logged loudly). Cleanup job scheduled with the Phase-4 runtime.
9. Rate resolution prefers effectiveFrom ≤ now, else falls back to the newest rate row — chosen rate ids are always recorded in the line breakdown, but nothing warns about future-dated rates yet.
10. Browser automation of file-picker inputs hit a tool-level (agent-browser/CDP) issue during verification; upload paths verified byte-exact via the real API instead (acceptance catalogue notes).

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
