# Extended-Disciplines Slice Contract — Phase 5

Binding for the three Phase-5 lanes (W1-f UI / W2-f engines / W3-f data plane), frozen before dispatch. Same discipline as the Phase-4 contract: signatures below are FROZEN — a lane that needs a change escalates to TL, it never edits a frozen interface in flight. The red lines are the standing ones: no simulated engine output, no invented numbers (ADR-0006 §2), no mock integrations, honest errors everywhere.

## 0. Phase-5 exit criteria

Ship the three remaining workspaces — **Simulation & Verification**, **Project Controls**, **Documents & Deliverables** — each anchored on a REAL capability (engine or platform core, never a stub), with the validation harness extended to cover every new engine adapter, all regressions green, and the docs/capability/acceptance records updated to match. Nothing in this slice is allowed to weaken a Phase 1–4 acceptance item.

## 1. Verified engine reality (TL probes, 2026-10-22, dev host — the slice is built on these facts)

| Engine | Registry version | Real capability proven | Notes |
|---|---|---|---|
| gmsh | 4.15.2 (`gmsh`) | STEP → linear-tet FE mesh: bracket-solid.step → 3482 tets, divergence-theorem volume 33286.264 mm³ vs analytic 32984.071 (0.92% at MeshSizeMax 4.0 — linear tets under-trap the curved hole; shrinks quadratically with mesh size) | Needs `libGLU.so.1` + `libOpenGL.so.0` from `/home/z/.local/lib/eos-engine-libs` (see §5.1); setup script `scripts/setup-engine-libs.sh` (TL-provided, committed) re-creates the dir if the sandbox recycles |
| pandapower | 3.5.6 (`pandapower`) | Newton-Raphson power flow on `case4gs`: converged, ext-grid vm_pu 1.0 matches MATPOWER's published result | pure-python install, no system deps |
| SimPy | 4.1.2 (`simpy`) | deterministic discrete-event runtime | pure-python install |
| LibreOffice | 25.2.3.2 (`libreoffice`) | headless conversion `.fodt` → PDF (writer_pdf_Export), 26 237 bytes produced; `.txt` → PDF too | already installed at `/usr/bin/libreoffice`; PDFs embed creation timestamps → **byte-determinism is NOT claimed for conversions** (§5.4) |

All four probe commands + observed outputs are recorded above; adapters must reproduce them, not restate them.

## 2. New artifact kinds & payload formats (W3-f owns `src/lib/artifact-meta.ts` additions)

`ARTIFACT_KINDS` grows additively (comment-only convention for the Prisma `kind` field, mirroring the Phase-2 `mesh` precedent):

- `"schedule"` — user-authored project schedule JSON. NEVER detected from uploads (a `.json` upload stays `dataset`); created only through the Controls workspace / a dedicated create route which writes the canonical JSON and registers the artifact with this kind explicitly.
- `"fe-mesh"` — engine-generated FE-mesh summary (gmsh). Never detected from uploads; never rendered by the Design Studio viewer (that viewer consumes `eos-mesh/1` only).
- `"analysis"` — engine- or platform-derived analysis results (power flow, DES, CPM; future FEA). Never detected from uploads.
- `"pdf"` — engine-generated PDF (document conversion). Never detected from uploads (an uploaded `.pdf` stays `drawing`, existing behavior unchanged).

Derived payload formats (all JSON unless stated; **no timestamps, no run-ids — byte-deterministic by construction** except the binary PDF):

- **`eos-femesh/1`** — `{format, sourceArtifactName, units:"mm", generatedBy:{engineKey,engineVersion,adapterScript}, meshSizeMin, meshSizeMax, elementOrder, nodes:{count}, elements:{type:"tet4", count}, solids:[{ref, name?, tetCount, meshVolume}], quality:{min, mean}}` where `meshVolume` is the divergence-theorem volume of the tets attributed to that solid (honest mesh-derived quantity, never claimed analytic). Pinned key order, literal ascending solid order.
- **`eos-powerflow/1`** — `{format, sourceArtifactName, converged, buses:[{id, vmPu, angleDeg, pMw, qMvar}], lines:[{fromBus, toBus, iKa, pLossMw, qLossMvar}], totals:{lossMw, loadMw}}` — every numeric copied VERBATIM from the pandapool result frame (engine is the source of truth; nobody rounds "for presentation").
- **`eos-des/1`** — `{format, sourceArtifactName, policy:"fifo", makespan, resources:[{id, busy, utilization}], jobs:[{id, startAt, endAt}]}` — start/end times in the scenario's time unit, copied from the SimPy event record deterministically.
- **`eos-cpm/1`** — `{format, sourceArtifactName, activities:[{id, name, durationDays, es, ef, ls, lf, totalFloat, critical}], criticalPath:[ids], durationDays}` — pure platform core (§6), byte-deterministic.
- **PDF conversions** — raw `application/pdf` bytes as the revision content; `MIME_BY_EXT` gains `pdf → application/pdf` if missing (upload-side `.pdf` → `drawing` mapping and download behavior unchanged).

Every derived artifact is linked `derived_from` its source artifact and inherits the existing revision/staleness/Journey-G machinery — **zero new graph code is in scope** (that is a feature, not an omission: AC-P5-05 asserts the cascade works by reusing it).

## 3. Input schemas (frozen; W3-f implements as zod in `src/core/analysis-schemas.ts`, W2-f's python adapters accept exactly this JSON)

### 3.1 Schedule (`eos-schedule/1`)

```json
{ "format": "eos-schedule/1", "name": "string 1..200",
  "activities": [ { "id": "a-z0-9- unique 1..32", "name": "string 1..200",
                    "durationDays": "integer 0..10000", "predecessorIds": ["ids"] } ] }
```
1..64 activities. Verbatim joined error style: `invalid schedule: path: msg; …`. Cycle → error `activity chain contains a cycle involving "<id>"`; unknown predecessor → `activity "<id>" references unknown predecessor "<pid>"`; duplicate id → `activity id "<id>" is used more than once`.

### 3.2 Power-flow network (`eos-powerflow-network/1`)

```json
{ "format": "eos-powerflow-network/1", "name": "string 1..200", "baseMva": "number > 0 (default 100)",
  "buses": [ { "id": "a-z0-9- unique 1..32", "nominalVk": "number > 0" } ],
  "lines": [ { "id": "a-z0-9- unique 1..32", "fromBus": "bus id", "toBus": "bus id",
               "lengthKm": "number > 0", "rOhmPerKm": "number ≥ 0", "xOhmPerKm": "number > 0",
               "maxCurrentKa": "number > 0 (default 1)" } ],
  "externalGrid": { "busId": "bus id", "vmPu": "number (default 1.0)" },
  "loads": [ { "id": "a-z0-9- unique 1..32", "busId": "bus id", "pMw": "number ≥ 0", "qMvar": "number ≥ 0" } ] }
```
1..16 buses, 0..48 lines/loads. Single external grid (radial/tree reality for the slice; loop flows are out of scope, §10).

### 3.3 DES scenario (`eos-des-scenario/1`)

```json
{ "format": "eos-des-scenario/1", "name": "string 1..200", "timeUnit": "hour|day|minute (default day)",
  "resources": [ { "id": "a-z0-9- unique 1..32", "capacity": "integer 1..8 (default 1)" } ],
  "jobs": [ { "id": "a-z0-9- unique 1..32", "arriveAt": "number ≥ 0 (default 0)",
              "tasks": [ { "resourceId": "resource id", "duration": "number > 0" } ] } ] }
```
1..32 resources, 1..256 jobs, 1..8 tasks per job (executed in array order). Policy is `fifo` — the only one shipped (§10).

## 4. Broker operations (W2-f owns `src/engines/broker.ts` additions — the ONLY execution path, ADR-0005 rule 1)

`BrokerOperation` grows: `… | "fe_mesh" | "run_powerflow" | "run_des" | "convert_document" | "analyze_schedule"`.

Frozen inputs/parameters:

| op | inputs | parameters (defaults) | output kind + format | engineKey |
|---|---|---|---|---|
| `fe_mesh` | `{artifactId}` (STEP/IFC model) | `{meshSizeMin: 2.0, meshSizeMax: 4.0, elementOrder: 1}` (1 = linear tets only this phase) | `"fe-mesh"` / `eos-femesh/1` | `"gmsh"` |
| `run_powerflow` | `{artifactId}` (schedule/network/scenario JSON of format 3.2) | `{}` | `"analysis"` / `eos-powerflow/1` | `"pandapower"` |
| `run_des` | `{artifactId}` (format 3.3) | `{}` | `"analysis"` / `eos-des/1` | `"simpy"` |
| `convert_document` | `{artifactId}` (LO-convertible document) | `{}` | `"pdf"` / raw PDF bytes | `"libreoffice"` (adapterScript `convert-document.ts` recorded; no python) |
| `analyze_schedule` | `{artifactId}` (format 3.1) | `{}` | `"analysis"` / `eos-cpm/1` | **absent/null — platform core, honestly recorded** (no adapterScript, no adapterHash) |

Every op: find-or-create semantics on the derived artifact (match by `derived_from` target set — the `build_report` precedent), revision APPENDED per run (never a new artifact), DRAFT approvalState (publishing stays a human act, ADR-0006), ONE audit event per run (§8), full `BrokerOutcome` (engineKey/engineVersion/adapterScript/adapterHash/stdout+stderr tails/exitCode/durationMs — `analyze_schedule` leaves the engine fields null and that is visible in the step/execution records). `BrokerRefusalError` covers every honest refusal with the existing 422 mapping.

`src/core/workflow.ts` pure `BROKER_OPERATIONS` + the per-op input shapes in `WorkflowDefinitionSchema` grow to match this table EXACTLY (W3-f owns that file; W2-f's broker must accept what the zod admits and refuse the rest) — workflows can therefore compose the new ops; shipping a new workflow TEMPLATE is out of scope (§10).

## 5. Adapter specifications (W2-f owns; same subprocess protocol as the existing bridges)

### 5.1 `src/engines/adapters/step_femesh.py` (gmsh)

- JSON-protocol stdin/stdout script in the existing style: reads `{storagePath, parameters{meshSizeMin, meshSizeMax, elementOrder}}`, emits `{nodes, elements, solids[], quality, adapterHash-self}`.
- The TS bridge `src/engines/adapters/femesh.ts` (mirror of `mesh.ts`: `feMeshFromFile`, `supportsFeMesh` for `.step/.stp/.ifc`, `EngineUnavailableError`) spawns the venv python with `LD_LIBRARY_PATH` prepending `process.env.EOS_ENGINE_LIBDIR ?? "/home/z/.local/lib/eos-engine-libs"` (the directory `scripts/setup-engine-libs.sh` maintains). If the import still fails → `EngineUnavailableError` with the message naming the missing library and the setup script (`gmsh requires system libraries (libGLU.so.1, libOpenGL.so.0) — run scripts/setup-engine-libs.sh`). Honest absence, never a fallback.
- Geometry-free STEP (0 solids after OCC import) → honest refusal `no solid geometry found in STEP file (import produced 0 solids) - cannot generate an FE mesh, and simulated meshes are not an option` (the established verbatim pattern). Same for geometry-free IFC. Non-model file → the established parse-error envelope.
- Determinism: fixed gmsh options only (MeshSizeMin/Max from parameters, `Mesh.Algorithm3D` default, `Geometry.Tolerance` default, no randomize). Double-run byte-identical is a harness-enforced pin (§7).
- `gmsh.initialize()`/`finalize()` per run; `gmsh.clear()` before import; OCC "Unresolved Reference" reader warnings go to stderr verbatim (recorded in the tails — they are evidence, not noise).

### 5.2 `src/engines/adapters/powerflow.py` (pandapower)

- Builds a pandapower net from the validated network JSON (buses → `create_bus` with `vn_kv`; lines → `create_line_from_parameters` with `r_ohm_per_km/x_ohm_per_km/cmax_ka/max_i_ka`; `create_ext_grid` at the external-grid bus with `vm_pu`; loads → `create_load` p_mw/q_mvar), `runpp(net, init="flat")`, emits the result frames as the §2 JSON verbatim (no rounding).
- Non-convergence → honest refusal `power flow did not converge (newton-raphson exhausted) - results are not available, and simulated results are not an option`. Islanded bus (no path to the ext grid) surfaces pandapower's own error text verbatim in the refusal envelope.
- Version pinned 3.5.6 in the provenance (`engineVersion`).

### 5.3 `src/engines/adapters/des.py` (SimPy)

- FIFO resources (`simpy.Resource(env, capacity)`), jobs as processes, tasks sequential per job, `arriveAt` = initial `env.timeout` if > 0. Records per-job start (first task begin) and end (last task end), per-resource busy time (sum of task durations actually served) and utilization = busy / makespan.
- Fully deterministic by construction (no stochastic distributions this phase — §10). Emit time values verbatim.
- Zero-duration tasks are schema-refused upstream (zod), never an engine error.

### 5.4 `src/engines/adapters/convert-document.ts` (LibreOffice; no python)

- Spawns `/usr/bin/libreoffice` (the registry's probe path) `--headless --convert-to pdf --outdir <tmpdir> <source>` with a fresh tmpdir per run, maxBuffer/timeout conventions of the existing bridges; reads the produced PDF bytes; emits them plus `{engineVersion}` parsed from `libreoffice --version` once (cached per process).
- Convertible inputs: extensions `.odt .fodt .docx .rtf .txt .md .csv .ods .fods .xlsx .pptx .odp` (per the LO Writer/Calc/Impress import filters). Everything else → 422 `artifact "<name>" is not convertible to PDF (no LibreOffice import filter for this kind)`. A `.pdf` input → 422 `artifact "<name>" is already a PDF`. LO crash/timeout → honest 422 envelope with the stderr tail; the tmpdir is cleaned in a `finally`.
- **Byte-determinism NOT claimed**: PDFs embed creation timestamps; re-conversion appends a new revision with a different contentHash and that is the honest record. The harness does NOT pin LO bytes (§7); the derive route does not pretend idempotence.

## 6. Platform core (W3-f owns; pure, ADR-0002)

`src/core/cpm.ts` — frozen:

```ts
export interface CpmActivity { id: string; name: string; durationDays: number; predecessorIds: string[] }
export interface CpmActivityResult {
  activities: Array<{ id: string; name: string; durationDays: number;
    es: number; ef: number; ls: number; lf: number; totalFloat: number; critical: boolean }>;
  criticalPath: string[]; durationDays: number;
}
export function analyzeCpm(activities: CpmActivity[]):
  { ok: true; value: CpmActivityResult } | { ok: false; error: string };
```

Forward pass (es = max(ef of predecessors), ef = es + duration), backward pass (lf = min(ls of successors), ls = lf − duration), totalFloat = ls − es, critical = float 0, `criticalPath` = topologically-ordered critical ids, `durationDays` = project finish. Errors verbatim-joined (§3.1 messages). Zero-duration activities allowed (milestones). Hand-computed unit fixtures (W3-f): the classic A(3)→C(4)→E(3) / B(2)→D(5)→F(1) graph with D→F→E dependency chosen so the critical path is pinned — at least 3 fixtures incl. a cycle error, an unknown-predecessor error and a diamond dependency graph with hand-derived floats; pin exact expected values in tests.

`src/core/analysis-schemas.ts` — zod for §3.1/3.2/3.3 with the exact messages; consumed by the create/analyze routes AND mirrored by the python adapters (which additionally defend themselves — invalid shapes produce the honest envelope, never a crash).

## 7. Validation harness (W2-f extends `tests/validation/corpus-manifest.json` + `src/engines/validation/`)

New cases (all with derivation-audit strings like the existing 39; every success case runs twice — byte-identical enforced — EXCEPT any LibreOffice case, which runs once and asserts structure, not bytes):

1. **fe-mesh bracket-solid.step** — tet count pinned (record observed), divergence volume vs closed form 36000−960π with the linear-tet bias honestly quantified at the pinned tolerance **2%** (observed 0.92% at default sizes; MeshSizeMax 4.0), quality fields present, `solids[0].ref == "step:solid:0"`.
2. **fe-mesh two-solids.step** — planar: divergence volume EXACT by derivation at analytic tolerance (rel ≤ 1e-12 expected), per-solid tet counts + mesh volumes pinned, two solids in order.
3. **fe-mesh honest errors** — `bracket.step` (geometry-free) refusal substring; non-model file refusal substring.
4. **powerflow closed-form case** — 2-bus lossless line (r=0, x=0.1 Ω/km, 10 km, ext grid 1.0 pu, load P=2.0 MW, Q=0): exact high-branch solution V₂ = √((1+√(1−4p²x²))/2) with p = P/baseMva, x = xΩ/baseZ — hand derivation string in the manifest; pinned at rel ≤ 1e-6; angle checked symmetric. Also loss ≈ 0 pinned at 1e-9.
5. **powerflow honest error** — islanded bus (load on a bus with no line path) → refusal substring.
6. **DES closed-form case** — 3 jobs × 2 machines flow-shop (J1: 2+4, J2: 3+2, J3: 1+5; FIFO) → makespan **13** hand-derived (event trace in the derivation string), per-resource busy 6/11, utilization pinned.
7. **DES honest error** — job referencing an absent resource is schema-refused upstream (zod), the harness asserts the route-level 422 shape (the adapter itself can assume validated input; defense-in-depth still required by §5.3 conventions).
8. **CPM platform case** — driven through the `analyze_schedule` broker op (not an engine): hand-derived fixture with pinned critical path + floats, double-run byte-identical (it is pure JSON assembly), engineKey asserted ABSENT in the execution record.

Registry (`src/engines/registry.json`): additive `validation {cases, lastRun, result}` fields on `gmsh`, `pandapower`, `simpy`, `libreoffice` after a green run (state vocabulary unchanged; `libreoffice` gains `validation` only for conversion — detection already real). Report writers extend to the new case kinds; `bun run validate:engines` stays the single entry point and its all-skip path (EOS_PYTHON=/nonexistent) must stay honest (LibreOffice cases skip on `EOS_LIBREOFFICE=/nonexistent` in the same style).

## 8. API + event contract (W3-f owns routes; thin wrappers over broker cores — the Phase-4 route pattern)

| Route | Semantics |
|---|---|
| `POST /api/projects/[id]/artifacts/[aid]/fe-mesh` | 201 `{femesh}` — broker `fe_mesh` core; 404/400/422 per the frozen messages; ONE `femesh.derived` audit event |
| `POST …/powerflow` | 201 `{powerflow}`; ONE `powerflow.derived` |
| `POST …/simulate` | 201 `{sim}`; ONE `sim.completed` |
| `POST …/convert-document` | 201 `{pdf}` (download via the existing artifact download route); ONE `document.converted` |
| `POST …/analyze-schedule` | 201 `{analysis}`; ONE `schedule.analyzed` |
| `POST /api/projects/[id]/schedules` | create schedule artifact: body = §3.1 JSON (zod-validated verbatim 422s) → registers artifact kind `schedule` with the canonical JSON bytes as revision 1 (contentHash normal); 201 `{artifact}`; ONE `schedule.created` |
| `POST /api/estimates/[id]/recompute` | see §9 |

Every derive route: 422s verbatim from `BrokerRefusalError`; existing derive routes (quantities/mesh) byte-stable — AC-P5-09 pins them via the existing four scripts.

## 9. Estimate recompute (the known-limitation #7 closure — W3-f owns route + core logic)

`POST /api/estimates/[id]/recompute {}`:

- 404 unknown estimate; must be `approved` else 422 verbatim `only approved estimates can be recomputed into a revised draft (this estimate is "<status>")`.
- Staleness gate: at least one source artifact behind the estimate's quantity rows must be stale (the Journey-G marks already computed) else 422 verbatim `nothing to recompute: no quantity source behind this estimate is stale` — an honest dead end, surfaced as such in the UI copy (never a dead button: the button renders only when a stale source exists, and the 422 is defended server-side regardless).
- Effect: create a NEW draft estimate — title `<original> — revised draft`, same project; lines rebuilt from the CURRENT quantity rows of the project (the same row-selection semantics as the estimate-creation flow), priced at CURRENTLY-effective rates (chosen rate ids recorded per line); totals via the existing `estimateTotals` core; the original estimate is untouched (stays `approved`, its lines frozen). Deterministic server math, ledger-style.
- Audit: exactly ONE `estimate.recomputed {action:"recompute", fromEstimateId, staleSourceArtifactIds, newDraftId}` event.
- The recomputed draft flows through the EXISTING estimate machinery (in_review → approve → export). No estimate-model schema change (the link lives in the audit trail + title convention — ratified by TL).

## 10. Explicit exclusions (honest scope — recorded, not hidden)

- No new workflow templates (ops are composable; template authoring is Phase-5b).
- No FEA solver (Code_Aster/Elmer): FE MESHING ships; solving is a later phase on the same broker path.
- No stochastic DES distributions (fixed durations only — deterministic hand-checkable ground truth).
- No loop/network power flow (single external grid, radial; transformers/genmodels out).
- No PDF page counting, text extraction or preview rendering (no poppler in the sandbox — not claimed).
- No Gantt editing/drag interactions (read-only bars + table + critical-path highlight).
- No GIS/EE-desktop/CFD adapters (registry rows stay `planned`; QGIS/KiCad/OpenFOAM… are Phase-5b+ investigation, unchanged).
- No auth/PostgreSQL/packaging (Phase 6 concerns, unchanged).

## 11. UI contract (W1-f owns)

Three new workspace components + `nav.tsx`/`project-workspace.tsx` wiring (planned badges and toasts for the three entries are REMOVED — they become real tabs: `sim`, `controls`, `docs`), `api.ts` client fns, and the **cache-nudge convention applied to every new mutation** (each workspace's derive/convert/analyze actions refresh the project-level caches — the Phase-4 Artifacts-tab lesson is a standard now, not a fix):

- **`sim-workspace.tsx`** (Simulation & Verification): capability cards (FE mesh / power flow / discrete-event), each with an input picker (model artifacts for FE mesh; dataset JSON artifacts for network/scenario — the route validates, the picker filters generously and the 422s surface verbatim), Run buttons, and a results register (this project's `fe-mesh`/`analysis` artifacts) with provenance bar (engine badge, version, adapter hash, duration), expandable verbatim stdout/stderr tails, staleness banner + Regenerate (the Studio pattern), derived-from link chips.
- **`docs-workspace.tsx`** (Documents & Deliverables): deliverable register (kinds document/report/drawing/pdf + office extensions), review-state badges from the EXISTING revision approval machine, "Convert to PDF" on convertible artifacts (real route), PDF results as register rows with download links (existing download route), a callout stating conversions embed timestamps (re-runs produce new revisions — honest copy).
- **`controls-workspace.tsx`** (Project Controls): schedule register (`schedule` kind), "New schedule" dialog (activity editor: id/name/duration/predecessors → canonical §3.1 JSON through `POST …/schedules`), "Analyze" action → CPM analysis artifact, analysis view: activity table (ES/EF/LS/LF/TF) with critical-path highlight, read-only CSS Gantt bars scaled to project duration, critical-path chip list; Estimates panel: approved estimates WITH stale sources get a "Create revised draft" action → recompute route → toast names the absorbed stale sources; estimates without stale sources render the honest copy (no button).
- Mobile 390px, dark mode, sticky-footer standard, `sr-only` labels, loading/error states per the product standard; no new shadcn components beyond what exists in `src/components/ui`.

## 12. Acceptance items (TL verifies each with a command + observed result; scripts in git)

| ID | Item |
|---|---|
| AC-P5-01 | FE-mesh derive round-trip: STEP → `fe-mesh` artifact rev, harness case green (pinned counts, closed-form volume vs divergence volume, double-run byte-identical), Journey-G staleness on source revision, honest geometry-free/non-model/missing-libs refusals |
| AC-P5-02 | Power-flow round-trip: network JSON → `analysis` artifact, closed-form case green (V₂ high-branch exact, loss ≈ 0), convergence + islanded honest errors, results verbatim from the engine |
| AC-P5-03 | DES round-trip: scenario JSON → `analysis` artifact, makespan-13 closed-form case green, utilization pinned, FIFO determinism double-run |
| AC-P5-04 | Document conversion: fodt fixture → `pdf` derived artifact, provenance + download round-trip, non-byte-determinism honestly recorded (two runs → two hashes, no idempence claim), non-convertible/PDF-input 422s verbatim |
| AC-P5-05 | CPM: schedule create → analyze round-trip, hand-computed fixture green (critical path + floats pinned), byte-deterministic artifact, engineKey absent in the execution record, staleness cascade on schedule edit → analysis stale |
| AC-P5-06 | Estimate recompute: approved + stale → revised draft with current quantities/rates, original untouched, exactly one `estimate.recomputed` audit event, non-approved 422 + nothing-stale 422 verbatim |
| AC-P5-07 | Single execution path holds: all six new routes are thin wrappers over broker cores, workflow definition zod accepts the five new ops with the right input shapes, existing derive routes byte-stable |
| AC-P5-08 | Registry + Engines page: validation fields on gmsh/pandapower/simpy/libreoffice after the green harness run; probe honestly reports the four installed |
| AC-P5-09 | Regressions: `e2e-takeoff` 27 · `e2e-p3-hardening` 40 · `e2e-p2-modelviewer` 67 · `e2e-p4-workflows` 49 all PASS; `bun test src/` 0 fail; `bun run validate:engines` extended corpus all pass / honest skips; lint 0 · typecheck clean |
| AC-P5-10 | Browser journeys: S&V run → result card with provenance + logs; Docs convert → register + download; Controls schedule create → analyze → gantt + critical path + recompute; Artifacts tab refreshes without reload (cache-nudge); mobile 390px, dark mode, footer standard; zero console/page errors |

## 13. Lane split (parallel; frozen interfaces above are the only cross-lane dependencies)

- **W1-f** (UI): the three workspaces, nav/tab wiring, api.ts fns, cache-nudges — consumes only the frozen §8 route shapes + §2 response formats.
- **W2-f** (engines): §5 adapters + bridges, §4 broker ops + cores, §7 harness + fixtures (`tests/fixtures/cover-sheet.fodt`, `powerflow-2bus.json`, `des-flowshop.json`, `schedule-…​.json` — committed), registry validation fields, engine-inventory/validation-report doc updates.
- **W3-f** (data plane): §6 pure core (cpm.ts + tests, analysis-schemas.ts), §8 routes (incl. `POST …/schedules`), §9 recompute, `artifact-meta.ts` kind additions, workflow.ts zod/vocabulary extension to match §4 exactly.

The existing dev-DB demo dataset ("Harbour View Extension") is NOT to be destroyed; acceptance scripts create and remove their own probe projects (`scripts/dev-db-cleanup.ts` pattern).

## 14. Slice-22 addendum — Continuum FEA v1: plane-stress solving via scikit-fem (BSD-3)

§10's "No FEA solver" exclusion closes for the PLANE-STRESS lane. The engine is
**scikit-fem 12.0.2** (BSD-3-Clause, OSI-verified, pip-installable, numpy+scipy
only — the clean-license path the GPL incumbents could not offer; probe record
below). Amendments are ADDITIVE to §2/§3/§4/§5/§8/§12; nothing frozen above
changes.

### 14.1 Verified engine reality (TL probes, 2026-10-28, dev host)

| Probe | Result |
|---|---|
| scikit-fem 12.0.2 import (venv python 3.12) | OK; deps numpy 2.1.3 + scipy 1.18.1 only |
| Plane-stress uniform tension, roller BC (400×200×10 mm, E=200 000, ν=0.3, σ=10 MPa on the right edge; left edge ux fixed incl. midside dofs + one corner uy) | **machine-precision**: u_x(400,100) = 0.020000000000 vs σW/E = 0.02 (12-decimal match); u_y = −νσy/E exact — the uniform field is reproduced bit-for-bit by tri6 elements |
| Poisson manufactured solution (sin πx sin πy, tri6, refined 5) | midpoint 1.0000009024 (rel 9.0e-7) → refined 6: 5.6e-8 — textbook P2 convergence |
| Determinism | double-run solutions **array-identical** (direct sparse solve, no iteration) |
| **REJECTED — OpenSeesPy 3.8.0.0/3.7.1.2 (the originally-probed FEA engine)** | the `elasticBeamColumn` lane is machine-precision (cantilever PL³/3EI = 16.000000000000004, end forces exact) BUT (a) the bundled LICENSE.md: "free for research, education, and internal use. Commercial redistribution … **such as … a cloud-based service that uses import openseespy, requires a license**" — this product is exactly that class; the registry's pending license review closes REJECTED (the bpy/PyMuPDF precedent discipline); (b) the `truss` element is broken in both builds on CPython 3.12 (canonical docs example → singular matrix; the element object exists but contributes zero stiffness) — recorded as upstream evidence, not ours to fix. The registry row keeps state `planned` with the rejection recorded; no adapter ships. |

### 14.2 Input schema `eos-fea-model/1` (amends §3; zod in `src/core/analysis-schemas.ts`, adapter mirrors)

```json
{ "format": "eos-fea-model/1", "name": "string 1..200",
  "thicknessMm": "number > 0",
  "domain": { "widthMm": "number > 0", "heightMm": "number > 0" },
  "material": { "elasticModulusMpa": "number > 0", "poissonRatio": "number 0..0.49" },
  "supports": [ { "edge": "left|right|bottom|top", "ux": "bool", "uy": "bool" } ],
  "loads": [ { "edge": "left|right|bottom|top", "tractionMPa": "number (uniform, outward normal)",
                                            "shearMPa": "number (uniform, CCW tangent)" } ] }
```

1..4 supports (each must fix at least one DOF; duplicate edges refused), 1..8
loads (duplicate edges refused). **Amended before first ship (TL escalation,
recorded honestly): the original draft carried normal traction only — the
probe's "cantilever" fixture exposed the gap (a normal traction on the tip
edge is AXIAL, the plate never bends); each load now carries EITHER component
(both optional) with at least one non-zero required.** Tangent convention:
the CCW tangent per edge (left (0,+1) · right (0,−1) · bottom (+1,0) · top
(−1,0)) — positive shear on the right edge points DOWN, the natural
cantilever-tip reading. Verbatim joined error style `invalid FEA model: path:
msg; …`. The rigid-body constraint check is DETERMINISTIC in the adapter
(§14.4): a model whose supports do not kill all three 2D rigid modes is
refused honestly, never solved.

### 14.3 Broker op (amends §4)

| op | inputs | parameters (defaults) | output kind + format | engineKey |
|---|---|---|---|---|
| `solve_fea` | `{artifactId}` (eos-fea-model/1 JSON dataset) | `{meshRefinement: 4}` (integer 1..7 — the uniform tri mesh refinement level) | `"analysis"` / `eos-fea/1` | `"scikit-fem"` |

Audit action `fea.solved`; every BrokerOutcome field per §4's rules.

### 14.4 Output document `eos-fea/1` (amends §2; byte-deterministic by construction)

`{format, sourceArtifactName, analysis:"plane_stress", mesh:{elementType:"tri6", refinement, elementCount, nodeCount}, thicknessMm, elasticModulusMpa, poissonRatio, samples:[{x,y,ux,uy}] (the 4 domain corners + center, ascending x then y), maxDisplacementMagnitudeMm, stress:{sigmaXxMinMpa, sigmaXxMaxMpa, vonMisesMaxMpa} (per-element centroid statistics), generatedBy:{engineKey,engineVersion,adapterScript,adapterHash}}`

### 14.5 Adapter spec (amends §5; `src/engines/adapters/fea_solve.py` + `fea.ts`)

- Same stdin/argv JSON protocol as §5.2: argv[1] = stored model path; stdout
  = the payload above or `{"error": …}` exit 1. The engine is honest about
  under-constrained models: the rigid-mode check (the three 2D rigid
  displacement fields evaluated against the fixed DOF set — pure math on the
  mesh + support pattern) precedes the solve; a surviving rigid mode →
  `the supports do not constrain the model's rigid-body motion (…naming the
  free mode(s)…) - an unconstrained model cannot be solved, and simulated
  results are not an option`.
- Mesh: `MeshTri().refined(meshRefinement).scaled((widthMm, heightMm))` —
  deterministic, no randomness anywhere in the pipeline (direct solver).
- Element: `ElementVector(ElementTriP2())` (tri6); plane-stress Lamé
  (λ_ps = 2μλ/(λ+2μ)); thickness multiplies BOTH stiffness and load
  (thickness-consistent — the probe caught the 10× error class when only the
  load carries t).
- Supports: per-edge DOF sets (ALL dofs on the edge incl. midside — the
  vertex-only variant leaves the edge free to breathe between nodes and
  reads ~1% soft; the probe caught this class too).
- Loads: uniform traction per edge: (tractionMPa·n̂ + shearMPa·t̂)·t·v on the
  edge's facets (outward normal n̂, CCW tangent t̂; positive tractionMPa =
  tension AWAY from the domain, positive shearMPa = the CCW tangent
  direction).
- Stress: per-element σ = C·B·u at the centroid, von Mises per element; the
  document carries min/max σ_xx and max von Mises across elements.
- Determinism: fixed everything; the harness double-run pins byte-identity.

### 14.6 Acceptance (amends §12)

| ID | Item |
|---|---|
| AC-FEA-01 | Uniform-tension harness case: machine-precision pins (sample ux/uy abs ≤ 1e-9 vs the closed form; vonMisesMax = σ), double-run byte-identical |
| AC-FEA-02 | Cantilever-plate harness case (end SHEAR): tip sample vs the Timoshenko closed form (PL³/3EI + PL/κGA), rel tolerance pinned from the measured convergence (the gmsh-volume precedent — observed, derived, not hand-waved) |
| AC-FEA-03 | Honest refusals: under-constrained model (rigid-mode refusal verbatim), wrong-format dataset (the §14.2 zod 422 verbatim), non-JSON/absent engine (EngineUnavailableError class) |
| AC-FEA-04 | e2e p5 block: fixture upload → POST …/fea → 201 with pinned document fields; the two 422 gates + 401 gate; exactly one `fea.solved` audit event; the analysis artifact registers in the Simulation workspace |
| AC-FEA-05 | Registry: scikit-fem row (BSD-3, simulation domain) reaches `tested` with the probe evidence; OpenSees row's license review closes REJECTED with the bundled-license quote; engines-requirements pins scikit-fem==12.0.2 |

### 14.7 Honest exclusions (extends §10)

- Plane STRAIN, 3D elasticity, von-Mises-plasticity, modal/buckling, mesh
  adaptivity: out of scope (v1 is linear plane stress; each later lane gets
  its own addendum).
- Non-rectangular domains, holes, point/body loads: out of scope (the
  rectangular plate is the v1 "drawn-room reality"; DXF-domain meshing is a
  future lane).
- OpenSees/Code_Aster/Elmer: rejected on license (14.1); not revisited
  without a license change upstream.

## 15. Slice-23 addendum — Stormwater drainage v1: SWMM5 via pyswmm (BSD-2 + CC0/MIT)

The Phase-5 long tail's named clean-license GIS candidate opens: a **linear
drainage-network simulation** (impervious catchment → junction → rectangular
conduit → free outfall under one uniform rain event). The engine is EPA SWMM5
(public domain per the USEPA repo, CC0-dedicated in the OWA distribution) driven
in-process by **pyswmm 2.2.0 + swmm-toolkit 0.17.0** (wheel-verified 2026-10-28:
pyswmm `License-Expression: BSD-2-Clause` + OSI classifier; swmm-toolkit
`CC0-1.0 AND (MIT OR Apache-2.0)` with the bundled engine LICENSE.md naming the
MIT/Apache split — NO cloud-service restriction clause anywhere, contrast
14.1's openseespy rejection). Amendments are ADDITIVE to §2/§3/§4/§5/§8/§12;
nothing frozen above changes.

### 15.1 Verified engine reality (TL probes, 2026-10-28, dev host)

| Probe | Result |
|---|---|
| pip coexistence dry-run + install | adds ONLY aenum 3.1.17 + julian 0.14 + swmm-toolkit 0.17.0 (compiled manylinux, self-contained — no GLU bridge needed); numpy/scipy/pandas untouched; all six existing engine pins re-import OK (the openseespy wipe class does not recur) |
| Volume conservation (1 ha, 100% impervious, Dstore 0, uniform 25 mm/hr × 2 h, kinematic wave, 10 s routing step) | outfall volume **500.0219 m³ vs the hand truth 500 m³ (rel 4.4e-5)** through the whole nonlinear-reservoir + kinematic-wave chain; peak runoff 0.0694522 vs the i·A asymptote 0.0694444 (rel 1.1e-4) |
| Manning equilibrium (B=0.5 m, n=0.015, S=0.005, RECT_CLOSED) | max depth **0.14486048 m vs the hand-solved normal-depth cubic 0.144866657 m (rel 4.3e-5)** — the kinematic-wave equilibrium reproduces the Manning closed form to 4 decimals |
| Engine continuity (parsed from the .rpt) | runoff −0.012 % · routing −0.055 % (SWMM's own honesty check, both far under its 1 % warning) |
| Determinism | double-run **byte-identical** (fixed steps, no RNG anywhere) |
| **INP-generation truth 1 — the recording-interval trap** | an `INTENSITY` rain gage consumes its TIMESERIES **per recording interval**: a two-entry series (25 then 0) rains for exactly ONE 5-minute interval (observed 20.9 m³ = 2.083 mm — rel error 0.96 caught by the volume balance). The adapter spreads a uniform event as per-interval entries at the gage's fixed 5-minute cadence — deterministic by construction. |
| **INP-generation truth 2 — [SUBAREA] arity** | swmm 5.2.4 (via swmm-toolkit 0.17.0) rejects the 6-token [SUBAREA] line with `ERROR 203: too few items`; the 7-token form (with RouteTo `OUTLET`) parses. Recorded from the live engine, not inferred from docs. |

### 15.2 Input schema `eos-swmm-model/1` (amends §3; zod in `src/core/analysis-schemas.ts`, adapter mirrors)

```json
{ "format": "eos-swmm-model/1", "name": "string 1..200",
  "simulation": { "durationMin": "int 1..1440 (post-rain drainage included)" },
  "rainfall": { "intensityMMperHr": "number > 0", "durationMin": "int 5..720, multiple of 5 (the gage cadence)" },
  "subcatchments": [ { "id": "string 1..32", "outletNodeId": "node id",
      "areaHA": "number 0.0001..1000", "widthM": "number 0.1..10000",
      "slopePct": "number 0.01..100", "manningNImperv": "number 0.001..1",
      "depressionStorageMM": "number 0..500" } ],
  "nodes": [ { "kind": "junction", "id": "…", "invertElevM": "number", "maxDepthM": "number > 0" }
           | { "kind": "outfall", "id": "…", "invertElevM": "number" } ],
  "conduits": [ { "id": "…", "fromNodeId": "…", "toNodeId": "…",
      "lengthM": "number 1..100000", "manningN": "number 0.001..1",
      "slopePct": "number > 0 (drives the inverts the engine sees)",
      "heightM": "number 0.01..20", "widthM": "number 0.01..50" } ] }
```

1..50 subcatchments, 1..200 nodes, 0..250 conduits. Refused before the engine:
zero-intensity storms ("produces no runoff — and simulated results are not an
option", the §14.2 zero-load precedent), duplicate ids, dangling
subcatchment/conduit references, and **a network with no outfall** (the
rigid-mode analog: "the network has no outfall - runoff cannot leave the model
(and simulated results are not an option)"). Zero conduits is legal (a catchment
can outlet directly to an outfall). Verbatim joined error style
`invalid SWMM model: path: msg; …`.

### 15.3 Broker op (amends §4)

| op | inputs | parameters (defaults) | output kind + format | engineKey |
|---|---|---|---|---|
| `run_swmm` | `{artifactId}` (eos-swmm-model/1 JSON dataset) | `{routingStepSec: 10}` (int 1..60 — the kinematic-wave routing step, the numerical-refinement dial) | `"analysis"` / `eos-swmm/1` | `"pyswmm"` |

Audit action `swmm.ran`; every BrokerOutcome field per §4's rules.

### 15.4 Output document `eos-swmm/1` (amends §2; byte-deterministic by construction)

`{format, sourceArtifactName, analysis:"drainage", rain:{intensityMMperHr, durationMin, totalDepthMm, totalVolumeM3}, routing:{model:"kinematic_wave", routingStepSec}, continuity:{runoffErrorPct, routingErrorPct} (parsed from the engine's own .rpt), outfallVolumeM3 (trapezoid-integrated over the stepping loop), volumeBalancePct (our honesty metric: 100·(outfall−rain)/rain), peaks:{maxRunoffCms (largest subcatchment runoff), maxConduitFlowCms}, depths:[{id, maxDepthM}] (every node + conduit, ascending id — the Manning pin rides here), generatedBy:{engineKey,engineVersion,adapterScript,adapterHash}}`

### 15.5 Adapter spec (amends §5; `src/engines/adapters/swmm_run.py` + `swmm.ts`)

- Same stdin/argv JSON protocol as §5.2: argv[1] = stored model path; the model
  is validated (§15.2 mirrored) + graph-checked (references, ≥1 outfall) BEFORE
  the engine opens; `swmm_open` failures map to the honest engine-refusal
  envelope, never a raw traceback.
- The adapter WRITES a canonical INP into a temp dir (never the repo): fixed
  start date, fixed options (KINWAVE, SI/CMS, 60 s wet step, parameters'
  routing step), the [SUBAREA]/[INFILTRATION] constants pinned (100% impervious
  — the §15.6 exclusion), conduit inverts DERIVED from slopePct (to-node
  invert = from-node invert − length·slope; the from-node invert defaults so
  the outfall sits at 0), the uniform rain spread per 15.1-truth-1.
- Stepping loop over `pyswmm.Simulation` with trapezoid volume integration of
  outfall inflow (first sample carries no dt); peaks/max depths tracked in
  doubles; continuity parsed from the .rpt text; temp dir removed after parse.
- Determinism: fixed everything; the harness double-run pins byte-identity.

### 15.6 Acceptance (amends §12)

| ID | Item |
|---|---|
| AC-SW-01 | Runoff-balance harness case: outfall volume vs the hand truth `i·A·t` (rel ≤ 1e-3; probe-observed 4.4e-5), peak runoff vs the i·A asymptote (rel ≤ 1e-2; observed 1.1e-4), engine continuity magnitudes ≤ 0.5 %, double-run byte-identical |
| AC-SW-02 | Manning-equilibrium harness case (steeper network: 50 mm/hr × 2 ha, B=0.8, n=0.013, S=1 %): the node max-depth pin vs the hand-solved normal-depth cubic 0.1809516 m (abs ≤ 0.005; the kinematic-wave equilibrium), peak conduit flow vs i·A (rel ≤ 3 %, the surge allowance), volume balance rel ≤ 1e-3 |
| AC-SW-03 | Honest refusals: no-outfall network (the §15.2 refusal verbatim), zero-intensity storm, wrong-format dataset (zod 422 verbatim), non-JSON/absent engine (EngineUnavailableError class) |
| AC-SW-04 | e2e p5 block: fixture upload → POST …/swmm → 201 with pinned document fields; the two 422 gates + 401 gate; exactly one `swmm.ran` audit event; the analysis artifact registers in the Simulation workspace |
| AC-SW-05 | Registry: pyswmm row (BSD-2, gis domain) reaches `tested` with the probe evidence + validation block; the swmm (EPA) row's note records the in-process lane; engines-requirements pins pyswmm==2.2.0 + swmm-toolkit==0.17.0 |

### 15.7 Honest exclusions (extends §10)

- Pervious-area hydrology (infiltration Horton/Green-Ampt, evaporation,
  groundwater): out of scope v1 — the subcatchments are 100 % impervious
  (the closed forms live there; a pervious lane gets its own addendum).
- Non-uniform rainfall (hyetographs), multiple rain gages, snowmelt: out of
  scope (one uniform event per run, by construction).
- Dynamic-wave routing, surcharge/pressurization, pumps, orifices/weirs,
  storage/treatment nodes, water quality: out of scope v1.
- Non-rectangular cross-sections (circular/trapezoid), multiple outfall types
  (FIXED/NORMAL/TAPE), US units: out of scope v1 (RECT_CLOSED under open-
  channel depth + FREE outfalls + SI only — each its own future lane).

## 16. Slice-29 addendum — CFD v1: steady scalar transport via SfePy (BSD-3)

The Slice-28 license-first probe opened this lane (BSD-3 verified on the
sdist's own PKG-INFO + LICENSE); §10's "no CFD" exclusion now closes for the
STEADY SCALAR-TRANSPORT class. The engine is **SfePy 2026.3** (sdist-built
cp312 wheel, numpy/scipy + pypardiso-free direct solves). Amendments are
ADDITIVE to §2/§3/§4/§5/§8/§12; nothing frozen above changes.

### 16.1 Verified engine reality (TL probes, 2026-10-30, dev host)

| Probe | Result |
|---|---|
| sfepy 2026.3 import (venv python 3.12) | OK |
| Channel transport closed form (L=2 m, H=0.5 m, a=0.05 m/s, D=0.01 m²/s → Pe=10; inlet 1, outlet 0, zero-flux walls; Q2 square-element meshes): Linf by longer-axis divisions N: 8→2.62e-3, 16→2.51e-4, 32→1.96e-5, 64→1.38e-6, 128→9.14e-8 | textbook O(h³) Linf (Q2) |
| y-independence of the channel solution (the no-flux wall class) | spread 3.0e-15 over y at fixed x — machine zero; the 2D assembly is exactly y-uniform |
| Uniform case (inlet = outlet = 1 → u ≡ 1) | max |u−1| = 4.5e-14 — machine class |
| General closed form u(x) = u_in + (u_out−u_in)·(e^(Pe·x/L)−1)/(e^Pe−1), Pe = a·L/D | reproduced at the 5 centerline stations to ≤ 4.8e-6 (N=32) |
| **Oscillation boundary (Q2, EMPIRICAL)**: element Péclet Pe_h = a·h/(2D), h = L/N | monotone through Pe_h = 2.0 (excursion 3.8e-15); over-shoot 7.5e-3 at 2.5; 0.16 at 4.0 → **the adapter refuses Pe_h > 2** (the probed-monotone bound). Cross-check on P1: monotone ≤ 1, oscillatory at 2 — the classic textbook criterion reproduced by the same probe, which validates the method |
| Determinism | double-run solutions array-identical (direct sparse solve) |
| Cost | r=7 (N=512, 263,425 dofs) = 12.5 s wall; r=4 (N=32) = 0.01 s |
| API traps caught live (never remembered) | `Term.new` takes the BARE term name (`dw_laplace(m.D, v, u)`, no `.i.Omega` suffix); `pb.set_solver(Newton({}, lin_solver=ScipyDirect({})))` required before `pb.solve()`; nodal values = `state().reshape(-1)` aligned with `field.get_coor()`; `evaluate_at` returns shape (n,1,1); velocity material shape (2,1) for `dw_advect_div_free`; block mesh cells are `2_4` quads (Q2 field = 9-node quads) |

### 16.2 Input schema `eos-cfd-transport-model/1` (amends §3; zod in `src/core/analysis-schemas.ts`, adapter mirrors)

```json
{ "format": "eos-cfd-transport-model/1", "name": "string 1..200",
  "domain": { "lengthM": "number > 0", "heightM": "number > 0" },
  "diffusivityM2PerS": "number > 0",
  "velocityMPerS": "number > 0 (axial, left-to-right — the lane's declared direction)",
  "inletConcentration": "finite number (the x=0 Dirichlet value)",
  "outletConcentration": "finite number (the x=L Dirichlet value)" }
```

The walls (y=0, y=H) carry zero diffusive flux (the natural class — no term
assembled). Verbatim joined error style `invalid transport model: path: msg; …`
(mirroring §14.2). A non-positive velocity is refused at the schema (the v1
lane declares left-to-right transport; the pure-diffusion limit and
right-to-left flow are each their own future lane).

### 16.3 Broker op (amends §4)

| op | inputs | parameters (defaults) | output kind + format | engineKey |
|---|---|---|---|---|
| `solve_transport` | `{artifactId}` (eos-cfd-transport-model/1 JSON dataset) | `{meshRefinement: 4}` (integer 1..7) | `"analysis"` / `eos-cfd-transport/1` | `"sfepy"` |

Mesh rule (deterministic): N = 8·2^(r−1) element divisions on the LONGER
axis; the shorter axis gets max(1, round(N·shorter/longer)) divisions —
square elements; Q2 (approx_order 2) on the `2_4` block mesh. Audit action
`transport.solved`; every BrokerOutcome field per §4's rules.

### 16.4 Output document `eos-cfd-transport/1` (amends §2; byte-deterministic by construction)

`{format, sourceArtifactName, analysis:"scalar_transport", mesh:{elementType:"quad", approximation:"Q2", refinement, elementCount, nodeCount}, domain:{lengthM, heightM}, diffusivityM2PerS, velocityMPerS, inletConcentration, outletConcentration, pecletNumber (a·L/D), meshPecletNumber (a·h/(2D) at the actual mesh), samples:[{x, y, concentration}] (the 5 centerline stations x ∈ {L/8, L/4, L/2, 3L/4, 7L/8} at y = H/2, ascending x), minConcentration, maxConcentration (over all dofs — the honest oscillation visibility), generatedBy:{engineKey, engineVersion, adapterScript, adapterHash}}`

### 16.5 Adapter spec (amends §5; `src/engines/adapters/transport_solve.py` + `cfd.ts`)

- Same stdin/argv JSON protocol as §5.2/§14.5: stdin =
  `{storagePath, parameters}`; stdout = the payload or `{"error": …}` exit 1.
- Terms: `dw_laplace(m.D, v, u)` + `dw_advect_div_free(m.vel, v, u)` (the
  velocity is constant, hence divergence-free — the term's own precondition
  holds by construction); Dirichlet via EssentialBC on the x-facet regions;
  walls natural.
- Honest refusals, verbatim:
  - invalid model → the mirrored-§16.2 defense message;
  - **mesh-Péclet refusal**: `the mesh does not resolve the transport boundary layer (element Péclet <Pe_h, %.3g> exceeds the stability bound 2) - refine the mesh (increase meshRefinement) or reduce the flow Péclet number; an oscillatory solution is not an option` — computed BEFORE the solve (h = L/N_x along the flow axis; the bound 2 is the probed-monotone value from §16.1, conservative against the observed 2.5 over-shoot);
  - sfepy not importable → the engine-unavailable class;
  - any solver failure / non-finite solution → the engine's own text verbatim,
    never a simulated result.
- Determinism: fixed block mesh, direct sparse solve, zero randomness; the
  harness double-run pins byte-identity of the emitted document.

### 16.6 Acceptance (amends §12)

| ID | Item |
|---|---|
| AC-CFD-01 | Channel harness case (Pe=10): closed-form pins at the 5 stations (u(x) = (e^Pe − e^(Pe·x/L))/(e^Pe − 1); abs ≤ 1e-4 at r=4 — observed 4.8e-6), peclet/meshPeclet pins, min/max pins, double-run byte-identical |
| AC-CFD-02 | Uniform harness case (inlet = outlet = 1): u ≡ 1 at every station and every dof (abs ≤ 1e-12; observed 4.5e-14) — the machine-class assembly pin |
| AC-CFD-03 | Honest refusals: the mesh-Péclet refusal verbatim (a high-Pe model at the default refinement), wrong-format dataset (the §16.2 zod 422 verbatim), non-JSON/absent engine (EngineUnavailableError class) |
| AC-CFD-04 | e2e p5 block: fixture upload → POST …/transport → 201 with pinned document fields; the two 422 gates + 401 gate; exactly one `transport.solved` audit event; the analysis artifact registers in the Simulation workspace |
| AC-CFD-05 | Registry: the sfepy row reaches `tested` with the §16.1 probe evidence + validation block (3 harness cases); engines-requirements pins sfepy==2026.3; the openfoam row's note records that the pip-only CFD lane rides sfepy |

### 16.7 Honest exclusions (extends §10)

- Transient transport, cross-flow velocity components (v ≠ 0), space-varying
  velocity/diffusivity, volumetric sources, reactions/decay: out of scope v1
  (steady, uniform-property, source-free axial transport — each its own
  addendum).
- Pure diffusion (velocity ≤ 0): refused at the schema — the lane declares
  advective transport; the pure-diffusion limit is its own lane.
- Non-rectangular domains, unstructured meshes, adaptivity, SUPG/upwind
  stabilization: out of scope v1 (the rectangular channel + Q2 + the
  Pe_h ≤ 2 monotonicity gate is the frozen reality).
- Navier-Stokes, turbulence, buoyancy, multiphase: out of scope — separate
  lanes entirely (the registry's openfoam row stays the system-binary class).
