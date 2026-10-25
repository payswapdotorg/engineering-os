#!/usr/bin/env python3
"""Deterministic DXF fixture generator for the ezdxf takeoff adapter (Lane 16-V).

Writes tests/fixtures/takeoff-room.dxf — the vector-takeoff corpus fixture for
the dxf-takeoff-room harness case. Regenerating under the pinned venv
(ezdxf 1.4.5, tests/validation/engines-requirements.txt) reproduces the
committed fixture BYTE-IDENTICALLY: `ezdxf.options.write_fixed_meta_data_for_testing
= True` pins the wall-clock-dependent header variables ($TDCREATE/$TDUPDATE/
$TDINDWG/$FINGERPRINTGUID/$VERSIONGUID/…) to fixed literals, so two fresh
documents serialize to the same sha256 (proven empirically in worklog 16-R1
and re-proven by the harness regen check, which runs this script twice and
compares bytes + the committed fixture).

  make_fixture_takeoff_room.py            -> tests/fixtures/takeoff-room.dxf
  make_fixture_takeoff_room.py --out P    -> P (harness regen probe; the
                                              committed fixture is untouched)

Fixture — a minimal 2D room plan, $INSUNITS = 4 (MILLIMETRE, required by the
adapter's unit gate), three layers:

  layer "WALLS": one CLOSED LWPOLYLINE rectangle 4000 x 3000 mm at the origin
      (4 vertices, counter-clockwise)
      -> perimeter 14000.000000 mm (2*(4000+3000))
      -> shoelace area 12000000.000000 mm2 (4000*3000)
  layer "DIM":   one LINE (1000,0) -> (1000,2000)     -> length 2000.000000 mm
                 one ARC   center (1000,0), r = 900, start 0 deg, end 90 deg
      -> EXACT arc length r*theta = 900*(pi/2) = 1413.716694115407 mm
         (DXF stores full IEEE doubles; the adapter computes r*theta directly,
          NO flattening — the value is exact up to the pi double)
      -> DIM totalLengthMm = 2000 + 900*pi/2 = 3413.716694115407 mm
  layer "FURN":  one CIRCLE center (500,500), r = 100
      -> EXACT circumference 2*pi*100 = 628.3185307179587 mm

entityCount 4 (1 LWPOLYLINE + 1 LINE + 1 ARC + 1 CIRCLE), layerCount 3.

The generator self-checks the written file by re-importing it with ezdxf and
comparing the adapter's own geometry math against these closed forms
(rel tol 1e-9); exit 1 on any mismatch, sha256 printed on success.
Run: /home/z/.venv/bin/python3 src/engines/adapters/make_fixture_takeoff_room.py
"""

import hashlib
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE_DIR = os.path.normpath(os.path.join(HERE, "..", "..", "..", "tests", "fixtures"))
DEFAULT_OUT = os.path.join(FIXTURE_DIR, "takeoff-room.dxf")

# Fixture parameters (mm) — mirror of the ANALYTIC block above.
ROOM_W, ROOM_H = 4000.0, 3000.0
LINE_A = (1000.0, 0.0)
LINE_B = (1000.0, 2000.0)
ARC_CENTER = (1000.0, 0.0)
ARC_R = 900.0
ARC_START_DEG = 0.0
ARC_END_DEG = 90.0
CIRC_CENTER = (500.0, 500.0)
CIRC_R = 100.0

ROOM_PERIMETER = 2.0 * (ROOM_W + ROOM_H)          # 14000.0
ROOM_AREA = ROOM_W * ROOM_H                        # 12000000.0
LINE_LENGTH = math.dist(LINE_A, LINE_B)            # 2000.0
ARC_LENGTH = ARC_R * math.radians(ARC_END_DEG - ARC_START_DEG)  # 900*pi/2
CIRC_LENGTH = 2.0 * math.pi * CIRC_R               # 628.3185307179587

REL_TOL = 1e-9  # self-check bound (DXF stores full doubles — observed 0.00e+00)


def fail(msg: str) -> None:
    print(f"FAIL: {msg}", file=sys.stderr)
    sys.exit(1)


def check(name: str, measured: float, expected: float) -> float:
    rel = abs(measured - expected) / expected
    if rel > REL_TOL:
        fail(f"self-check {name}: measured {measured!r} vs analytic {expected!r} (rel {rel:.3e})")
    print(f"self-check {name}: engine={measured!r} analytic={expected!r} (rel {rel:.2e})")
    return rel


def build(out_path: str) -> None:
    import ezdxf

    # BYTE-DETERMINISM PIN: fixed meta data (timestamps/GUIDs) — set BEFORE the
    # document is created so the header vars are initialized from the fixed set.
    ezdxf.options.write_fixed_meta_data_for_testing = True
    doc = ezdxf.new("R2010", units=ezdxf.units.MM)  # $INSUNITS = 4 (mm)
    doc.layers.add("WALLS")
    doc.layers.add("DIM")
    doc.layers.add("FURN")
    msp = doc.modelspace()
    msp.add_lwpolyline(
        [(0.0, 0.0), (ROOM_W, 0.0), (ROOM_W, ROOM_H), (0.0, ROOM_H)],
        close=True,
        dxfattribs={"layer": "WALLS"},
    )
    msp.add_line(LINE_A, LINE_B, dxfattribs={"layer": "DIM"})
    msp.add_arc(
        center=ARC_CENTER,
        radius=ARC_R,
        start_angle=ARC_START_DEG,
        end_angle=ARC_END_DEG,
        dxfattribs={"layer": "DIM"},
    )
    msp.add_circle(center=CIRC_CENTER, radius=CIRC_R, dxfattribs={"layer": "FURN"})

    # BYTE-DETERMINISM, second pin (empirically isolated 16-V): ezdxf's
    # ClassesSection.add_required_classes — run INSIDE save() — appends the
    # drawing's "dxf types in use" by iterating a SET (entitydb.dxf_types_in_use
    # -> set[str]), so the CLASSES-section tail order is str-hash-dependent:
    # observed live, ACDBPLACEHOLDER and LAYOUT swap position across
    # interpreter runs (PYTHONHASHSEED=0 stable, random seeds alternate).
    # write_fixed_meta_data_for_testing does NOT cover this. Canonical fix:
    # run the (idempotent) class registration OURSELVES, then emit the section
    # in sorted key order — CLASS order carries no semantics for any DXF
    # reader, and the sorted order reproduces the committed fixture under ANY
    # hash seed. save()'s own add_required_classes call then finds every key
    # already registered (register() skips existing keys) and appends nothing.
    doc.classes.add_required_classes(doc.dxfversion)
    doc.classes.classes = dict(sorted(doc.classes.classes.items()))
    doc.saveas(out_path)


def shoelace(points) -> float:
    """|2*A| via the shoelace formula (same math as the dxf_takeoff.py adapter)."""
    total = 0.0
    n = len(points)
    for i in range(n):
        x0, y0 = points[i]
        x1, y1 = points[(i + 1) % n]
        total += x0 * y1 - x1 * y0
    return abs(total) / 2.0


def verify(out_path: str) -> None:
    import ezdxf

    doc = ezdxf.readfile(out_path)
    insunits = doc.header.get("$INSUNITS", 0)
    if insunits != 4:
        fail(f"self-check $INSUNITS: expected 4 (mm), got {insunits!r}")
    msp = doc.modelspace()
    by_type: dict = {}
    for e in msp:
        by_type.setdefault(e.dxftype(), []).append(e)
    if {t: len(v) for t, v in by_type.items()} != {"LWPOLYLINE": 1, "LINE": 1, "ARC": 1, "CIRCLE": 1}:
        fail(f"self-check entity set: unexpected modelspace contents {sorted(by_type)}")
    poly = by_type["LWPOLYLINE"][0]
    if poly.dxf.layer != "WALLS" or not poly.closed or len(poly) != 4:
        fail("self-check LWPOLYLINE: expected a closed 4-vertex rectangle on WALLS")
    pts = [(p[0], p[1]) for p in poly.get_points("xy")]
    perim = sum(math.dist(pts[i], pts[(i + 1) % 4]) for i in range(4))
    check("WALLS closed-polyline perimeter", perim, ROOM_PERIMETER)
    check("WALLS closed-polyline shoelace area", shoelace(pts), ROOM_AREA)
    line = by_type["LINE"][0]
    if line.dxf.layer != "DIM":
        fail("self-check LINE: expected layer DIM")
    check("DIM line length", math.dist((line.dxf.start.x, line.dxf.start.y), (line.dxf.end.x, line.dxf.end.y)), LINE_LENGTH)
    arc = by_type["ARC"][0]
    if arc.dxf.layer != "DIM":
        fail("self-check ARC: expected layer DIM")
    if abs(arc.dxf.radius - ARC_R) > 1e-9:
        fail(f"self-check ARC radius: {arc.dxf.radius!r} vs {ARC_R!r}")
    check("DIM arc length (r*theta, exact)", arc.dxf.radius * math.radians(arc.dxf.end_angle - arc.dxf.start_angle), ARC_LENGTH)
    circ = by_type["CIRCLE"][0]
    if circ.dxf.layer != "FURN":
        fail("self-check CIRCLE: expected layer FURN")
    check("FURN circle circumference (2*pi*r, exact)", 2.0 * math.pi * circ.dxf.radius, CIRC_LENGTH)


def main() -> None:
    out_path = DEFAULT_OUT
    if len(sys.argv) == 3 and sys.argv[1] == "--out":
        out_path = os.path.abspath(sys.argv[2])
    elif sys.argv[1:] and sys.argv[1] != "--out":
        fail(f"usage: {sys.argv[0]} [--out <path>]")
    build(out_path)
    verify(out_path)
    with open(out_path, "rb") as f:
        digest = hashlib.sha256(f.read()).hexdigest()
    print(f"wrote {out_path}")
    print(f"sha256 {digest}")
    print(
        f"analytic: WALLS perim {ROOM_PERIMETER!r} mm / area {ROOM_AREA!r} mm2; "
        f"DIM line {LINE_LENGTH!r} + arc {ARC_LENGTH!r} = {LINE_LENGTH + ARC_LENGTH!r} mm; "
        f"FURN circumference {CIRC_LENGTH!r} mm"
    )


if __name__ == "__main__":
    main()
