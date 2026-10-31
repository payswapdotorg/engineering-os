# Upstream PR text — pdfplumber `curve_points` / `curve_length`

> **Status: AUTHORED + FULLY VERIFIED, submission PAT-blocked.** The sandbox
> that produced this contribution lost its GitHub token to a platform reset
> before the branch could be pushed; the patch, this PR text and the
> verification record are committed here as evidence (ADR-0011 Stage 5).
> Re-ship note: authored twice today — the first unpushed tree was destroyed
> by the same class of reset; this is the second, re-authored from the
> preserved session record and re-verified end-to-end.

**Branch:** `curve-length-utils` (off `develop` @ `2fcbe6a`)
**Files:** `pdfplumber/utils/geometry.py` (+83), `pdfplumber/utils/__init__.py` (+2), `tests/test_utils.py` (+79)

---

## Summary

The `path` attribute has exposed bezier control points since v0.11.0, but no
measurement capability uses them: the only length information on a curve
object is its bounding box, and endpoint-to-endpoint distances under-read
curved paths substantially — a kappa-approximated quarter-arc measured by its
chord is ~10% short (282.84 vs 314.20 at r=200, measured downstream in
[engineering takeoff tooling built on pdfplumber]).

This PR adds two utilities to `pdfplumber.utils`:

- **`curve_points(curve)`** — all control points of a curve object's path, in
  path order: the full drawn geometry (including the `c` commands' off-curve
  control points), recoverable in one call.
- **`curve_length(curve, n=32)`** — the arc length in points. Lines (`l`) and
  closes (`h`) contribute their euclidean lengths; each cubic bezier segment
  (`c`) is flattened at `n` sample points (`t = k/n`, `k = 1..n`, direct
  Bernstein form) and contributes the chord sum — the standard flattening
  approximation. `n < 1` raises `ValueError`.

## The arithmetic, pinned

For a kappa-approximated quarter-arc of radius 100 (control constant
`kappa = 0.5522847498307936`), at the default `n = 32`:

- analytic arc length: `100 × π/2 = 157.07963267948966`
- `curve_length(...)` returns **`157.08587595730572`** — `3.97e-5` relative
  above the analytic arc. The kappa bezier itself deviates outward from the
  true circle (its length exceeds the arc's), while the chord flattening
  inside the bezier reads correspondingly low; at `n = 32` the two effects
  nearly cancel. The test pins the exact literal.

## Tests (173 → 177)

1. `curve_points` returns the control points in path order (m / c / l / h).
2. `curve_length` of a line-and-close path is the exact euclidean total.
3. The quarter-arc convergence: the pinned `n = 32` literal + `< 1e-4`
   relative vs the analytic arc.
4. The default `n = 32` equals an explicit `n = 32`; segment lengths sum
   across subpaths (the same arc drawn twice = twice the single-arc length,
   pinned at `1e-12` — sequential float addition may differ from the exact
   doubling in the last ulp).

## Verification (the full record in VERIFICATION.md)

- Upstream suite: **173 → 177 passed** (fail-on-prior proven: the four tests
  run against the pre-change tree fail with `AttributeError`).
- `black --check`: clean · `isort --check-only --profile black`: clean ·
  `flake8`: clean · `mypy pdfplumber/`: `Success: no issues found in 20
  source files`.
- The pinned `n = 32` literal is bit-identical to the value the downstream
  engineering-takeoff harness computes with the same Bernstein-form
  arithmetic at the same `n` — the two implementations were written
  independently and agree to the last bit.
