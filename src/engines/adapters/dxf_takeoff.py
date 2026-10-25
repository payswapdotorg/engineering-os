#!/usr/bin/env python3
"""Engineering OS — DXF vector takeoff adapter (engine: ezdxf, 16-V).

Protocol (the step_femesh.py stdin/stdout house style, contract §5.1):

  stdin  (JSON): {"storagePath": "<abs path>",
                  "parameters": {"layerFilter": [<layer names; optional,
                                                 empty/absent = all layers>]}}

  The stored bytes are copied to a temp `.dxf` first (the femesh pattern).
  `layerFilter` is normalized the same way the TS bridge normalizes it
  (resolveDxfTakeoffParams): strings only, deduplicated, sorted — the
  adapter re-applies the identical normalization so a direct call can never
  bypass it.

  stdout (exit 0): {
    "engineKey":     "ezdxf",
    "engineVersion": <ezdxf.__version__>,
    "adapterScript": "dxf_takeoff.py",
    "adapterHash":   <sha256 of THIS file's own bytes>,
    "unitsMm":   true,
    "layerCount":  <int>,
    "entityCount": <int — every modelspace entity on the (filtered) layers,
                    measured types AND unmeasured "others">,
    "layers": [ <= one row per layer carrying entities, sorted by name asc:
      {"name": <>, "counts": {"lines": <>, "polylines": <>, "arcs": <>,
                              "circles": <>, "others": <>},
       "totalLengthMm": <sum over measured entities>,
       "totalClosedAreaMm2": <shoelace areas of CLOSED polylines only>}]
  }
  stdout (exit 1): {"error": "<honest message>"}  — never simulated geometry.

ENTITY SUPPORT, v1 (measured in the drawing's declared millimetres):
  LINE       — exact 3D distance between the endpoints
  LWPOLYLINE — consecutive segment lengths (plus the closing segment when
               closed); a CLOSED polyline additionally carries its shoelace
               area over the vertices. HONEST v1 LIMITATION: bulged segments
               are measured chord-wise (a bulged edge reads short by its
               arc-sagitta amount) — recorded here, never hidden.
  CIRCLE     — exact circumference 2*pi*r
  ARC        — EXACT length r*theta, theta = radians((end-start) mod 360)
               — no flattening anywhere
  everything else — counted under "others" only, no geometry, no guessing.

Honest refusals (verbatim shapes pinned in the harness corpus):
  - $INSUNITS != 4 (mm) ->
      "this drawing does not declare millimetre units ($INSUNITS=N) —
       refusing to guess a unit conversion"
  - 0 supported entities on the (filtered) layers ->
      "this drawing contains no supported entities (LINE/LWPOLYLINE/CIRCLE/ARC)"
  - corrupt DXF -> ezdxf.readfile tried first, then ezdxf.recover on
    DXFStructureError; if both fail, ezdxf's own error class + message,
    verbatim
  - unsupported DXF version -> ezdxf's own message, verbatim

Determinism (contract §5.1): pure parsing + exact closed-form geometry —
identical input bytes give identical output bytes. Layer rows are emitted
sorted by name; per-layer sums follow the (stable) modelspace iteration
order. The harness double-run enforces byte-identity.
"""

import hashlib
import json
import math
import os
import shutil
import sys
import tempfile

ENGINE_KEY = "ezdxf"
ADAPTER_NAME = "dxf_takeoff.py"

SUPPORTED = ("LINE", "LWPOLYLINE", "CIRCLE", "ARC")


def fail(msg: str) -> None:
    """Print the honest error envelope and exit non-zero. Nothing else on stdout."""
    sys.stdout.write(json.dumps({"error": msg}) + "\n")
    sys.stdout.flush()
    sys.exit(1)


def read_request() -> dict:
    """Read + validate the {storagePath, parameters} stdin envelope."""
    try:
        req = json.loads(sys.stdin.read())
    except Exception as e:
        raise RuntimeError(f"adapter input is not valid JSON on stdin: {e}")
    if not isinstance(req, dict) or not isinstance(req.get("storagePath"), str) or not req["storagePath"]:
        raise RuntimeError("adapter input must be {storagePath, parameters} with a non-empty storagePath")
    params = req.get("parameters", {})
    if not isinstance(params, dict):
        raise RuntimeError("adapter input parameters must be an object")

    # layerFilter: absent / [] / non-array-with-None -> all layers. Same
    # normalization as resolveDxfTakeoffParams on the bridge: strings only,
    # deduplicated, sorted.
    raw = params.get("layerFilter")
    if raw is None or raw == []:
        layer_filter = None
    elif isinstance(raw, list) and all(isinstance(x, str) and x for x in raw):
        layer_filter = sorted(set(raw))
    else:
        raise RuntimeError(
            "parameters.layerFilter must be an array of non-empty layer names - got "
            f"{json.dumps(params.get('layerFilter'))}"
        )
    return {"storagePath": req["storagePath"], "layerFilter": layer_filter}


def dist3(p, q) -> float:
    return math.sqrt((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2)


def shoelace(points) -> float:
    """|2*A| over a ring (implicit closure) — the planar-area house formula."""
    total = 0.0
    n = len(points)
    for i in range(n):
        x0, y0 = points[i]
        x1, y1 = points[(i + 1) % n]
        total += x0 * y1 - x1 * y0
    return abs(total) / 2.0


def polyline_measure(entity) -> tuple:
    """(length_mm, closed_area_mm2) for an LWPOLYLINE — chord-wise v1."""
    pts = [(p[0], p[1]) for p in entity.get_points("xy")]
    closed = bool(entity.closed)
    length = 0.0
    if len(pts) >= 2:
        edges = list(range(1, len(pts))) + ([0] if closed else [])
        for i_next in edges:
            a = pts[i_next - 1]
            b = pts[i_next]
            length += math.dist(a, b)
    area = shoelace(pts) if closed and len(pts) >= 3 else 0.0
    return length, area


def arc_length(entity) -> float:
    """EXACT r*theta — theta from the DXF CCW degree angles, no flattening."""
    sweep = (entity.dxf.end_angle - entity.dxf.start_angle) % 360.0
    return entity.dxf.radius * math.radians(sweep)


def main() -> None:
    adapter_hash = hashlib.sha256(open(os.path.abspath(__file__), "rb").read()).hexdigest()

    # Silence everything except our JSON on stdout: fd-level redirect 1 -> 2.
    saved_fd = os.dup(1)
    os.dup2(2, 1)
    error = None
    payload = None
    tmp_dir = None
    try:
        req = read_request()
        model_path = os.path.abspath(req["storagePath"])
        if not os.path.isfile(model_path):
            raise RuntimeError(f"file not found: {model_path}")

        try:
            import ezdxf
            from ezdxf import recover as ezdxf_recover
        except Exception as e:
            raise RuntimeError(f"ezdxf is not importable in this python ({e})")

        engine_version = getattr(ezdxf, "__version__", None) or "unknown"

        tmp_dir = tempfile.mkdtemp(prefix="eos-dxf-takeoff-")
        dxf_path = os.path.join(tmp_dir, "drawing.dxf")
        shutil.copyfile(model_path, dxf_path)

        # readfile first; recover on structural damage; ezdxf's own error
        # surfaces verbatim when both paths fail (or for version refusals).
        try:
            doc = ezdxf.readfile(dxf_path)
        except ezdxf.DXFStructureError as e:
            try:
                doc = ezdxf_recover.readfile(dxf_path)[0]
            except Exception as e2:
                raise RuntimeError(f"{type(e2).__name__}: {e2}")
        except Exception as e:
            raise RuntimeError(f"{type(e).__name__}: {e}")

        insunits = doc.header.get("$INSUNITS", 0)
        if insunits != 4:
            raise RuntimeError(
                "this drawing does not declare millimetre units "
                f"($INSUNITS={insunits}) — refusing to guess a unit conversion"
            )

        layer_filter = req["layerFilter"]
        layers: dict = {}
        entity_count = 0
        supported_count = 0
        for e in doc.modelspace():
            layer = e.dxf.layer
            if layer_filter is not None and layer not in layer_filter:
                continue
            entity_count += 1
            row = layers.setdefault(
                layer,
                {"lines": 0, "polylines": 0, "arcs": 0, "circles": 0, "others": 0,
                 "totalLengthMm": 0.0, "totalClosedAreaMm2": 0.0},
            )
            t = e.dxftype()
            if t == "LINE":
                row["lines"] += 1
                row["totalLengthMm"] += dist3(
                    (e.dxf.start.x, e.dxf.start.y, e.dxf.start.z),
                    (e.dxf.end.x, e.dxf.end.y, e.dxf.end.z),
                )
                supported_count += 1
            elif t == "LWPOLYLINE":
                row["polylines"] += 1
                length, area = polyline_measure(e)
                row["totalLengthMm"] += length
                row["totalClosedAreaMm2"] += area
                supported_count += 1
            elif t == "CIRCLE":
                row["circles"] += 1
                row["totalLengthMm"] += 2.0 * math.pi * e.dxf.radius
                supported_count += 1
            elif t == "ARC":
                row["arcs"] += 1
                row["totalLengthMm"] += arc_length(e)
                supported_count += 1
            else:
                # counted honestly, never half-measured
                row["others"] += 1

        if supported_count == 0:
            raise RuntimeError(
                "this drawing contains no supported entities (LINE/LWPOLYLINE/CIRCLE/ARC)"
            )

        payload = {
            "engineKey": ENGINE_KEY,
            "engineVersion": engine_version,
            "adapterScript": ADAPTER_NAME,
            "adapterHash": adapter_hash,
            "unitsMm": True,
            "layerCount": len(layers),
            "entityCount": entity_count,
            "layers": [
                {
                    "name": name,
                    "counts": {k: layers[name][k] for k in ("lines", "polylines", "arcs", "circles", "others")},
                    "totalLengthMm": layers[name]["totalLengthMm"],
                    "totalClosedAreaMm2": layers[name]["totalClosedAreaMm2"],
                }
                for name in sorted(layers)
            ],
        }
    except RuntimeError as e:
        error = str(e)
    except Exception as e:  # unexpected: still an honest error envelope
        error = f"unexpected adapter failure: {type(e).__name__}: {e}"
    finally:
        if tmp_dir is not None:
            shutil.rmtree(tmp_dir, ignore_errors=True)
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
