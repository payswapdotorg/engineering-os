# Capability Matrix

Owner: Worker 2 (Engines & Integration) · Date: **2026-10-21** · Adapter update: **2026-10-21 (W2-b)** · Validation update: **2026-10-21 (W2-c — benchmark harness, both quantity adapters validated 11/11)** · Tessellation update: **2026-10-21 (W2-d — eos-mesh/1 bridge, harness-validated incl. 9 mesh blocks)** · Companion to [engine-inventory.md](engine-inventory.md) · Contract: [ADR-0005](../adr/0005-engine-integration-contract.md) · Status vocabulary: `planned → installed → available → implemented → tested → verified → production-ready` (evidence-linked — never upgraded without a test, command output or acceptance item).

## Reading this matrix

- **Two capabilities reached `tested` on 2026-10-21 (W2-b): model-derived quantities from STEP (cadquery) and from IFC (IfcOpenShell)** — the first REAL engine adapters (registry states `tested` for both engines). Evidence: fixtures + analytic cross-checks + test names in [engine-inventory.md § First real engine adapters](engine-inventory.md#first-real-engine-adapters-w2-b-2026-10-21).
- **Both quantity adapters are benchmark-validated as of 2026-10-21 (W2-c)**: the validation harness (`src/engines/validation/`, corpus [`tests/validation/corpus-manifest.json`](../../tests/validation/corpus-manifest.json) — 11 cases: 5 STEP / 6 IFC) drives the real production bridge against hand-derived closed-form ground truth with set-equality, bitwise-determinism and honest-error enforcement; latest run **11 pass / 0 fail** (`bun run validate:engines`, evidence: [validation-report.md](validation-report.md)). The status vocabulary defines no `validated` state, so the capabilities remain `tested` with the harness evidence recorded here and in the registry's per-engine `validation` fields (state-vocabulary changes are the TL's call).
- **Model tessellation for the 3D viewer is `tested` (harness-validated) as of 2026-10-21 (W2-d)**: the eos-mesh/1 tessellation bridge (`src/engines/adapters/mesh.ts` → `step_mesh.py` / `ifc_mesh.py`) turns STEP/IFC into byte-deterministic viewer meshes; the same harness corpus pins element refs set-equal to the quantity ledger, per-element vertex/triangle counts, byte-determinism and divergence-theorem volumes vs closed forms (9 mesh blocks across 11 cases — planar exact, curved ≤ 1% pinned with observed errors recorded). See the [tessellation section in engine-inventory.md](engine-inventory.md#tessellation-adapters--the-eos-mesh1-bridge-w2-d-2026-10-21) and [validation-report.md](validation-report.md).
- **Everything else below is `planned`:** those engines are audited upstream (35 verified records) but no adapter exists yet (adapters land in Phase 2+ per ADR-0005), and only cadquery 2.6.1 / ifcopenshell 0.9.0.post1 (uv venv) and LibreOffice 25.2.3.2 (PATH) are installed on the dev host. Detection probes for the rest are specified and tested; adapter capabilities get their own states as evidence accrues. FreeCAD/Bonsai were investigated in this sandbox on 2026-10-21 (not importable, no binaries, no pip-installable distribution) — both stay `planned` for editor/authoring; this slice's geometry is served by cadquery/IfcOpenShell.
- **Platform capabilities (implemented now)** are listed at the end — these are the TL-provided foundation the engines plug into, with their real states.

## CAD (Phase 2 focus)

| Capability | Engine(s) | State | Target phase | Evidence / notes |
|---|---|---|---|---|
| **Model-derived quantities from STEP (per-solid volume, total surface area, bbox diagonal)** | **cadquery 2.6.1 (OCCT 7.8)** | **tested** (harness-validated) | 3 (shipped 2026-10-21 W2-b; validated 2026-10-21 W2-c) | REAL adapter `src/engines/adapters/step_quantities.py` (venv subprocess, JSON protocol, units parsed from the STEP header); bridge `src/engines/adapters/quantities.ts`; fixture `tests/fixtures/bracket-solid.step` (deterministic generator `make_fixture_bracket.py`); test "bracket-solid.step: engine values match hand-derived analytic closed forms (±2%)" — engine 32984.07105 mm³ vs analytic 36000−960π ≈ 32984.07105 (rel ~1e-14). Honest-failure test: `bracket.step` (0 solids) → `EngineUnavailableError`. **Harness-validated (W2-c): 5 STEP cases — 3 analytic closed-form solids (bracket rel 1.46e-14; Ø40×100 mm CYLINDER curved-surface area rel 5.49e-14 through the exact OCCT path; two-solids multi-solid case bitwise-exact incl. per-solid volumes, total area 5050 mm², bbox √15225) + 2 honest-error probes ("no solid geometry", non-model file)** — corpus `tests/validation/corpus-manifest.json`, regenerate `bun run validate:engines`, evidence [validation-report.md](validation-report.md). See [engine-inventory.md § W2-c](engine-inventory.md#validation-harness-w2-c-2026-10-21) |
| Parametric 3D modeling (headless scripting) | FreeCAD | planned | 2 | Registry `freecad` (LGPL-2.1, 1.1.4); `FreeCADCmd --version` probe; adapter = Phase 2 deliverable |
| 2D drafting (DXF/DWG read, DXF write) | LibreCAD | planned | 2 | Registry `librecad` (GPL-2.0, 2.2.1.6); arm's-length process |
| DWG conversion (DWG ↔ DXF compatibility boundary) | LibreDWG | planned | 2 | Registry `libredwg` (GPL-3.0, 0.14); CLI-only integration (dwg2dxf/dwgread/dwgwrite); FreeCAD limitation note |
| Technical drawing export (PDF/SVG) | FreeCAD (TechDraw), LibreCAD | planned | 2 | Same adapters; export via CLI where upstream supports it |
| 3D BIM host application | Blender | planned | 2 | Registry `blender` (GPL-2.0-or-later, 5.2.2); hosts Bonsai IFC authoring; `blender --version` probe |

## BIM (Phase 2/3)

| Capability | Engine(s) | State | Target phase | Evidence / notes |
|---|---|---|---|---|
| IFC authoring / native editing | IfcOpenShell + Bonsai (in Blender) | planned | 2 | Registry `ifcopenshell` (LGPL-3.0, 0.9.0 via PyPI); python-module probe tested |
| IFC model validation (schema + rules) | IfcOpenShell (python) | planned | 2/3 | Validation runs in broker-supervised process; results enter artifact graph with provenance (ADR-0005 rule 2) |
| **Model-derived quantity extraction (IFC)** | **IfcOpenShell 0.9.0.post1** | **tested** (harness-validated) | 3 (shipped 2026-10-21 W2-b; validated 2026-10-21 W2-c) | REAL adapter `src/engines/adapters/ifc_quantities.py`: IfcElementQuantity/BaseQuantities first (elementRef `#<GlobalId>`), geometric fallback via `ifcopenshell.geom` mesh (exact for planar solids, approximate for curved — recorded in `raw.method`); weight/time quantities skipped honestly. Tests: declared-value round-trip on `tests/fixtures/wall-quantities.ifc` (NetWeight=2880 kg present in fixture, proven skipped), mesh fallback vs analytic box (V=1.2 m³, S=14.0 m²) on `tests/fixtures/wall-geometry.ifc`, honest empty on `tests/fixtures/wall-stripped.ifc`; IFC tests auto-skip with a printed reason when the engine is absent. **Harness-validated (W2-c): 6 IFC cases — exact multi-element declared readback (wall-quantities 10/10 and two-elements 15/15 over 3 elements, must-skip NetWeight quantities enforced by set equality), planar mesh fallback at analytic tolerance (rel ≈ 1.9e-16), CURVED-column mesh fallback at the pinned 1% tolerance with observed error RECORDED (volume 0.3246%, area 0.0964% — the has_occ=False limitation quantified), honest empty set, non-model error probe** — corpus `tests/validation/corpus-manifest.json`, regenerate `bun run validate:engines`, evidence [validation-report.md](validation-report.md). See [engine-inventory.md § W2-c](engine-inventory.md#validation-harness-w2-c-2026-10-21) |
| **Model tessellation for the 3D viewer (STEP/IFC → byte-deterministic `eos-mesh/1`)** | **cadquery 2.6.1 (OCCT) + IfcOpenShell 0.9.0.post1** | **tested** (harness-validated) | 2 (shipped 2026-10-21 W2-d) | REAL adapters `src/engines/adapters/step_mesh.py` / `ifc_mesh.py` + bridge `src/engines/adapters/mesh.ts` (`tessellateFromFile`): vertices in metres (STEP unit scale table; IFC verified SI-metres), element refs set-equal the quantity ledger (`step:solid:<i>` / `#<GlobalId>`), tolerance pinned per adapter (STEP 0.0001 m; IFC runtime default 0.001 m). **Harness-validated (W2-d): 9 mesh blocks across the 11-case corpus — refs set-equality (pinned + ledger cross-check), pinned counts (two-solids 2×24v/12t; cylinder-solid 506v/500t; two-elements 3×8v/12t; wall-geometry 8v/12t; cylinder-geometry 90v/176t), byte-determinism (two real runs → identical JSON), divergence-theorem volumes vs closed forms (planar EXACT rel ≤ 1.9e-16; curved STEP 0.0414% / curved IFC 0.3246% within the pinned 1%)** — regenerate `bun run validate:engines`, evidence [validation-report.md](validation-report.md) + [engine-inventory.md § W2-d](engine-inventory.md#tessellation-adapters--the-eos-mesh1-bridge-w2-d-2026-10-21). Bridge tests: `src/engines/adapters/mesh.test.ts` (16 pass). Honest errors pinned: 0-solid STEP, geometry-free IFC, non-model files |
| In-app 3D / IFC web viewer (client rendering) | web-ifc + That Open Engine (components) — server tessellation by cadquery/IfcOpenShell above | planned (client engine); server side tested | 2 | Registry `web-ifc` (MPL-2.0, 0.78), `thatopen-engine` (MIT, 3.4.9); web-module mechanism — detection via package-lock inspection at adapter time (no PATH probe). The W1-d viewer consumes the harness-validated server meshes (eos-mesh/1) above |

## Takeoff (Phase 3)

| Capability | Engine(s) | State | Target phase | Evidence / notes |
|---|---|---|---|---|
| PDF drawing measurement (scale-calibrated takeoff) | OpenTakeoff | planned | 3 | Registry `opentakeoff` (AGPL-3.0, 0.9.98) — active upstream found by mandated audit 2026-10-21; MCP + canvas surfaces; strict arm's-length (AGPL) |
| Agent-drivable takeoff (tool invocation) | OpenTakeoff (MCP server) | planned | 3 | `opentakeoff-mcp` bin verified via npm registry; broker-only execution path (ADR-0005 rule 1); agent measurements carry review status upstream |
| Model-derived quantities (distinct ledger column) | cadquery (STEP) + IfcOpenShell (IFC) | tested (harness-validated) | 3 (shipped 2026-10-21, W2-b; validated W2-c) | Both adapters live (`src/engines/adapters/`) and **benchmark-validated by the 11-case harness** (`bun run validate:engines`, [validation-report.md](validation-report.md)); W3's derive-quantities route creates ledger rows with method `model-derived` + engine/script-hash provenance. Drawing-derived vs model-derived kept separate by design (ledger schema in `docs/03-data/quantity-ledger-schema.md`) |
| BOQ assembly (bill of quantities) | platform ledger + OpenTakeoff / IfcOpenShell inputs | planned | 3 | Ledger domain logic: `src/core/ledger.ts` (W3 lane, in progress); no engine is claimed complete for this |

## GIS / civil (Phase 5)

| Capability | Engine(s) | State | Target phase | Evidence / notes |
|---|---|---|---|---|
| Geospatial processing (headless) | QGIS (`qgis_process`) | planned | 5 | Registry `qgis` (GPL-2.0, 3.44.15); probe `qgis_process --version` |
| Raster/vector geostatistics | GRASS GIS | planned | 5 | Registry `grass` (GPL-2.0-or-later, 8.5.0) |
| CRS handling (coordinate reference systems) | QGIS, GRASS | planned | 5 | Used to ground site/civil drawings and takeoff scale context |
| Drainage / stormwater analysis (civil) | EPA SWMM, pyswmm | planned | 5 | Registry `swmm` (public domain, 5.2.4), `pyswmm` (BSD-2-Clause, 2.2.0); pyswmm may run in-process after license review |

## Electrical / electronics (Phase 5)

| Capability | Engine(s) | State | Target phase | Evidence / notes |
|---|---|---|---|---|
| Electronics schematic capture | KiCad | planned | 5 | Registry `kicad` (GPL-3.0-or-later, 10.0.7 — seed AGPL claim corrected by tree text) |
| PCB layout + fabrication exports | KiCad (`kicad-cli`) | planned | 5 | Headless gerber/step/netlist exports |
| Electrical installation diagrams (buildings) | QElectroTech | planned | 5 | Registry `qelectrotech` (GPL-2.0, 0.100); presence-only probe |
| SPICE circuit simulation | ngspice | planned | 5 | Registry `ngspice` (BSD-3-Clause, 47); batch netlist runs via broker |
| Power system analysis | pandapower | planned | 5 | Registry `pandapower` (BSD-3-Clause, 3.5.6); python-module probe |
| Chip design flow (RTL → GDSII) | GHDL, Yosys, Verilator, OpenROAD | planned | 5 | Registry rows all verified (GPL-2.0 / ISC / LGPL-3.0-or-Artistic / BSD-3-Clause); flow orchestrated by broker, per-tool provenance recorded |

## Simulation & analysis (Phase 5)

| Capability | Engine(s) | State | Target phase | Evidence / notes |
|---|---|---|---|---|
| Meshing (2D/3D FE meshes) | Gmsh | planned | 5 | Registry `gmsh` (GPL-2.0-or-later + exception, 4.15.2); `gmsh --version` probe |
| FEA — structural & thermomechanics | Code_Aster, Elmer FEM | planned | 5 | Registry `code-aster` (GPL-3.0, 17.5.8), `elmerfem` (GPL-2.0, 26.2) |
| FEA — earthquake/geotechnical (license-risk) | OpenSees | planned | 5 | Registry `opensees`: custom UC Regents noncommercial license — **no capability beyond `planned` until written license review** |
| CFD | OpenFOAM (Foundation, v14) | planned | 5 | Registry `openfoam` (GPL-3.0-or-later); Foundation/OpenCFD fork duality recorded |
| Systems dynamics (Modelica, FMU) | OpenModelica | planned | 5 | Registry `openmodelica` (AGPL-3.0 OR OSMC-PL-1.8, 1.27.1); `omc --version` probe |
| Chemical process simulation | DWSIM | planned | 5 | Registry `dwsim` (GPL-3.0, 10.2.12) — upstream repo moved (dwsim10); tracking updated |
| Discrete-event simulation | SimPy | planned | 5 | Registry `simpy` (MIT, 4.1.2 — now hosted on GitLab); python-module probe |
| Robotics simulation | ROS 2 + Gazebo (gz-sim) | planned | 5 | Registry `ros2` (multi-license superproject), `gazebo` (Apache-2.0, 10.0.0) |
| Result post-processing / visualization | ParaView | planned | 5 | Registry `paraview` (BSD-3-Clause, 6.2.0); headless pvpython/pvbatch rendering |

## Docs / controls (Phase 3/5)

| Capability | Engine(s) | State | Target phase | Evidence / notes |
|---|---|---|---|---|
| Document conversion / rendering (headless) | LibreOffice | planned | 5 | Registry `libreoffice` (license conflict GPL-3.0 vs MPL-2.0/LGPL-3.0+ flagged for Phase-6); `libreoffice --version` probe |
| Spreadsheet / BOQ document generation | LibreOffice headless + platform ledger | planned | 3/5 | BOQ data assembled by ledger (W3), rendered via LO in Phase 3 pilot |
| Project scheduling (Gantt/CPM desktop) | ProjectLibre | planned | 3 | Registry `projectlibre` (CPAL-1.0, 1.9.8 via SourceForge); presence-only probe |
| Work-package / schedule server (REST) | OpenProject | planned | 3/5 | Registry `openproject` (GPL-3.0, 17.9.2); arm's-length REST API integration |

## Platform capabilities (implemented now)

These are the TL-provided platform foundation (not engine claims); states reflect what is in the tree today:

| Capability | State | Evidence (src modules) |
|---|---|---|
| **Engine adapter bridge — model-derived quantities (STEP + IFC)** | **tested** (harness-validated) | `src/engines/adapters/quantities.ts` (`deriveFromFile`, `supportsDerive`, `EngineUnavailableError`) spawning the venv python + `step_quantities.py` / `ifc_quantities.py` (JSON protocol, self-reported adapter sha256 independently re-verified by the test via `node:crypto`); `src/engines/adapters/quantities.test.ts` — 7 tests / 74 assertions green 2026-10-21, incl. honest-failure and honest-empty cases; no simulated results, ever. **Phase-4:** the bridge additionally captures verbatim stdout/stderr tails (2000-char, additive — HTTP behavior unchanged) for the broker execution record |
| **Broker — the single execution path for engine operations (ADR-0005 rule 1)** | **tested** | `src/engines/broker.ts` (Phase 4, 2026-10-22): `runBrokerOperation` exposes `derive_quantities` / `derive_mesh` / `build_report`; both derive routes are thin wrappers over the extracted cores (byte-stable — proven by the rebuilt 27/40/67 acceptance scripts + a 71-check HTTP smoke); every workflow-path call carries the ADR-0005 execution record (engine version, adapter hash, input revision ids + contentHashes, exit code, verbatim stream tails, duration, output summary); `build_report` assembles `eos-report/1` from DB-verified rows ONLY (verbatim figures + per-figure source ids, byte-deterministic, no timestamps); `src/engines/broker.test.ts` 28 tests green |
| **Engine adapter bridge — model tessellation → `eos-mesh/1` (STEP + IFC)** | **tested** (harness-validated) | `src/engines/adapters/mesh.ts` (`tessellateFromFile`, pinned interface) sharing the exec/parse machinery extracted additively from `quantities.ts`; spawns `step_mesh.py` / `ifc_mesh.py` (same JSON protocol; the bridge adds `generatedBy` when returning); `src/engines/adapters/mesh.test.ts` — 16 tests green 2026-10-21 (pure payload/protocol validation + real-engine pinned counts, refs set-equality, mm→m conversion, byte-determinism, honest-error probes); byte-determinism enforced by the harness double-run |
| **Engine validation harness — benchmark corpus, closed-form ground truth** | **tested** | `src/engines/validation/` (`harness.ts` pure runner with set-equality + bitwise-determinism + tolerance policy + W2-d mesh sub-expectations (refs set-equality, pinned counts, byte-determinism, divergence volumes), `run.ts` CLI, `report.ts` writers, `harness.test.ts` 11 tests green 2026-10-21); corpus `tests/validation/corpus-manifest.json` (11 cases, 39 hand-derived ground-truth entries + 9 mesh blocks (5 tessellation-success + 4 honest-error) with 8 divergence-volume closed forms, all with derivation audit strings); deterministic fixture generators `make_fixture_step_solids.py` / `make_fixture_two_elements.py` / `make_fixture_cylinder_ifc.py` (byte-identical regeneration sha256-verified); latest run 11 pass / 0 fail, mesh-fallback error on the curved column honestly quantified (volume 0.3246% / area 0.0964% within the pinned 1%) and tessellation errors quantified (curved STEP cylinder 0.0414%). Regenerate: `bun run validate:engines`; evidence: `docs/02-engines/validation-report.md` + `tests/validation/report.json` |
| Project & artifact registry (REST API + Prisma model) | implemented | `src/app/api/projects/**`, `src/app/api/artifacts/**` (incl. revisions, links, approvals), `prisma/schema.prisma`, `src/lib/db.ts` |
| Content hashing + revision storage (sha256-addressed artifact store) | implemented | `src/lib/hash.ts` (`sha256Hex`), `src/lib/artifact-store.ts`, `src/lib/artifact-meta.ts` (artifact kinds/mime detection) |
| Audit event trail | implemented | `src/lib/audit.ts` (`recordEvent`), `src/app/api/events/route.ts` |
| Engine detection framework (registry + honest probes) | tested | `src/engines/index.ts` (`engineRegistry`, `detectEngines` — signatures stable for W1), `src/engines/registry.json` (35 source-verified engine records — 34 from the 2026-10-21 audit + cadquery added 2026-10-21 at first-adapter time), `src/engines/detect.test.ts` (5 passing bun:test cases: versioned executable, missing-binary, absent python-module, presence-only, PATH hygiene — no network, no real engines) |

Graph domain logic (impact propagation, staleness, approvals, ledger) is Worker 3's lane (`src/core/`) — its Phase-3/4 slices (ledger, estimates, workflow state machine + runtime) are verified in the [acceptance catalogue](../06-qa/acceptance-catalogue.md) and [implementation status](../07-release/implementation-status.md); no states are claimed here on its behalf.
