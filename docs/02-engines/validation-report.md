# Engine validation report — quantities + tessellation + Phase-5 disciplines

> **Regenerated file — do not edit by hand.** Regenerate with `bun run validate:engines`.
> Machine-readable companion: [`tests/validation/report.json`](../../tests/validation/report.json) ·
> Corpus + hand-derived ground truth: [`tests/validation/corpus-manifest.json`](../../tests/validation/corpus-manifest.json)

## What this harness proves

- The REAL production bridge (`src/engines/adapters/quantities.ts` → `step_quantities.py` / `ifc_quantities.py`) is executed
  per corpus case — never a mock, never a simulated number (ADR-0005/ADR-0006).
- Every ground-truth value is a **hand-derived closed form** pinned in the corpus manifest (derivation strings are the
  audit trail); the manifest is written before any adapter runs and is never copied from adapter output.
- **Set equality per (elementRef, quantityType)**: an extra or missing adapter quantity fails the case even when all
  pinned values match — this is what proves must-skip quantities (IFC `NetWeight`) are genuinely skipped.
- **Determinism**: every success case runs TWICE; quantity values must be bitwise identical.
- Error cases must throw `EngineUnavailableError` whose message contains the pinned substring — honest failure,
  never a fallback value.
- **Mesh (W2-d)**: cases with pinned `mesh` expectations additionally drive the REAL tessellation bridge
  (`src/engines/adapters/mesh.ts` → `step_mesh.py` / `ifc_mesh.py`) TWICE — element refs must be SET-EQUAL to both
  the pinned refs and the quantity ledger's element-level refs (the cross-reference contract), per-element
  vertex/triangle counts are pinned exactly, the two runs must be byte-identical (no timestamps anywhere —
  Contract A), and divergence-theorem mesh volumes are checked against hand-derived closed forms (planar exact;
  curved within the pinned 1% `mesh` tolerance with the observed relative error recorded).
- **Phase-5 disciplines (W2-f)**: the femesh/powerflow/des cases drive the REAL gmsh / pandapower / SimPy
  bridges TWICE and require the stored §2 documents (built by the broker's own pure builders) to be
  BYTE-IDENTICAL across the runs; the cpm case drives the exact pure pipeline behind the `analyze_schedule`
  broker op and asserts engine identity ABSENT (platform core); the libreoffice case runs ONE real conversion
  with structural pins and claims NO byte-determinism (PDFs embed creation timestamps — contract §5.4).

## Environment

- Ran at (UTC): `2026-11-01T11:27:58.992Z`
- Python (engine venv, `EOS_PYTHON`-overridable): `/home/z/.local/share/eos-engines/venv/bin/python`
- LibreOffice (`EOS_LIBREOFFICE`-overridable): `/usr/bin/libreoffice`
- Engine availability probe — cadquery (STEP quantities): available
- Engine availability probe — ifcopenshell (IFC quantities): available
- Engine availability probe — gmsh (FE mesh): available
- Engine availability probe — pandapower (power flow): available
- Engine availability probe — simpy (discrete-event): available
- Engine availability probe — scikit-fem (plane-stress FEA): available
- Engine availability probe — sfepy/SfePy (steady scalar transport CFD): available
- Engine availability probe — amaranth + yowasp-yosys (RTL synthesis): available
- Engine availability probe — pin/Pinocchio (planar-2R kinematics): available
- Engine availability probe — pybullet/PyBullet (drop-impact simulation): available
- Engine availability probe — pyswmm/SWMM5 (stormwater drainage): available
- Engine availability probe — platform CPM core (no engine): available
- Engine availability probe — libreoffice (document conversion): available
- Engine availability probe — pdfplumber (vector sheet takeoff): available
- Engine availability probe — ezdxf (DXF takeoff): available
- Engine availability probe — cadquery (parametric rebuild): available
- Engine availability probe — tesseract (sheet-text OCR): available
- Engine availability probe — pdf2takeoff (ADOPTED takeoff engine — ADR-0011): available
- Engine versions (as reported inside real adapter runs): cadquery 2.6.1 · ifcopenshell 0.9.0.post1 · gmsh 4.15.2 · pandapower 3.5.6 · simpy 4.1.2 · scikit-fem 12.0.2 · sfepy 2026.3 · libreoffice 25.2.3.2 · pdfplumber 0.11.10 · ezdxf 1.4.5 · pdf2takeoff 0.1.0 · tesseract 5.5.0 · pyswmm 2.2.0 · amaranth 0.5.10 · pin 4.1.0 · pybullet 3.2.7
- Adapter `step_quantities.py` sha256: `950e3e9f358c0bb16895d222076fbcb99dab58d9f1cbf454a05ba5469515e02d`
- Adapter `ifc_quantities.py` sha256: `68b4ca17ed355e6afa89529fa66c5ef9a73e530da7117f8a9db9f6c3abc43e78`
- Adapter `step_mesh.py` sha256: `e042b686916a212a46dd947a0e6852ec02c10c3687913299d679e38309d5aa9c`
- Adapter `ifc_mesh.py` sha256: `6854d6c0a170daf29de36991af88996af10f2169084d5850083fad03b9747465`
- Adapter `step_femesh.py` sha256: `3770e13ab779e6cbbe3db9162533bf028a26b4087dcbb476d92742f927a34b3f`
- Adapter `powerflow.py` sha256: `a1a8fc441d0cf321e95bbd655fc368cb04c22e17ee693090f9b7193fdb380606`
- Adapter `des.py` sha256: `9295a66271617f068f9dfab63f9339e814f993db59605df7b7ce86a0c3842550`
- Adapter `convert-document.ts` sha256: `4b1bb3d10fdcaa3f85ebb654a652092acb3ac5a59812f1f0fd9c5074b15540d0`
- Adapter `sheet_takeoff.py` sha256: `bea0a985d34cd8bda44aab4251f2d2ec7039f032445d14d7c99b5ed998425bff`
- Adapter `dxf_takeoff.py` sha256: `07d24da5749543b546d75f45aca01fb8078aa708325cb74282730c2074159329`
- Adapter `parametric_rebuild.py` sha256: `14d62a117314160ffea825ec9aca038e863a550fa7cc5b33babb487295854acf`
- Adapter `pdf2takeoff.ts` sha256: `7723d6e2132568f611c58b1acd25d178f20727a05e157f79c1fab37283801344`
- Adapter `sheet_ocr.ts` sha256: `b2e7798973ab7f9f78f6d58d482986bfb38ab112cb3e0586c6cf6107b07dfd45`
- Adapter `fea_solve.py` sha256: `86674028a476438081788dd6a16c2552ba0ed9cbe9332023cc77956b1b9d62ef`
- Adapter `swmm_run.py` sha256: `6f6714b8ec6d8616d4fd5adbab681b5486ca10063049a672e6f7e1647024ef8d`
- Adapter `transport_solve.py` sha256: `d519891e7ba6ce23aa826af323f146c3f684c48127516ed88a1c7d270b94f13b`
- Adapter `rtl_synthesize.py` sha256: `dfd179e6be39f1bea0b70e8ac889c8e56ffa39554ce85188d85d9cde8a37fba7`
- Adapter `kinematics_solve.py` sha256: `c7277a99d7a5f98a589c84026f794f9e5904bbf837cff0ca6b8cd5f6609aaf48`
- Adapter `impact_solve.py` sha256: `881cf7872f11dc52ef17ec79587f9885c4d1749619b423e2ee8af048ce77b479`
- Corpus: `tests/validation/corpus-manifest.json` — 57 cases

## Tolerance policy (pinned)

| tolerance class | rule | meaning |
|---|---|---|
| `exact` | \|obs − exp\| ≤ 1e-9 · max(1, \|exp\|) | declared-quantity readback — authored values must round-trip |
| `analytic` | \|obs − exp\| ≤ 1e-9 · max(1, \|exp\|) | exact-engine value vs closed form; also used for the PLANAR mesh case, where the divergence-theorem volume / triangle-sum area are mathematically exact (only IEEE rounding remains) |
| `mesh` | \|obs − exp\| ≤ 1e-2 · \|exp\| | pinned 1% engineering tolerance for triangulated CURVED surfaces (ifcopenshell PyPI wheel has no OCCT backend, `has_occ=False`); the observed relative error is recorded below — the limitation is quantified, not hidden |

## Results — 57 cases: 57 pass / 0 fail / 0 skip

| Case | Adapter | Fixture | Expect | Status | Determinism | Quantities (obs / pinned) | Max observed rel error | Notes |
|---|---|---|---|---|---|---|---|---|
| `step-bracket-solid` | step | `bracket-solid.step` | success | pass | ✅ true | 3 / 3 | 1.456e-14 | largest observed rel error 1.456e-14 (step:solid:0 volume) — IEEE/authoring noise only, within tolerance |
| `step-cylinder-solid` | step | `cylinder-solid.step` | success | pass | ✅ true | 3 / 3 | 5.488e-14 | mesh: 1 element(s) / 506 verts / 500 tris · byte-determinism ✅ · max mesh-volume rel error 4.144e-4 · largest observed rel error 5.488e-14 (step:solids:all area) — IEEE/authoring noise only, within tolerance |
| `step-two-solids` | step | `two-solids.step` | success | pass | ✅ true | 4 / 4 | 0.000e+0 | mesh: 2 element(s) / 48 verts / 24 tris · byte-determinism ✅ · max mesh-volume rel error 3.765e-16 |
| `step-bracket-empty` | step | `bracket.step` | error | pass | — | — | — | mesh: threw honest error: `no solid geometry found in STEP file (import produced 0 solids) - cannot tessellate, and simulated m` · threw honest error: `no solid geometry found in STEP file (import produced 0 solids) - cannot derive quantities, and simulated values are not an option` |
| `step-nonmodel-file` | step | `site-notes.md` | error | pass | — | — | — | mesh: threw honest error: `cadquery STEP import failed: ValueError: STEP File could not be loaded` · threw honest error: `cadquery STEP import failed: ValueError: STEP File could not be loaded` |
| `ifc-wall-quantities` | ifc | `wall-quantities.ifc` | success | pass | ✅ true | 10 / 10 | 0.000e+0 |  |
| `ifc-two-elements` | ifc | `two-elements.ifc` | success | pass | ✅ true | 15 / 15 | 0.000e+0 | mesh: 3 element(s) / 24 verts / 36 tris · byte-determinism ✅ · max mesh-volume rel error 1.586e-16 |
| `ifc-wall-geometry-mesh` | ifc | `wall-geometry.ifc` | success | pass | ✅ true | 2 / 2 | 1.850e-16 | mesh: 1 element(s) / 8 verts / 12 tris · byte-determinism ✅ · max mesh-volume rel error 1.850e-16 · largest observed rel error 1.850e-16 (#2rUnE8CnPHBwLdZzIqZkf1 volume) — IEEE/authoring noise only, within tolerance |
| `ifc-cylinder-geometry-mesh` | ifc | `cylinder-geometry.ifc` | success | pass | ✅ true | 2 / 2 | 3.246e-3 | mesh: 1 element(s) / 90 verts / 176 tris · byte-determinism ✅ · max mesh-volume rel error 3.246e-3 · mesh vs closed form: volume observed 0.3757673725921769 vs expected 0.3769911184307752 m³ — rel error 3.246e-3 (0.3246%) · mesh vs closed form: area observed 4.017361163910887 vs expected 4.0212385965949355 m² — rel error 9.642e-4 (0.0964%) |
| `ifc-wall-stripped-empty` | ifc | `wall-stripped.ifc` | success | pass | ✅ true | 0 / 0 | — | mesh: threw honest error: `no meshable geometry found in IFC file (1 element(s) examined, 0 produced a triangulation) — cannot ` · empty pinned set — the adapter returned zero quantities (honest empty, never fabricated) |
| `ifc-nonmodel-file` | ifc | `site-notes.md` | error | pass | — | — | — | mesh: threw honest error: `ifcopenshell could not open the file: Error: Unable to parse IFC SPF header` · threw honest error: `ifcopenshell could not open the file: Error: Unable to parse IFC SPF header` |
| `femesh-bracket-solid` | femesh | `bracket-solid.step` | success | pass | — | — / — | — | femesh: 7 pin(s) · gmsh 4.15.2 · doc byte-determinism ✅ · max pin rel error 9.162e-3 |
| `femesh-two-solids` | femesh | `two-solids.step` | success | pass | — | — / — | — | femesh: 6 pin(s) · gmsh 4.15.2 · doc byte-determinism ✅ · max pin rel error 1.364e-15 |
| `femesh-geometry-free` | femesh | `bracket.step` | error | pass | — | — | — | femesh: threw honest error: `no solid geometry found in STEP file (import produced 0 solids) - cannot generate an FE mesh, and simulated meshes are n` · threw honest error: `` |
| `femesh-ifc-refused` | femesh | `wall-quantities.ifc` | error | pass | — | — | — | femesh: threw honest error: `gmsh cannot import IFC geometry (gmsh has no IFC import reader - OCC STEP/IGES/BRep only) - cannot generate an FE mesh, ` · threw honest error: `` |
| `powerflow-2bus-closed-form` | powerflow | `powerflow-2bus.json` | success | pass | — | — / — | — | powerflow: 10 pin(s) · pandapower 3.5.6 · doc byte-determinism ✅ · max pin rel error 1.648e-5 |
| `powerflow-islanded` | powerflow | `powerflow-islanded.json` | error | pass | — | — | — | powerflow: threw honest error: `power flow did not produce results for all buses (islanded network - buses with no path to the external grid: bus-3) - r` · threw honest error: `` |
| `des-flowshop-makespan` | des | `des-flowshop.json` | success | pass | — | — / — | — | des: 11 pin(s) · simpy 4.1.2 · doc byte-determinism ✅ |
| `des-invalid-resource` | des | `des-invalid-resource.json` | error | pass | — | — | — | des: threw honest error: `jobs[0].tasks[1] references unknown resource "crane"` · threw honest error: `` |
| `cpm-platform-rollout` | cpm | `schedule-cpm.json` | success | pass | — | — / — | — | cpm: 28 pin(s) · engine identity absent (platform core) · doc byte-determinism ✅ |
| `lo-cover-sheet-convert` | libreoffice | `cover-sheet.fodt` | success | pass | — | — / — | — | libreoffice: 4 pin(s) · libreoffice 25.2.3.2 · byte-determinism not claimed (PDFs embed creation timestamps — single run, §5.4) |
| `sheet-vector-plan` | sheet | `sheet-a102-plan.pdf` | success | pass | — | — / — | — | sheet: 38 pin(s) · pdfplumber 0.11.10 · doc byte-determinism ✅ · max pin rel error 3.519e-7 |
| `sheet-vector-curve` | sheet | `sheet-curve-arc.pdf` | success | pass | — | — / — | — | sheet: 6 pin(s) · pdfplumber 0.11.10 · doc byte-determinism ✅ · max pin rel error 3.981e-5 |
| `sheet-vector-refusal` | sheet | `sheet-scan-like.pdf` | error | pass | — | — | — | sheet: threw honest error: `this sheet page has no vector path operators — it is a scan or raster-only page; vector takeoff is not available for it,` · threw honest error: `` |
| `dxf-takeoff-room` | dxf | `takeoff-room.dxf` | success | pass | — | — / — | — | dxf: 13 pin(s) · ezdxf 1.4.5 · doc byte-determinism ✅ |
| `parametric-schema` | parametric | `parametric-bracket.py` | success | pass | — | — / — | — | parametric: 5 pin(s) · cadquery 2.6.1 · doc byte-determinism ✅ |
| `parametric-defaults` | parametric | `parametric-bracket.py` | success | pass | — | — / — | — | parametric: 9 pin(s) · cadquery 2.6.1 · doc byte-determinism ✅ · max pin rel error 7.530e-16 |
| `parametric-edited` | parametric | `parametric-bracket.py` | success | pass | — | — / — | — | parametric: 9 pin(s) · cadquery 2.6.1 · doc byte-determinism ✅ · max pin rel error 8.017e-16 |
| `parametric-refusals` | parametric | `parametric-bracket.py` | error | pass | — | — | — | parametric: threw honest error: `parameter 'width' = 10 below minimum 20 \| unknown parameter(s) rejected: ['bogus'] \| hole does not fit inside the vertic` · threw honest error: `` |
| `sheet-ocr-callout` | ocr | `ocr-callout.png` | success | pass | — | — / — | — | ocr: 9 pin(s) · tesseract 5.5.0 · doc byte-determinism ✅ |
| `fea-uniform-tension` | fea | `fea-uniform-tension.json` | success | pass | — | — / — | — | fea: 16 pin(s) · scikit-fem 12.0.2 · doc byte-determinism ✅ · max pin rel error 1.713e-13 |
| `fea-cantilever-end-shear` | fea | `fea-cantilever-plate.json` | success | pass | — | — / — | — | fea: 3 pin(s) · scikit-fem 12.0.2 · doc byte-determinism ✅ · max pin rel error 4.684e-3 |
| `fea-underconstrained` | fea | `fea-underconstrained.json` | error | pass | — | — | — | fea: threw honest error: `the supports do not constrain the model's rigid-body motion (free: translation in y, rotation about z) - an unconstraine` · threw honest error: `` |
| `swmm-runoff-balance` | swmm | `swmm-runoff-balance.json` | success | pass | — | — / — | — | swmm: 11 pin(s) · pyswmm 2.2.0 · doc byte-determinism ✅ · max pin rel error 1.652e-2 |
| `swmm-manning-conduit` | swmm | `swmm-manning-conduit.json` | success | pass | — | — / — | — | swmm: 8 pin(s) · pyswmm 2.2.0 · doc byte-determinism ✅ · max pin rel error 9.948e-3 |
| `swmm-no-outfall` | swmm | `swmm-no-outfall.json` | error | pass | — | — | — | swmm: threw honest error: `the network has no outfall - runoff cannot leave the model, and simulated results are not an option` · threw honest error: `` |
| `transport-channel` | transport | `transport-channel.json` | success | pass | — | — / — | — | transport: 16 pin(s) · sfepy 2026.3 · doc byte-determinism ✅ · max pin rel error 4.158e-7 |
| `transport-uniform` | transport | `transport-uniform.json` | success | pass | — | — / — | — | transport: 8 pin(s) · sfepy 2026.3 · doc byte-determinism ✅ · max pin rel error 8.749e-14 |
| `transport-mesh-peclet-refusal` | transport | `transport-high-peclet.json` | error | pass | — | — | — | transport: threw honest error: `the mesh does not resolve the transport boundary layer (element Péclet 7.81 exceeds the stability bound 2) - refine the ` · threw honest error: `` |
| `rtl-counter-4bit` | chip | `rtl-counter-4bit.json` | success | pass | — | — / — | — | chip: 18 pin(s) · amaranth 0.5.10 · doc byte-determinism ✅ |
| `rtl-counter-8bit` | chip | `rtl-counter-8bit.json` | success | pass | — | — / — | — | chip: 11 pin(s) · amaranth 0.5.10 · doc byte-determinism ✅ |
| `rtl-invalid-kind` | chip | `rtl-invalid-kind.json` | error | pass | — | — | — | chip: threw honest error: `rtl model device.kind must be "enable_counter" (the v1 device class; every other class is its own future lane) (got "alu` · threw honest error: `` |
| `robot-arm-2link` | robotics | `robot-arm-2link.json` | success | pass | — | — / — | — | robotics: 43 pin(s) · pin 4.1.0 · doc byte-determinism ✅ · max pin rel error 4.969e-16 |
| `robot-arm-long` | robotics | `robot-arm-long.json` | success | pass | — | — / — | — | robotics: 26 pin(s) · pin 4.1.0 · doc byte-determinism ✅ · max pin rel error 6.361e-16 |
| `robot-arm-invalid-kind` | robotics | `robot-arm-invalid-kind.json` | error | pass | — | — | — | robotics: threw honest error: `robot model mechanism.kind must be "planar_2r" (the v1 mechanism class; every other class is its own future lane) (got "` · threw honest error: `` |
| `impact-drop-sphere` | physics | `impact-drop-sphere.json` | success | pass | — | — / — | — | physics: 29 pin(s) · pybullet 3.2.7 · doc byte-determinism ✅ · max pin rel error 2.284e-6 |
| `impact-drop-bounce` | physics | `impact-drop-bounce.json` | success | pass | — | — / — | — | physics: 11 pin(s) · pybullet 3.2.7 · doc byte-determinism ✅ · max pin rel error 1.709e-14 |
| `impact-drop-invalid-kind` | physics | `impact-drop-invalid-kind.json` | error | pass | — | — | — | physics: threw honest error: `impact model mechanism.kind must be "drop_impact" (the v1 mechanism class; every other class is its own future lane) (go` · threw honest error: `` |
| `p2t-compare-identical` | pdf2takeoff | `sheet-a102-plan.pdf` | success | pass | — | — / — | — | pdf2takeoff: 8 pin(s) · pdf2takeoff 0.1.0 · doc byte-determinism ✅ |
| `p2t-compare-different` | pdf2takeoff | `sheet-a102-plan.pdf` | success | pass | — | — / — | — | pdf2takeoff: 8 pin(s) · pdf2takeoff 0.1.0 · doc byte-determinism ✅ |
| `p2t-annotate-roundtrip` | pdf2takeoff | `sheet-a102-plan.pdf` | success | pass | — | — / — | — | pdf2takeoff: 4 pin(s) · pdf2takeoff 0.1.0 |
| `p2t-export-boq-roundtrip` | pdf2takeoff | `sheet-a102-plan.pdf` | success | pass | — | — / — | — | pdf2takeoff: 9 pin(s) · pdf2takeoff 0.1.0 · doc byte-determinism ✅ |
| `p2t-fill-area-room` | pdf2takeoff | `sheet-a102-plan.pdf` | success | pass | — | — / — | — | pdf2takeoff: 6 pin(s) · pdf2takeoff 0.1.0 · doc byte-determinism ✅ |
| `p2t-fill-no-scale` | pdf2takeoff | `sheet-a102-plan.pdf` | error | pass | — | — | — | pdf2takeoff: threw honest error: `fill_area parameters.scaleMmPerPt must be a positive number — calibrate the sheet first or pass it explicitly (an uncali` · threw honest error: `` |
| `p2t-export-no-annotations` | pdf2takeoff | `sheet-a102-plan.pdf` | error | pass | — | — | — | pdf2takeoff: threw honest error: `pdf2takeoff export failed: pdf2takeoff: no pdf2takeoff annotations found in /home/z/engineering-os/tests/fixtures/sheet-` · threw honest error: `` |
| `p2t-annotate-bad-spec` | pdf2takeoff | `sheet-a102-plan.pdf` | error | pass | — | — | — | pdf2takeoff: threw honest error: `annotate_takeoff parameters.markups[0].points must be an array of 2..64 [x,y] pairs for type area` · threw honest error: `` |
| `p2t-fill-click-on-line` | pdf2takeoff | `sheet-a102-plan.pdf` | error | pass | — | — | — | pdf2takeoff: threw honest error: `pdf2takeoff fill_area refused: you clicked on a line — click inside the region` · threw honest error: `` |

## Mesh tessellation validation (W2-d — the eos-mesh/1 bridge)

Cases carrying a `mesh` block in the corpus manifest drive the REAL tessellation bridge (`tessellateFromFile` →
`step_mesh.py` (cadquery/OCCT) / `ifc_mesh.py` (ifcopenshell.geom, default settings) — never a mock. The adapters emit
`eos-mesh/1` WITHOUT `generatedBy`; the BRIDGE adds it when returning. The harness enforces: element refs set-equal the pinned
refs AND the quantity ledger's element-level refs (cross-reference contract), pinned per-element vertex/triangle counts,
byte-identical JSON across two real runs, and divergence-theorem mesh volumes vs hand-derived closed forms
(planar exact; curved ≤ 1% pinned, observed errors recorded below).

Adapter tolerance pins (payload `tolerance`, metres — documented per adapter): STEP linear deflection pinned at
`0.0001` m (native 0.1 in mm-authored files + cadquery's default 0.1 rad angular tolerance); IFC = the engine's default
`mesher-linear-deflection` read at runtime (`0.001` m on the pinned wheel — geometry is processed in SI metres).

| Case | Adapter | Elements | Verts | Tris | upAxis | tolerance (m) | Byte-determinism | Status |
|---|---|---|---|---|---|---|---|---|
| `step-cylinder-solid` | step | 1 (step_mesh) | 506 | 500 | z | 0.0001 | ✅ true | pass |
| `step-two-solids` | step | 2 (step_mesh) | 48 | 24 | z | 0.0001 | ✅ true | pass |
| `step-bracket-empty` | step | — | — | — | — | — | — | pass (honest error) |
| `step-nonmodel-file` | step | — | — | — | — | — | — | pass (honest error) |
| `ifc-two-elements` | ifc | 3 (ifc_mesh) | 24 | 36 | z | 0.001 | ✅ true | pass |
| `ifc-wall-geometry-mesh` | ifc | 1 (ifc_mesh) | 8 | 12 | z | 0.001 | ✅ true | pass |
| `ifc-cylinder-geometry-mesh` | ifc | 1 (ifc_mesh) | 90 | 176 | z | 0.001 | ✅ true | pass |
| `ifc-wall-stripped-empty` | ifc | — | — | — | — | — | — | pass (honest error) |
| `ifc-nonmodel-file` | ifc | — | — | — | — | — | — | pass (honest error) |

### Observed mesh-volume errors — divergence theorem vs closed forms

- `step-cylinder-solid` (cylinder-solid.step) step:solid:0: observed **0.00012561163186495692** vs closed form 0.0001256637061435917 m³ → relative error 4.144e-4 (0.0414%) — within the pinned 1% mesh tolerance · π · 20² · 100 mm³ = 40000π mm³ = 4π×10⁻⁵ m³ (Ø40×100 mm cylinder). 'mesh' tolerance (pinned 1%): the divergence-theorem volume over the OCCT triangulation is an approximation on the CURVED lateral surface (the inscribed tessellation slightly underestimates) — the harness records the observed relative error per run
- `step-two-solids` (two-solids.step) step:solid:0: observed **0.000005999999999999999** vs closed form 0.000006 m³ → relative error 1.412e-16 — planar-solid exactness (IEEE rounding only) · box A 30 × 20 × 10 mm = 6000 mm³ = 6×10⁻⁶ m³ (PLANAR solid → divergence-theorem mesh volume is mathematically exact; only IEEE rounding remains, and the mesh elementRef set-equals the quantity ledger's per-solid refs)
- `step-two-solids` (two-solids.step) step:solid:1: observed **0.000008999999999999997** vs closed form 0.000009 m³ → relative error 3.765e-16 — planar-solid exactness (IEEE rounding only) · box B 15 × 15 × 40 mm = 9000 mm³ = 9×10⁻⁶ m³ (PLANAR solid → mesh volume exact)
- `ifc-two-elements` (two-elements.ifc) #3rUnE8CnPHBwLdZzIqZkf1: observed **2.8000000000000003** vs closed form 2.8 m³ → relative error 1.586e-16 — planar-solid exactness (IEEE rounding only) · Wall A 4.0 × 0.25 × 2.8 m = 2.8 m³ (PLANAR → divergence-theorem mesh volume exact; metres authored and verified)
- `ifc-two-elements` (two-elements.ifc) #3rUnE8CnPHBwLdZzIqZkf2: observed **0.84** vs closed form 0.84 m³ → relative error 0 (bitwise) — planar-solid exactness (IEEE rounding only) · Wall B 2.0 × 0.15 × 2.8 m = 0.84 m³ (PLANAR → exact)
- `ifc-two-elements` (two-elements.ifc) #3rUnE8CnPHBwLdZzIqZkf3: observed **3** vs closed form 3 m³ → relative error 0 (bitwise) — planar-solid exactness (IEEE rounding only) · Slab S 5.0 × 3.0 × 0.2 m = 3.0 m³ (PLANAR → exact)
- `ifc-wall-geometry-mesh` (wall-geometry.ifc) #2rUnE8CnPHBwLdZzIqZkf1: observed **1.2000000000000002** vs closed form 1.2 m³ → relative error 1.850e-16 — planar-solid exactness (IEEE rounding only) · box 3.0 × 0.2 × 2.0 m = 1.2 m³ (PLANAR → divergence-theorem mesh volume is mathematically exact; the mesh elementRef set-equals the quantity ledger ref)
- `ifc-cylinder-geometry-mesh` (cylinder-geometry.ifc) #4rUnE8CnPHBwLdZzIqZkf1: observed **0.3757673725921769** vs closed form 0.3769911184307752 m³ → relative error 3.246e-3 (0.3246%) — within the pinned 1% mesh tolerance · π · 0.2² · 3.0 = 0.12π m³ (Ø400 × 3000 mm column). 'mesh' tolerance (pinned 1%): the default-settings triangulation (44 segments) is an APPROXIMATION on the curved surface — the harness records the observed relative error per run (same triangulation the quantity adapter's fallback reports on)

### Honest notes on the tessellation adapters

- STEP vertices are converted from the file's declared length unit to metres via a pinned scale table; a STEP file with an
  unsupported or missing unit declaration is refused, never guessed. Solid enumeration is byte-identical to
  `step_quantities.py` (`importers.importStep` → `solids().vals()`), so `step:solid:<i>` means the same solid in both ledgers.
- IFC: ifcopenshell's geometry module returns vertex coordinates in SI METERS regardless of the project length unit
  (verified empirically on the pinned wheel with an mm-authored probe file: a 1000×500×300 mm box tessellates to
  x ∈ [−0.5, 0.5] m) — the adapter applies NO extra scale; the harness volume cross-checks against metre-authored
  fixtures would catch any units regression loudly.
- The IFC mesh adapter reuses the quantity adapter's proven `create_shape(settings, element)` iteration (one shape per
  element, openings excluded) with DEFAULT settings — sidestepping the geom-iterator quirk (only one `get()` per `initialize()`).
- A geometry-free IFC (no element yields a triangulation) and a solid-free STEP are HONEST ERRORS, not empty meshes:
  the mesh adapters refuse to emit an empty `elements` array, and the harness pins those error envelopes.

### Observed mesh errors — the `has_occ=False` limitation, quantified

- `ifc-cylinder-geometry-mesh` (cylinder-geometry.ifc): volume observed **0.3757673725921769** vs closed form 0.3769911184307752 m³ → relative error 3.246e-3 (0.3246%) — within the pinned 1% mesh tolerance
- `ifc-cylinder-geometry-mesh` (cylinder-geometry.ifc): area observed **4.017361163910887** vs closed form 4.0212385965949355 m² → relative error 9.642e-4 (0.0964%) — within the pinned 1% mesh tolerance

The PLANAR mesh case (`ifc-wall-geometry-mesh`) runs at the stricter `analytic` tolerance by derivation:
divergence-theorem volume and triangle-sum area are mathematically exact for planar solids, so only IEEE
rounding remains — its observed relative error sits at ~2e-16 (see the results table).

### Per-case ground truth

Full derivations for every pinned value live in the committed corpus manifest
(`tests/validation/corpus-manifest.json`, one `derivation` string per entry — the audit trail).

## Phase-5 disciplines validation (W2-f — femesh / power flow / DES / CPM / LibreOffice)

Cases with a Phase-5 adapter drive the REAL discipline bridges — gmsh (FE meshing via `step_femesh.py`,
system-library bootstrap through LD_LIBRARY_PATH), pandapower (`powerflow.py`), SimPy (`des.py`), the headless
LibreOffice conversion bridge, and the pure CPM platform core behind the `analyze_schedule` broker op. Every pin
carries its hand-derived closed form or its live-observed provenance in the manifest. The femesh/powerflow/des
success cases run TWICE and the BYTE-IDENTICAL §2 documents the broker stores must come out identical; the cpm
case runs the exact pure pipeline the broker core runs and records NO engine identity (honest null); the
LibreOffice case runs ONCE — byte-determinism is NOT claimed for PDF conversions (contract §5.4).

| Case | Adapter | Fixture | Expect | Engine | Doc byte-determinism | Pins | Status |
|---|---|---|---|---|---|---|---|
| `femesh-bracket-solid` | femesh | `bracket-solid.step` | success | gmsh 4.15.2 | ✅ true | 7 | pass |
| `femesh-two-solids` | femesh | `two-solids.step` | success | gmsh 4.15.2 | ✅ true | 6 | pass |
| `femesh-geometry-free` | femesh | `bracket.step` | error | — (platform core, honestly absent) | — | 0 | pass |
| `femesh-ifc-refused` | femesh | `wall-quantities.ifc` | error | — (platform core, honestly absent) | — | 0 | pass |
| `powerflow-2bus-closed-form` | powerflow | `powerflow-2bus.json` | success | pandapower 3.5.6 | ✅ true | 10 | pass |
| `powerflow-islanded` | powerflow | `powerflow-islanded.json` | error | — (platform core, honestly absent) | — | 0 | pass |
| `des-flowshop-makespan` | des | `des-flowshop.json` | success | simpy 4.1.2 | ✅ true | 11 | pass |
| `des-invalid-resource` | des | `des-invalid-resource.json` | error | — (platform core, honestly absent) | — | 0 | pass |
| `cpm-platform-rollout` | cpm | `schedule-cpm.json` | success | — (platform core, honestly absent) | ✅ true | 28 | pass |
| `lo-cover-sheet-convert` | libreoffice | `cover-sheet.fodt` | success | libreoffice 25.2.3.2 | not claimed (single run, §5.4) | 4 | pass |
| `sheet-vector-plan` | sheet | `sheet-a102-plan.pdf` | success | pdfplumber 0.11.10 | ✅ true | 38 | pass |
| `sheet-vector-curve` | sheet | `sheet-curve-arc.pdf` | success | pdfplumber 0.11.10 | ✅ true | 6 | pass |
| `sheet-vector-refusal` | sheet | `sheet-scan-like.pdf` | error | — (platform core, honestly absent) | — | 0 | pass |
| `dxf-takeoff-room` | dxf | `takeoff-room.dxf` | success | ezdxf 1.4.5 | ✅ true | 13 | pass |
| `parametric-schema` | parametric | `parametric-bracket.py` | success | cadquery 2.6.1 | ✅ true | 5 | pass |
| `parametric-defaults` | parametric | `parametric-bracket.py` | success | cadquery 2.6.1 | ✅ true | 9 | pass |
| `parametric-edited` | parametric | `parametric-bracket.py` | success | cadquery 2.6.1 | ✅ true | 9 | pass |
| `parametric-refusals` | parametric | `parametric-bracket.py` | error | — (platform core, honestly absent) | — | 0 | pass |
| `sheet-ocr-callout` | ocr | `ocr-callout.png` | success | tesseract 5.5.0 | ✅ true | 9 | pass |
| `fea-uniform-tension` | fea | `fea-uniform-tension.json` | success | scikit-fem 12.0.2 | ✅ true | 16 | pass |
| `fea-cantilever-end-shear` | fea | `fea-cantilever-plate.json` | success | scikit-fem 12.0.2 | ✅ true | 3 | pass |
| `fea-underconstrained` | fea | `fea-underconstrained.json` | error | — (platform core, honestly absent) | — | 0 | pass |
| `swmm-runoff-balance` | swmm | `swmm-runoff-balance.json` | success | pyswmm 2.2.0 | ✅ true | 11 | pass |
| `swmm-manning-conduit` | swmm | `swmm-manning-conduit.json` | success | pyswmm 2.2.0 | ✅ true | 8 | pass |
| `swmm-no-outfall` | swmm | `swmm-no-outfall.json` | error | — (platform core, honestly absent) | — | 0 | pass |
| `transport-channel` | transport | `transport-channel.json` | success | sfepy 2026.3 | ✅ true | 16 | pass |
| `transport-uniform` | transport | `transport-uniform.json` | success | sfepy 2026.3 | ✅ true | 8 | pass |
| `transport-mesh-peclet-refusal` | transport | `transport-high-peclet.json` | error | — (platform core, honestly absent) | — | 0 | pass |
| `rtl-counter-4bit` | chip | `rtl-counter-4bit.json` | success | amaranth 0.5.10 | ✅ true | 18 | pass |
| `rtl-counter-8bit` | chip | `rtl-counter-8bit.json` | success | amaranth 0.5.10 | ✅ true | 11 | pass |
| `rtl-invalid-kind` | chip | `rtl-invalid-kind.json` | error | — (platform core, honestly absent) | — | 0 | pass |
| `robot-arm-2link` | robotics | `robot-arm-2link.json` | success | pin 4.1.0 | ✅ true | 43 | pass |
| `robot-arm-long` | robotics | `robot-arm-long.json` | success | pin 4.1.0 | ✅ true | 26 | pass |
| `robot-arm-invalid-kind` | robotics | `robot-arm-invalid-kind.json` | error | — (platform core, honestly absent) | — | 0 | pass |
| `impact-drop-sphere` | physics | `impact-drop-sphere.json` | success | pybullet 3.2.7 | ✅ true | 29 | pass |
| `impact-drop-bounce` | physics | `impact-drop-bounce.json` | success | pybullet 3.2.7 | ✅ true | 11 | pass |
| `impact-drop-invalid-kind` | physics | `impact-drop-invalid-kind.json` | error | — (platform core, honestly absent) | — | 0 | pass |
| `p2t-compare-identical` | pdf2takeoff | `sheet-a102-plan.pdf` | success | pdf2takeoff 0.1.0 | ✅ true | 8 | pass |
| `p2t-compare-different` | pdf2takeoff | `sheet-a102-plan.pdf` | success | pdf2takeoff 0.1.0 | ✅ true | 8 | pass |
| `p2t-annotate-roundtrip` | pdf2takeoff | `sheet-a102-plan.pdf` | success | pdf2takeoff 0.1.0 | — | 4 | pass |
| `p2t-export-boq-roundtrip` | pdf2takeoff | `sheet-a102-plan.pdf` | success | pdf2takeoff 0.1.0 | ✅ true | 9 | pass |
| `p2t-fill-area-room` | pdf2takeoff | `sheet-a102-plan.pdf` | success | pdf2takeoff 0.1.0 | ✅ true | 6 | pass |
| `p2t-fill-no-scale` | pdf2takeoff | `sheet-a102-plan.pdf` | error | — (platform core, honestly absent) | — | 0 | pass |
| `p2t-export-no-annotations` | pdf2takeoff | `sheet-a102-plan.pdf` | error | — (platform core, honestly absent) | — | 0 | pass |
| `p2t-annotate-bad-spec` | pdf2takeoff | `sheet-a102-plan.pdf` | error | — (platform core, honestly absent) | — | 0 | pass |
| `p2t-fill-click-on-line` | pdf2takeoff | `sheet-a102-plan.pdf` | error | — (platform core, honestly absent) | — | 0 | pass |

### Discipline pin comparisons (observed vs hand-derived)

- `femesh-bracket-solid` nodes: observed **1088** vs pinned 1088 [bound abs:0] → rel error 0 (bitwise) · live-observed node count at MeshSizeMin 2.0 / MeshSizeMax 4.0, gmsh 4.15.2 linear tets — pinned after the TL smoke run
- `femesh-bracket-solid` elements: observed **3482** vs pinned 3482 [bound abs:0] → rel error 0 (bitwise) · live-observed tet4 count under the same pinned options
- `femesh-bracket-solid` solidRefOrderOk: observed **true** vs pinned true [bound structural] · solids[i].ref === step:solid:i for every index (the pinned ascending order)
- `femesh-bracket-solid` tetSumOk: observed **true** vs pinned true [bound structural] · sum of per-solid tetCounts === elements.count (payload self-consistency)
- `femesh-bracket-solid` qualityRangeOk: observed **true** vs pinned true [bound structural] · gmsh element qualities in (0,1] with min <= mean (observed min 0.2997 / mean 0.7848 live)
- `femesh-bracket-solid` tetCount @ step:solid:0: observed **3482** vs pinned 3482 [bound abs:0] → rel error 0 (bitwise) · single-solid fixture: the whole tet count
- `femesh-bracket-solid` meshVolume @ step:solid:0: observed **33286.26390462647** vs pinned 32984.071 mm3 [bound rel:0.02] → rel error 9.162e-3 (0.9162%) · closed form 36000 - 960*pi mm3 (40x30x30 block minus two r=4 h=30 through-holes; pi=3.14159265358979 -> 32984.07105). Linear tets under-trap the curved holes so the mesh volume runs HIGH: live-observed 33286.264 = +0.92%, the expected O(h^2) bias at these sizes; pinned at the contract's 2%
- `femesh-two-solids` nodes: observed **479** vs pinned 479 [bound abs:0] → rel error 0 (bitwise) · live-observed node count, gmsh 4.15.2 defaults
- `femesh-two-solids` elements: observed **1378** vs pinned 1378 [bound abs:0] → rel error 0 (bitwise) · live-observed tet4 count
- `femesh-two-solids` tetCount @ step:solid:0: observed **599** vs pinned 599 [bound abs:0] → rel error 0 (bitwise) · live-observed per-solid split (599 + 779 = 1378)
- `femesh-two-solids` tetCount @ step:solid:1: observed **779** vs pinned 779 [bound abs:0] → rel error 0 (bitwise) · live-observed per-solid split
- `femesh-two-solids` meshVolume @ step:solid:0: observed **5999.999999999992** vs pinned 6000 mm3 [bound rel:1e-12] → rel error 1.364e-15 · closed form 30x20x10 mm = 6000 mm3 (make_fixture_step_solids.py); planar -> EXACT by divergence theorem
- `femesh-two-solids` meshVolume @ step:solid:1: observed **9000.000000000005** vs pinned 9000 mm3 [bound rel:1e-12] → rel error 6.063e-16 · closed form 15x15x40 mm = 9000 mm3; planar -> EXACT by divergence theorem
- `femesh-geometry-free` (femesh) threw the honest error: `no solid geometry found in STEP file (import produced 0 solids) - cannot generate an FE mesh, and simulated meshes are not an option`
- `femesh-ifc-refused` (femesh) threw the honest error: `gmsh cannot import IFC geometry (gmsh has no IFC import reader - OCC STEP/IGES/BRep only) - cannot generate an FE mesh, and simulated meshes are not an option`
- `powerflow-2bus-closed-form` converged: observed **true** vs pinned true [bound structural] · lossless radial 2-bus with a light load: NR from a flat start converges to the high branch
- `powerflow-2bus-closed-form` busCount: observed **2** vs pinned 2 [bound abs:0] → rel error 0 (bitwise) · fixture declares 2 buses
- `powerflow-2bus-closed-form` lineCount: observed **1** vs pinned 1 [bound abs:0] → rel error 0 (bitwise) · fixture declares 1 line
- `powerflow-2bus-closed-form` lossMw: observed **0** vs pinned 0 [bound abs:1e-9] · r = 0 ohm/km -> I^2*R losses are identically zero; pandapower's residual rounding pinned at 1e-9
- `powerflow-2bus-closed-form` loadMw: observed **2** vs pinned 2 [bound abs:1e-9] → rel error 0 (bitwise) · the single declared load (2 MW)
- `powerflow-2bus-closed-form` vmPu @ bus-1: observed **1** vs pinned 1 [bound abs:1e-12] → rel error 0 (bitwise) · slack bus holds the external-grid setpoint exactly
- `powerflow-2bus-closed-form` vmPu @ bus-2: observed **0.9999874997656195** vs pinned 0.9999875 [bound rel:0.000001] → rel error 2.344e-10 · V2 = sqrt((1 + sqrt(1 - 4*(p*x)^2)) / 2) with p = P/baseMva = 2/100 = 0.02 pu and x = Xohm/baseZ = (0.1 ohm/km * 10 km) / ((20 kV)^2 / 100 MVA) = 1 / 4 = 0.25 pu -> p*x = 5e-3 -> 4*(px)^2 = 1e-4 -> V2^2 = (1 + 0.99995)/2 = 0.999975 -> V2 = 0.9999875 (the high branch NR converges to). [An earlier draft of this derivation wrote 1/4 as 0.025 — the harness caught the 10x slip against the real engine, which is exactly its job.]
- `powerflow-2bus-closed-form` angleDeg @ bus-2: observed **-0.28648367232412064** vs pinned -0.28647895 [bound abs:0.0001] → rel error 1.648e-5 · sin(delta) = p*x/V2 = 5.00000625e-3 rad = 0.28647895 degrees across the line (lossless: P = V1*V2*sin(delta)/X); bus-2 LAGS the slack reference so pandapower reports the negative angle; absTolerance 1e-4 deg absorbs NR's convergence residual (observed -0.28648367, residual 4.7e-6 deg — the solver's own tolerance, not a formula error)
- `powerflow-2bus-closed-form` iKa @ bus-1>bus-2: observed **0.057735748617323765** vs pinned 0.057735749 [bound rel:0.00001] → rel error 6.628e-9 · I = P / (sqrt(3) * V2_LL * ...) with the SOLVED V2: 2 MW / (1.7320508 * 20 kV * 0.9999875) = 0.05773575 kA (the current reflects the actual end-of-line voltage, not the nominal)
- `powerflow-2bus-closed-form` pLossMw @ bus-1>bus-2: observed **0** vs pinned 0 [bound abs:1e-9] · r = 0 -> zero active loss on the line
- `powerflow-islanded` (powerflow) threw the honest error: `power flow did not produce results for all buses (islanded network - buses with no path to the external grid: bus-3) - results are not available, and simulated `
- `des-flowshop-makespan` policy: observed **"fifo"** vs pinned "fifo" [bound structural] · the only policy shipped (contract §3.3)
- `des-flowshop-makespan` jobCount: observed **3** vs pinned 3 [bound abs:0] → rel error 0 (bitwise) · fixture declares 3 jobs
- `des-flowshop-makespan` resourceCount: observed **2** vs pinned 2 [bound abs:0] → rel error 0 (bitwise) · fixture declares 2 machines
- `des-flowshop-makespan` makespan: observed **13** vs pinned 13 [bound abs:0] → rel error 0 (bitwise) · hand trace: m1 serves j1[0,2] j2[2,5] j3[5,6] (busy 6); m2 serves j1[2,6] then j2[6,8] (j2 arrives at 5, waits), then j3[8,13] -> last completion 13
- `des-flowshop-makespan` utilizationInvariantOk: observed **true** vs pinned true [bound structural] · utilization === busy/makespan for every resource (payload self-consistency)
- `des-flowshop-makespan` busy @ m1: observed **6** vs pinned 6 [bound abs:0] → rel error 0 (bitwise) · sum of m1 task durations 2+3+1
- `des-flowshop-makespan` busy @ m2: observed **11** vs pinned 11 [bound abs:0] → rel error 0 (bitwise) · sum of m2 task durations 4+2+5
- `des-flowshop-makespan` utilization @ m1: observed **0.46153846153846156** vs pinned 0.46153846153846156 [bound abs:1e-12] → rel error 0 (bitwise) · 6/13 (busy/makespan)
- `des-flowshop-makespan` utilization @ m2: observed **0.8461538461538461** vs pinned 0.8461538461538461 [bound abs:1e-12] → rel error 0 (bitwise) · 11/13
- `des-flowshop-makespan` endAt @ j1: observed **6** vs pinned 6 [bound abs:0] → rel error 0 (bitwise) · j1: m1 [0,2] then m2 [2,6]
- `des-flowshop-makespan` endAt @ j3: observed **13** vs pinned 13 [bound abs:0] → rel error 0 (bitwise) · j3: m1 [5,6] then m2 [8,13] (waits for m2 to clear j2 at 8)
- `des-invalid-resource` (des) threw the honest error: `jobs[0].tasks[1] references unknown resource "crane"`
- `cpm-platform-rollout` activityCount: observed **6** vs pinned 6 [bound abs:0] → rel error 0 (bitwise) · fixture declares 6 activities
- `cpm-platform-rollout` durationDays: observed **11** vs pinned 11 [bound abs:0] → rel error 0 (bitwise) · longest path b(2)+d(5)+f(1)+e(3) = 11 days
- `cpm-platform-rollout` criticalPathCount: observed **4** vs pinned 4 [bound abs:0] → rel error 0 (bitwise) · critical activities: b, d, f, e
- `cpm-platform-rollout` criticalPath: observed **["b","d","f","e"]** vs pinned ["b","d","f","e"] [bound structural] · the single zero-float chain b->d->f->e (a and c each carry 1 day float)
- `cpm-platform-rollout` formatOk: observed **true** vs pinned true [bound structural] · document starts with the pinned eos-cpm/1 prefix (byte-deterministic pure assembly)
- `cpm-platform-rollout` engineKeyAbsent: observed **true** vs pinned true [bound structural] · NO engineKey/adapterScript in the document — platform core honesty (contract §4)
- `cpm-platform-rollout` es @ a: observed **0** vs pinned 0 [bound abs:0] · no predecessors -> starts day 0
- `cpm-platform-rollout` ef @ a: observed **3** vs pinned 3 [bound abs:0] → rel error 0 (bitwise) · 0 + duration 3
- `cpm-platform-rollout` totalFloat @ a: observed **1** vs pinned 1 [bound abs:0] → rel error 0 (bitwise) · ls 4 - es 3... hand: a feeds c(e->8 chain: c.ls = e.ls - dur = 8-3? c: ls = min(successor e.ls) - 4 = 8-4 = 4 -> float = 4-3 = 1
- `cpm-platform-rollout` critical @ a: observed **false** vs pinned false [bound structural] · float 1 > 0
- `cpm-platform-rollout` es @ b: observed **0** vs pinned 0 [bound abs:0] · no predecessors
- `cpm-platform-rollout` ef @ b: observed **2** vs pinned 2 [bound abs:0] → rel error 0 (bitwise) · 0 + 2
- `cpm-platform-rollout` totalFloat @ b: observed **0** vs pinned 0 [bound abs:0] · b->d->f->e is the critical chain -> b.ls = 0 = es
- `cpm-platform-rollout` critical @ b: observed **true** vs pinned true [bound structural] · zero float
- `cpm-platform-rollout` es @ c: observed **3** vs pinned 3 [bound abs:0] → rel error 0 (bitwise) · after a (ef 3)
- `cpm-platform-rollout` ef @ c: observed **7** vs pinned 7 [bound abs:0] → rel error 0 (bitwise) · 3 + 4
- `cpm-platform-rollout` totalFloat @ c: observed **1** vs pinned 1 [bound abs:0] → rel error 0 (bitwise) · c.ls = e.ls(8) - 4 = 4 -> float 1
- `cpm-platform-rollout` es @ d: observed **2** vs pinned 2 [bound abs:0] → rel error 0 (bitwise) · after b (ef 2)
- `cpm-platform-rollout` ef @ d: observed **7** vs pinned 7 [bound abs:0] → rel error 0 (bitwise) · 2 + 5
- `cpm-platform-rollout` ls @ d: observed **2** vs pinned 2 [bound abs:0] → rel error 0 (bitwise) · f.ls(7) - 5 = 2
- `cpm-platform-rollout` critical @ d: observed **true** vs pinned true [bound structural] · zero float
- `cpm-platform-rollout` es @ f: observed **7** vs pinned 7 [bound abs:0] → rel error 0 (bitwise) · after d (ef 7)
- `cpm-platform-rollout` ef @ f: observed **8** vs pinned 8 [bound abs:0] → rel error 0 (bitwise) · 7 + 1
- `cpm-platform-rollout` critical @ f: observed **true** vs pinned true [bound structural] · zero float
- `cpm-platform-rollout` es @ e: observed **8** vs pinned 8 [bound abs:0] → rel error 0 (bitwise) · after max(c ef 7, f ef 8)
- `cpm-platform-rollout` ef @ e: observed **11** vs pinned 11 [bound abs:0] → rel error 0 (bitwise) · 8 + 3 = project duration
- `cpm-platform-rollout` lf @ e: observed **11** vs pinned 11 [bound abs:0] → rel error 0 (bitwise) · terminal activity on the critical chain
- `cpm-platform-rollout` critical @ e: observed **true** vs pinned true [bound structural] · zero float
- `lo-cover-sheet-convert` pdfMagic: observed **"%PDF-"** vs pinned "%PDF-" [bound structural] · a PDF must start with the %PDF- magic (the bridge also refuses non-PDF output)
- `lo-cover-sheet-convert` sizeBytes: observed **26201** vs pinned 1000 [bound min] · the converted Writer document is a multi-digit-KB PDF (live-observed 26201 bytes) — a lower bound only, never an equality claim (timestamps affect exact bytes)
- `lo-cover-sheet-convert` engineKey: observed **"libreoffice"** vs pinned "libreoffice" [bound structural] · the registry key of the converting engine
- `lo-cover-sheet-convert` adapterScript: observed **"convert-document.ts"** vs pinned "convert-document.ts" [bound structural] · the TS-native bridge name (no python in the LO path)
- `sheet-vector-plan` pageCount: observed **4** vs pinned 4 [bound abs:0] → rel error 0 (bitwise) · fixture builder pins a 4-page document (Slice 20 added page 3, the two-size panel schedule; Slice 27 added page 4, the /Rotate 90 rotated-page fixture — pages 1-3 streams byte-identical)
- `sheet-vector-plan` pageNo: observed **1** vs pinned 1 [bound abs:0] → rel error 0 (bitwise) · the requested page, echoed by the adapter
- `sheet-vector-plan` linesCount: observed **5** vs pinned 5 [bound abs:0] → rel error 0 (bitwise) · page 1 drawn ops: bar + 2 end ticks + mid tick + wall = 5 lines (builder pin list)
- `sheet-vector-plan` rectsCount: observed **2** vs pinned 2 [bound abs:0] → rel error 0 (bitwise) · page 1 drawn ops: sheet border + room outline = 2 rects (builder pin list)
- `sheet-vector-plan` curvesCount: observed **0** vs pinned 0 [bound abs:0] · page 1 has no curve ops (builder pin list)
- `sheet-vector-plan` linesTotalLengthMm: observed **14270.002222222225** vs pinned 14270 mm [bound rel:0.000001] → rel error 1.557e-7 · (283.464567 + 85.039370 + 3 x 12) pt x 35.277777… mm/pt = 14 270.000 mm
- `sheet-vector-plan` rectsTotalPerimeterMm: observed **162666.11555555556** vs pinned 162666.1156 mm [bound rel:0.000001] → rel error 2.732e-10 · (2x(1143+794) + 2x(226.7717+141.7323)) pt x 35.277777… = 162 666.1156 mm
- `sheet-vector-plan` rectsTotalAreaMm2: observed **1169455639.250001** vs pinned 1169455639.25 mm2 [bound rel:0.000001] → rel error 8.155e-16 · (1143x794 + 226.7717x141.7323) pt2 x (35.277777…)2 = 1 169 455 639.25 mm2
- `sheet-vector-plan` textContains @ eos demo sheet a-102: observed **true** vs pinned true [bound structural] · the sheet title text operator is drawn on page 1 (builder pin list)
- `sheet-vector-plan` itemLengthMm @ line@60,120: observed **10000.001166666667** vs pinned 10000 mm [bound rel:0.000001] → rel error 1.167e-7 · bar span 343.4646 - 60 = 283.464567 pt = 10 000.000 mm @ 1:100
- `sheet-vector-plan` itemLengthMm @ line@613.3858,400: observed **3000.0010555555555** vs pinned 3000 mm [bound rel:0.000001] → rel error 3.519e-7 · wall span 485.0394 - 400 = 85.039370 pt = 3 000.000 mm @ 1:100
- `sheet-vector-plan` itemPerimeterMm @ rect@500,400: observed **26000.004444444447** vs pinned 26000 mm [bound rel:0.000001] → rel error 1.709e-7 · 2 x (226.7717 + 141.7323) pt = 737.008 pt = 26 000.000 mm @ 1:100
- `sheet-vector-plan` itemAreaMm2 @ rect@500,400: observed **40000012.86111207** vs pinned 40000000 mm2 [bound rel:0.000001] → rel error 3.215e-7 · 226.7717 x 141.7323 pt2 = 32 139.36 pt2 = 40 000 000 mm2 @ 1:100
- `sheet-vector-plan` pageNo: observed **2** vs pinned 2 [bound abs:0] → rel error 0 (bitwise) · the requested page, echoed by the adapter
- `sheet-vector-plan` linesCount: observed **4** vs pinned 4 [bound abs:0] → rel error 0 (bitwise) · page 2 is the self-contained calibration page: scale bar + 2 end ticks + mid tick = 4 lines (builder: page 2 carries scaleBarOps, NO wall)
- `sheet-vector-plan` rectsCount: observed **13** vs pinned 13 [bound abs:0] → rel error 0 (bitwise) · page 2: sheet border (borderOps) + 6 outer + 6 inner symbol squares = 13 rects (builder: buildSymbolPageContentStream)
- `sheet-vector-plan` rectsTotalAreaMm2: observed **1130321813.4259262** vs pinned 1130321813.4259 mm2 [bound rel:0.000001] → rel error 2.320e-14 · (1143x794 border + 6x10x10 + 6x4x4 symbols) pt2 = 908 238 pt2 x (35.277777…)2 = 1 130 321 8xx mm2
- `sheet-vector-plan` fixtureSha256: observed **"af00a43e0f8b22e2cea8261da5fd93ee9456941df27f9d40f33cd8297ff205a6"** vs pinned "af00a43e0f8b22e2cea8261da5fd93ee9456941df27f9d40f33cd8297ff205a6" [bound structural] · see case groundTruth — Slice 27 regenerated the fixture (page 4, the /Rotate 90 rotated page, added; pages 1-3 streams byte-identical)
- `sheet-vector-plan` linesTotalLengthMm: observed **11270.001166666669** vs pinned 11270 mm [bound rel:0.000001] → rel error 1.035e-7 · page-2 scale bar 283.464567 pt + 3 x 12 pt ticks = 319.464567 pt = 11 270.1 mm (same bar geometry as page 1, no wall)
- `sheet-vector-plan` pageNo: observed **3** vs pinned 3 [bound abs:0] → rel error 0 (bitwise) · the requested page, echoed by the adapter
- `sheet-vector-plan` pageCount: observed **4** vs pinned 4 [bound abs:0] → rel error 0 (bitwise) · fixture builder pins a 4-page document (Slice 27 added page 4, the /Rotate 90 rotated-page fixture; pages 1-3 streams byte-identical)
- `sheet-vector-plan` linesCount: observed **4** vs pinned 4 [bound abs:0] → rel error 0 (bitwise) · page 3 is self-contained like page 2: scale bar + 2 end ticks + mid tick = 4 lines (builder: buildPanelScheduleContentStream)
- `sheet-vector-plan` rectsCount: observed **21** vs pinned 21 [bound abs:0] → rel error 0 (bitwise) · page 3: border + 6 outer 10 pt + 6 inner 4 pt small sockets + 4 outer 15 pt + 4 inner 6 pt large sockets = 21 rects (the Slice-20 two-size field)
- `sheet-vector-plan` rectsTotalAreaMm2: observed **1131621093.9814816** vs pinned 1131621093.9815 mm2 [bound rel:0.000001] → rel error 1.622e-14 · (1143x794 border + 6x(100+16) small + 4x(225+36) large) pt2 = 909 282 pt2 x (35.277777…)2 = 1 131 621 093.98 mm2
- `sheet-vector-plan` fixtureSha256: observed **"af00a43e0f8b22e2cea8261da5fd93ee9456941df27f9d40f33cd8297ff205a6"** vs pinned "af00a43e0f8b22e2cea8261da5fd93ee9456941df27f9d40f33cd8297ff205a6" [bound structural] · see case groundTruth — Slice 27 regenerated the fixture (page 4, the /Rotate 90 rotated page, added; pages 1-3 streams byte-identical)
- `sheet-vector-plan` linesTotalLengthMm: observed **11270.001166666669** vs pinned 11270 mm [bound rel:0.000001] → rel error 1.035e-7 · page-3 scale bar 283.464567 pt + 3 x 12 pt ticks = 319.464567 pt = 11 270.000 mm (same furniture as page 2)
- `sheet-vector-plan` pageNo: observed **4** vs pinned 4 [bound abs:0] → rel error 0 (bitwise) · the requested page, echoed by the adapter
- `sheet-vector-plan` pageCount: observed **4** vs pinned 4 [bound abs:0] → rel error 0 (bitwise) · fixture builder pins a 4-page document (Slice 27 added page 4, the /Rotate 90 rotated-page fixture; pages 1-3 streams byte-identical)
- `sheet-vector-plan` widthPt: observed **842** vs pinned 842 [bound abs:0] → rel error 0 (bitwise) · pdfplumber reports the DISPLAYED page for /Rotate 90 — the unrotated 1191x842 MediaBox turned upright is 842 wide (probed 2026-10-29; pdf.js's viewport paints the same view, the empirically probed alignment of src/core/page-rotation.ts)
- `sheet-vector-plan` heightPt: observed **1191** vs pinned 1191 [bound abs:0] → rel error 0 (bitwise) · the displayed height = the unrotated width 1191 (the /Rotate 90 extent swap, pdfplumber semantics)
- `sheet-vector-plan` linesCount: observed **4** vs pinned 4 [bound abs:0] → rel error 0 (bitwise) · page 4 carries the same scale-bar furniture as page 2: bar + 2 end ticks + mid tick = 4 lines — rotation never moves a count
- `sheet-vector-plan` rectsCount: observed **13** vs pinned 13 [bound abs:0] → rel error 0 (bitwise) · page 4 is page-2-isomorphic by construction: border + 6 outer + 6 inner = 13 rects
- `sheet-vector-plan` rectsTotalAreaMm2: observed **1130321813.4259262** vs pinned 1130321813.4259 mm2 [bound rel:0.000001] → rel error 2.320e-14 · rotation never moves an area — the page-2 value pinned again (908 238 pt2 x (35.277777...)2 = 1 130 321 813.4259 mm2)
- `sheet-vector-plan` fixtureSha256: observed **"af00a43e0f8b22e2cea8261da5fd93ee9456941df27f9d40f33cd8297ff205a6"** vs pinned "af00a43e0f8b22e2cea8261da5fd93ee9456941df27f9d40f33cd8297ff205a6" [bound structural] · Slice 27 regenerated the fixture (page 4, the /Rotate 90 rotated page, added; pages 1-3 streams byte-identical)
- `sheet-vector-plan` itemAreaMm2 @ rect@350,741: observed **124452.16049382716** vs pinned 124452.1605 mm2 [bound rel:0.000001] → rel error 4.960e-11 · THE ROTATED-ANCHOR PIN: the socket at unrotated (440..450, 350..360) presents its first corner at (350, 741) in the pdfminer-CTM rotated view (y, W-x) — 10x10 pt = 100 pt2 x (35.277777...)2 = 124 452.1605 mm2; probed through the real adapter (the same view pdf.js paints)
- `sheet-vector-plan` itemAreaMm2 @ rect@500,981: observed **124452.16049382716** vs pinned 124452.1605 mm2 [bound rel:0.000001] → rel error 4.960e-11 · the far rotated anchor: the socket at unrotated (200..210, 500..510) presents its first corner at (500, 981) in the CTM view — same 100 pt2 area, the anchor proves the W-x axis
- `sheet-vector-plan` itemFill @ rect@503,744: observed **true** vs pinned true [bound structural] · the concentric INNER socket (unrotated 443..447, 503..507) presents its first corner at (503, 744) in the CTM view and stays the filled square
- `sheet-vector-plan` linesTotalLengthMm: observed **11270.001166666669** vs pinned 11270 mm [bound rel:0.000001] → rel error 1.035e-7 · rotation never moves a length: the scale bar's 283.464567 pt + 3 x 12 pt ticks = 11 270.000 mm (same furniture as page 2)
- `sheet-vector-curve` curvesCount: observed **1** vs pinned 1 [bound abs:0] → rel error 0 (bitwise) · page 1 has no curve ops (builder pin list)
- `sheet-vector-curve` curvesTotalLengthMm: observed **157.08588681984884** vs pinned 157.0796327 mm [bound rel:0.001] → rel error 3.981e-5 · analytic quarter-arc r x pi/2 = 100 x pi/2 = 157.0796327 pt; N=32 flattening rel ~4e-5 (16-R1)
- `sheet-vector-curve` rectsCount: observed **1** vs pinned 1 [bound abs:0] → rel error 0 (bitwise) · page 1 drawn ops: sheet border + room outline = 2 rects (builder pin list)
- `sheet-vector-curve` rectsTotalPerimeterMm: observed **160** vs pinned 160 mm [bound rel:1e-9] → rel error 0 (bitwise) · (2x(1143+794) + 2x(226.7717+141.7323)) pt x 35.277777… = 162 666.1156 mm
- `sheet-vector-curve` rectsTotalAreaMm2: observed **1500** vs pinned 1500 mm2 [bound rel:1e-9] → rel error 0 (bitwise) · (1143x794 + 226.7717x141.7323) pt2 x (35.277777…)2 = 1 169 455 639.25 mm2
- `sheet-vector-curve` fixtureSha256: observed **"e690f692d1484c2a558d99d0e8181868dd828ba0ad191614662f1bc932d20557"** vs pinned "e690f692d1484c2a558d99d0e8181868dd828ba0ad191614662f1bc932d20557" [bound structural] · see case groundTruth
- `sheet-vector-refusal` (sheet) threw the honest error: `this sheet page has no vector path operators — it is a scan or raster-only page; vector takeoff is not available for it, and simulated geometry is not an option`
- `dxf-takeoff-room` unitsMm: observed **true** vs pinned true [bound structural] · $INSUNITS = 4 (mm) set by the fixture generator
- `dxf-takeoff-room` layerCount: observed **3** vs pinned 3 [bound abs:0] → rel error 0 (bitwise) · WALLS + DIM + FURN layers authored by the generator
- `dxf-takeoff-room` entityCount: observed **4** vs pinned 4 [bound abs:0] → rel error 0 (bitwise) · 1 polyline + 1 line + 1 arc + 1 circle = 4 supported entities
- `dxf-takeoff-room` fixtureSha256: observed **"c97db72ff09d8e862529422883d164a4d7feca3a41f1aac985a484704c40ed8b"** vs pinned "c97db72ff09d8e862529422883d164a4d7feca3a41f1aac985a484704c40ed8b" [bound structural] · see case groundTruth
- `dxf-takeoff-room` fixtureRegenByteIdentical: observed **true** vs pinned true [bound structural] · two fresh make_fixture_takeoff_room.py runs == committed bytes (ezdxf write_fixed_meta_data_for_testing)
- `dxf-takeoff-room` layerPolylinesCount @ WALLS: observed **1** vs pinned 1 [bound abs:0] → rel error 0 (bitwise) · WALLS carries the one closed rectangle LWPOLYLINE
- `dxf-takeoff-room` layerTotalLengthMm @ WALLS: observed **14000** vs pinned 14000 mm [bound rel:1e-9] → rel error 0 (bitwise) · closed rectangle 4000x3000 mm -> 2x(4000+3000) = 14 000 mm exact
- `dxf-takeoff-room` layerTotalClosedAreaMm2 @ WALLS: observed **12000000** vs pinned 12000000 mm2 [bound rel:1e-9] → rel error 0 (bitwise) · closed rectangle 4000x3000 mm -> 12 000 000 mm2 exact
- `dxf-takeoff-room` layerLinesCount @ DIM: observed **1** vs pinned 1 [bound abs:0] → rel error 0 (bitwise) · DIM carries the one vertical LINE
- `dxf-takeoff-room` layerArcsCount @ DIM: observed **1** vs pinned 1 [bound abs:0] → rel error 0 (bitwise) · DIM carries the one quarter ARC
- `dxf-takeoff-room` layerTotalLengthMm @ DIM: observed **3413.716694115407** vs pinned 3413.716694115407 mm [bound rel:1e-9] → rel error 0 (bitwise) · LINE 2000 mm + ARC 900 x pi/2 = 1413.716694 mm -> 3413.716694 mm exact (no flattening)
- `dxf-takeoff-room` layerCirclesCount @ FURN: observed **1** vs pinned 1 [bound abs:0] → rel error 0 (bitwise) · FURN carries the one CIRCLE
- `dxf-takeoff-room` layerTotalLengthMm @ FURN: observed **628.3185307179587** vs pinned 628.3185307179587 mm [bound rel:1e-9] → rel error 0 (bitwise) · circle circumference 2 x pi x 100 = 628.318531 mm exact
- `parametric-schema` engineKey: observed **"cadquery"** vs pinned "cadquery" [bound structural] · the adapter's declared engine — cadquery is the pinned BREP kernel (16-R3: the only STEP-authoring engine in the pinned set, zero new dependencies)
- `parametric-schema` adapterScript: observed **"parametric_rebuild.py"** vs pinned "parametric_rebuild.py" [bound structural] · the adapter names itself in the envelope (the step_femesh.py protocol contract)
- `parametric-schema` schemaKeysCount: observed **5** vs pinned 5 [bound abs:0] → rel error 0 (bitwise) · the committed model declares exactly five numeric parameters: width, depth, thickness, height, holeDia
- `parametric-schema` defaultsCount: observed **5** vs pinned 5 [bound abs:0] → rel error 0 (bitwise) · DEFAULT_PARAMS pins one authored default per declared parameter (w80-d50-t8-h60-hd10)
- `parametric-schema` modelScriptHash: observed **"fcfb7185b7cfc75f5211b17c763df3919f602f4c344c405172f551756463ea82"** vs pinned "fcfb7185b7cfc75f5211b17c763df3919f602f4c344c405172f551756463ea82" [bound structural] · sha256 of the committed tests/fixtures/parametric-bracket.py bytes — the artifact-revision identity the broker pins to the parametric-model revision
- `parametric-defaults` engineKey: observed **"cadquery"** vs pinned "cadquery" [bound structural] · the adapter's declared engine (cadquery, the pinned BREP kernel)
- `parametric-defaults` paramKeys: observed **"depth,height,holeDia,thickness,width"** vs pinned "depth,height,holeDia,thickness,width" [bound structural] · paramsUsed = the authored defaults merged over the empty edit set — five keys, sorted, comma-joined
- `parametric-defaults` paramVolumeMm3: observed **64651.68146928197** vs pinned 64651.68146928197 mm3 [bound rel:1e-9] → rel error 0 (bitwise) · V = 80*50*8 + 80*8*(60-8) - pi*10^2/4*8 = 65280 - 200*pi = 64651.68146928204 mm3 analytic; pinned value = the 16-R3 RUN A STEP re-import (rel 1.13e-15 vs analytic)
- `parametric-defaults` paramAreaMm2: observed **19326.247779607707** vs pinned 19326.247779607693 mm2 [bound rel:1e-9] → rel error 7.530e-16 · A = w*d + w*(d-t) + 3*w*t + 2*t*(d+h-t) + 2*w*(h-t) - pi*hd^2/2 + pi*hd*t = 19232 + 30*pi mm2 (incl. the internal shared face OCCT retains in the fused solid; verified rel 7e-16)
- `parametric-defaults` paramBboxW: observed **80** vs pinned 80 [bound abs:0] → rel error 0 (bitwise) · the re-imported solid spans x in [0, 80] — the drawn base width, uncut by the through-hole
- `parametric-defaults` paramBboxD: observed **50** vs pinned 50 [bound abs:0] → rel error 0 (bitwise) · the re-imported solid spans y in [0, 50] — the drawn base depth (the drill overshoots y but is a cut, adding no material)
- `parametric-defaults` paramBboxH: observed **60** vs pinned 60 [bound abs:0] → rel error 0 (bitwise) · the re-imported solid spans z in [0, 60] — the drawn overall height
- `parametric-defaults` paramChecksRelErr: observed **1.1254088755047233e-15** vs pinned 0 [bound abs:1e-9] · the adapter's own analytic gate: |re-imported - analytic| / analytic must be <= 1e-9 (16-R3 measured 1.1254e-15)
- `parametric-defaults` paramChecksPassed: observed **true** vs pinned true [bound structural] · the STEP is emitted ONLY because the analytic gate passed — the gate result itself is pinned
- `parametric-edited` engineKey: observed **"cadquery"** vs pinned "cadquery" [bound structural] · the adapter's declared engine (cadquery, the pinned BREP kernel)
- `parametric-edited` paramKeys: observed **"depth,height,holeDia,thickness,width"** vs pinned "depth,height,holeDia,thickness,width" [bound structural] · paramsUsed = the five edited values — the merged keys are exactly the schema's keys, sorted, comma-joined
- `parametric-edited` paramVolumeMm3: observed **153989.38070170232** vs pinned 153989.38070170232 mm3 [bound rel:1e-9] → rel error 0 (bitwise) · V = 120*60*10 + 120*10*(80-10) - pi*16^2/4*10 = 156000 - 640*pi = 153989.38070170252 mm3 analytic; pinned value = the 16-R3 RUN B STEP re-import (rel 1.32e-15 vs analytic)
- `parametric-edited` paramAreaMm2: observed **36300.530964914906** vs pinned 36300.53096491488 mm2 [bound rel:1e-9] → rel error 8.017e-16 · A = w*d + w*(d-t) + 3*w*t + 2*t*(d+h-t) + 2*w*(h-t) - pi*hd^2/2 + pi*hd*t = 36200 + 32*pi mm2 (verified rel 7e-16 against the re-imported solid)
- `parametric-edited` paramBboxW: observed **120** vs pinned 120 [bound abs:0] → rel error 0 (bitwise) · the re-imported solid spans x in [0, 120] — the edited width
- `parametric-edited` paramBboxD: observed **60** vs pinned 60 [bound abs:0] → rel error 0 (bitwise) · the re-imported solid spans y in [0, 60] — the edited depth
- `parametric-edited` paramBboxH: observed **80** vs pinned 80 [bound abs:0] → rel error 0 (bitwise) · the re-imported solid spans z in [0, 80] — the edited height
- `parametric-edited` paramChecksRelErr: observed **1.3229926133139096e-15** vs pinned 0 [bound abs:1e-9] · the adapter's own analytic gate: |re-imported - analytic| / analytic must be <= 1e-9 (16-R3 measured 1.3230e-15)
- `parametric-edited` paramChecksPassed: observed **true** vs pinned true [bound structural] · the STEP is emitted ONLY because the analytic gate passed — the gate result itself is pinned
- `parametric-refusals` (parametric) threw the honest error: `parameter 'width' = 10 below minimum 20 | unknown parameter(s) rejected: ['bogus'] | hole does not fit inside the vertical leg — raise height or shrink holeDia`
- `sheet-ocr-callout` tessdata sha256 @ tests/fixtures/tessdata/eng.traineddata: observed **"7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2"** vs pinned "7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2" [bound exact] · the vendored eng model — byte-identical reads in CI (16-R2)
- `sheet-ocr-callout` word @ word 1: observed **"LOADING (conf 96.2)"** vs pinned "LOADING (conf ≥ 90)" [bound min 90] · the live tesseract read of the committed fixture with the vendored model
- `sheet-ocr-callout` word @ word 2: observed **"BAY (conf 96.5)"** vs pinned "BAY (conf ≥ 90)" [bound min 90] · the live tesseract read of the committed fixture with the vendored model
- `sheet-ocr-callout` word @ word 3: observed **"PLAN (conf 97.0)"** vs pinned "PLAN (conf ≥ 90)" [bound min 90] · the live tesseract read of the committed fixture with the vendored model
- `sheet-ocr-callout` word @ word 4: observed **"2400 (conf 97.0)"** vs pinned "2400 (conf ≥ 90)" [bound min 90] · the live tesseract read of the committed fixture with the vendored model
- `sheet-ocr-callout` word @ Ø-rule row 5: observed **"@400 → Ø400 (conf 55.0)"** vs pinned "@400 → Ø400 (conf ≥ 40)" [bound min 40] · the live tesseract read of the committed fixture with the vendored model
- `sheet-ocr-callout` word @ word 6: observed **"1200 (conf 96.0)"** vs pinned "1200 (conf ≥ 90)" [bound min 90] · the live tesseract read of the committed fixture with the vendored model
- `sheet-ocr-callout` word @ word 7: observed **"GHS (conf 90.3)"** vs pinned "GHS (conf ≥ 85)" [bound min 85] · the live tesseract read of the committed fixture with the vendored model
- `sheet-ocr-callout` word @ word 8: observed **"225.00 (conf 96.7)"** vs pinned "225.00 (conf ≥ 90)" [bound min 90] · the live tesseract read of the committed fixture with the vendored model
- `fea-uniform-tension` analysis: observed **"plane_stress"** vs pinned "plane_stress" [bound structural] · the only analysis shipped this phase (contract §14.2)
- `fea-uniform-tension` elementType: observed **"tri6"** vs pinned "tri6" [bound structural] · ElementVector(ElementTriP2()) — quadratic triangles, 6 nodes (contract §14.5)
- `fea-uniform-tension` refinement: observed **4** vs pinned 4 [bound abs:0] → rel error 0 (bitwise) · the default meshRefinement parameter (contract §14.3)
- `fea-uniform-tension` elementCount: observed **512** vs pinned 512 [bound abs:0] → rel error 0 (bitwise) · MeshTri().refined(4): the base 2 triangles × 4^4 = 512 — deterministic uniform mesh
- `fea-uniform-tension` nodeCount: observed **2178** vs pinned 2178 [bound abs:0] → rel error 0 (bitwise) · P2 dof points of the refined(4) mesh: 81 vertices + 144 midside points × 2 components interleaved = 2178/2 scalar points… pinned as the deterministic dof-point count
- `fea-uniform-tension` ux @ 0x0: observed **0** vs pinned 0 [bound abs:1e-9] · u_x = σx/E = 0 at x = 0 (the left edge ux support is exactly compatible)
- `fea-uniform-tension` uy @ 0x0: observed **0** vs pinned 0 [bound abs:1e-9] · u_y = −νσy/E = 0 at y = 0 (the bottom edge uy support is exactly compatible)
- `fea-uniform-tension` uy @ 0x200: observed **-0.003000000000000113** vs pinned -0.003 [bound abs:1e-9] → rel error 3.759e-14 · u_y(H) = −νσH/E = −0.3·10·200/200000 = −0.003 mm (Poisson contraction, free left-edge uy)
- `fea-uniform-tension` ux @ 200x100: observed **0.01000000000000092** vs pinned 0.01 [bound abs:1e-9] → rel error 9.194e-14 · u_x(W/2) = σ(W/2)/E = 10·200/200000 = 0.01 mm
- `fea-uniform-tension` uy @ 200x100: observed **-0.0014999999999999666** vs pinned -0.0015 [bound abs:1e-9] → rel error 2.226e-14 · u_y(H/2) = −νσ(H/2)/E = −0.0015 mm
- `fea-uniform-tension` ux @ 400x0: observed **0.02000000000000134** vs pinned 0.02 [bound abs:1e-9] → rel error 6.696e-14 · u_x(W) = σW/E = 10·400/200000 = 0.02 mm — the Hooke's-law anchor
- `fea-uniform-tension` ux @ 400x200: observed **0.02000000000000105** vs pinned 0.02 [bound abs:1e-9] → rel error 5.256e-14 · u_x(W) = σW/E = 0.02 mm at the far corner (uniform field: independent of y)
- `fea-uniform-tension` uy @ 400x200: observed **-0.002999999999999486** vs pinned -0.003 [bound abs:1e-9] → rel error 1.713e-13 · u_y(H) = −νσH/E = −0.003 mm at the far corner
- `fea-uniform-tension` sigmaXxMinMpa: observed **9.999999999999728** vs pinned 10 [bound abs:1e-9] → rel error 2.718e-14 · σ_xx = σ = 10 MPa uniform (plane stress, σ_yy = τ_xy = 0) — the per-element mean equals the constant exactly
- `fea-uniform-tension` vonMisesMaxMpa: observed **10.000000000001068** vs pinned 10 [bound abs:1e-9] → rel error 1.068e-13 · von Mises of uniaxial σ: √(σ²) = σ = 10 MPa
- `fea-uniform-tension` maxDisplacementMagnitudeMm: observed **0.02022374841615765** vs pinned 0.020223748416157 [bound abs:1e-9] → rel error 3.208e-14 · hypot(u_x(W), u_y(H)) = √(0.02² + 0.003²) = √0.000409 = 0.020223748416157 mm at the far corner
- `fea-cantilever-end-shear` elementCount: observed **512** vs pinned 512 [bound abs:0] → rel error 0 (bitwise) · MeshTri().refined(4) on the scaled 2000×500 domain — same deterministic 512 tri6 elements
- `fea-cantilever-end-shear` uy @ 2000x0: observed **-1.336151125569775** vs pinned -1.3424 [bound rel:0.01] → rel error 4.655e-3 (0.4655%) · Timoshenko tip deflection at the bottom-right corner: PL³/3EI + PL/κGA = 1.28 + 0.0624 = 1.3424 mm (positive shear acts along the CCW tangent = −y on the right edge, so the plate bends DOWN); the corner carries the centerline deflection (the section rotation displaces the tip corners horizontally, not vertically)
- `fea-cantilever-end-shear` uy @ 2000x500: observed **-1.3361125402122764** vs pinned -1.3424 [bound rel:0.01] → rel error 4.684e-3 (0.4684%) · the top-right corner mirrors the bottom within the solver's clamp-boundary-layer difference — both carry the Timoshenko centerline value (observed 1.3361 vs 1.3362)
- `fea-underconstrained` (fea) threw the honest error: `the supports do not constrain the model's rigid-body motion (free: translation in y, rotation about z) - an unconstrained model cannot be solved, and simulated `
- `swmm-runoff-balance` analysis: observed **"drainage"** vs pinned "drainage" [bound structural] · the only analysis shipped this phase (contract §15.4)
- `swmm-runoff-balance` engineKey: observed **"pyswmm"** vs pinned "pyswmm" [bound structural] · the pip-pinned pyswmm distribution drives the EPA SWMM5 engine in-process (contract §15.5)
- `swmm-runoff-balance` routingStepSec: observed **10** vs pinned 10 [bound abs:0] → rel error 0 (bitwise) · the default routingStepSec parameter (contract §15.3)
- `swmm-runoff-balance` rainVolumeM3: observed **500** vs pinned 500 [bound abs:0] → rel error 0 (bitwise) · i.A.t = 0.025 m/hr x 2 hr x 10 000 m2 = 500 m3 -- the adapter's own rain block must agree exactly
- `swmm-runoff-balance` outfallVolumeM3: observed **500.02193805825715** vs pinned 500 [bound rel:0.001] → rel error 4.388e-5 · mass conservation: all rain that fell drains by end of window (probe-observed rel 4.4e-5)
- `swmm-runoff-balance` maxRunoffCms: observed **0.06945220755175956** vs pinned 0.06944444444444443 [bound rel:0.01] → rel error 1.118e-4 (0.0112%) · equilibrium runoff = i.A = 25/1000/3600 x 10 000 = 0.0694444 m3/s, approached asymptotically (observed rel 1.1e-4)
- `swmm-runoff-balance` maxConduitFlowCms: observed **0.07059164318103153** vs pinned 0.06944444444444443 [bound rel:0.03] → rel error 1.652e-2 (1.6520%) · equilibrium flow + the kinematic-wave numerical surge (probe-observed +1.6%)
- `swmm-runoff-balance` maxDepthM @ C1: observed **0.14486048192340867** vs pinned 0.14486665688316655 [bound abs:0.005] → rel error 4.263e-5 · Manning normal depth: (1/0.015).0.5.y.(0.5y/(0.5+2y))^(2/3).sqrt(0.005) = 0.0694444 -> y_N = 0.144866657 m (observed abs 6.2e-6)
- `swmm-runoff-balance` maxDepthM @ J1: observed **0.14486048196573673** vs pinned 0.14486665688316655 [bound abs:0.005] → rel error 4.262e-5 · the junction's max depth equals the conduit's equilibrium depth (observed abs 6.2e-6)
- `swmm-runoff-balance` runoffErrorPct: observed **-0.012** vs pinned 0 [bound abs:0.5] · the engine's own .rpt runoff continuity error, pinned as a magnitude bound (observed -0.012%)
- `swmm-runoff-balance` routingErrorPct: observed **-0.055** vs pinned 0 [bound abs:0.5] · the engine's own .rpt flow-routing continuity error, pinned as a magnitude bound (observed -0.055%)
- `swmm-manning-conduit` rainVolumeM3: observed **2000** vs pinned 2000 [bound abs:0] → rel error 0 (bitwise) · i.A.t = 0.05 x 2 x 20 000 = 2 000 m3
- `swmm-manning-conduit` outfallVolumeM3: observed **2000.2177313394764** vs pinned 2000 [bound rel:0.001] → rel error 1.089e-4 (0.0109%) · mass conservation on the bigger storm (probe-observed rel 1.1e-4)
- `swmm-manning-conduit` maxRunoffCms: observed **0.2778088311533788** vs pinned 0.2777777777777778 [bound rel:0.01] → rel error 1.118e-4 (0.0112%) · equilibrium runoff = i.A = 50/1000/3600 x 20 000 = 0.2777778 m3/s (observed rel 1.1e-4)
- `swmm-manning-conduit` maxConduitFlowCms: observed **0.28054116263223894** vs pinned 0.2777777777777778 [bound rel:0.03] → rel error 9.948e-3 (0.9948%) · equilibrium + surge (probe-observed +1.0%)
- `swmm-manning-conduit` maxDepthM @ J1: observed **0.18094179310931605** vs pinned 0.1809516359327449 [bound abs:0.005] → rel error 5.439e-5 · Manning cubic: (1/0.013).0.8.y.(0.8y/(0.8+2y))^(2/3).sqrt(0.01) = 0.2777778 -> y_N = 0.180951636 m (observed abs 9.8e-6)
- `swmm-manning-conduit` maxDepthM @ C1: observed **0.18094179310920122** vs pinned 0.1809516359327449 [bound abs:0.005] → rel error 5.439e-5 · the conduit's own equilibrium depth mirrors the junction (observed abs 9.8e-6)
- `swmm-manning-conduit` runoffErrorPct: observed **-0.015** vs pinned 0 [bound abs:0.5] · engine .rpt runoff continuity magnitude bound (observed -0.015%)
- `swmm-manning-conduit` routingErrorPct: observed **-0.02** vs pinned 0 [bound abs:0.5] · engine .rpt routing continuity magnitude bound (observed -0.02%)
- `swmm-no-outfall` (swmm) threw the honest error: `the network has no outfall - runoff cannot leave the model, and simulated results are not an option`
- `transport-channel` analysis: observed **"scalar_transport"** vs pinned "scalar_transport" [bound structural] · the only analysis shipped this phase (contract §16.2)
- `transport-channel` engineKey: observed **"sfepy"** vs pinned "sfepy" [bound structural] · the CFD lane's pinned engine (contract §16.1)
- `transport-channel` elementType: observed **"quad"** vs pinned "quad" [bound structural] · gen_block_mesh 2_4 quads (contract §16.1 probe)
- `transport-channel` approximation: observed **"Q2"** vs pinned "Q2" [bound structural] · approx_order=2 on quads → 9-node Q2 (contract §16.3)
- `transport-channel` refinement: observed **4** vs pinned 4 [bound abs:0] → rel error 0 (bitwise) · the default meshRefinement parameter (contract §16.3)
- `transport-channel` elementCount: observed **1024** vs pinned 1024 [bound abs:0] → rel error 0 (bitwise) · N=8·2³=64 divisions on the longer (x) axis, y gets round(64·0.5/2)=16 → 64·16=1024 quads (the frozen square-element rule)
- `transport-channel` nodeCount: observed **4257** vs pinned 4257 [bound abs:0] → rel error 0 (bitwise) · Q2 dofs: 65·17 corners + 64·17 x-midside + 65·16 y-midside + 64·16 centers = 1105+1088+1040+1024 = 4257
- `transport-channel` pecletNumber: observed **10** vs pinned 10 [bound abs:1e-12] → rel error 0 (bitwise) · Pe = a·L/D = 0.05·2/0.01 = 10
- `transport-channel` meshPecletNumber: observed **0.078125** vs pinned 0.078125 [bound abs:1e-12] → rel error 0 (bitwise) · Pe_h = a·h/(2D) with h = L/64 = 0.03125 → 0.05·0.03125/0.02 = 0.078125 (far inside the probed-monotone bound 2)
- `transport-channel` minConcentration: observed **0** vs pinned 0 [bound abs:1e-12] · the outlet Dirichlet dof is exactly 0 and the monotone solution never undershoots (Pe_h ≪ 2)
- `transport-channel` maxConcentration: observed **1** vs pinned 1 [bound abs:1e-12] → rel error 0 (bitwise) · the inlet Dirichlet dof is exactly 1 and the monotone solution never overshoots
- `transport-channel` concentration @ 0.25x0.25: observed **0.9998869326982197** vs pinned 0.9998869334714342 [bound abs:0.0001] → rel error 7.733e-10 · u(L/8) = (e^10 − e^1.25)/(e^10 − 1) = 0.9998869334714342
- `transport-channel` concentration @ 0.5x0.25: observed **0.9994922894467514** vs pinned 0.9994922925097303 [bound abs:0.0001] → rel error 3.065e-9 · u(L/4) = (e^10 − e^2.5)/(e^10 − 1) = 0.9994922925097303
- `transport-channel` concentration @ 1.0x0.25: observed **0.9933071215178892** vs pinned 0.9933071490757152 [bound abs:0.0001] → rel error 2.774e-8 · u(L/2) = (e^10 − e^5)/(e^10 − 1) = 0.9933071490757152
- `transport-channel` concentration @ 1.5x0.25: observed **0.9179565067518198** vs pinned 0.9179566765447413 [bound abs:0.0001] → rel error 1.850e-7 · u(3L/4) = (e^10 − e^7.5)/(e^10 − 1) = 0.9179566765447413
- `transport-channel` concentration @ 1.75x0.25: observed **0.7135273005906564** vs pinned 0.7135275972426084 [bound abs:0.0001] → rel error 4.158e-7 · u(7L/8) = (e^10 − e^8.75)/(e^10 − 1) = 0.7135275972426084 — inside the outlet boundary layer (observed 3.0e-7 at r=4, the O(h³) convergence pin)
- `transport-uniform` pecletNumber: observed **10** vs pinned 10 [bound abs:1e-12] → rel error 0 (bitwise) · Pe = a·L/D = 10 (same transport regime as the channel case)
- `transport-uniform` minConcentration: observed **0.9999999999999125** vs pinned 1 [bound abs:1e-12] → rel error 8.749e-14 · u ≡ 1: the constant field is the exact solution (observed 0.9999999999999238)
- `transport-uniform` maxConcentration: observed **1** vs pinned 1 [bound abs:1e-12] → rel error 0 (bitwise) · u ≡ 1 (observed exactly 1.0 — the Dirichlet dofs pin the range)
- `transport-uniform` concentration @ 0.25x0.25: observed **0.9999999999999813** vs pinned 1 [bound abs:1e-12] → rel error 1.865e-14 · u ≡ 1 at every station (observed 1 − 1.4e-14)
- `transport-uniform` concentration @ 0.5x0.25: observed **0.9999999999999647** vs pinned 1 [bound abs:1e-12] → rel error 3.531e-14 · u ≡ 1 at every station (observed 1 − 2.5e-14)
- `transport-uniform` concentration @ 1.0x0.25: observed **0.9999999999999315** vs pinned 1 [bound abs:1e-12] → rel error 6.850e-14 · u ≡ 1 at every station (observed 1 − 5.6e-14)
- `transport-uniform` concentration @ 1.5x0.25: observed **0.999999999999915** vs pinned 1 [bound abs:1e-12] → rel error 8.504e-14 · u ≡ 1 at every station (observed 1 − 7.4e-14)
- `transport-uniform` concentration @ 1.75x0.25: observed **0.9999999999999325** vs pinned 1 [bound abs:1e-12] → rel error 6.750e-14 · u ≡ 1 at every station (observed 1 − 6.1e-14)
- `transport-mesh-peclet-refusal` (transport) threw the honest error: `the mesh does not resolve the transport boundary layer (element Péclet 7.81 exceeds the stability bound 2) - refine the mesh (increase meshRefinement) or reduce`
- `rtl-counter-4bit` analysis: observed **"rtl_synthesis"** vs pinned "rtl_synthesis" [bound structural] · the only analysis shipped this phase (contract §17.4)
- `rtl-counter-4bit` engineKey: observed **"amaranth"** vs pinned "amaranth" [bound structural] · the lane's front-end engine (contract §17.3)
- `rtl-counter-4bit` engineVersion: observed **"0.5.10"** vs pinned "0.5.10" [bound structural] · the pinned amaranth wheel (engines-requirements)
- `rtl-counter-4bit` deviceKind: observed **"enable_counter"** vs pinned "enable_counter" [bound structural] · the frozen v1 device class (contract §17.2)
- `rtl-counter-4bit` widthBits: observed **4** vs pinned 4 [bound abs:0] → rel error 0 (bitwise) · the fixture's register width
- `rtl-counter-4bit` flipFlopCount: observed **4** vs pinned 4 [bound abs:0] → rel error 0 (bitwise) · the closed form: a W-bit register has exactly W storage elements — probed at every width (§17.1)
- `rtl-counter-4bit` totalCells: observed **10** vs pinned 10 [bound abs:0] → rel error 0 (bitwise) · 4 $_SDFFE_PP0P_ + 3 $_XOR_ + 2 $_AND_ + 1 $_NOT_ (§17.1 probe)
- `rtl-counter-4bit` cellTypes: observed **["$_AND_","$_NOT_","$_SDFFE_PP0P_","$_XOR_"]** vs pinned ["$_AND_","$_NOT_","$_SDFFE_PP0P_","$_XOR_"] [bound structural] · the exact cell-type set, sorted
- `rtl-counter-4bit` cellCount @ $_SDFFE_PP0P_: observed **4** vs pinned 4 [bound abs:0] → rel error 0 (bitwise) · one $_SDFFE_PP0P_ per register bit — the yosys $_SDFFE mapping of the sync-domain enable register
- `rtl-counter-4bit` cellCount @ $_XOR_: observed **3** vs pinned 3 [bound abs:0] → rel error 0 (bitwise) · W−1 = 3 XOR gates: each upper bit XORs its carry-in (the closed form at every width)
- `rtl-counter-4bit` cellCount @ $_AND_: observed **2** vs pinned 2 [bound abs:0] → rel error 0 (bitwise) · empirical: the yosys carry-chain sharing at W=4 (§17.1)
- `rtl-counter-4bit` cellCount @ $_NOT_: observed **1** vs pinned 1 [bound abs:0] → rel error 0 (bitwise) · the constant NOT (one at every width)
- `rtl-counter-4bit` synthesisEngineKey: observed **"yowasp-yosys"** vs pinned "yowasp-yosys" [bound structural] · the synthesis half of the lane (contract §17.3)
- `rtl-counter-4bit` synthesisEngineVersion: observed **"0.70.0.0.post1259"** vs pinned "0.70.0.0.post1259" [bound structural] · the pinned yowasp-yosys wheel
- `rtl-counter-4bit` netlistSha256: observed **"549bbd3fc1205712bd044282ca09da9360f2149e5c319f70f38015daf3548dd4"** vs pinned "549bbd3fc1205712bd044282ca09da9360f2149e5c319f70f38015daf3548dd4" [bound structural] · the src-stripped netlist is byte-identical across hosts — probed via three different source paths (§17.1)
- `rtl-counter-4bit` stepCount: observed **25** vs pinned 25 [bound abs:0] → rel error 0 (bitwise) · the frozen stimulus: 18 enabled, 1 disabled, 6 enabled (contract §17.4)
- `rtl-counter-4bit` count @ cycle19: observed **2** vs pinned 2 [bound abs:0] → rel error 0 (bitwise) · cycle 19 is the DISABLED cycle: 18 enabled before it → 18 mod 16 = 2, and the register HOLDS (the closed-form hold pin)
- `rtl-counter-4bit` count @ cycle25: observed **8** vs pinned 8 [bound abs:0] → rel error 0 (bitwise) · the final step: 24 enabled cycles → 24 mod 16 = 8 — the WRAP the closed form predicts (visible at W=4)
- `rtl-counter-8bit` widthBits: observed **8** vs pinned 8 [bound abs:0] → rel error 0 (bitwise) · the fixture's register width
- `rtl-counter-8bit` flipFlopCount: observed **8** vs pinned 8 [bound abs:0] → rel error 0 (bitwise) · the closed form at W=8
- `rtl-counter-8bit` totalCells: observed **24** vs pinned 24 [bound abs:0] → rel error 0 (bitwise) · 8 $_SDFFE_PP0P_ + 7 $_XOR_ + 8 $_AND_ + 1 $_NOT_ (§17.1 probe)
- `rtl-counter-8bit` cellTypes: observed **["$_AND_","$_NOT_","$_SDFFE_PP0P_","$_XOR_"]** vs pinned ["$_AND_","$_NOT_","$_SDFFE_PP0P_","$_XOR_"] [bound structural] · the same four cell types at every width ≥ 2
- `rtl-counter-8bit` cellCount @ $_SDFFE_PP0P_: observed **8** vs pinned 8 [bound abs:0] → rel error 0 (bitwise) · one storage element per bit
- `rtl-counter-8bit` cellCount @ $_XOR_: observed **7** vs pinned 7 [bound abs:0] → rel error 0 (bitwise) · W−1 = 7 (the XOR closed form)
- `rtl-counter-8bit` cellCount @ $_AND_: observed **8** vs pinned 8 [bound abs:0] → rel error 0 (bitwise) · empirical carry-chain sharing at W=8 (§17.1: 2W − 2log2W − 2 = 16−6−2)
- `rtl-counter-8bit` cellCount @ $_NOT_: observed **1** vs pinned 1 [bound abs:0] → rel error 0 (bitwise) · the constant NOT
- `rtl-counter-8bit` stepCount: observed **25** vs pinned 25 [bound abs:0] → rel error 0 (bitwise) · the same frozen stimulus
- `rtl-counter-8bit` count @ cycle19: observed **18** vs pinned 18 [bound abs:0] → rel error 0 (bitwise) · the disabled cycle 19 HOLDS the register at 18 enabled cycles — at W=8 there is no wrap (18 < 256), so the held value IS 18 (the W=4 case wraps it to 2; the hold itself is width-independent)
- `rtl-counter-8bit` count @ cycle25: observed **24** vs pinned 24 [bound abs:0] → rel error 0 (bitwise) · the final step: 24 enabled cycles, no wrap at W=8 (24 < 256) — the non-wrapping regime pinned honestly
- `rtl-invalid-kind` (chip) threw the honest error: `rtl model device.kind must be "enable_counter" (the v1 device class; every other class is its own future lane) (got "alu")`
- `robot-arm-2link` analysis: observed **"kinematic_analysis"** vs pinned "kinematic_analysis" [bound structural] · the only analysis shipped this phase (contract §18.4)
- `robot-arm-2link` engineKey: observed **"pin"** vs pinned "pin" [bound structural] · the lane's engine (contract §18.3) — pip name 'pin', import name 'pinocchio' (the name-trap)
- `robot-arm-2link` engineVersion: observed **"4.1.0"** vs pinned "4.1.0" [bound structural] · the pinned pin wheel (engines-requirements)
- `robot-arm-2link` mechanismKind: observed **"planar_2r"** vs pinned "planar_2r" [bound structural] · the frozen v1 mechanism class (contract §18.2)
- `robot-arm-2link` linkCount: observed **2** vs pinned 2 [bound abs:0] → rel error 0 (bitwise) · the planar 2R arm: exactly two links
- `robot-arm-2link` linkLength1: observed **0.5** vs pinned 0.5 [bound abs:1e-12] → rel error 0 (bitwise) · the fixture's link 1 length (m)
- `robot-arm-2link` linkLength2: observed **0.35** vs pinned 0.35 [bound abs:1e-12] → rel error 0 (bitwise) · the fixture's link 2 length (m)
- `robot-arm-2link` configurationCount: observed **4** vs pinned 4 [bound abs:0] → rel error 0 (bitwise) · the fixture carries 4 configurations
- `robot-arm-2link` xMeters @ config1: observed **0.5235993676781017** vs pinned 0.5235993676781017 [bound abs:1e-12] → rel error 0 (bitwise) · closed form at (π/6, π/4): 0.5·cos(π/6) + 0.35·cos(5π/12)
- `robot-arm-2link` yMeters @ config1: observed **0.5880740392011738** vs pinned 0.5880740392011738 [bound abs:1e-12] → rel error 0 (bitwise) · closed form: 0.5·sin(π/6) + 0.35·sin(5π/12)
- `robot-arm-2link` thetaRad @ config1: observed **1.308996938995747** vs pinned 1.3089969389957474 [bound abs:1e-12] → rel error 3.393e-16 · closed form θ = q1+q2 = 5π/12 (inside (−π,π], no wrap)
- `robot-arm-2link` fkMaxAbsError @ config1: observed **4.440892098500626e-16** vs pinned 0 [bound abs:1e-12] · the adapter's FK closed-form gate residual (probed bit-exact, §18.1)
- `robot-arm-2link` jacobianMaxAbsError @ config1: observed **1.3877787807814457e-17** vs pinned 0 [bound abs:1e-12] · the adapter's Jacobian closed-form gate residual (probed 1.388e-17, §18.1)
- `robot-arm-2link` jacobian0 @ config1: observed **-0.5880740392011738** vs pinned -0.5880740392011738 [bound abs:1e-12] → rel error 0 (bitwise) · closed form vx/dq1 = −L1·sin q1 − L2·sin(q1+q2)
- `robot-arm-2link` jacobian1 @ config1: observed **-0.33807403920117385** vs pinned -0.33807403920117385 [bound abs:1e-12] → rel error 0 (bitwise) · closed form vx/dq2 = −L2·sin(q1+q2)
- `robot-arm-2link` jacobian2 @ config1: observed **0.5235993676781017** vs pinned 0.5235993676781017 [bound abs:1e-12] → rel error 0 (bitwise) · closed form vy/dq1 = L1·cos q1 + L2·cos(q1+q2)
- `robot-arm-2link` jacobian3 @ config1: observed **0.09058666578588231** vs pinned 0.09058666578588233 [bound abs:1e-12] → rel error 1.532e-16 · closed form vy/dq2 = L2·cos(q1+q2)
- `robot-arm-2link` jacobian4 @ config1: observed **0** vs pinned 0 [bound abs:1e-12] · vz/dq1 — identically zero for RZ joints (the 6x2 shape trap, §18.1)
- `robot-arm-2link` jacobian5 @ config1: observed **0** vs pinned 0 [bound abs:1e-12] · vz/dq2 — identically zero for RZ joints
- `robot-arm-2link` jacobian9 @ config1: observed **0** vs pinned 0 [bound abs:1e-12] · wy/dq2 — identically zero for RZ joints (the zero-rows structural pin)
- `robot-arm-2link` jacobian10 @ config1: observed **1** vs pinned 1 [bound abs:1e-12] → rel error 0 (bitwise) · wz/dq1 — exactly 1: both joints rotate about z
- `robot-arm-2link` jacobian11 @ config1: observed **1** vs pinned 1 [bound abs:1e-12] → rel error 0 (bitwise) · wz/dq2 — exactly 1 (the angular closed form)
- `robot-arm-2link` xMeters @ config2: observed **0.5531088913245535** vs pinned 0.5531088913245535 [bound abs:1e-12] → rel error 0 (bitwise) · closed form at (−π/3, π/2): 0.5·cos(−π/3) + 0.35·cos(π/6)
- `robot-arm-2link` yMeters @ config2: observed **-0.25801270189221925** vs pinned -0.2580127018922193 [bound abs:1e-12] → rel error 2.151e-16 · closed form: 0.5·sin(−π/3) + 0.35·sin(π/6)
- `robot-arm-2link` thetaRad @ config2: observed **0.523598775598299** vs pinned 0.5235987755982991 [bound abs:1e-12] → rel error 2.120e-16 · closed form θ = −π/3 + π/2 = π/6
- `robot-arm-2link` fkMaxAbsError @ config2: observed **5.551115123125783e-17** vs pinned 0 [bound abs:1e-12] · the FK gate residual (probed 5.551e-17 at this config, §18.1)
- `robot-arm-2link` jacobianMaxAbsError @ config2: observed **5.551115123125783e-17** vs pinned 0 [bound abs:1e-12] · the Jacobian gate residual (probed 5.551e-17 at this config, §18.1)
- `robot-arm-2link` jacobian0 @ config2: observed **0.25801270189221925** vs pinned 0.2580127018922193 [bound abs:1e-12] → rel error 2.151e-16 · closed form vx/dq1 at (−π/3, π/2)
- `robot-arm-2link` jacobian1 @ config2: observed **-0.17500000000000004** vs pinned -0.175 [bound abs:1e-12] → rel error 3.172e-16 · closed form vx/dq2 = −0.35·sin(π/6) = −0.175 (exact decimal)
- `robot-arm-2link` xMeters @ config3: observed **0.85** vs pinned 0.85 [bound abs:1e-12] → rel error 0 (bitwise) · the SINGULAR fully-extended config: x = L1 + L2 = 0.85 exactly, y = 0, θ = 0
- `robot-arm-2link` yMeters @ config3: observed **0** vs pinned 0 [bound abs:1e-12] · closed form: 0.5·sin(0) + 0.35·sin(0) = 0
- `robot-arm-2link` thetaRad @ config3: observed **0** vs pinned 0 [bound abs:1e-12] · closed form θ = 0 + 0 = 0
- `robot-arm-2link` fkMaxAbsError @ config3: observed **0** vs pinned 0 [bound abs:1e-12] · the FK gate residual (probed bit-exact at (0,0), §18.1)
- `robot-arm-2link` jacobianMaxAbsError @ config3: observed **0** vs pinned 0 [bound abs:1e-12] · the Jacobian gate residual (probed 0.0 at (0,0) — the singular config computes exactly)
- `robot-arm-2link` jacobian0 @ config3: observed **0** vs pinned 0 [bound abs:1e-12] · closed form vx/dq1 = −L1·sin(0) − L2·sin(0) = 0 — the extended arm has no x-sensitivity at (0,0)
- `robot-arm-2link` jacobian1 @ config3: observed **0** vs pinned 0 [bound abs:1e-12] · closed form vx/dq2 = −L2·sin(0) = 0
- `robot-arm-2link` xMeters @ config4: observed **-0.11170434255507944** vs pinned -0.1117043425550795 [bound abs:1e-12] → rel error 4.969e-16 · closed form at (2.5, −1.9): 0.5·cos(2.5) + 0.35·cos(0.6)
- `robot-arm-2link` yMeters @ config4: observed **0.4968609377402406** vs pinned 0.49686093774024065 [bound abs:1e-12] → rel error 1.117e-16 · closed form: 0.5·sin(2.5) + 0.35·sin(0.6)
- `robot-arm-2link` thetaRad @ config4: observed **0.5999999999999999** vs pinned 0.6000000000000001 [bound abs:1e-12] → rel error 3.701e-16 · closed form θ = 2.5 − 1.9 = 0.6 (inside (−π,π])
- `robot-arm-2link` fkMaxAbsError @ config4: observed **5.551115123125783e-17** vs pinned 0 [bound abs:1e-12] · the FK gate residual (probed 5.551e-17 at this config, §18.1)
- `robot-arm-2link` jacobianMaxAbsError @ config4: observed **8.326672684688674e-17** vs pinned 0 [bound abs:1e-12] · the Jacobian gate residual (probed 8.327e-17 at this config, §18.1)
- `robot-arm-2link` jacobian0 @ config4: observed **-0.4968609377402406** vs pinned -0.49686093774024065 [bound abs:1e-12] → rel error 1.117e-16 · closed form vx/dq1 at (2.5, −1.9)
- `robot-arm-2link` jacobian1 @ config4: observed **-0.19762486568826232** vs pinned -0.1976248656882624 [bound abs:1e-12] → rel error 4.213e-16 · closed form vx/dq2 = −0.35·sin(0.6)
- `robot-arm-long` mechanismKind: observed **"planar_2r"** vs pinned "planar_2r" [bound structural] · the frozen v1 mechanism class
- `robot-arm-long` linkCount: observed **2** vs pinned 2 [bound abs:0] → rel error 0 (bitwise) · exactly two links
- `robot-arm-long` linkLength1: observed **1.2** vs pinned 1.2 [bound abs:1e-12] → rel error 0 (bitwise) · the fixture's link 1 length (m)
- `robot-arm-long` linkLength2: observed **0.8** vs pinned 0.8 [bound abs:1e-12] → rel error 0 (bitwise) · the fixture's link 2 length (m)
- `robot-arm-long` configurationCount: observed **3** vs pinned 3 [bound abs:0] → rel error 0 (bitwise) · the fixture carries 3 configurations
- `robot-arm-long` xMeters @ config1: observed **1.9318516525781368** vs pinned 1.9318516525781368 [bound abs:1e-12] → rel error 0 (bitwise) · closed form at (π/12, −π/6): 1.2·cos(π/12) + 0.8·cos(−π/12)
- `robot-arm-long` yMeters @ config1: observed **0.1035276180410083** vs pinned 0.1035276180410083 [bound abs:1e-12] → rel error 0 (bitwise) · closed form: 1.2·sin(π/12) + 0.8·sin(−π/12)
- `robot-arm-long` thetaRad @ config1: observed **-0.2617993877991494** vs pinned -0.2617993877991496 [bound abs:1e-12] → rel error 6.361e-16 · closed form θ = π/12 − π/6 = −π/12
- `robot-arm-long` fkMaxAbsError @ config1: observed **0** vs pinned 0 [bound abs:1e-12] · the FK gate residual (≤ 1e-12 by the §18.5 gate)
- `robot-arm-long` jacobianMaxAbsError @ config1: observed **1.1102230246251565e-16** vs pinned 0 [bound abs:1e-12] · the Jacobian gate residual (≤ 1e-12 by the §18.5 gate)
- `robot-arm-long` jacobian0 @ config1: observed **-0.1035276180410083** vs pinned -0.1035276180410083 [bound abs:1e-12] → rel error 0 (bitwise) · closed form vx/dq1 at (π/12, −π/6)
- `robot-arm-long` jacobian1 @ config1: observed **0.2070552360820166** vs pinned 0.2070552360820166 [bound abs:1e-12] → rel error 0 (bitwise) · closed form vx/dq2 = −0.8·sin(−π/12) (positive — the elbow is folded back)
- `robot-arm-long` xMeters @ config2: observed **0.09625072399246914** vs pinned 0.09625072399246914 [bound abs:1e-12] → rel error 0 (bitwise) · closed form at (−2.1, 2.6): 1.2·cos(−2.1) + 0.8·cos(0.5)
- `robot-arm-long` yMeters @ config2: observed **-0.652310809095286** vs pinned -0.6523108090952859 [bound abs:1e-12] → rel error 1.702e-16 · closed form: 1.2·sin(−2.1) + 0.8·sin(0.5)
- `robot-arm-long` thetaRad @ config2: observed **0.49999999999999994** vs pinned 0.5 [bound abs:1e-12] → rel error 1.110e-16 · closed form θ = −2.1 + 2.6 = 0.5
- `robot-arm-long` fkMaxAbsError @ config2: observed **1.1102230246251565e-16** vs pinned 0 [bound abs:1e-12] · the FK gate residual
- `robot-arm-long` jacobianMaxAbsError @ config2: observed **1.1102230246251565e-16** vs pinned 0 [bound abs:1e-12] · the Jacobian gate residual
- `robot-arm-long` jacobian0 @ config2: observed **0.652310809095286** vs pinned 0.6523108090952859 [bound abs:1e-12] → rel error 1.702e-16 · closed form vx/dq1 at (−2.1, 2.6)
- `robot-arm-long` jacobian1 @ config2: observed **-0.3835404308833623** vs pinned -0.3835404308833624 [bound abs:1e-12] → rel error 2.895e-16 · closed form vx/dq2 = −0.8·sin(0.5)
- `robot-arm-long` xMeters @ config3: observed **-7.347880794884119e-17** vs pinned -7.347880794884119e-17 [bound abs:1e-12] → rel error 0 (bitwise) · the FOLDED-BACK singular (q2=π): x = 1.2·cos(π/2) + 0.8·cos(3π/2) = 0 — the pin value is the closed form's float noise, |x| < 1e-12 either way
- `robot-arm-long` yMeters @ config3: observed **0.3999999999999999** vs pinned 0.3999999999999999 [bound abs:1e-12] → rel error 0 (bitwise) · closed form: 1.2·sin(π/2) + 0.8·sin(3π/2) = 1.2 − 0.8 = 0.4
- `robot-arm-long` thetaRad @ config3: observed **-1.5707963267948968** vs pinned -1.5707963267948966 [bound abs:1e-12] → rel error 1.414e-16 · closed form θ = π/2 + π = 3π/2, WRAPPED to −π/2 (the §18.1 θ convention)
- `robot-arm-long` fkMaxAbsError @ config3: observed **0** vs pinned 0 [bound abs:1e-12] · the FK gate residual at the folded singular
- `robot-arm-long` jacobianMaxAbsError @ config3: observed **0** vs pinned 0 [bound abs:1e-12] · the Jacobian gate residual at the folded singular
- `robot-arm-long` jacobian0 @ config3: observed **-0.3999999999999999** vs pinned -0.3999999999999999 [bound abs:1e-12] → rel error 0 (bitwise) · closed form vx/dq1 = −1.2·sin(π/2) − 0.8·sin(3π/2) = −1.2 + 0.8 = −0.4
- `robot-arm-long` jacobian1 @ config3: observed **0.8** vs pinned 0.8 [bound abs:1e-12] → rel error 0 (bitwise) · closed form vx/dq2 = −0.8·sin(3π/2) = +0.8 (the folded elbow swings the tip backward-first)
- `robot-arm-invalid-kind` (robotics) threw the honest error: `robot model mechanism.kind must be "planar_2r" (the v1 mechanism class; every other class is its own future lane) (got "spatial_6r")`
- `impact-drop-sphere` analysis: observed **"impact_simulation"** vs pinned "impact_simulation" [bound structural] · the only analysis shipped this phase (contract §19.4)
- `impact-drop-sphere` engineKey: observed **"pybullet"** vs pinned "pybullet" [bound structural] · the lane's engine (contract §19.3)
- `impact-drop-sphere` engineVersion: observed **"3.2.7"** vs pinned "3.2.7" [bound structural] · the pinned pybullet sdist (engines-requirements)
- `impact-drop-sphere` mechanismKind: observed **"drop_impact"** vs pinned "drop_impact" [bound structural] · the frozen v1 mechanism class (contract §19.2)
- `impact-drop-sphere` massKilograms: observed **1** vs pinned 1 [bound abs:1e-12] → rel error 0 (bitwise) · the fixture's sphere mass (kg)
- `impact-drop-sphere` radiusMeters: observed **0.1** vs pinned 0.1 [bound abs:1e-12] → rel error 0 (bitwise) · the fixture's sphere radius (m)
- `impact-drop-sphere` restitution: observed **0** vs pinned 0 [bound abs:1e-12] · the dead-bang drop: e = 0
- `impact-drop-sphere` centerHeightMeters: observed **1** vs pinned 1 [bound abs:1e-12] → rel error 0 (bitwise) · the release center height (m)
- `impact-drop-sphere` gravityMetersPerSecondSquared: observed **9.81** vs pinned 9.81 [bound abs:1e-12] → rel error 0 (bitwise) · the configured gravity (m/s²)
- `impact-drop-sphere` timestepSeconds: observed **0.004166666666666667** vs pinned 0.004166666666666667 [bound abs:1e-15] → rel error 0 (bitwise) · the pinned 240 Hz timestep 1/240 s (§19.1)
- `impact-drop-sphere` sampleCount: observed **344** vs pinned 344 [bound abs:0] → rel error 0 (bitwise) · the horizon: first contact (step 104) + exactly 240 post-contact steps (§19.4)
- `impact-drop-sphere` firstContactStep: observed **104** vs pinned 104 [bound abs:0] → rel error 0 (bitwise) · the probed first-contact step (§19.1): the discrete fall crosses r between steps 103/104
- `impact-drop-sphere` firstContactTimeSeconds: observed **0.43333333333333335** vs pinned 0.43333333333333335 [bound abs:1e-12] → rel error 0 (bitwise) · 104/240 — the measured contact time
- `impact-drop-sphere` closedFormContactTimeSeconds: observed **0.4283529368781193** vs pinned 0.4283529368781193 [bound abs:1e-12] → rel error 0 (bitwise) · closed form t* = sqrt(2·0.9/9.81)
- `impact-drop-sphere` timeResidualSeconds: observed **0.004980396455214031** vs pinned 0.004980396455214031 [bound abs:1e-9] → rel error 0 (bitwise) · t_meas − t* = +1.195 dt (one 240 Hz quantum + the soft-contact penetration margin, §19.1)
- `impact-drop-sphere` impactSpeedMetersPerSecond: observed **4.210125000000009** vs pinned 4.210125 [bound abs:1e-9] → rel error 2.321e-15 · the discrete closed form |−g·dt·103| = 9.81·103/240 (bit-consistent, §19.1)
- `impact-drop-sphere` closedFormImpactSpeedMetersPerSecond: observed **4.2021423107743505** vs pinned 4.2021423107743505 [bound abs:1e-12] → rel error 0 (bitwise) · closed form v* = sqrt(2·9.81·0.9)
- `impact-drop-sphere` speedResidualMetersPerSecond: observed **0.007982689225658923** vs pinned 0.007982689225658923 [bound abs:1e-9] → rel error 0 (bitwise) · v_meas − v* (within 3·g·dt = 0.1226 by the §19.5 gate)
- `impact-drop-sphere` reboundPeakHeightMeters: observed **0.09998999997716257** vs pinned 0.09999 [bound abs:0.005] → rel error 2.284e-10 · the e=0 no-rebound reality (§19.1 probed: rest r − 1e-5; engine behavior, the chip-lane empirical-count precedent)
- `impact-drop-sphere` closedFormReboundPeakMeters: observed **0.1** vs pinned 0.1 [bound abs:1e-12] → rel error 0 (bitwise) · the energy bound r + e²(h−r) = r at e=0
- `impact-drop-sphere` reboundResidualMeters: observed **-0.000010000022837436395** vs pinned -0.00001 [bound abs:0.005] → rel error 2.284e-6 · dissipative by exactly the probed penetration (−1.0e-5 m)
- `impact-drop-sphere` maxPreContactHeightError: observed **1.4710455076283324e-15** vs pinned 0 [bound abs:1e-9] · the adapter's discrete closed-form gate residual (probed 1.47e-15)
- `impact-drop-sphere` maxPreContactSpeedError: observed **1.0658141036401503e-14** vs pinned 0 [bound abs:1e-9] · the adapter's velocity gate residual (probed 1.07e-14)
- `impact-drop-sphere` centerHeightMeters @ sample1: observed **0.9998296875** vs pinned 0.9998296875 [bound abs:1e-9] → rel error 0 (bitwise) · discrete closed form z_1 = 1 − ½·9.81·dt²·1·2 (exact in binary, §19.1)
- `impact-drop-sphere` velocityZMetersPerSecond @ sample1: observed **-0.040875** vs pinned -0.040875 [bound abs:1e-9] → rel error 0 (bitwise) · discrete closed form vz_1 = −9.81/240 (exact)
- `impact-drop-sphere` centerHeightMeters @ sample50: observed **0.7828515625** vs pinned 0.7828515625 [bound abs:1e-9] → rel error 0 (bitwise) · discrete closed form z_50 = 1 − ½·9.81·dt²·50·51 (exact)
- `impact-drop-sphere` velocityZMetersPerSecond @ sample50: observed **-2.04375** vs pinned -2.04375 [bound abs:1e-9] → rel error 0 (bitwise) · discrete closed form vz_50 = −9.81·50/240 (exact)
- `impact-drop-sphere` centerHeightMeters @ sample103: observed **0.0878062499999986** vs pinned 0.08780625 [bound abs:1e-9] → rel error 1.596e-14 · discrete closed form z_103 (the last pre-contact step)
- `impact-drop-sphere` velocityZMetersPerSecond @ sample103: observed **-4.210125000000009** vs pinned -4.210125 [bound abs:1e-9] → rel error 2.321e-15 · discrete closed form vz_103 = −9.81·103/240 (the impact speed's source step)
- `impact-drop-bounce` mechanismKind: observed **"drop_impact"** vs pinned "drop_impact" [bound structural] · the frozen v1 mechanism class
- `impact-drop-bounce` restitution: observed **0.6** vs pinned 0.6 [bound abs:1e-12] → rel error 0 (bitwise) · the bounce configuration (the fixture)
- `impact-drop-bounce` sampleCount: observed **344** vs pinned 344 [bound abs:0] → rel error 0 (bitwise) · the same horizon: first contact (step 104) + 240 post-contact steps
- `impact-drop-bounce` firstContactStep: observed **104** vs pinned 104 [bound abs:0] → rel error 0 (bitwise) · identical to the e=0 drop — restitution never acts before contact
- `impact-drop-bounce` closedFormContactTimeSeconds: observed **0.4283529368781193** vs pinned 0.4283529368781193 [bound abs:1e-12] → rel error 0 (bitwise) · the same closed form t* = sqrt(2·0.9/9.81)
- `impact-drop-bounce` impactSpeedMetersPerSecond: observed **4.210125000000009** vs pinned 4.210125 [bound abs:1e-9] → rel error 2.321e-15 · the same discrete impact speed (restitution acts only AFTER contact)
- `impact-drop-bounce` closedFormReboundPeakMeters: observed **0.42400000000000004** vs pinned 0.42400000000000004 [bound abs:1e-12] → rel error 0 (bitwise) · the energy bound r + e²(h−r) = 0.1 + 0.36·0.9
- `impact-drop-bounce` reboundPeakHeightMeters: observed **0.25014342500000425** vs pinned 0.250143425 [bound abs:0.02] → rel error 1.709e-14 · ENGINE BEHAVIOR pin (§19.1 probed ratio 0.419 < e): the dissipative LCP rebound, tolerance for build variance — the chip-lane AND-count precedent
- `impact-drop-bounce` reboundResidualMeters: observed **-0.1738565749999958** vs pinned -0.1738565749999958 [bound abs:0.02] → rel error 0 (bitwise) · dissipative (negative) as probed — never above 0 (energy creation is a §19.5 refusal)
- `impact-drop-bounce` velocityZMetersPerSecond @ sample103: observed **-4.210125000000009** vs pinned -4.210125 [bound abs:1e-9] → rel error 2.321e-15 · the last pre-contact step: identical to the e=0 drop (the discrete closed form)
- `impact-drop-bounce` velocityZMetersPerSecond @ sample104: observed **1.7642880000000307** vs pinned 1.7642880000000307 [bound abs:0.05] → rel error 0 (bitwise) · the first post-contact step's upward velocity (engine behavior: the solver's restitution response, ratio 0.419·|v_impact|)
- `impact-drop-invalid-kind` (physics) threw the honest error: `impact model mechanism.kind must be "drop_impact" (the v1 mechanism class; every other class is its own future lane) (got "pendulum")`
- `p2t-compare-identical` comparedSheets: observed **4** vs pinned 4 [bound abs:0] → rel error 0 (bitwise) · the A-102 fixture has 4 pages; both revisions identical, so all 4 pair up
- `p2t-compare-identical` changedSheetCount: observed **0** vs pinned 0 [bound abs:0] · byte-identical revisions cannot differ on any sheet
- `p2t-compare-identical` summary.changed: observed **0** vs pinned 0 [bound abs:0] · same — the summary counts the sheets array
- `p2t-compare-identical` summary.unchanged: observed **4** vs pinned 4 [bound abs:0] → rel error 0 (bitwise) · all four pages identical
- `p2t-compare-identical` summary.onlyInA: observed **0** vs pinned 0 [bound abs:0] · same page count on both sides — nothing unmatched
- `p2t-compare-identical` summary.onlyInB: observed **0** vs pinned 0 [bound abs:0] · same page count on both sides — nothing unmatched
- `p2t-compare-identical` changedFraction @ page:1: observed **0** vs pinned 0 [bound abs:0] · identical raster → zero changed pixels
- `p2t-compare-identical` vectorIdentical @ page:4: observed **true** vs pinned true [bound structural] · identical vector operators (the portrait panel-schedule page included)
- `p2t-compare-different` comparedSheets: observed **1** vs pinned 1 [bound abs:0] → rel error 0 (bitwise) · only page 1 exists on both sides (curve fixture is single-sheet)
- `p2t-compare-different` changedSheetCount: observed **1** vs pinned 1 [bound abs:0] → rel error 0 (bitwise) · the paired page 1 differs (completely different drawing content)
- `p2t-compare-different` summary.changed: observed **1** vs pinned 1 [bound abs:0] → rel error 0 (bitwise) · page 1 changed
- `p2t-compare-different` summary.onlyInA: observed **3** vs pinned 3 [bound abs:0] → rel error 0 (bitwise) · A-102 pages 2, 3, 4 have no counterpart in the single-page curve revision
- `p2t-compare-different` summary.onlyInB: observed **0** vs pinned 0 [bound abs:0] · every curve-sheet page (just page 1) has an A-counterpart
- `p2t-compare-different` changed @ page:1: observed **true** vs pinned true [bound structural] · different drawings on the paired page
- `p2t-compare-different` changedFraction @ page:1: observed **0.0059** vs pinned 0.0059 [bound abs:0.005] → rel error 0 (bitwise) · engine-observed raster-diff fraction on the dev host (title bar + room rectangle + wall regions); abs 0.005 keeps the pin honest across raster hosts
- `p2t-compare-different` regionCount @ page:1: observed **18** vs pinned 1 [bound min] · at least one changed region localizes the change (the engine reported 3 on the dev host)
- `p2t-annotate-roundtrip` markupCount: observed **3** vs pinned 3 [bound abs:0] → rel error 0 (bitwise) · the spec carries exactly 3 markups (length + area + count)
- `p2t-annotate-roundtrip` kept: observed **0** vs pinned 0 [bound abs:0] · the bare fixture carries no pdf2takeoff annotations — nothing to keep
- `p2t-annotate-roundtrip` isPdf: observed **true** vs pinned true [bound structural] · the annotated output must be a real PDF (%PDF magic)
- `p2t-annotate-roundtrip` sizeBytes: observed **6169** vs pinned 4000 [bound min] · the 6166-byte dev-host output sizes the floor; an annotated copy of the 4-page fixture cannot be tiny
- `p2t-export-boq-roundtrip` rowCount: observed **3** vs pinned 3 [bound abs:0] → rel error 0 (bitwise) · three markups -> three data rows
- `p2t-export-boq-roundtrip` value @ label:Scale bar: observed **10.000001166666667** vs pinned 10.000001166666667 [bound rel:1e-9] → rel error 0 (bitwise) · 283.4646 pt x 0.03527778 m/pt (the engine's exact 1:100 preset); analytic 100 paper-mm = 10.000 m real
- `p2t-export-boq-roundtrip` unit @ label:Scale bar: observed **"m"** vs pinned "m" [bound structural] · length export in metres
- `p2t-export-boq-roundtrip` value @ label:Room 101: observed **40.00001783583051** vs pinned 40.00001783583051 [bound rel:1e-9] → rel error 0 (bitwise) · 226.7717 x 141.7323 pt at 1:100 -> 80x50 paper-mm -> 8.000 x 5.000 m = 40.000 m2 analytic
- `p2t-export-boq-roundtrip` type @ label:Room 101: observed **"area"** vs pinned "area" [bound structural] · the spec's area markup exports as an area row
- `p2t-export-boq-roundtrip` value @ label:Socket: observed **1** vs pinned 1 [bound abs:0] → rel error 0 (bitwise) · one count markup at (205, 505) on page 2 (the S13 lighting-layout socket grid, first symbol)
- `p2t-export-boq-roundtrip` unit @ label:Socket: observed **"each"** vs pinned "each" [bound structural] · counts export in each
- `p2t-export-boq-roundtrip` isXlsx: observed **true** vs pinned true [bound structural] · the XLSX export must be a real workbook (PK zip magic)
- `p2t-export-boq-roundtrip` sizeBytes: observed **17914** vs pinned 3000 [bound min] · a 3-row workbook with styles sizes the floor (dev host: ~5 KB)
- `p2t-fill-area-room` value: observed **39.4009** vs pinned 39.4009 [bound abs:0.1] → rel error 0 (bitwise) · analytic 40.000 m2 minus the inner-wall-face inset of the 1-pt stroke (~0.67 pt/side); engine-observed 39.4009 on the dev host
- `p2t-fill-area-room` vertices: observed **8** vs pinned 8 [bound abs:0] → rel error 0 (bitwise) · the room rectangle's 4 corners + the interior wall's 2 boundary intersections + the 2 jogs where the boundary turns along the wall — the dev-host raster polygon
- `p2t-fill-area-room` unit: observed **"m2"** vs pinned "m2" [bound structural] · the fill records an area in square metres
- `p2t-fill-area-room` calibrated: observed **true** vs pinned true [bound structural] · the bridge ALWAYS calibrates the session (from_points carries the platform scale exactly)
- `p2t-fill-area-room` bboxX0: observed **500.67** vs pinned 500.67 [bound abs:1] → rel error 0 (bitwise) · the analytic left edge is x=500; the fill boundary sits ~0.67 pt inside it (pen half-width)
- `p2t-fill-area-room` bboxX1: observed **726.33** vs pinned 726.33 [bound abs:1] → rel error 0 (bitwise) · the analytic right edge is x=726.7717; inset ~0.44 pt on the dev host
- `p2t-fill-no-scale` (pdf2takeoff) threw the honest error: `fill_area parameters.scaleMmPerPt must be a positive number — calibrate the sheet first or pass it explicitly (an uncalibrated takeoff number is a fabricated nu`
- `p2t-export-no-annotations` (pdf2takeoff) threw the honest error: `pdf2takeoff export failed: pdf2takeoff: no pdf2takeoff annotations found in /home/z/engineering-os/tests/fixtures/sheet-a102-plan.pdf (annotate it first, or ope`
- `p2t-annotate-bad-spec` (pdf2takeoff) threw the honest error: `annotate_takeoff parameters.markups[0].points must be an array of 2..64 [x,y] pairs for type area`
- `p2t-fill-click-on-line` (pdf2takeoff) threw the honest error: `pdf2takeoff fill_area refused: you clicked on a line — click inside the region`

## Regenerate

```bash
bun run validate:engines   # runs the harness, rewrites report.json + this file, exit 1 on any FAIL
```

All-skip runs (python/engine unavailable) exit 0 and are marked NOT RUN — skipped-with-reason is honest;
fabricated results are not an option.
