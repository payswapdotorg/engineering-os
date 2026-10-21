#!/usr/bin/env python3
"""Engineering OS — STEP quantity adapter (engine: cadquery / OCCT).

Contract (worklog.md "TL-pinned contracts", W2-b):
  argv[1]        absolute path to a .step/.stp file
  stdout (exit 0): {
    "engineKey":   "cadquery",
    "engineVersion": <real cadquery.__version__>,
    "adapterScript": "step_quantities.py",
    "adapterHash":   <sha256 of THIS file's own bytes>,
    "quantities": [
      per solid i:    {"elementRef": "step:solid:i", "quantityType": "volume",
                       "value": <OCCT Volume()>, "unit": "<u>^3", "raw": {...}},
      aggregate:      {"elementRef": "step:solids:all", "quantityType": "area",
                       "value": <sum of per-solid OCCT Area()>, "unit": "<u>^2", ...},
      model bbox:     {"elementRef": "step:model:bbox", "quantityType": "length",
                       "value": <bbox diagonal>, "unit": "<u>", ...}
    ]
  }
  stdout (exit 1): {"error": "<honest message>"}  — never a simulated value.

Only REAL values from the engine are emitted (ADR-0006): no solids in the file,
unreadable file, or missing engine → {"error"} exit 1. NOTHING else is ever
printed on stdout: fd 1 is redirected to fd 2 (stderr) for the whole engine
phase so OCCT/cadquery chatter can never contaminate the JSON protocol, and is
restored only for the final JSON dump.

Unit honesty: the length unit is parsed from the file's own declared units
(LENGTH_UNIT ... SI_UNIT(prefix,.METRE.) or CONVERSION_BASED_UNIT('...')).
If the STEP file declares no length unit, the adapter refuses with an error
instead of guessing. Unit strings use Unicode superscripts, e.g. "mm³".

Solid ordering follows the engine's enumeration of the imported compound
(documented limitation: OCCT's solid order is not semantically meaningful).
"""

import hashlib
import json
import math
import os
import re
import sys

ENGINE_KEY = "cadquery"
ADAPTER_NAME = "step_quantities.py"


def fail(msg: str) -> None:
    """Print the honest error envelope and exit non-zero. Nothing else on stdout."""
    sys.stdout.write(json.dumps({"error": msg}) + "\n")
    sys.stdout.flush()
    sys.exit(1)


def detect_length_unit(step_text: str) -> tuple:
    """Return (unit_symbol, detection_evidence) from the STEP header's units.

    STEP writes the length unit inside a parenthesised derived-unit group, e.g.
      ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );
      ( LENGTH_UNIT() NAMED_UNIT(*) CONVERSION_BASED_UNIT('INCH',#28) );
    """
    m = re.search(
        r"LENGTH_UNIT\(\)\s*NAMED_UNIT\(\*\)\s*SI_UNIT\(\s*([^,)]*)\s*,\s*\.?([A-Z_]*)\.?\s*\)",
        step_text,
    )
    if m:
        prefix = (m.group(1) or "$").strip(".")
        base = m.group(2).strip(".")
        prefixes = {"MILLI": "mm", "CENTI": "cm", "DECI": "dm", "$": "m", None: "m"}
        if base == "METRE" and prefix in prefixes:
            sym = prefixes[prefix]
            decl = f"SI_UNIT({'.' + prefix + '.' if prefix != '$' else '$'},.METRE.)"
            return sym, f"{decl} -> '{sym}'"
        return None, f"unsupported SI length unit SI_UNIT({m.group(1)}, .{base}.)"
    m = re.search(r"LENGTH_UNIT\(\)\s*NAMED_UNIT\(\*\)\s*CONVERSION_BASED_UNIT\(\s*'([^']*)'", step_text)
    if m:
        return m.group(1).lower(), f"CONVERSION_BASED_UNIT('{m.group(1)}')"
    return None, "no LENGTH_UNIT declaration found in STEP file"


def solid_properties(solids):
    """Per-solid real OCCT geometric properties via BRepGProp (cadquery API)."""
    out = []
    for s in solids:
        bb = s.BoundingBox()
        com = s.Center()
        out.append({
            "volume": float(s.Volume()),
            "area": float(s.Area()),
            "bbox": {"xLen": bb.xlen, "yLen": bb.ylen, "zLen": bb.zlen,
                     "xMin": bb.xmin, "yMin": bb.ymin, "zMin": bb.zmin,
                     "xMax": bb.xmax, "yMax": bb.ymax, "zMax": bb.zmax},
            "centerOfMass": {"x": com.x, "y": com.y, "z": com.z},
        })
    return out


def main() -> None:
    if len(sys.argv) != 2:
        fail("usage: step_quantities.py <absolute-path-to-step-file> (exactly one argument required)")
    step_path = os.path.abspath(sys.argv[1])
    if not os.path.isfile(step_path):
        fail(f"file not found: {step_path}")

    adapter_hash = hashlib.sha256(open(os.path.abspath(__file__), "rb").read()).hexdigest()

    # Silence everything except our JSON on stdout: fd-level redirect 1 -> 2.
    # The redirect is ALWAYS restored before any error envelope or result is
    # printed, so the JSON protocol is the only thing that ever hits stdout.
    saved_fd = os.dup(1)
    os.dup2(2, 1)
    error = None
    payload = None
    try:
        try:
            import cadquery as cq  # noqa: F401  (version + importers namespace)
            from cadquery import importers
        except Exception as e:  # pragma: no cover - depends on host venv
            raise RuntimeError(f"cadquery is not importable in this python ({e})")

        engine_version = getattr(cq, "__version__", None) or "unknown"

        try:
            wp = importers.importStep(step_path)
        except Exception as e:
            raise RuntimeError(f"cadquery STEP import failed: {type(e).__name__}: {e}")

        solids = wp.solids().vals()
        if not solids:
            raise RuntimeError(
                "no solid geometry found in STEP file (import produced 0 solids) "
                "- cannot derive quantities, and simulated values are not an option"
            )

        try:
            with open(step_path, "r", encoding="utf-8", errors="replace") as f:
                step_text = f.read()
        except Exception as e:
            raise RuntimeError(f"could not read STEP file for unit detection: {e}")

        unit, unit_evidence = detect_length_unit(step_text)
        if unit is None:
            raise RuntimeError(f"could not determine STEP length unit: {unit_evidence}")

        props = solid_properties(solids)

        quantities = []
        total_area = 0.0
        for i, p in enumerate(props):
            total_area += p["area"]
            quantities.append({
                "elementRef": f"step:solid:{i}",
                "quantityType": "volume",
                "value": p["volume"],
                "unit": f"{unit}³",
                "raw": {
                    "method": "occt-brep-gprop",
                    "engineKernel": "OpenCascade (OCCT) via cadquery",
                    "solidIndex": i,
                    "volume": p["volume"],
                    "area": p["area"],
                    "bbox": p["bbox"],
                    "centerOfMass": p["centerOfMass"],
                    "lengthUnit": unit,
                    "unitEvidence": unit_evidence,
                },
            })

        bb = props[0]["bbox"]
        for p in props[1:]:
            bb = {
                "xMin": min(bb["xMin"], p["bbox"]["xMin"]),
                "yMin": min(bb["yMin"], p["bbox"]["yMin"]),
                "zMin": min(bb["zMin"], p["bbox"]["zMin"]),
                "xMax": max(bb["xMax"], p["bbox"]["xMax"]),
                "yMax": max(bb["yMax"], p["bbox"]["yMax"]),
                "zMax": max(bb["zMax"], p["bbox"]["zMax"]),
            }
        # extents of the compound bounding box, then its diagonal
        x_len = bb["xMax"] - bb["xMin"]
        y_len = bb["yMax"] - bb["yMin"]
        z_len = bb["zMax"] - bb["zMin"]
        diagonal = math.sqrt(x_len**2 + y_len**2 + z_len**2)

        quantities.append({
            "elementRef": "step:solids:all",
            "quantityType": "area",
            "value": total_area,
            "unit": f"{unit}²",
            "raw": {
                "method": "sum of per-solid OCCT Area()",
                "solidCount": len(solids),
                "perSolidAreas": [p["area"] for p in props],
                "lengthUnit": unit,
                "unitEvidence": unit_evidence,
            },
        })
        quantities.append({
            "elementRef": "step:model:bbox",
            "quantityType": "length",
            "value": diagonal,
            "unit": unit,
            "raw": {
                "method": "bounding-box diagonal of all solids",
                "xLen": x_len, "yLen": y_len, "zLen": z_len,
                "diagonal": diagonal,
                "lengthUnit": unit,
                "unitEvidence": unit_evidence,
            },
        })

        payload = {
            "engineKey": ENGINE_KEY,
            "engineVersion": engine_version,
            "adapterScript": ADAPTER_NAME,
            "adapterHash": adapter_hash,
            "quantities": quantities,
        }
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
