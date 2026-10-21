# Engine validation report — model-derived quantity adapters

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

## Environment

- Ran at (UTC): `2026-10-21T17:45:34.724Z`
- Python (engine venv, `EOS_PYTHON`-overridable): `/home/z/.venv/bin/python3`
- Engine availability probe — cadquery (STEP): available · ifcopenshell (IFC): available
- Engine versions (as reported inside real adapter runs): cadquery 2.6.1 · ifcopenshell 0.9.0.post1
- Adapter `step_quantities.py` sha256: `950e3e9f358c0bb16895d222076fbcb99dab58d9f1cbf454a05ba5469515e02d`
- Adapter `ifc_quantities.py` sha256: `68b4ca17ed355e6afa89529fa66c5ef9a73e530da7117f8a9db9f6c3abc43e78`
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
| `step-cylinder-solid` | step | `cylinder-solid.step` | success | pass | ✅ true | 3 / 3 | 5.488e-14 | largest observed rel error 5.488e-14 (step:solids:all area) — IEEE/authoring noise only, within tolerance |
| `step-two-solids` | step | `two-solids.step` | success | pass | ✅ true | 4 / 4 | 0.000e+0 |  |
| `step-bracket-empty` | step | `bracket.step` | error | pass | — | — | — | threw honest error: `no solid geometry found in STEP file (import produced 0 solids) - cannot derive quantities, and simulated values are not an option` |
| `step-nonmodel-file` | step | `site-notes.md` | error | pass | — | — | — | threw honest error: `cadquery STEP import failed: ValueError: STEP File could not be loaded` |
| `ifc-wall-quantities` | ifc | `wall-quantities.ifc` | success | pass | ✅ true | 10 / 10 | 0.000e+0 |  |
| `ifc-two-elements` | ifc | `two-elements.ifc` | success | pass | ✅ true | 15 / 15 | 0.000e+0 |  |
| `ifc-wall-geometry-mesh` | ifc | `wall-geometry.ifc` | success | pass | ✅ true | 2 / 2 | 1.850e-16 | largest observed rel error 1.850e-16 (#2rUnE8CnPHBwLdZzIqZkf1 volume) — IEEE/authoring noise only, within tolerance |
| `ifc-cylinder-geometry-mesh` | ifc | `cylinder-geometry.ifc` | success | pass | ✅ true | 2 / 2 | 3.246e-3 | mesh vs closed form: volume observed 0.3757673725921769 vs expected 0.3769911184307752 m³ — rel error 3.246e-3 (0.3246%) · mesh vs closed form: area observed 4.017361163910887 vs expected 4.0212385965949355 m² — rel error 9.642e-4 (0.0964%) |
| `ifc-wall-stripped-empty` | ifc | `wall-stripped.ifc` | success | pass | ✅ true | 0 / 0 | — | empty pinned set — the adapter returned zero quantities (honest empty, never fabricated) |
| `ifc-nonmodel-file` | ifc | `site-notes.md` | error | pass | — | — | — | threw honest error: `ifcopenshell could not open the file: Error: Unable to parse IFC SPF header` |

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
