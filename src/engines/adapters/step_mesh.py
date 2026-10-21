#!/usr/bin/env python3
"""Engineering OS — STEP tessellation adapter (engine: cadquery / OCCT).

Contract (worklog.md "TL-pinned contracts — Phase 2", Contracts A+B, W2-d):
  argv[1]        absolute path to a .step/.stp file
  stdout (exit 0): {
    "engineKey":     "cadquery",
    "engineVersion": <real cadquery.__version__>,
    "adapterScript": "step_mesh.py",
    "adapterHash":   <sha256 of THIS file's own bytes>,
    "mesh": {                      -- eos-mesh/1 WITHOUT generatedBy (the
      "format": "eos-mesh/1",         bridge adds generatedBy when returning)
      "units": "m",
      "upAxis": "z",
      "tolerance": 0.0001,         -- linear deflection used, in METERS
      "elements": [
        {"elementRef": "step:solid:0", "name": "Solid 1",
         "vertices": [[x, y, z], ...], "triangles": [[i, j, k], ...]}, ...
      ]
    }
  }
  stdout (exit 1): {"error": "<honest message>"}  — never a simulated mesh.

Only REAL engine output is emitted (ADR-0005/ADR-0006): no solids in the
file, unreadable file, undetectable length unit, or missing engine →
{"error"} exit 1. NOTHING else is ever printed on stdout: fd 1 is
redirected to fd 2 (stderr) for the whole engine phase so OCCT/cadquery
chatter can never contaminate the JSON protocol, and is restored only for
the final JSON dump.

Solid enumeration is EXACTLY the same code path as step_quantities.py:
`importers.importStep(path)` → `wp.solids().vals()` — so elementRef
`step:solid:<i>` indexes the SAME solid the quantity ledger calls
`step:solid:<i>` (the cross-reference contract). The tessellation itself
is `Shape.tessellate(tolerance, angularTolerance=0.1)` (cadquery → OCCT
BRepMesh_IncrementalMesh), which returns per-face node lists (NOT a welded
mesh — vertices are duplicated across shared face edges; e.g. an
axis-aligned box tessellates to 6 faces × 4 nodes = 24 vertices /
12 triangles, observed stable at native linear deflection 0.1 and 0.01 on
a 1000×500×300 box during the TL probe) and 0-based triangle tuples.

TOLERANCE PIN (native value, documented): the linear deflection is pinned
in METERS at LINEAR_DEFLECTION_M = 0.0001 m and converted to the file's
declared length unit for the tessellate() call (e.g. 0.0001 m → 0.1 in a
millimetre file, the native value observed in the TL probe). The payload
reports the pinned meter value so the stored file stays unit-honest.
Observed on the pinned venv (cadquery 2.6.1 / OCCT 7.8) at that deflection:
two-solids.step boxes → 24 verts / 12 tris each (planar, counts are
deflection-independent in the 0.1–0.01 range); cylinder-solid.step
Ø40×100 mm → 506 verts / 500 tris.

Unit honesty: the length unit is parsed from the file's own declared units
(same regex/evidence format as step_quantities.py — duplicated here so each
adapter stays a self-contained subprocess script) and vertices are converted
to METERS via an explicit scale table. A STEP file with an unsupported or
missing length unit is refused, never guessed. -0.0 coordinates are
normalised to 0.0 (mathematically identical, cosmetic only).

upAxis honesty: STEP carries no in-file up-axis declaration; the adapter
reports "z", the OCCT/STEP canonical convention under which the fixtures are
authored (extrusions in +Z). The value is never rewritten by the adapter —
the viewer rotates (Contract A).

Determinism: same input file + same adapter → byte-identical mesh JSON.
There is NO timestamp or random value anywhere in the payload; OCCT
BRepMesh and the STEP reader are deterministic for a fixed engine build
(the harness double-run enforces this).
"""

import hashlib
import json
import os
import re
import sys

ENGINE_KEY = "cadquery"
ADAPTER_NAME = "step_mesh.py"

# Pinned linear deflection in METERS (Contract B: W2 picks + documents the
# native value; observed native 0.1 for mm-authored files, i.e. 0.1 mm).
LINEAR_DEFLECTION_M = 0.0001
# cadquery's own default angular tolerance (rad) — passed through, documented.
ANGULAR_TOLERANCE_RAD = 0.1

# metres per declared STEP length unit — the honest conversion table.
UNIT_SCALE_M = {
    "mm": 0.001,
    "cm": 0.01,
    "dm": 0.1,
    "m": 1.0,
    "inch": 0.0254,
    "foot": 0.3048,
    "yard": 0.9144,
    "mile": 1609.344,
}


def fail(msg: str) -> None:
    """Print the honest error envelope and exit non-zero. Nothing else on stdout."""
    sys.stdout.write(json.dumps({"error": msg}) + "\n")
    sys.stdout.flush()
    sys.exit(1)


def detect_length_unit(step_text: str) -> tuple:
    """Return (unit_symbol, detection_evidence) — same parsing as step_quantities.py."""
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


def main() -> None:
    if len(sys.argv) != 2:
        fail("usage: step_mesh.py <absolute-path-to-step-file> (exactly one argument required)")
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

        # EXACTLY the quantity adapter's enumeration (step_quantities.py):
        # wp.solids().vals() over the imported compound, same order.
        solids = wp.solids().vals()
        if not solids:
            raise RuntimeError(
                "no solid geometry found in STEP file (import produced 0 solids) "
                "- cannot tessellate, and simulated meshes are not an option"
            )

        try:
            with open(step_path, "r", encoding="utf-8", errors="replace") as f:
                step_text = f.read()
        except Exception as e:
            raise RuntimeError(f"could not read STEP file for unit detection: {e}")

        unit, unit_evidence = detect_length_unit(step_text)
        if unit is None:
            raise RuntimeError(f"could not determine STEP length unit: {unit_evidence}")
        scale = UNIT_SCALE_M.get(unit)
        if scale is None:
            raise RuntimeError(
                f"STEP length unit '{unit}' has no metre conversion pinned "
                f"({unit_evidence}) — refusing to guess a scale"
            )

        native_tolerance = LINEAR_DEFLECTION_M / scale  # e.g. mm file: 0.0001 m -> 0.1

        elements = []
        for i, s in enumerate(solids):
            verts, tris = s.tessellate(native_tolerance, ANGULAR_TOLERANCE_RAD)
            if not verts or not tris:
                raise RuntimeError(
                    f"tessellation of solid {i} produced {len(verts)} vertices / "
                    f"{len(tris)} triangles at native linear deflection "
                    f"{native_tolerance!r} — refusing to emit an empty element"
                )
            vertices = []
            for v in verts:
                x = v.x * scale
                y = v.y * scale
                z = v.z * scale
                # normalise IEEE negative zero (mathematically identical; -0.0 in a
                # stored mesh is noise from STEP directions like (1., 0., -0.))
                vertices.append([
                    0.0 if x == 0.0 else x,
                    0.0 if y == 0.0 else y,
                    0.0 if z == 0.0 else z,
                ])
            triangles = [[int(t[0]), int(t[1]), int(t[2])] for t in tris]
            elements.append({
                "elementRef": f"step:solid:{i}",
                "name": f"Solid {i + 1}",
                "vertices": vertices,
                "triangles": triangles,
            })

        payload = {
            "engineKey": ENGINE_KEY,
            "engineVersion": engine_version,
            "adapterScript": ADAPTER_NAME,
            "adapterHash": adapter_hash,
            "mesh": {
                "format": "eos-mesh/1",
                "units": "m",
                "upAxis": "z",
                "tolerance": LINEAR_DEFLECTION_M,
                "elements": elements,
            },
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
