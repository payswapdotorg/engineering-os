#!/usr/bin/env python3
"""Engineering OS — IFC quantity adapter (engine: IfcOpenShell).

Contract (worklog.md "TL-pinned contracts", W2-b):
  argv[1]         absolute path to an .ifc file
  stdout (exit 0): {
    "engineKey":    "ifcopenshell",
    "engineVersion": <real ifcopenshell.version>,
    "adapterScript": "ifc_quantities.py",
    "adapterHash":   <sha256 of THIS file's own bytes>,
    "quantities": [
      {"elementRef": "#<GlobalId>", "quantityType": "volume"|"area"|"length"|"count",
       "value": <number>, "unit": "<unit string>", "raw": {...}}, ...
    ]
  }
  stdout (exit 1): {"error": "<honest message>"}  — never a simulated value.

Per-element derivation order (honest, no mixing of methods):
  1. DECLARED quantities: IfcElementQuantity sets (sets named "BaseQuantities"
     first, then any other IfcElementQuantity) reached via IfcRelDefinesByProperties.
     IfcQuantityLength/Volume/Area/Count map onto the contract's quantityType
     union. Other kinds (IfcQuantityWeight, IfcQuantityTime, complex quantities)
     are SKIPPED and their names are recorded in raw["skippedUnsupportedQuantities"]
     — they cannot be expressed in the DerivedQuantity contract and are never
     relabeled or approximated.
  2. GEOMETRIC fallback (only when no declared quantity was usable and the
     element has a representation): ifcopenshell.geom triangulation. Volume via
     the divergence theorem over the closed triangle soup, area via the
     triangle-sum. Exact for planar solids, an APPROXIMATION for curved surfaces
     — raw["method"] = "mesh-triangulation" records this honestly.

Units are resolved from the IfcProject's IfcUnitAssignment (SI length/area/
volume units; area/volume units are derived from the length unit as <u>²/<u>³
when not explicitly assigned — recorded in raw). IfcQuantityCount values are
dimensionless; their unit string is "count". Declared quantities carry the
per-quantity IfcNamedUnit when the IFC file provides one.

IfcOpeningElement (and other void features) are excluded: openings are
subtracted negative space, not additional takeoff quantities.

NOTHING except the JSON protocol is ever printed on stdout (fd-level redirect
1 -> 2 for the whole engine phase, restored before printing).
"""

import hashlib
import json
import math
import os
import sys

ENGINE_KEY = "ifcopenshell"
ADAPTER_NAME = "ifc_quantities.py"

SI_LENGTH_PREFIX = {"MILLI": "mm", "CENTI": "cm", "DECI": "dm", None: "m", "$": "m"}


def fail(msg: str) -> None:
    """Print the honest error envelope and exit non-zero. Nothing else on stdout."""
    sys.stdout.write(json.dumps({"error": msg}) + "\n")
    sys.stdout.flush()
    sys.exit(1)


def resolve_project_units(f):
    """Return {'length': sym, 'area': sym, 'volume': sym, 'count': 'count'} + evidence."""
    evidence = []
    length_sym = None
    area_sym = None
    volume_sym = None
    projects = f.by_type("IfcProject")
    if not projects:
        return None, "no IfcProject instance found (units are assigned per project)"
    unit_assignment = projects[0].UnitsInContext
    for u in getattr(unit_assignment, "Units", []) or []:
        if getattr(u, "is_a", None) and u.is_a("IfcSIUnit"):
            unit_type = u.UnitType or ""
            if unit_type == "LENGTHUNIT":
                length_sym = SI_LENGTH_PREFIX.get(u.Prefix)
                evidence.append(
                    f"IfcSIUnit LENGTHUNIT .{u.Prefix or '$'}. .{u.Name}. -> '{length_sym or '?'}'"
                    if length_sym is not None
                    else f"unsupported SI LENGTHUNIT prefix {u.Prefix!r}"
                )
            elif unit_type == "AREAUNIT":
                base = "m" if u.Name == "SQUARE_METRE" else None
                if base is not None:
                    area_sym = SI_LENGTH_PREFIX.get(u.Prefix, base) + "²"
                    evidence.append(f"IfcSIUnit AREAUNIT .{u.Name}. -> '{area_sym}'")
            elif unit_type == "VOLUMEUNIT":
                base = "m" if u.Name == "CUBIC_METRE" else None
                if base is not None:
                    volume_sym = SI_LENGTH_PREFIX.get(u.Prefix, base) + "³"
                    evidence.append(f"IfcSIUnit VOLUMEUNIT .{u.Name}. -> '{volume_sym}'")
        elif getattr(u, "is_a", None) and u.is_a("IfcConversionBasedUnit"):
            if u.UnitType == "LENGTHUNIT" and length_sym is None:
                length_sym = (u.Name or "unit").lower()
                evidence.append(f"IfcConversionBasedUnit LENGTHUNIT '{u.Name}' -> '{length_sym}'")
    if length_sym is None:
        return None, "; ".join(evidence) or "no LENGTHUNIT in project unit assignment"
    # Area/volume units are optional in IFC — deriving them from the length unit
    # is mathematically exact; the derivation is recorded in the evidence.
    derived = []
    if area_sym is None:
        area_sym = length_sym + "²"
        derived.append("area")
    if volume_sym is None:
        volume_sym = length_sym + "³"
        derived.append("volume")
    if derived:
        evidence.append("derived from length unit (not explicitly assigned): " + ", ".join(derived))
    units = {"length": length_sym, "area": area_sym, "volume": volume_sym, "count": "count"}
    return units, "; ".join(evidence)


def quantity_unit(q, units):
    """Per-quantity unit: honour an attached IfcNamedUnit, else the project unit."""
    attached = getattr(q, "Unit", None)
    if attached is not None:
        if getattr(attached, "is_a", None) and attached.is_a("IfcSIUnit"):
            if attached.UnitType == "LENGTHUNIT":
                return SI_LENGTH_PREFIX.get(attached.Prefix) or units["length"]
            if attached.UnitType == "AREAUNIT" and attached.Name == "SQUARE_METRE":
                return SI_LENGTH_PREFIX.get(attached.Prefix, "m") + "²"
            if attached.UnitType == "VOLUMEUNIT" and attached.Name == "CUBIC_METRE":
                return SI_LENGTH_PREFIX.get(attached.Prefix, "m") + "³"
        if getattr(attached, "is_a", None) and attached.is_a("IfcConversionBasedUnit"):
            return (attached.Name or "unit").lower()
    return None


def declared_quantities(element):
    """All IfcElementQuantity sets of an element, 'BaseQuantities' sets first."""
    sets = []
    for rel in getattr(element, "IsDefinedBy", []) or []:
        pdef = getattr(rel, "RelatingPropertyDefinition", None)
        if pdef is not None and getattr(pdef, "is_a", None) and pdef.is_a("IfcElementQuantity"):
            sets.append(pdef)
    sets.sort(key=lambda s: (0 if s.Name == "BaseQuantities" else 1, s.id()))
    return sets


def quantity_entries(element, sets, units):
    """Map declared IFC quantities onto the DerivedQuantity contract."""
    entries = []
    skipped = []
    for qset in sets:
        for q in qset.Quantities or []:
            kind = getattr(q, "is_a", lambda *_: None)()
            mapped = None
            if kind == "IfcQuantityLength":
                mapped = ("length", float(q.LengthValue))
            elif kind == "IfcQuantityArea":
                mapped = ("area", float(q.AreaValue))
            elif kind == "IfcQuantityVolume":
                mapped = ("volume", float(q.VolumeValue))
            elif kind == "IfcQuantityCount":
                mapped = ("count", float(q.CountValue))
            if mapped is None:
                # Weight/Time/complex quantities have no slot in the contract's
                # quantityType union — skip honestly, record the name.
                skipped.append(f"{kind}:{getattr(q, 'Name', '?')}")
                continue
            qtype, value = mapped
            unit = quantity_unit(q, units) or units[qtype]
            entries.append({
                "elementRef": f"#{element.GlobalId}",
                "quantityType": qtype,
                "value": value,
                "unit": unit,
                "raw": {
                    "method": "ifc-element-quantity",
                    "quantitySetName": qset.Name,
                    "quantityName": q.Name,
                    "ifcQuantityType": kind,
                    "formula": getattr(q, "Formula", None),
                    "unitSource": "per-quantity IfcNamedUnit" if quantity_unit(q, units)
                                  else "project IfcUnitAssignment",
                },
            })
    for e in entries:
        e["raw"]["skippedUnsupportedQuantities"] = skipped
    return entries


def mesh_volume_area(verts, faces):
    """Divergence-theorem volume + triangle-sum area over a closed triangle soup."""
    vol = 0.0
    area = 0.0
    for i in range(0, len(faces), 3):
        a, b, c = faces[i], faces[i + 1], faces[i + 2]
        p0 = verts[a * 3:a * 3 + 3]
        p1 = verts[b * 3:b * 3 + 3]
        p2 = verts[c * 3:c * 3 + 3]
        ux, uy, uz = p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]
        vx, vy, vz = p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]
        cx, cy, cz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
        area += math.sqrt(cx * cx + cy * cy + cz * cz) / 2.0
        vol += (p0[0] * (p1[1] * p2[2] - p1[2] * p2[1])
                - p0[1] * (p1[0] * p2[2] - p1[2] * p2[0])
                + p0[2] * (p1[0] * p2[1] - p1[1] * p2[0])) / 6.0
    return vol, area


def geometric_fallback_entries(element, settings, units, geom):
    """Mesh-based fallback when no declared quantity was usable (real engine output)."""
    try:
        shape = geom.create_shape(settings, element)
    except Exception:
        return None  # no representation / no tessellation — nothing derivable
    verts = list(shape.geometry.verts)
    faces = list(shape.geometry.faces)
    if not faces:
        return None
    vol, area = mesh_volume_area(verts, faces)
    common = {
        "method": "mesh-triangulation",
        "ifcElementType": element.is_a(),
        "elementName": element.Name,
        "vertexCount": len(verts) // 3,
        "triangleCount": len(faces) // 3,
        "approximation": ("exact for planar faces; approximate for curved surfaces "
                          "(triangulated geometry)"),
    }
    return [
        {
            "elementRef": f"#{element.GlobalId}",
            "quantityType": "volume",
            "value": vol,
            "unit": units["volume"],
            "raw": dict(common, derivedValue="volume"),
        },
        {
            "elementRef": f"#{element.GlobalId}",
            "quantityType": "area",
            "value": area,
            "unit": units["area"],
            "raw": dict(common, derivedValue="surface area"),
        },
    ]


def main() -> None:
    if len(sys.argv) != 2:
        fail("usage: ifc_quantities.py <absolute-path-to-ifc-file> (exactly one argument required)")
    ifc_path = os.path.abspath(sys.argv[1])
    if not os.path.isfile(ifc_path):
        fail(f"file not found: {ifc_path}")

    adapter_hash = hashlib.sha256(open(os.path.abspath(__file__), "rb").read()).hexdigest()

    # Silence everything except our JSON on stdout: fd-level redirect 1 -> 2.
    saved_fd = os.dup(1)
    os.dup2(2, 1)
    error = None
    payload = None
    try:
        try:
            import ifcopenshell
        except Exception as e:
            raise RuntimeError(f"ifcopenshell is not installed in this python ({e})")
        try:
            import ifcopenshell.geom
            geom = ifcopenshell.geom
        except Exception:
            geom = None  # declared-quantity mode only; recorded honestly below

        engine_version = getattr(ifcopenshell, "version", None) or "unknown"

        try:
            f = ifcopenshell.open(ifc_path)
        except Exception as e:
            raise RuntimeError(f"ifcopenshell could not open the file: {type(e).__name__}: {e}")

        units, unit_evidence = resolve_project_units(f)
        if units is None:
            raise RuntimeError(f"could not determine IFC project units: {unit_evidence}")

        settings = geom.settings() if geom is not None else None

        quantities = []
        element_count = 0
        for element in sorted(f.by_type("IfcElement"), key=lambda e: e.id()):
            # Openings/voids are subtracted negative space, not takeoff quantities.
            if element.is_a("IfcOpeningElement"):
                continue
            element_count += 1
            entries = quantity_entries(element, declared_quantities(element), units)
            if not entries and geom is not None and getattr(element, "Representation", None):
                entries = geometric_fallback_entries(element, settings, units, geom) or []
            quantities.extend(entries)

        payload = {
            "engineKey": ENGINE_KEY,
            "engineVersion": engine_version,
            "adapterScript": ADAPTER_NAME,
            "adapterHash": adapter_hash,
            "quantities": quantities,
        }
        if geom is None:
            # honest degradation note in the only evidence channel we have:
            for q in quantities:
                q["raw"]["geometricFallback"] = "unavailable (ifcopenshell.geom not importable)"
        payload_note = {"ifcElementCount": element_count, "unitEvidence": unit_evidence}
        if quantities:
            for q in quantities:
                q["raw"]["fileUnits"] = payload_note
    except RuntimeError as e:
        error = str(e)
    except Exception as e:  # unexpected: still an honest error envelope
        error = f"unexpected adapter failure: {type(e).__name__}: {e}"
    finally:
        try:
            sys.stdout.flush()
        except Exception:
            pass
        os.dup2(saved_fd, 1)
        os.close(saved_fd)

    if error is not None:
        fail(error)
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.exit(0)


if __name__ == "__main__":
    main()
