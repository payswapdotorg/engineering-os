# Verification record — pdfplumber curve-length-utils contribution

ADR-0011 Stage 5 (the audit's decision #2 upstream contribution: "pdfplumber
bezier-control-point PR queued"). Authored 2026-10-31; re-authored the same
day after a platform sandbox reset destroyed the first unpushed tree — every
step below was re-run on the re-shipped tree (nothing carried over on trust).

## The tree

- Upstream: `jsvine/pdfplumber`, branch `curve-length-utils` off `develop`
  at `2fcbe6a6264201e9ae3e661c01c39b4111eb9af0` (2026-10-14).
- The commit: `eb6ff8a20102c75cd33329ce868ee502cbc4c8c8` — 3 files,
  +162 / −2 (`geometry.py` +83, `__init__.py` +2, `test_utils.py` +79).
- The patch: `0001-Add-curve_points-and-curve_length-utils-bezier-control.patch`
  (git format-patch, 233 lines).

## The honest correction the contribution records

The original audit premise ("pdfplumber hides bezier control points") was
WRONG: `curve["path"]` has exposed them since 0.11.0 (the `c` command
carries both off-curve control points alongside the on-curve endpoint —
`pdfplumber/page.py`, the `LTCurve` branch). The real gap was MEASUREMENT:
no utility computed a curve's length from those control points, and
endpoint-only distances under-read quarter-arcs ~10% (measured 282.84 vs
314.20 at r=200 in our Slice-15 research). The PR text says exactly this.

## Commands run + results (fresh venv from requirements-dev.txt)

```
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt -r requirements-dev.txt -e .

# baseline (BEFORE the change): 173 passed
.venv/bin/python -m pytest tests/ -q --no-cov
  → 173 passed in 49.12s

# fail-on-prior: the four new tests against the pre-change tree
.venv/bin/python -m pytest tests/test_utils.py::TestCurveMeasurement -q --no-cov   [at 2fcbe6a]
  → AttributeError: module 'pdfplumber.utils' has no attribute 'curve_points'
  → 4 errors (the tests cannot pass without the implementation)

# after the change: 177 passed
.venv/bin/python -m pytest tests/ -q --no-cov
  → 177 passed in 17.52s

# the four lint gates
.venv/bin/black --check pdfplumber/ tests/
  → 37 files would be left unchanged.
.venv/bin/isort --check-only --profile black pdfplumber/utils/__init__.py \
                                        pdfplumber/utils/geometry.py tests/test_utils.py
  → clean  [NOTE: --profile black is the repo's setup.cfg [tool.isort] profile;
             without it isort 8.0.1's defaults reformat untouched lines — and
             tests/test_oss_fuzz.py fails the default check at BASELINE too,
             i.e. pre-existing, untouched by this contribution]
.venv/bin/flake8 pdfplumber/ tests/test_utils.py pdfplumber/utils/
  → clean
.venv/bin/mypy pdfplumber/
  → Success: no issues found in 20 source files
```

## The bit-identity cross-check (downstream harness ↔ upstream contribution)

The engineering-takeoff platform's own vector-takeoff adapter (built on the
pinned pdfplumber 0.11.10) measures bezier curves with the same arithmetic —
direct Bernstein form, `t = k/n`, `k = 1..n`, `math.sqrt((x0−x1)**2 +
(y0−y1)**2)` chord sums — at the same default `n = 32`. Run independently in
the platform's engine venv on the same kappa quarter-arc (r = 100):

- platform venv (python 3.12, its own float environment): `157.08587595730572`
- upstream contribution (pinned in `test_curve_length_quarter_arc_converges`):
  `157.08587595730572`

**Bit-identical.** The two implementations were authored independently; the
agreement to the last bit is the strongest available evidence that the
contribution's arithmetic is the platform's measured truth, not a re-derivation.

The analytic reference: `100 × π/2 = 157.07963267948966`; the observed value
sits `3.97e-5` relative above it (the kappa bezier deviates outward from the
true circle; the chord flattening inside it reads correspondingly low; the
effects nearly cancel at n=32). Recorded honestly in the PR text.

## Submission status

**PAT-blocked** — the authoring sandbox's GitHub token was wiped by a
platform reset before the branch could be pushed (the same reset class that
destroyed the first authoring tree). The patch, PR text and this record are
committed as evidence; submission awaits a token. When submitted, the PR
should target `develop` and carry the branch name `curve-length-utils`.
