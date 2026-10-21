#!/usr/bin/env python3
"""Deterministic fixture generator for the cadquery STEP quantity adapter.

Writes tests/fixtures/two new benchmark solids used by the validation harness
(tests/validation/corpus-manifest.json); regenerating under the pinned venv
(cadquery 2.6.1 / OCCT 7.8) reproduces byte-identical output — the OCC-written
header (which embeds a wall-clock timestamp) is normalized to a fixed literal.

  make_fixture_step_solids.py --cylinder  -> tests/fixtures/cylinder-solid.step
  make_fixture_step_solids.py --two-boxes -> tests/fixtures/two-solids.step

Fixture 1 — CYLINDER (curved surface through the EXACT OCCT BRep path):
  Ø40 x 100 mm cylinder (r = 20, h = 100), axis +Z, centred on the origin,
  base at z = 0.
  ANALYTIC (hand-derived, independent of OCC/cadquery):
    volume        V = pi * 20^2 * 100            = 40000*pi  ~ 125663.7061 mm3
    surface area  S = 2*pi*20*100 + 2*pi*20^2    = 4800*pi   ~ 15079.6447 mm2
                  (lateral 4000*pi + two caps 800*pi)
    bounding box 40 x 40 x 100 -> diagonal sqrt(40^2+40^2+100^2) = sqrt(13200)
                                                                   ~ 114.8913 mm
  Unlike the mesh fallback (IfcOpenShell PyPI wheel), cadquery/OCCT integrates
  analytic surfaces EXACTLY via BRepGProp — the observed deviation from these
  closed forms is floating-point level (~5e-14 relative for the curved area).

Fixture 2 — TWO DISJOINT BOXES (multi-solid corpus case):
  box A: 30 x 20 x 10 mm with corner at (0, 0, 0)
  box B: 15 x 15 x 40 mm with corner at (100, 0, 0)   (70 mm gap -> disjoint)
  ANALYTIC (hand-derived):
    V_A = 30*20*10                = 6000  mm3
    V_B = 15*15*40                = 9000  mm3
    S_A = 2*(30*20+30*10+20*10)   = 2200  mm2
    S_B = 2*(15*15+15*40+15*40)   = 2850  mm2
    S_total                        = 5050  mm2
    overall bbox 115 x 20 x 40 -> diagonal sqrt(115^2+20^2+40^2) = sqrt(15225)
                                                                    ~ 123.3896 mm
  Solid enumeration: box A is written to the STEP file first and OCCT
  enumerates it as solid 0 on import (verified stable across imports and runs;
  the harness additionally re-verifies via its bitwise determinism double-run).
  If a future OCCT ever flips the order, the self-check below fails loudly —
  the corpus manifest must then be updated together with the engine pin.

The generator self-checks the exported file by re-importing it and comparing the
engine-computed values against these closed forms (rel. tol 1e-9); exit 1 on any
mismatch. Run: /home/z/.venv/bin/python3 make_fixture_step_solids.py
"""

import hashlib
import math
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE_DIR = os.path.normpath(os.path.join(HERE, "..", "..", "..", "tests", "fixtures"))
CYL_PATH = os.path.join(FIXTURE_DIR, "cylinder-solid.step")
TWO_PATH = os.path.join(FIXTURE_DIR, "two-solids.step")

# Fixture parameters (mm) — mirror of the ANALYTIC block above.
CYL_R, CYL_H = 20.0, 100.0
BOX_A = (30.0, 20.0, 10.0)          # extents
BOX_A_ORIGIN = (0.0, 0.0, 0.0)
BOX_B = (15.0, 15.0, 40.0)
BOX_B_ORIGIN = (100.0, 0.0, 0.0)

CYL_VOLUME = math.pi * CYL_R**2 * CYL_H
CYL_AREA = 2.0 * math.pi * CYL_R * CYL_H + 2.0 * math.pi * CYL_R**2
CYL_BBOX_DIAG = math.sqrt((2 * CYL_R) ** 2 + (2 * CYL_R) ** 2 + CYL_H**2)

BOX_A_VOLUME = BOX_A[0] * BOX_A[1] * BOX_A[2]
BOX_B_VOLUME = BOX_B[0] * BOX_B[1] * BOX_B[2]
BOX_A_AREA = 2.0 * (BOX_A[0] * BOX_A[1] + BOX_A[0] * BOX_A[2] + BOX_A[1] * BOX_A[2])
BOX_B_AREA = 2.0 * (BOX_B[0] * BOX_B[1] + BOX_B[0] * BOX_B[2] + BOX_B[1] * BOX_B[2])
BOXES_TOTAL_AREA = BOX_A_AREA + BOX_B_AREA
BOXES_BBOX_DIAG = math.sqrt(
    (BOX_B_ORIGIN[0] + BOX_B[0]) ** 2
    + max(BOX_A[1], BOX_B[1]) ** 2
    + max(BOX_A[2], BOX_B[2]) ** 2
)

REL_TOL = 1e-9  # generator self-check bound (harness pins the same 1e-9 policy)


def fail(msg: str) -> None:
    print(f"FAIL: {msg}", file=sys.stderr)
    sys.exit(1)


def normalize_header(path: str, fixture_name: str) -> None:
    """Normalize the OCC header: fixed timestamp + honest origin description so
    regeneration is byte-identical and the fixture documents its own source."""
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    text = re.sub(
        r"FILE_DESCRIPTION\(.*?\);",
        "FILE_DESCRIPTION(('Engineering OS W2-c quantity fixture - generated "
        "by src/engines/adapters/make_fixture_step_solids.py'),'2;1');",
        text, count=1, flags=re.S,
    )
    text = re.sub(
        r"FILE_NAME\([^;]*\);",
        f"FILE_NAME('{fixture_name}','2026-01-01T00:00:00',('Engineering OS'),"
        "('Engineering OS'),'Manual','');",
        text, count=1,
    )
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def check(name: str, measured: float, expected: float) -> float:
    rel = abs(measured - expected) / expected
    if rel > REL_TOL:
        fail(f"self-check {name}: measured {measured!r} vs analytic {expected!r} (rel {rel:.3e})")
    print(f"self-check {name}: engine={measured!r} analytic={expected!r} (rel {rel:.2e})")
    return rel


def build_cylinder() -> None:
    import cadquery as cq
    from cadquery import exporters

    cyl = cq.Workplane("XY").circle(CYL_R).extrude(CYL_H)
    solids = cyl.solids().vals()
    if len(solids) != 1:
        fail(f"cylinder: expected exactly 1 solid, got {len(solids)}")
    exporters.export(cyl, CYL_PATH, exporters.ExportTypes.STEP)
    normalize_header(CYL_PATH, "cylinder-solid.step")


def check_cylinder() -> None:
    from cadquery import importers

    wp = importers.importStep(CYL_PATH)
    solids = wp.solids().vals()
    if len(solids) != 1:
        fail(f"cylinder re-import: expected 1 solid, got {len(solids)}")
    s = solids[0]
    bb = s.BoundingBox()
    diag = math.sqrt(bb.xlen**2 + bb.ylen**2 + bb.zlen**2)
    check("cylinder volume", float(s.Volume()), CYL_VOLUME)
    check("cylinder area", float(s.Area()), CYL_AREA)
    check("cylinder bbox diagonal", diag, CYL_BBOX_DIAG)


def build_two_boxes() -> None:
    import cadquery as cq
    from cadquery import exporters

    solid_a = cq.Solid.makeBox(*BOX_A, cq.Vector(*BOX_A_ORIGIN))
    solid_b = cq.Solid.makeBox(*BOX_B, cq.Vector(*BOX_B_ORIGIN))
    compound = cq.Compound.makeCompound([solid_a, solid_b])
    if len(compound.Solids()) != 2:
        fail("two-solids: compound does not carry exactly 2 solids")
    exporters.export(cq.Workplane(obj=compound), TWO_PATH, exporters.ExportTypes.STEP)
    normalize_header(TWO_PATH, "two-solids.step")


def check_two_boxes() -> None:
    from cadquery import importers

    wp = importers.importStep(TWO_PATH)
    solids = wp.solids().vals()
    if len(solids) != 2:
        fail(f"two-solids re-import: expected 2 solids, got {len(solids)}")
    # Enumeration-order contract with the corpus manifest: solid 0 = box A
    # (30x20x10 at origin), solid 1 = box B (15x15x40 at x=100). If this ever
    # flips, update manifest + this check TOGETHER with the engine pin.
    vols = [float(s.Volume()) for s in solids]
    if abs(vols[0] - BOX_A_VOLUME) > 1e-9 or abs(vols[1] - BOX_B_VOLUME) > 1e-9:
        fail(f"two-solids enumeration order changed: volumes {vols!r} "
             f"(expected [{BOX_A_VOLUME!r}, {BOX_B_VOLUME!r}]) - update the corpus "
             "manifest together with the engine pin if this is intentional")
    total_area = sum(float(s.Area()) for s in solids)
    # Manual union of per-solid bounding boxes (cadquery's BoundBox.add is not a
    # reliable mutator on this version — compute the union explicitly).
    mins = [+math.inf] * 3
    maxs = [-math.inf] * 3
    for s in solids:
        bb = s.BoundingBox()
        for i, (lo, hi) in enumerate(((bb.xmin, bb.xmax), (bb.ymin, bb.ymax), (bb.zmin, bb.zmax))):
            mins[i] = min(mins[i], lo)
            maxs[i] = max(maxs[i], hi)
    diag = math.sqrt((maxs[0] - mins[0]) ** 2 + (maxs[1] - mins[1]) ** 2 + (maxs[2] - mins[2]) ** 2)
    check("box A volume (solid 0)", vols[0], BOX_A_VOLUME)
    check("box B volume (solid 1)", vols[1], BOX_B_VOLUME)
    check("total area (A+B)", total_area, BOXES_TOTAL_AREA)
    check("overall bbox diagonal", diag, BOXES_BBOX_DIAG)


def main() -> None:
    build_cylinder()
    check_cylinder()
    build_two_boxes()
    check_two_boxes()
    for p, label in ((CYL_PATH, "cylinder-solid.step"), (TWO_PATH, "two-solids.step")):
        with open(p, "rb") as f:
            digest = hashlib.sha256(f.read()).hexdigest()
        print(f"wrote {p}")
        print(f"sha256 {digest}")
    print(f"analytic cylinder: V = 40000*pi = {CYL_VOLUME!r} mm3, "
          f"S = 4800*pi = {CYL_AREA!r} mm2, bbox = sqrt(13200) = {CYL_BBOX_DIAG!r} mm")
    print(f"analytic boxes: V_A = 6000, V_B = 9000, S_total = {BOXES_TOTAL_AREA!r}, "
          f"bbox = sqrt(15225) = {BOXES_BBOX_DIAG!r} mm")


if __name__ == "__main__":
    main()
