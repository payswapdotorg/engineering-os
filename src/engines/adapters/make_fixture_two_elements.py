#!/usr/bin/env python3
"""Deterministic fixture generator for the IfcOpenShell quantity adapter.

Writes tests/fixtures/two-elements.ifc — an IFC4 model with THREE elements
carrying declared BaseQuantities (2 walls + 1 slab), plus one IfcQuantityWeight
among Wall A's declared quantities that the adapter MUST SKIP (the
DerivedQuantity contract has no "weight" slot — the corpus manifest pins the
expected OUTPUT set, so set-equality enforcement proves the skip).

Byte-deterministic plain-text SPF: fixed GlobalIds + fixed header timestamp, so
regenerating reproduces identical bytes (sha256-stable).

Elements & quantities (SI units declared: metre / square metre / cubic metre):

  Wall A  'Wall A'   (GlobalId 3rUnE8CnPHBwLdZzIqZkf1)  4.0 x 0.25 x 2.8 m
    Length            = 4.0                        m
    Width             = 0.25                       m
    Height            = 2.8                        m
    GrossSideArea     = 2*(4.0+0.25)*2.8 = 23.8    m2
    NetVolume         = 4.0*0.25*2.8     = 2.8      m3
    NetWeight         = 2.8 * 2400       = 6720     kg   [IfcQuantityWeight ->
                                                         SKIPPED by adapter]
  Wall B  'Wall B'   (GlobalId 3rUnE8CnPHBwLdZzIqZkf2)  2.0 x 0.15 x 2.8 m
    Length            = 2.0                        m
    Width             = 0.15                       m
    Height            = 2.8                        m
    NetSideArea       = 2*(2.0+0.15)*2.8 = 12.04   m2
    NetFootprintArea  = 2.0*0.15         = 0.3     m2
    NetVolume         = 2.0*0.15*2.8     = 0.84    m3
  Slab S  'Slab S'   (GlobalId 3rUnE8CnPHBwLdZzIqZkf3)  5.0 x 3.0 x 0.2 m
    Length            = 5.0                        m
    Width             = 3.0                        m
    GrossArea         = 5.0*3.0          = 15.0     m2
    NetVolume         = 5.0*3.0*0.2      = 3.0      m3

Mapped (non-skipped) output the adapter must produce: 5 + 6 + 4 = 15 quantities.

Self-check (requires ifcopenshell, same venv as the adapter): re-opens the
generated file, verifies every declared quantity reads back exactly as
authored, that Wall A's BaseQuantities really contains the NetWeight (so the
skip-proof is meaningful), and that ifcopenshell.geom can process each
element's SweptSolid representation (catches malformed-geometry bugs early).
Run: /home/z/.venv/bin/python3 make_fixture_two_elements.py
"""

import hashlib
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE_DIR = os.path.normpath(os.path.join(HERE, "..", "..", "..", "tests", "fixtures"))
OUT_PATH = os.path.join(FIXTURE_DIR, "two-elements.ifc")

# Fixture parameters (m) — mirror of the table above.
WALL_A_LEN, WALL_A_WID, WALL_A_HGT = 4.0, 0.25, 2.8
WALL_B_LEN, WALL_B_WID, WALL_B_HGT = 2.0, 0.15, 2.8
SLAB_LEN, SLAB_WID, SLAB_THK = 5.0, 3.0, 0.2
DENSITY_KG_PER_M3 = 2400.0

WALL_A_GUID = "3rUnE8CnPHBwLdZzIqZkf1"
WALL_B_GUID = "3rUnE8CnPHBwLdZzIqZkf2"
SLAB_GUID = "3rUnE8CnPHBwLdZzIqZkf3"

# Authored declared values = the HUMAN closed forms written as clean decimal
# literals into the file (same authoring pattern as make_fixture_wall.py); the
# self-check below re-derives each one from the geometry parameters and proves
# the pair agrees to 1e-12 (the only differences are IEEE authoring noise, e.g.
# 2*(4.0+0.25)*2.8 lands 2.8e-15 below the decimal 23.8).
CLOSED_FORMS = {
    "wa_side": lambda: 2.0 * (WALL_A_LEN + WALL_A_WID) * WALL_A_HGT,
    "wa_vol": lambda: WALL_A_LEN * WALL_A_WID * WALL_A_HGT,
    "wa_weight": lambda: WALL_A_LEN * WALL_A_WID * WALL_A_HGT * DENSITY_KG_PER_M3,
    "wb_side": lambda: 2.0 * (WALL_B_LEN + WALL_B_WID) * WALL_B_HGT,
    "wb_foot": lambda: WALL_B_LEN * WALL_B_WID,
    "wb_vol": lambda: WALL_B_LEN * WALL_B_WID * WALL_B_HGT,
    "sl_area": lambda: SLAB_LEN * SLAB_WID,
    "sl_vol": lambda: SLAB_LEN * SLAB_WID * SLAB_THK,
}

EXPECTED = {
    WALL_A_GUID: [
        ("Length", "IfcQuantityLength", WALL_A_LEN, None),
        ("Width", "IfcQuantityLength", WALL_A_WID, None),
        ("Height", "IfcQuantityLength", WALL_A_HGT, None),
        ("GrossSideArea", "IfcQuantityArea", 23.8, "wa_side"),
        ("NetVolume", "IfcQuantityVolume", 2.8, "wa_vol"),
        ("NetWeight", "IfcQuantityWeight", 6720.0, "wa_weight"),
    ],
    WALL_B_GUID: [
        ("Length", "IfcQuantityLength", WALL_B_LEN, None),
        ("Width", "IfcQuantityLength", WALL_B_WID, None),
        ("Height", "IfcQuantityLength", WALL_B_HGT, None),
        ("NetSideArea", "IfcQuantityArea", 12.04, "wb_side"),
        ("NetFootprintArea", "IfcQuantityArea", 0.3, "wb_foot"),
        ("NetVolume", "IfcQuantityVolume", 0.84, "wb_vol"),
    ],
    SLAB_GUID: [
        ("Length", "IfcQuantityLength", SLAB_LEN, None),
        ("Width", "IfcQuantityLength", SLAB_WID, None),
        ("GrossArea", "IfcQuantityArea", 15.0, "sl_area"),
        ("NetVolume", "IfcQuantityVolume", 3.0, "sl_vol"),
    ],
}


def fail(msg: str) -> None:
    print(f"FAIL: {msg}", file=sys.stderr)
    sys.exit(1)


def r(x: float) -> str:
    """STEP REAL literal: repr(float) always carries a decimal point (a bare
    integer literal is not a valid IFC REAL and breaks ifcopenshell.geom)."""
    s = repr(float(x))
    assert "." in s or "e" in s.lower(), f"not a real literal: {x!r} -> {s!r}"
    return s


HEADER = """ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Engineering OS W2-c quantity fixture - generated by src/engines/adapters/make_fixture_two_elements.py'),'2;1');
FILE_NAME('two-elements.ifc','2026-01-01T00:00:00',('Engineering OS'),('Engineering OS'),'Manual','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('5rUnE8CnPHBwLdZzIqZkf0',$,'Two Element Fixture',$,$,$,$,(#2),#8);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#3,$);
#3=IFCAXIS2PLACEMENT3D(#4,$,$);
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#6=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#7=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);
#8=IFCUNITASSIGNMENT((#5,#6,#7));
#9=IFCLOCALPLACEMENT($,#3);
"""

# Bodies: all three elements share the +Z extrusion direction #17.
BODY = """#10=IFCWALL('{wa_guid}',$,'Wall A',$,$,#9,#11,$,$);
#11=IFCPRODUCTDEFINITIONSHAPE($,$,(#12));
#12=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#13));
#13=IFCEXTRUDEDAREASOLID(#14,#3,#17,{wa_h});
#14=IFCRECTANGLEPROFILEDEF(.AREA.,$,#15,{wa_l},{wa_w});
#15=IFCAXIS2PLACEMENT2D(#16,$);
#16=IFCCARTESIANPOINT((0.,0.));
#17=IFCDIRECTION((0.,0.,1.));
#20=IFCWALL('{wb_guid}',$,'Wall B',$,$,#9,#21,$,$);
#21=IFCPRODUCTDEFINITIONSHAPE($,$,(#22));
#22=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#23));
#23=IFCEXTRUDEDAREASOLID(#24,#3,#17,{wb_h});
#24=IFCRECTANGLEPROFILEDEF(.AREA.,$,#25,{wb_l},{wb_w});
#25=IFCAXIS2PLACEMENT2D(#26,$);
#26=IFCCARTESIANPOINT((0.,0.));
#30=IFCSLAB('{sl_guid}',$,'Slab S',$,$,#9,#31,$,$);
#31=IFCPRODUCTDEFINITIONSHAPE($,$,(#32));
#32=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#33));
#33=IFCEXTRUDEDAREASOLID(#34,#3,#17,{sl_t});
#34=IFCRECTANGLEPROFILEDEF(.AREA.,$,#35,{sl_l},{sl_w});
#35=IFCAXIS2PLACEMENT2D(#36,$);
#36=IFCCARTESIANPOINT((0.,0.));
"""

# BaseQuantities per element, hung off each element via IfcRelDefinesByProperties.
# Wall A's set intentionally ends with the IfcQuantityWeight NetWeight: the
# adapter must SKIP it (no "weight" slot in the DerivedQuantity contract) — the
# corpus manifest pins the expected OUTPUT set, proving the skip via set-equality.
QUANTITIES = """#40=IFCELEMENTQUANTITY('3rUnE8CnPHBwLdZzIqZkfA',$,'BaseQuantities',$,'BaseQuantities',(#41,#42,#43,#44,#45,#46));
#41=IFCQUANTITYLENGTH('Length',$,$,{wa_len},$);
#42=IFCQUANTITYLENGTH('Width',$,$,{wa_wid},$);
#43=IFCQUANTITYLENGTH('Height',$,$,{wa_hgt},$);
#44=IFCQUANTITYAREA('GrossSideArea',$,$,{wa_side},$);
#45=IFCQUANTITYVOLUME('NetVolume',$,$,{wa_vol},$);
#46=IFCQUANTITYWEIGHT('NetWeight',$,$,{wa_weight},$);
#47=IFCRELDEFINESBYPROPERTIES('3rUnE8CnPHBwLdZzIqZkfB',$,$,$,(#10),#40);
#50=IFCELEMENTQUANTITY('3rUnE8CnPHBwLdZzIqZkfC',$,'BaseQuantities',$,'BaseQuantities',(#51,#52,#53,#54,#55,#56));
#51=IFCQUANTITYLENGTH('Length',$,$,{wb_len},$);
#52=IFCQUANTITYLENGTH('Width',$,$,{wb_wid},$);
#53=IFCQUANTITYLENGTH('Height',$,$,{wb_hgt},$);
#54=IFCQUANTITYAREA('NetSideArea',$,$,{wb_side},$);
#55=IFCQUANTITYAREA('NetFootprintArea',$,$,{wb_foot},$);
#56=IFCQUANTITYVOLUME('NetVolume',$,$,{wb_vol},$);
#57=IFCRELDEFINESBYPROPERTIES('3rUnE8CnPHBwLdZzIqZkfD',$,$,$,(#20),#50);
#60=IFCELEMENTQUANTITY('3rUnE8CnPHBwLdZzIqZkfE',$,'BaseQuantities',$,'BaseQuantities',(#61,#62,#63,#64));
#61=IFCQUANTITYLENGTH('Length',$,$,{sl_len},$);
#62=IFCQUANTITYLENGTH('Width',$,$,{sl_wid},$);
#63=IFCQUANTITYAREA('GrossArea',$,$,{sl_area},$);
#64=IFCQUANTITYVOLUME('NetVolume',$,$,{sl_vol},$);
#65=IFCRELDEFINESBYPROPERTIES('3rUnE8CnPHBwLdZzIqZkfF',$,$,$,(#30),#60);
"""

FOOTER = "ENDSEC;\nEND-ISO-10303-21;\n"


def generate() -> None:
    body = BODY.format(
        wa_guid=WALL_A_GUID, wb_guid=WALL_B_GUID, sl_guid=SLAB_GUID,
        wa_h=r(WALL_A_HGT), wa_l=r(WALL_A_LEN), wa_w=r(WALL_A_WID),
        wb_h=r(WALL_B_HGT), wb_l=r(WALL_B_LEN), wb_w=r(WALL_B_WID),
        sl_t=r(SLAB_THK), sl_l=r(SLAB_LEN), sl_w=r(SLAB_WID),
    )
    quants = QUANTITIES.format(
        wa_len=r(WALL_A_LEN), wa_wid=r(WALL_A_WID), wa_hgt=r(WALL_A_HGT),
        wa_side=r(23.8),
        wa_vol=r(2.8),
        wa_weight=r(6720.0),
        wb_len=r(WALL_B_LEN), wb_wid=r(WALL_B_WID), wb_hgt=r(WALL_B_HGT),
        wb_side=r(12.04),
        wb_foot=r(0.3),
        wb_vol=r(0.84),
        sl_len=r(SLAB_LEN), sl_wid=r(SLAB_WID),
        sl_area=r(15.0),
        sl_vol=r(3.0),
    )
    with open(OUT_PATH, "w", encoding="utf-8", newline="\n") as f:
        f.write(HEADER + body + quants + FOOTER)


def self_check() -> None:
    try:
        import ifcopenshell
        import ifcopenshell.geom
    except Exception as e:
        print(f"self-check SKIPPED (ifcopenshell not importable: {e}) — file still written")
        return

    f = ifcopenshell.open(OUT_PATH)
    walls = f.by_type("IfcWall")
    slabs = f.by_type("IfcSlab")
    if len(walls) != 2 or len(slabs) != 1:
        fail(f"expected 2 IfcWall + 1 IfcSlab, got {len(walls)} + {len(slabs)}")

    value_attr = {
        "IfcQuantityLength": "LengthValue",
        "IfcQuantityArea": "AreaValue",
        "IfcQuantityVolume": "VolumeValue",
        "IfcQuantityWeight": "WeightValue",
    }
    mapped_count = 0
    for el in list(walls) + list(slabs):
        by_guid = EXPECTED[el.GlobalId]
        sets = [rel.RelatingPropertyDefinition for rel in el.IsDefinedBy
                if rel.RelatingPropertyDefinition.is_a("IfcElementQuantity")]
        if len(sets) != 1 or sets[0].Name != "BaseQuantities":
            fail(f"{el.Name}: expected exactly one 'BaseQuantities' set, got {sets}")
        declared = {q.Name: q for q in sets[0].Quantities}
        if len(declared) != len(by_guid):
            fail(f"{el.Name}: declared {len(declared)} quantities, expected {len(by_guid)}")
        for name, kind, authored, form_key in by_guid:
            q = declared.get(name)
            if q is None or not q.is_a(kind):
                fail(f"{el.Name}: quantity {name} ({kind}) missing or wrong kind: {q}")
            got = float(getattr(q, value_attr[kind]))
            # (a) round-trip: the authored literal reads back exactly
            if got != authored:
                fail(f"{el.Name}.{name}: round-trip mismatch {got!r} != {authored!r}")
            # (b) closed form: the authored literal agrees with the hand-derived
            # formula from the geometry parameters (IEEE authoring noise only)
            if form_key is not None:
                derived = CLOSED_FORMS[form_key]()
                if abs(got - derived) > 1e-12:
                    fail(f"{el.Name}.{name}: authored {got!r} disagrees with closed "
                         f"form {derived!r}")
            if kind != "IfcQuantityWeight":
                mapped_count += 1
        # geometry must be processable by the wheel's geom module (catches
        # malformed-representation bugs at fixture time, not harness time)
        try:
            ifcopenshell.geom.create_shape(ifcopenshell.geom.settings(), el)
        except Exception as e:
            fail(f"{el.Name}: ifcopenshell.geom.create_shape failed: {e}")

    if mapped_count != 15:
        fail(f"expected 15 mapped (non-skipped) quantities across elements, got {mapped_count}")
    print(f"round-trip OK: 3 elements, {mapped_count} mapped quantities "
          f"+ 1 IfcQuantityWeight (NetWeight 6720.0 kg) declared for the skip-proof")


def main() -> None:
    generate()
    self_check()
    with open(OUT_PATH, "rb") as fh:
        print(f"wrote {OUT_PATH}")
        print(f"sha256 {hashlib.sha256(fh.read()).hexdigest()}")
    print("analytic: WallA 23.8 m2 side / 2.8 m3, WallB 12.04 m2 side / 0.84 m3, "
          "Slab 15.0 m2 / 3.0 m3, NetWeight 6720 kg (must-skip)")


if __name__ == "__main__":
    main()
