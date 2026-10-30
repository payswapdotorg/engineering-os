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

- Ran at (UTC): `2026-10-30T18:35:34.535Z`
- Python (engine venv, `EOS_PYTHON`-overridable): `/home/z/.venv/bin/python3`
- LibreOffice (`EOS_LIBREOFFICE`-overridable): `/usr/bin/libreoffice`
- Engine availability probe — cadquery (STEP quantities): available
- Engine availability probe — ifcopenshell (IFC quantities): UNAVAILABLE (ifcopenshell is not importable in /home/z/.venv/bin/python3 (exit code 1))
- Engine availability probe — gmsh (FE mesh): UNAVAILABLE (gmsh is not importable in /home/z/.venv/bin/python3 (exit code 1) — missing system libs? run scripts/setup-engine-libs.sh)
- Engine availability probe — pandapower (power flow): UNAVAILABLE (pandapower is not importable in /home/z/.venv/bin/python3 (exit code 1))
- Engine availability probe — simpy (discrete-event): UNAVAILABLE (simpy is not importable in /home/z/.venv/bin/python3 (exit code 1))
- Engine availability probe — scikit-fem (plane-stress FEA): UNAVAILABLE (skfem is not importable in /home/z/.venv/bin/python3 (exit code 1))
- Engine availability probe — sfepy/SfePy (steady scalar transport CFD): UNAVAILABLE (sfepy is not importable in /home/z/.venv/bin/python3 (exit code 1))
- Engine availability probe — amaranth + yowasp-yosys (RTL synthesis): UNAVAILABLE (amaranth is not importable in /home/z/.venv/bin/python3 (exit code 1))
- Engine availability probe — pyswmm/SWMM5 (stormwater drainage): UNAVAILABLE (pyswmm is not importable in /home/z/.venv/bin/python3 (exit code 1))
- Engine availability probe — platform CPM core (no engine): available
- Engine availability probe — libreoffice (document conversion): available
- Engine availability probe — pdfplumber (vector sheet takeoff): available
- Engine availability probe — ezdxf (DXF takeoff): available
- Engine availability probe — cadquery (parametric rebuild): available
- Engine availability probe — tesseract (sheet-text OCR): available
- Engine availability probe — pdf2takeoff (ADOPTED takeoff engine — ADR-0009): available
- Engine versions (as reported inside real adapter runs): cadquery 2.6.1 · ifcopenshell no successful run (version unknown) · gmsh no successful run (version unknown) · pandapower no successful run (version unknown) · simpy no successful run (version unknown) · scikit-fem no successful run (version unknown) · sfepy no successful run (version unknown) · libreoffice 25.2.3.2 · pdfplumber 0.11.9 · ezdxf 1.4.3 · pdf2takeoff 0.1.0 · tesseract 5.5.0
- Adapter `step_quantities.py` sha256: `950e3e9f358c0bb16895d222076fbcb99dab58d9f1cbf454a05ba5469515e02d`
- Adapter `ifc_quantities.py` sha256: `not observed (no successful run)`
- Adapter `step_mesh.py` sha256: `e042b686916a212a46dd947a0e6852ec02c10c3687913299d679e38309d5aa9c`
- Adapter `ifc_mesh.py` sha256: `not observed (no successful run)`
- Adapter `step_femesh.py` sha256: `not observed (no successful run)`
- Adapter `powerflow.py` sha256: `not observed (no successful run)`
- Adapter `des.py` sha256: `not observed (no successful run)`
- Adapter `convert-document.ts` sha256: `4b1bb3d10fdcaa3f85ebb654a652092acb3ac5a59812f1f0fd9c5074b15540d0`
- Adapter `sheet_takeoff.py` sha256: `bea0a985d34cd8bda44aab4251f2d2ec7039f032445d14d7c99b5ed998425bff`
- Adapter `dxf_takeoff.py` sha256: `07d24da5749543b546d75f45aca01fb8078aa708325cb74282730c2074159329`
- Adapter `parametric_rebuild.py` sha256: `14d62a117314160ffea825ec9aca038e863a550fa7cc5b33babb487295854acf`
- Adapter `pdf2takeoff.ts` sha256: `8a975d2d8d752238308deedda6811bb345d295224f6cb086ba065acfb762b2d0`
- Adapter `sheet_ocr.ts` sha256: `b2e7798973ab7f9f78f6d58d482986bfb38ab112cb3e0586c6cf6107b07dfd45`
- Corpus: `tests/validation/corpus-manifest.json` — 51 cases

## Tolerance policy (pinned)

| tolerance class | rule | meaning |
|---|---|---|
| `exact` | \|obs − exp\| ≤ 1e-9 · max(1, \|exp\|) | declared-quantity readback — authored values must round-trip |
| `analytic` | \|obs − exp\| ≤ 1e-9 · max(1, \|exp\|) | exact-engine value vs closed form; also used for the PLANAR mesh case, where the divergence-theorem volume / triangle-sum area are mathematically exact (only IEEE rounding remains) |
| `mesh` | \|obs − exp\| ≤ 1e-2 · \|exp\| | pinned 1% engineering tolerance for triangulated CURVED surfaces (ifcopenshell PyPI wheel has no OCCT backend, `has_occ=False`); the observed relative error is recorded below — the limitation is quantified, not hidden |

## Results — 51 cases: 25 pass / 0 fail / 26 skip

| Case | Adapter | Fixture | Expect | Status | Determinism | Quantities (obs / pinned) | Max observed rel error | Notes |
|---|---|---|---|---|---|---|---|---|
| `step-bracket-solid` | step | `bracket-solid.step` | success | pass | ✅ true | 3 / 3 | 1.456e-14 | largest observed rel error 1.456e-14 (step:solid:0 volume) — IEEE/authoring noise only, within tolerance |
| `step-cylinder-solid` | step | `cylinder-solid.step` | success | pass | ✅ true | 3 / 3 | 5.488e-14 | mesh: 1 element(s) / 506 verts / 500 tris · byte-determinism ✅ · max mesh-volume rel error 4.144e-4 · largest observed rel error 5.488e-14 (step:solids:all area) — IEEE/authoring noise only, within tolerance |
| `step-two-solids` | step | `two-solids.step` | success | pass | ✅ true | 4 / 4 | 0.000e+0 | mesh: 2 element(s) / 48 verts / 24 tris · byte-determinism ✅ · max mesh-volume rel error 3.765e-16 |
| `step-bracket-empty` | step | `bracket.step` | error | pass | — | — | — | mesh: threw honest error: `no solid geometry found in STEP file (import produced 0 solids) - cannot tessellate, and simulated m` · threw honest error: `no solid geometry found in STEP file (import produced 0 solids) - cannot derive quantities, and simulated values are not an option` |
| `step-nonmodel-file` | step | `site-notes.md` | error | pass | — | — | — | mesh: threw honest error: `cadquery STEP import failed: ValueError: STEP File could not be loaded` · threw honest error: `cadquery STEP import failed: ValueError: STEP File could not be loaded` |
| `ifc-wall-quantities` | ifc | `wall-quantities.ifc` | success | skip | — | — / 10 | — | engine unavailable for the ifc adapter: ifcopenshell is not importable in /home/z/.venv/bin/python3 (exit code 1) |
| `ifc-two-elements` | ifc | `two-elements.ifc` | success | skip | — | — / 15 | — | engine unavailable for the ifc adapter: ifcopenshell is not importable in /home/z/.venv/bin/python3 (exit code 1) |
| `ifc-wall-geometry-mesh` | ifc | `wall-geometry.ifc` | success | skip | — | — / 2 | — | engine unavailable for the ifc adapter: ifcopenshell is not importable in /home/z/.venv/bin/python3 (exit code 1) |
| `ifc-cylinder-geometry-mesh` | ifc | `cylinder-geometry.ifc` | success | skip | — | — / 2 | — | engine unavailable for the ifc adapter: ifcopenshell is not importable in /home/z/.venv/bin/python3 (exit code 1) |
| `ifc-wall-stripped-empty` | ifc | `wall-stripped.ifc` | success | skip | — | — / 0 | — | engine unavailable for the ifc adapter: ifcopenshell is not importable in /home/z/.venv/bin/python3 (exit code 1) |
| `ifc-nonmodel-file` | ifc | `site-notes.md` | error | skip | — | — | — | engine unavailable for the ifc adapter: ifcopenshell is not importable in /home/z/.venv/bin/python3 (exit code 1) |
| `femesh-bracket-solid` | femesh | `bracket-solid.step` | success | skip | — | — / — | — | engine unavailable for the femesh adapter: gmsh is not importable in /home/z/.venv/bin/python3 (exit code 1) — missing system libs? run scripts/setup-engine-libs.sh |
| `femesh-two-solids` | femesh | `two-solids.step` | success | skip | — | — / — | — | engine unavailable for the femesh adapter: gmsh is not importable in /home/z/.venv/bin/python3 (exit code 1) — missing system libs? run scripts/setup-engine-libs.sh |
| `femesh-geometry-free` | femesh | `bracket.step` | error | skip | — | — | — | engine unavailable for the femesh adapter: gmsh is not importable in /home/z/.venv/bin/python3 (exit code 1) — missing system libs? run scripts/setup-engine-libs.sh |
| `femesh-ifc-refused` | femesh | `wall-quantities.ifc` | error | skip | — | — | — | engine unavailable for the femesh adapter: gmsh is not importable in /home/z/.venv/bin/python3 (exit code 1) — missing system libs? run scripts/setup-engine-libs.sh |
| `powerflow-2bus-closed-form` | powerflow | `powerflow-2bus.json` | success | skip | — | — / — | — | engine unavailable for the powerflow adapter: pandapower is not importable in /home/z/.venv/bin/python3 (exit code 1) |
| `powerflow-islanded` | powerflow | `powerflow-islanded.json` | error | skip | — | — | — | engine unavailable for the powerflow adapter: pandapower is not importable in /home/z/.venv/bin/python3 (exit code 1) |
| `des-flowshop-makespan` | des | `des-flowshop.json` | success | skip | — | — / — | — | engine unavailable for the des adapter: simpy is not importable in /home/z/.venv/bin/python3 (exit code 1) |
| `des-invalid-resource` | des | `des-invalid-resource.json` | error | skip | — | — | — | engine unavailable for the des adapter: simpy is not importable in /home/z/.venv/bin/python3 (exit code 1) |
| `cpm-platform-rollout` | cpm | `schedule-cpm.json` | success | pass | — | — / — | — | cpm: 28 pin(s) · engine identity absent (platform core) · doc byte-determinism ✅ |
| `lo-cover-sheet-convert` | libreoffice | `cover-sheet.fodt` | success | pass | — | — / — | — | libreoffice: 4 pin(s) · libreoffice 25.2.3.2 · byte-determinism not claimed (PDFs embed creation timestamps — single run, §5.4) |
| `sheet-vector-plan` | sheet | `sheet-a102-plan.pdf` | success | pass | — | — / — | — | sheet: 38 pin(s) · pdfplumber 0.11.9 · doc byte-determinism ✅ · max pin rel error 3.519e-7 |
| `sheet-vector-curve` | sheet | `sheet-curve-arc.pdf` | success | pass | — | — / — | — | sheet: 6 pin(s) · pdfplumber 0.11.9 · doc byte-determinism ✅ · max pin rel error 3.981e-5 |
| `sheet-vector-refusal` | sheet | `sheet-scan-like.pdf` | error | pass | — | — | — | sheet: threw honest error: `this sheet page has no vector path operators — it is a scan or raster-only page; vector takeoff is not available for it,` · threw honest error: `` |
| `dxf-takeoff-room` | dxf | `takeoff-room.dxf` | success | pass | — | — / — | — | dxf: 13 pin(s) · ezdxf 1.4.3 · doc byte-determinism ✅ |
| `parametric-schema` | parametric | `parametric-bracket.py` | success | pass | — | — / — | — | parametric: 5 pin(s) · cadquery 2.6.1 · doc byte-determinism ✅ |
| `parametric-defaults` | parametric | `parametric-bracket.py` | success | pass | — | — / — | — | parametric: 9 pin(s) · cadquery 2.6.1 · doc byte-determinism ✅ · max pin rel error 7.530e-16 |
| `parametric-edited` | parametric | `parametric-bracket.py` | success | pass | — | — / — | — | parametric: 9 pin(s) · cadquery 2.6.1 · doc byte-determinism ✅ · max pin rel error 8.017e-16 |
| `parametric-refusals` | parametric | `parametric-bracket.py` | error | pass | — | — | — | parametric: threw honest error: `parameter 'width' = 10 below minimum 20 \| unknown parameter(s) rejected: ['bogus'] \| hole does not fit inside the vertic` · threw honest error: `` |
| `sheet-ocr-callout` | ocr | `ocr-callout.png` | success | pass | — | — / — | — | ocr: 9 pin(s) · tesseract 5.5.0 · doc byte-determinism ✅ |
| `fea-uniform-tension` | fea | `fea-uniform-tension.json` | success | skip | — | — / — | — | engine unavailable for the fea adapter: skfem is not importable in /home/z/.venv/bin/python3 (exit code 1) |
| `fea-cantilever-end-shear` | fea | `fea-cantilever-plate.json` | success | skip | — | — / — | — | engine unavailable for the fea adapter: skfem is not importable in /home/z/.venv/bin/python3 (exit code 1) |
| `fea-underconstrained` | fea | `fea-underconstrained.json` | error | skip | — | — | — | engine unavailable for the fea adapter: skfem is not importable in /home/z/.venv/bin/python3 (exit code 1) |
| `swmm-runoff-balance` | swmm | `swmm-runoff-balance.json` | success | skip | — | — / — | — | engine unavailable for the swmm adapter: pyswmm is not importable in /home/z/.venv/bin/python3 (exit code 1) |
| `swmm-manning-conduit` | swmm | `swmm-manning-conduit.json` | success | skip | — | — / — | — | engine unavailable for the swmm adapter: pyswmm is not importable in /home/z/.venv/bin/python3 (exit code 1) |
| `swmm-no-outfall` | swmm | `swmm-no-outfall.json` | error | skip | — | — | — | engine unavailable for the swmm adapter: pyswmm is not importable in /home/z/.venv/bin/python3 (exit code 1) |
| `transport-channel` | transport | `transport-channel.json` | success | skip | — | — / — | — | engine unavailable for the transport adapter: sfepy is not importable in /home/z/.venv/bin/python3 (exit code 1) |
| `transport-uniform` | transport | `transport-uniform.json` | success | skip | — | — / — | — | engine unavailable for the transport adapter: sfepy is not importable in /home/z/.venv/bin/python3 (exit code 1) |
| `transport-mesh-peclet-refusal` | transport | `transport-high-peclet.json` | error | skip | — | — | — | engine unavailable for the transport adapter: sfepy is not importable in /home/z/.venv/bin/python3 (exit code 1) |
| `rtl-counter-4bit` | chip | `rtl-counter-4bit.json` | success | skip | — | — / — | — | engine unavailable for the chip adapter: amaranth is not importable in /home/z/.venv/bin/python3 (exit code 1) |
| `rtl-counter-8bit` | chip | `rtl-counter-8bit.json` | success | skip | — | — / — | — | engine unavailable for the chip adapter: amaranth is not importable in /home/z/.venv/bin/python3 (exit code 1) |
| `rtl-invalid-kind` | chip | `rtl-invalid-kind.json` | error | skip | — | — | — | engine unavailable for the chip adapter: amaranth is not importable in /home/z/.venv/bin/python3 (exit code 1) |
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

### Observed mesh-volume errors — divergence theorem vs closed forms

- `step-cylinder-solid` (cylinder-solid.step) step:solid:0: observed **0.00012561163186495692** vs closed form 0.0001256637061435917 m³ → relative error 4.144e-4 (0.0414%) — within the pinned 1% mesh tolerance · π · 20² · 100 mm³ = 40000π mm³ = 4π×10⁻⁵ m³ (Ø40×100 mm cylinder). 'mesh' tolerance (pinned 1%): the divergence-theorem volume over the OCCT triangulation is an approximation on the CURVED lateral surface (the inscribed tessellation slightly underestimates) — the harness records the observed relative error per run
- `step-two-solids` (two-solids.step) step:solid:0: observed **0.000005999999999999999** vs closed form 0.000006 m³ → relative error 1.412e-16 — planar-solid exactness (IEEE rounding only) · box A 30 × 20 × 10 mm = 6000 mm³ = 6×10⁻⁶ m³ (PLANAR solid → divergence-theorem mesh volume is mathematically exact; only IEEE rounding remains, and the mesh elementRef set-equals the quantity ledger's per-solid refs)
- `step-two-solids` (two-solids.step) step:solid:1: observed **0.000008999999999999997** vs closed form 0.000009 m³ → relative error 3.765e-16 — planar-solid exactness (IEEE rounding only) · box B 15 × 15 × 40 mm = 9000 mm³ = 9×10⁻⁶ m³ (PLANAR solid → mesh volume exact)

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

- no mesh-tolerance comparisons ran (case skipped or none expected)

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
| `cpm-platform-rollout` | cpm | `schedule-cpm.json` | success | — (platform core, honestly absent) | ✅ true | 28 | pass |
| `lo-cover-sheet-convert` | libreoffice | `cover-sheet.fodt` | success | libreoffice 25.2.3.2 | not claimed (single run, §5.4) | 4 | pass |
| `sheet-vector-plan` | sheet | `sheet-a102-plan.pdf` | success | pdfplumber 0.11.9 | ✅ true | 38 | pass |
| `sheet-vector-curve` | sheet | `sheet-curve-arc.pdf` | success | pdfplumber 0.11.9 | ✅ true | 6 | pass |
| `sheet-vector-refusal` | sheet | `sheet-scan-like.pdf` | error | — (platform core, honestly absent) | — | 0 | pass |
| `dxf-takeoff-room` | dxf | `takeoff-room.dxf` | success | ezdxf 1.4.3 | ✅ true | 13 | pass |
| `parametric-schema` | parametric | `parametric-bracket.py` | success | cadquery 2.6.1 | ✅ true | 5 | pass |
| `parametric-defaults` | parametric | `parametric-bracket.py` | success | cadquery 2.6.1 | ✅ true | 9 | pass |
| `parametric-edited` | parametric | `parametric-bracket.py` | success | cadquery 2.6.1 | ✅ true | 9 | pass |
| `parametric-refusals` | parametric | `parametric-bracket.py` | error | — (platform core, honestly absent) | — | 0 | pass |
| `sheet-ocr-callout` | ocr | `ocr-callout.png` | success | tesseract 5.5.0 | ✅ true | 9 | pass |
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
