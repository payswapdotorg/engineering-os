# Implementation Status

Updated: 2026-10-21 — Phase 1 slice integrated and TL-verified · Verifier: TL · Rule: a state is only as good as its evidence link.

## Capability states

Legend: `planned → installed → available → implemented → tested → verified → production-ready` (ownership-map). Nothing is `production-ready`.

| Capability | State | Evidence / notes |
|---|---|---|
| Public repository + CI (install/lint/typecheck/test on ubuntu-latest) | **tested** | CI green on the Phase-1 integration commit (see verification record); first push failed "no tests found" (pre-worker baseline, honest history) |
| Product shell: Project Home, project workspace (Overview/Artifacts/Team/Activity), Engines & Discovery, Activity, Status & Roadmap | **verified** | agent-browser golden path: create project → upload artifact → approve → stale cascade → discovery; console clean; mobile + dark verified |
| Product shell: Design Studio, Takeoff & Estimating, Simulation & Verification, Project Controls, Documents & Deliverables, Agents & Automations | planned (labeled "Planned · Phase N" in UI) | target phases 2/3/4/5 |
| Project CRUD + disciplines + members/roles (local model) | **verified** | AC-P1-02; UI + API evidence |
| Artifact registry: upload → hash → revision → download round-trip | **verified** | AC-P1-03; byte-exact sha256 round-trip; Unicode filename fix (RFC 5987) |
| Revisions: sequential numbering; approval machine | **verified** | AC-P1-04 |
| Artifact links: 8 typed relations, validation | **tested** | `src/core` unit tests + API link creation verified |
| Change impact → stale marking with path evidence (Journey G seed) | **verified** | AC-P1-06 (independent re-run) |
| Engine registry: 34-engine source-verified inventory | **tested** (data) | `src/engines/registry.json` + `docs/02-engines/engine-inventory.md`; every row verified against upstream (GitHub/GitLab/SourceForge/PyPI/npm) on 2026-10-21 with method recorded |
| Engine detection: PATH/executable + python-module probes | **tested** | 5 unit tests with fake executables; live probe: 34 probed, 1 installed (LibreOffice 25.2.3.2) |
| Real engine adapters (FreeCAD, IfcOpenShell…) | planned | Phase 2 — no adapter behavior is claimed |
| Quantity ledger + estimating | planned (schema + domain model tested) | `src/core/ledger.ts` + 34 ledger tests; UI/data-plane lands Phase 3 |
| Durable workflow runtime + agent execution | planned (schema only) | Phase 4; no execution simulated |
| Auth & multi-user permissions | planned | Phase 4 (NextAuth available in stack) |
| PostgreSQL production backend | planned | ADR-0003; dev is SQLite — no production claim |
| Ubuntu packaging (.deb/desktop entry/service) | planned | Phase 6; dev install works (AC-P1-01) |

## Known limitations (current, honest)

1. Single-operator local mode; no auth.
2. Dev database is SQLite; PostgreSQL migration defined but **not verified end-to-end**.
3. No engine adapters execute yet — the Engines workspace shows registry + real detection results only. 33 of 34 registry engines are not installed on this host; that is a true state.
4. Workflow runtime does not execute (Phase 4); the Agents workspace is disabled with its phase label.
5. Quantity/estimating screens are planned placeholders — no numbers are shown or computed anywhere in Phase 1 (domain model and tests exist in `src/core/ledger.ts`).
6. Artifact compare/diff of native CAD formats is not implemented (Phase 2).
7. Upload writes bytes before the DB transaction; a failed registration can leave orphaned bytes (logged loudly by the route). Orphans from Phase-1 development were cleaned at integration; storage↔DB consistency re-verified. Robust store-then-adopt + cleanup job scheduled with the Phase-4 runtime.
8. Browser automation of file-picker inputs hit a tool-level (agent-browser/CDP) issue during verification; the upload path itself was verified byte-exact via the real API (see acceptance catalogue notes).

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
