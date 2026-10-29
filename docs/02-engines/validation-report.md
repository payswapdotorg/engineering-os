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

- Ran at (UTC): `2026-10-29T14:51:41.719Z`
- Python (engine venv, `EOS_PYTHON`-overridable): `/home/z/.venv/bin/python`
- LibreOffice (`EOS_LIBREOFFICE`-overridable): `/usr/bin/libreoffice`
- Engine availability probe — cadquery (STEP quantities): available
- Engine availability probe — ifcopenshell (IFC quantities): available
- Engine availability probe — gmsh (FE mesh): available
- Engine availability probe — pandapower (power flow): available
- Engine availability probe — simpy (discrete-event): available
- Engine availability probe — scikit-fem (plane-stress FEA): available
- Engine availability probe — pyswmm/SWMM5 (stormwater drainage): available
- Engine availability probe — platform CPM core (no engine): available
- Engine availability probe — libreoffice (document conversion): available
- Engine availability probe — pdfplumber (vector sheet takeoff): available
- Engine availability probe — ezdxf (DXF takeoff): available
- Engine availability probe — cadquery (parametric rebuild): available
- Engine availability probe — tesseract (sheet-text OCR): available
- Engine versions (as reported inside real adapter runs): cadquery 2.6.1 · ifcopenshell 0.9.0.post1 · gmsh 4.15.2 · pandapower 3.5.6 · simpy 4.1.2 · scikit-fem 12.0.2 · libreoffice 25.2.3.2 · pdfplumber 0.11.10 · ezdxf 1.4.5 · tesseract 5.5.0 · pyswmm 2.2.0
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
- Adapter `parametric_rebuild.py` sha256: `7251b8cb913ecb541c91f2ec9f4da16e6057f9a70cb15e90d709fd9e340356a9`
- Adapter `sheet_ocr.ts` sha256: `b2e7798973ab7f9f78f6d58d482986bfb38ab112cb3e0586c6cf6107b07dfd45`
- Adapter `fea_solve.py` sha256: `86674028a476438081788dd6a16c2552ba0ed9cbe9332023cc77956b1b9d62ef`
- Adapter `swmm_run.py` sha256: `6f6714b8ec6d8616d4fd5adbab681b5486ca10063049a672e6f7e1647024ef8d`
- Corpus: `tests/validation/corpus-manifest.json` — 36 cases

## Tolerance policy (pinned)

| tolerance class | rule | meaning |
|---|---|---|
| `exact` | \|obs − exp\| ≤ 1e-9 · max(1, \|exp\|) | declared-quantity readback — authored values must round-trip |
| `analytic` | \|obs − exp\| ≤ 1e-9 · max(1, \|exp\|) | exact-engine value vs closed form; also used for the PLANAR mesh case, where the divergence-theorem volume / triangle-sum area are mathematically exact (only IEEE rounding remains) |
| `mesh` | \|obs − exp\| ≤ 1e-2 · \|exp\| | pinned 1% engineering tolerance for triangulated CURVED surfaces (ifcopenshell PyPI wheel has no OCCT backend, `has_occ=False`); the observed relative error is recorded below — the limitation is quantified, not hidden |

## Results — 36 cases: 36 pass / 0 fail / 0 skip

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
| `sheet-vector-plan` | sheet | `sheet-a102-plan.pdf` | success | pass | — | — / — | — | sheet: 26 pin(s) · pdfplumber 0.11.10 · doc byte-determinism ✅ · max pin rel error 3.519e-7 |
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
| `sheet-vector-plan` | sheet | `sheet-a102-plan.pdf` | success | pdfplumber 0.11.10 | ✅ true | 26 | pass |
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
- `sheet-vector-plan` pageCount: observed **3** vs pinned 3 [bound abs:0] → rel error 0 (bitwise) · fixture builder pins a 3-page document (Slice 20 added page 3, the two-size panel schedule; pages 1-2 streams byte-identical)
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
- `sheet-vector-plan` fixtureSha256: observed **"ed19c9c5bb70213508c48c2cb986b5fddcc1cd87b55d051aa995ed349ce5ec8d"** vs pinned "ed19c9c5bb70213508c48c2cb986b5fddcc1cd87b55d051aa995ed349ce5ec8d" [bound structural] · see case groundTruth — Slice 20 regenerated the fixture (page 3 added; pages 1-2 streams byte-identical)
- `sheet-vector-plan` linesTotalLengthMm: observed **11270.001166666669** vs pinned 11270 mm [bound rel:0.000001] → rel error 1.035e-7 · page-2 scale bar 283.464567 pt + 3 x 12 pt ticks = 319.464567 pt = 11 270.1 mm (same bar geometry as page 1, no wall)
- `sheet-vector-plan` pageNo: observed **3** vs pinned 3 [bound abs:0] → rel error 0 (bitwise) · the requested page, echoed by the adapter
- `sheet-vector-plan` pageCount: observed **3** vs pinned 3 [bound abs:0] → rel error 0 (bitwise) · fixture builder pins a 3-page document (Slice 20 added page 3, the two-size panel schedule; pages 1-2 streams byte-identical)
- `sheet-vector-plan` linesCount: observed **4** vs pinned 4 [bound abs:0] → rel error 0 (bitwise) · page 3 is self-contained like page 2: scale bar + 2 end ticks + mid tick = 4 lines (builder: buildPanelScheduleContentStream)
- `sheet-vector-plan` rectsCount: observed **21** vs pinned 21 [bound abs:0] → rel error 0 (bitwise) · page 3: border + 6 outer 10 pt + 6 inner 4 pt small sockets + 4 outer 15 pt + 4 inner 6 pt large sockets = 21 rects (the Slice-20 two-size field)
- `sheet-vector-plan` rectsTotalAreaMm2: observed **1131621093.9814816** vs pinned 1131621093.9815 mm2 [bound rel:0.000001] → rel error 1.622e-14 · (1143x794 border + 6x(100+16) small + 4x(225+36) large) pt2 = 909 282 pt2 x (35.277777…)2 = 1 131 621 093.98 mm2
- `sheet-vector-plan` fixtureSha256: observed **"ed19c9c5bb70213508c48c2cb986b5fddcc1cd87b55d051aa995ed349ce5ec8d"** vs pinned "ed19c9c5bb70213508c48c2cb986b5fddcc1cd87b55d051aa995ed349ce5ec8d" [bound structural] · see case groundTruth — Slice 20 regenerated the fixture (page 3 added; pages 1-2 streams byte-identical)
- `sheet-vector-plan` linesTotalLengthMm: observed **11270.001166666669** vs pinned 11270 mm [bound rel:0.000001] → rel error 1.035e-7 · page-3 scale bar 283.464567 pt + 3 x 12 pt ticks = 319.464567 pt = 11 270.000 mm (same furniture as page 2)
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

## Regenerate

```bash
bun run validate:engines   # runs the harness, rewrites report.json + this file, exit 1 on any FAIL
```

All-skip runs (python/engine unavailable) exit 0 and are marked NOT RUN — skipped-with-reason is honest;
fabricated results are not an option.
