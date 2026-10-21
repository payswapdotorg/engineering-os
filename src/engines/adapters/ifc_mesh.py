#!/usr/bin/env python3
"""Engineering OS — IFC tessellation adapter (engine: IfcOpenShell).

Contract (worklog.md "TL-pinned contracts — Phase 2", Contracts A+B, W2-d):
  argv[1]         absolute path to an .ifc file
  stdout (exit 0): {
    "engineKey":     "ifcopenshell",
    "engineVersion": <real ifcopenshell.version>,
    "adapterScript": "ifc_mesh.py",
    "adapterHash":   <sha256 of THIS file's own bytes>,
    "mesh": {                      -- eos-mesh/1 WITHOUT generatedBy (the
      "format": "eos-mesh/1",         bridge adds generatedBy when returning)
      "units": "m",
      "upAxis": "z",
      "tolerance": 0.001,         -- the engine's default mesher linear
                                     deflection, in METERS (read at runtime)
      "elements": [
        {"elementRef": "#<GlobalId>", "name": "<element Name or GlobalId>",
         "vertices": [[x, y, z], ...], "triangles": [[i, j, k], ...]}, ...
      ]
    }
  }
  stdout (exit 1): {"error": "<honest message>"}  — never a simulated mesh.

elementRef is "#<GlobalId>" — IDENTICAL to the quantity adapter's refs
(ifc_quantities.py), so mesh elements set-equal the quantity ledger's
per-element refs (the cross-reference contract pinned in Contract A).
(NOTE for TL: two prose spots say `ifc:#<GlobalId>`; the quantity ledger
ref format — which the mesh MUST equal — has no "ifc:" prefix. This
adapter follows the ledger.)

Iteration pattern: reuses the PROVEN mesh-fallback path from
ifc_quantities.py — `sorted(f.by_type("IfcElement"), key=lambda e: e.id())`
(skip IfcOpeningElement: openings are subtracted negative space, never
viewed as own elements), then `ifcopenshell.geom.create_shape(settings,
element)` per element with DEFAULT `ifcopenshell.geom.settings()` (pinned
for consistency with the quantities fallback). create_shape is chosen over
the geom iterator deliberately: it is the exact code path already
validated by the quantity harness, and it sidesteps the iterator quirk
(one get() per initialize() step).

Units honesty: ifcopenshell's geometry module returns vertex coordinates
in SI METERS regardless of the project's length unit (verified
empirically on the pinned wheel 0.9.0.post1: an mm-authored
1000×500×300 mm box tessellates to x ∈ [−0.5, 0.5], z ∈ [0, 0.3] m).
The adapter therefore applies NO unit scale — multiplying by the project
length unit would double-convert and corrupt the vertices. The project
unit assignment is not consulted at all. The cross-check that would catch
any units regression is the harness divergence-volume comparison against
closed forms authored in metres (two-elements.ifc, wall-geometry.ifc are
metre-authored; cylinder-geometry.ifc is a Ø0.4×3.0 m column).

Tolerance honesty: the payload `tolerance` is the engine's default
"mesher-linear-deflection" read from the live settings object at runtime
(0.001 m on the pinned wheel) — the deflection the geometry module
actually applied while processing in metres.

upAxis honesty: the IFC schema's geometric representation context is +Z
up; the adapter reports "z" and never rewrites it — the viewer rotates
(Contract A).

Honest failures ({"error"} exit 1): missing ifcopenshell or
ifcopenshell.geom (the mesh adapter REQUIRES the geometry module — no
declared-quantity degradation exists for a visual mesh), unreadable /
non-model file, a model in which NO element yields a triangulation
(geometry-free IFC, e.g. the stripped fixture), or an element that
tessellates to zero triangles mid-run. NOTHING else is ever printed on
stdout (fd-level redirect 1 -> 2 for the whole engine phase, restored
before printing).

Determinism: same input file + same adapter → byte-identical mesh JSON.
No timestamps, no random values; the pinned wheel's triangulation is
deterministic (proven by the harness double-run).
"""

import hashlib
import json
import os
import sys

ENGINE_KEY = "ifcopenshell"
ADAPTER_NAME = "ifc_mesh.py"


def fail(msg: str) -> None:
    """Print the honest error envelope and exit non-zero. Nothing else on stdout."""
    sys.stdout.write(json.dumps({"error": msg}) + "\n")
    sys.stdout.flush()
    sys.exit(1)


def main() -> None:
    if len(sys.argv) != 2:
        fail("usage: ifc_mesh.py <absolute-path-to-ifc-file> (exactly one argument required)")
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
        except Exception as e:
            raise RuntimeError(
                f"ifcopenshell.geom is not importable in this python ({e}) — "
                "mesh tessellation requires the geometry module (there is no "
                "declared-quantity degradation for a visual mesh)"
            )

        engine_version = getattr(ifcopenshell, "version", None) or "unknown"

        try:
            f = ifcopenshell.open(ifc_path)
        except Exception as e:
            raise RuntimeError(f"ifcopenshell could not open the file: {type(e).__name__}: {e}")

        # DEFAULT settings — the same settings object the proven mesh-fallback
        # path in ifc_quantities.py constructs (pinned for consistency).
        settings = ifcopenshell.geom.settings()
        try:
            deflection = float(settings.get("mesher-linear-deflection"))
        except Exception as e:
            raise RuntimeError(
                f"could not read the engine's default mesher linear deflection "
                f"from settings ({type(e).__name__}: {e}) — refusing to guess"
            )

        elements = []
        seen_refs = set()
        element_count = 0
        for element in sorted(f.by_type("IfcElement"), key=lambda e: e.id()):
            # Openings/voids are subtracted negative space, not viewable elements
            # (same exclusion as the quantity adapter).
            if element.is_a("IfcOpeningElement"):
                continue
            element_count += 1
            if not getattr(element, "Representation", None):
                continue
            try:
                shape = ifcopenshell.geom.create_shape(settings, element)
            except Exception:
                continue  # no tessellatable representation for this element
            verts = list(shape.geometry.verts)
            faces = list(shape.geometry.faces)
            if not verts or not faces:
                raise RuntimeError(
                    f"tessellation of element {element.GlobalId!r} produced "
                    f"{len(verts) // 3} vertices / {len(faces) // 3} triangles — "
                    "refusing to emit an empty element"
                )
            if (len(verts) % 3) != 0 or (len(faces) % 3) != 0:
                raise RuntimeError(
                    f"tessellation of element {element.GlobalId!r} returned malformed "
                    f"flat arrays (verts {len(verts)}, faces {len(faces)} — not multiples of 3)"
                )
            ref = f"#{element.GlobalId}"
            if ref in seen_refs:
                raise RuntimeError(f"duplicate elementRef {ref!r} — refusing ambiguous output")
            seen_refs.add(ref)
            # Coordinates are already SI metres (see module docstring) — NO scale.
            vertices = [
                [
                    0.0 if verts[j] == 0.0 else verts[j],
                    0.0 if verts[j + 1] == 0.0 else verts[j + 1],
                    0.0 if verts[j + 2] == 0.0 else verts[j + 2],
                ]
                for j in range(0, len(verts), 3)
            ]
            triangles = [[int(faces[j]), int(faces[j + 1]), int(faces[j + 2])]
                         for j in range(0, len(faces), 3)]
            name = element.Name if element.Name else element.GlobalId
            elements.append({
                "elementRef": ref,
                "name": name,
                "vertices": vertices,
                "triangles": triangles,
            })

        if not elements:
            raise RuntimeError(
                f"no meshable geometry found in IFC file ({element_count} element(s) "
                "examined, 0 produced a triangulation) — cannot tessellate, and "
                "simulated meshes are not an option"
            )

        payload = {
            "engineKey": ENGINE_KEY,
            "engineVersion": engine_version,
            "adapterScript": ADAPTER_NAME,
            "adapterHash": adapter_hash,
            "mesh": {
                "format": "eos-mesh/1",
                "units": "m",
                "upAxis": "z",
                "tolerance": deflection,
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
