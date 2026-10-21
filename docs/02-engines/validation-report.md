# Engine validation report — model-derived quantity adapters + mesh tessellation

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

## Environment

- Ran at (UTC): `2026-10-21T21:04:12.688Z`
- Python (engine venv, `EOS_PYTHON`-overridable): `/home/z/.venv/bin/python3`
- Engine availability probe — cadquery (STEP): available · ifcopenshell (IFC): available
- Engine versions (as reported inside real adapter runs): cadquery 2.6.1 · ifcopenshell 0.9.0.post1
- Adapter `step_quantities.py` sha256: `950e3e9f358c0bb16895d222076fbcb99dab58d9f1cbf454a05ba5469515e02d`
- Adapter `ifc_quantities.py` sha256: `68b4ca17ed355e6afa89529fa66c5ef9a73e530da7117f8a9db9f6c3abc43e78`
- Adapter `step_mesh.py` sha256: `e042b686916a212a46dd947a0e6852ec02c10c3687913299d679e38309d5aa9c`
- Adapter `ifc_mesh.py` sha256: `6854d6c0a170daf29de36991af88996af10f2169084d5850083fad03b9747465`
- Corpus: `tests/validation/corpus-manifest.json` — 11 cases

## Tolerance policy (pinned)

| tolerance class | rule | meaning |
|---|---|---|
| `exact` | \|obs − exp\| ≤ 1e-9 · max(1, \|exp\|) | declared-quantity readback — authored values must round-trip |
| `analytic` | \|obs − exp\| ≤ 1e-9 · max(1, \|exp\|) | exact-engine value vs closed form; also used for the PLANAR mesh case, where the divergence-theorem volume / triangle-sum area are mathematically exact (only IEEE rounding remains) |
| `mesh` | \|obs − exp\| ≤ 1e-2 · \|exp\| | pinned 1% engineering tolerance for triangulated CURVED surfaces (ifcopenshell PyPI wheel has no OCCT backend, `has_occ=False`); the observed relative error is recorded below — the limitation is quantified, not hidden |

## Results — 11 cases: 11 pass / 0 fail / 0 skip

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

## Regenerate

```bash
bun run validate:engines   # runs the harness, rewrites report.json + this file, exit 1 on any FAIL
```

All-skip runs (python/engine unavailable) exit 0 and are marked NOT RUN — skipped-with-reason is honest;
fabricated results are not an option.
