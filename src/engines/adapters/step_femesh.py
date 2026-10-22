#!/usr/bin/env python3
"""Engineering OS — STEP/IFC FE-mesh adapter (engine: gmsh, contract §5.1).

Protocol (Phase-5 disciplines contract; differs from the argv-based quantity/
tessellation adapters only in that parameters travel on STDIN):

  stdin  (JSON): {"storagePath": "<abs path>", "kind": "step"|"ifc",
                  "parameters": {"meshSizeMin": <number>, "meshSizeMax": <number>,
                                  "elementOrder": <1>}}

  `kind` comes from the BROKER's multi-signal detection on the ARTIFACT NAME
  (the content-addressed store keeps files under an extensionless `content`
  key — src/engines/adapters/derive-kind.ts) — the adapter NEVER guesses the
  model kind from the storage path. Because gmsh dispatches its reader by
  file EXTENSION, the stored bytes are copied to a temp `.step` file (bytes
  identical, temp dir removed in finally) before `gmsh.merge`.

  stdout (exit 0): {
    "engineKey":     "gmsh",
    "engineVersion": <real gmsh.__version__>,
    "adapterScript": "step_femesh.py",
    "adapterHash":   <sha256 of THIS file's own bytes>,
    "nodes":     {"count": <all mesh nodes>},
    "elements":  {"type": "tet4", "count": <linear tetrahedra>},
    "solids": [
      {"ref": "step:solid:<i>", "name": "Solid <i+1>",
       "tetCount": <tets attributed to this solid>,
       "meshVolume": <divergence-theorem mesh volume, mm³>}, ...
    ],
    "quality": {"min": <min gmsh getElementQualities>, "mean": <mean>}
  }
  stdout (exit 1): {"error": "<honest message>"}  — never a simulated mesh.

Only REAL engine output is emitted (ADR-0005/ADR-0006). Honest refusals:
  - elementOrder != 1        → linear tets only this phase (contract §4)
  - meshSizeMin/Max invalid  → parameter defense (mirrors the broker's 422)
  - .ifc files               → gmsh 4.15.2 has NO IFC import reader (observed
                               live: gmsh falls through to the .geo parser and
                               chokes) — the capability is refused by name,
                               never faked through a misleading parse error
  - 0 solids after OCC import→ the pinned verbatim refusal (contract §5.1)
  - non-model file           → gmsh's own import error, verbatim in the envelope
  - unsupported STEP length unit → refused, never guessed

Unit honesty: the length unit is parsed from the STEP header (same regex as
step_quantities.py/step_mesh.py — duplicated so each adapter stays a
self-contained subprocess) and mesh volumes are converted to mm³ via the
pinned scale table because the stored eos-femesh/1 format pins units:"mm"
(contract §2). meshVolume is the divergence-theorem volume of the tets
attributed to that solid (sum of signed tet volumes over the conformal mesh —
interior faces cancel; mathematically EXACT for planar solids, biased low on
curved ones at linear order) — an honest mesh-derived quantity, never claimed
analytic.

Determinism (contract §5.1): fixed gmsh options only — MeshSizeMin/Max from
parameters, Mesh.Algorithm3D default, Geometry.Tolerance default, no
randomize; gmsh.initialize()/gmsh.clear() around every run and finalize()
after. The harness double-run enforces byte-identity.

Evidence: gmsh/OCC chatter (including the OCC "Unresolved Reference" STEP
reader warnings the fixtures produce) goes to fd 2 via the fd-level redirect —
recorded verbatim in the broker execution record's stderr tail.
"""

import hashlib
import json
import os
import re
import sys

ENGINE_KEY = "gmsh"
ADAPTER_NAME = "step_femesh.py"

# metres per declared STEP length unit — same honest table as step_mesh.py.
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


def read_request() -> dict:
    """Read + validate the {storagePath, kind, parameters} stdin envelope."""
    try:
        req = json.loads(sys.stdin.read())
    except Exception as e:
        raise RuntimeError(f"adapter input is not valid JSON on stdin: {e}")
    if not isinstance(req, dict) or not isinstance(req.get("storagePath"), str) or not req["storagePath"]:
        raise RuntimeError("adapter input must be {storagePath, kind, parameters} with a non-empty storagePath")
    kind = req.get("kind")
    if kind not in ("step", "ifc"):
        raise RuntimeError(f"adapter input kind must be 'step' or 'ifc' - got {json.dumps(kind)}")
    params = req.get("parameters", {})
    if not isinstance(params, dict):
        raise RuntimeError("adapter input parameters must be an object")

    def positive(key, default):
        v = params.get(key, default)
        if not isinstance(v, (int, float)) or isinstance(v, bool) or not (v > 0):
            raise RuntimeError(f"parameters.{key} must be a positive number")
        return float(v)

    smin = positive("meshSizeMin", 2.0)
    smax = positive("meshSizeMax", 4.0)
    if smin > smax:
        raise RuntimeError("parameters.meshSizeMin must be <= parameters.meshSizeMax")
    order = params.get("elementOrder", 1)
    if order != 1 or isinstance(order, bool):
        raise RuntimeError(
            "parameters.elementOrder must be 1 (linear tetrahedra) in this phase "
            f"— got {json.dumps(params.get('elementOrder'))}"
        )
    return {"storagePath": req["storagePath"], "kind": kind, "meshSizeMin": smin, "meshSizeMax": smax, "elementOrder": 1}


def main() -> None:
    adapter_hash = hashlib.sha256(open(os.path.abspath(__file__), "rb").read()).hexdigest()

    # Silence everything except our JSON on stdout: fd-level redirect 1 -> 2.
    # The redirect is ALWAYS restored before any error envelope or result is
    # printed, so the JSON protocol is the only thing that ever hits stdout.
    saved_fd = os.dup(1)
    os.dup2(2, 1)
    error = None
    payload = None
    gmsh = None
    try:
        req = read_request()
        model_path = os.path.abspath(req["storagePath"])
        if not os.path.isfile(model_path):
            raise RuntimeError(f"file not found: {model_path}")

        if req["kind"] == "ifc":
            # Observed live on gmsh 4.15.2: gmsh has NO IFC import reader (OCC
            # STEP/IGES/BRep only) - refuse by name instead of letting gmsh
            # fall through to the .geo parser and die with a misleading
            # "Unknown variable" error (contract §5.1 "honest absence, never a
            # fallback").
            raise RuntimeError(
                "gmsh cannot import IFC geometry (gmsh has no IFC import reader - "
                "OCC STEP/IGES/BRep only) - cannot generate an FE mesh, "
                "and simulated meshes are not an option"
            )

        try:
            import gmsh
        except OSError as e:
            # missing system libs (libGLU.so.1 / libOpenGL.so.0) surface HERE
            raise RuntimeError(
                f"gmsh requires system libraries (libGLU.so.1, libOpenGL.so.0) - "
                f"run scripts/setup-engine-libs.sh ({e})"
            )
        except Exception as e:
            raise RuntimeError(f"gmsh is not importable in this python ({e})")

        engine_version = getattr(gmsh, "__version__", None) or "unknown"

        gmsh.initialize()
        tmp_dir = None
        try:
            gmsh.clear()  # contract §5.1: clear before import
            gmsh.option.setNumber("General.Terminal", 1)  # OCC/gmsh chatter -> fd 2 (evidence)
            # gmsh picks its reader by file EXTENSION; the content store's
            # `content` file has none - copy the real bytes to a temp .step
            # file (deterministic: identical bytes in, identical mesh out).
            import tempfile
            import shutil
            tmp_dir = tempfile.mkdtemp(prefix="eos-femesh-")
            step_path = os.path.join(tmp_dir, "model.step")
            shutil.copyfile(model_path, step_path)
            try:
                gmsh.merge(step_path)
            except Exception as e:
                raise RuntimeError(f"gmsh could not import the file: {e}")

            volumes = gmsh.model.getEntities(3)
            if not volumes:
                raise RuntimeError(
                    "no solid geometry found in STEP file (import produced 0 solids) "
                    "- cannot generate an FE mesh, and simulated meshes are not an option"
                )

            # length unit from the file's own declaration — refused, never guessed
            try:
                with open(model_path, "r", encoding="utf-8", errors="replace") as f:
                    step_text = f.read()
            except Exception as e:
                raise RuntimeError(f"could not read STEP file for unit detection: {e}")
            unit, unit_evidence = detect_length_unit(step_text)
            if unit is None:
                raise RuntimeError(f"could not determine STEP length unit: {unit_evidence}")
            scale_m = UNIT_SCALE_M.get(unit)
            if scale_m is None:
                raise RuntimeError(
                    f"STEP length unit '{unit}' has no conversion pinned ({unit_evidence}) "
                    "- refusing to guess a scale"
                )
            vol_to_mm3 = (scale_m * 1000.0) ** 3  # native³ -> mm³ (units pin, contract §2)

            # fixed options ONLY (determinism pin, contract §5.1)
            gmsh.option.setNumber("Mesh.MeshSizeMin", req["meshSizeMin"])
            gmsh.option.setNumber("Mesh.MeshSizeMax", req["meshSizeMax"])
            gmsh.option.setNumber("Mesh.ElementOrder", req["elementOrder"])
            gmsh.model.mesh.generate(3)

            node_tags, _coords, _param = gmsh.model.mesh.getNodes()
            by_tag = {}
            for i, tag in enumerate(node_tags):
                by_tag[tag] = (_coords[3 * i], _coords[3 * i + 1], _coords[3 * i + 2])

            solids = []
            quality = []
            total_tets = 0
            for i, (_dim, vtag) in enumerate(volumes):  # gmsh returns ascending tags
                types, etags, enodes = gmsh.model.mesh.getElements(3, vtag)
                tet_count = 0
                vol_sum = 0.0
                tet_tags_all = []
                for etype, tags, nodes in zip(types, etags, enodes):
                    if etype != 4:  # 4 = 4-node tetrahedron (linear)
                        raise RuntimeError(
                            f"mesher produced element type {etype} - only tet4 (linear "
                            "tetrahedra) is supported in this phase"
                        )
                    tet_count += len(tags)
                    tet_tags_all.extend(list(tags))
                    for j in range(len(tags)):
                        a = by_tag[nodes[4 * j]]
                        b = by_tag[nodes[4 * j + 1]]
                        c = by_tag[nodes[4 * j + 2]]
                        d = by_tag[nodes[4 * j + 3]]
                        # signed tet volume = det(b-a, c-a, d-a) / 6
                        vol_sum += (
                            (b[0] - a[0]) * ((c[1] - a[1]) * (d[2] - a[2]) - (c[2] - a[2]) * (d[1] - a[1]))
                            - (b[1] - a[1]) * ((c[0] - a[0]) * (d[2] - a[2]) - (c[2] - a[2]) * (d[0] - a[0]))
                            + (b[2] - a[2]) * ((c[0] - a[0]) * (d[1] - a[1]) - (c[1] - a[1]) * (d[0] - a[0]))
                        ) / 6.0
                if tet_count == 0:
                    raise RuntimeError(
                        f"meshing of solid {i} produced 0 tetrahedra - refusing to emit an empty solid"
                    )
                if tet_tags_all:
                    quality.extend(gmsh.model.mesh.getElementQualities(tet_tags_all))
                solids.append({
                    "ref": f"step:solid:{i}",
                    "name": f"Solid {i + 1}",
                    "tetCount": tet_count,
                    "meshVolume": vol_sum * vol_to_mm3,
                })
                total_tets += tet_count

            if total_tets == 0:
                raise RuntimeError("meshing produced 0 tetrahedra - refusing to emit an empty mesh")
            if not quality:
                raise RuntimeError("gmsh reported no element qualities - refusing to emit empty quality stats")

            payload = {
                "engineKey": ENGINE_KEY,
                "engineVersion": engine_version,
                "adapterScript": ADAPTER_NAME,
                "adapterHash": adapter_hash,
                "nodes": {"count": len(node_tags)},
                "elements": {"type": "tet4", "count": total_tets},
                "solids": solids,
                "quality": {"min": min(quality), "mean": sum(quality) / len(quality)},
            }
        finally:
            if tmp_dir is not None:
                shutil.rmtree(tmp_dir, ignore_errors=True)
            try:
                gmsh.clear()
            except Exception:
                pass
            gmsh.finalize()
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
