"""Parametric L-bracket MODEL DEFINITION — the committed 16-P fixture (16-R3 proven).

In the product these bytes are the CONTENT of a parametric-model artifact
revision (uploaded like any artifact; versioned; hash-pinned under
tests/fixtures/). The script is a MODULE read by the parametric-rebuild
adapter (`src/engines/adapters/parametric_rebuild.py`) — it is never executed
standalone. It declares:

  PARAM_SCHEMA          — explicit JSON-schema style object: per-key
                          {type:"number", minimum, maximum, default, unit,
                          label}, additionalProperties:false (the broker
                          mirrors it and refuses unknown keys before any
                          engine call; the adapter re-checks — never trusts
                          a client)
  DEFAULT_PARAMS        — the values the model was authored with
  analytic_volume_mm3(p) — the CLOSED-FORM ground truth (unfilleted L + one
                          through-hole, all mm):
                              V = width*depth*thickness
                                + width*thickness*(height-thickness)
                                - pi*holeDia^2/4*thickness
  build(p)              — pure function params -> cadquery Workplane

The adapter checks OCCT's built volume against that closed form and refuses
to emit a STEP when the two disagree beyond 1e-9 relative — an analytic
ground truth, not a self-computed number. That discipline caught the 16-R3
research's own first-cut modeling bug (cut cylinder on the wrong plane:
65,280 built vs 64,651.68 analytic — the refusal fired), which is exactly
why it ships.

Geometry (all mm, origin at the outer bottom front corner):
  base plate  [0,w] x [0,d] x [0,t]          (box on XY)
  vertical leg [0,w] x [d-t,d] x [t,h]       (box translated to the back)
  lifting hole  cylinder along +Y through the leg at x=w/2,
                z = t + (h-t)/2, diameter holeDia — only the leg (thickness t
                in Y) intersects it, so the removed volume is exactly
                pi*holeDia^2/4*t — the analytic term.
  holeDia = 0 authors NO hole (the cut is skipped; the analytic term is 0).
  The hole must fit inside the vertical leg's Z span with clearance to both
  faces, otherwise build() raises the pinned geometry-contradiction refusal.
"""

import math

import cadquery as cq

PARAM_SCHEMA = {
    "type": "object",
    "properties": {
        "width": {"type": "number", "minimum": 20, "maximum": 300,
                  "default": 80, "unit": "mm", "label": "Overall width (X)"},
        "depth": {"type": "number", "minimum": 20, "maximum": 200,
                  "default": 50, "unit": "mm", "label": "Base depth (Y)"},
        "thickness": {"type": "number", "minimum": 2, "maximum": 40,
                      "default": 8, "unit": "mm", "label": "Plate thickness"},
        "height": {"type": "number", "minimum": 20, "maximum": 300,
                   "default": 60, "unit": "mm", "label": "Overall height (Z)"},
        "holeDia": {"type": "number", "minimum": 0, "maximum": 60,
                    "default": 10, "unit": "mm", "label": "Lifting hole diameter"},
    },
    "required": ["width", "depth", "thickness", "height", "holeDia"],
    "additionalProperties": False,
}

DEFAULT_PARAMS = {"width": 80, "depth": 50, "thickness": 8,
                  "height": 60, "holeDia": 10}


def analytic_volume_mm3(p) -> float:
    """Closed-form volume: base + leg - one cylindrical through-hole."""
    return (p["width"] * p["depth"] * p["thickness"]
            + p["width"] * p["thickness"] * (p["height"] - p["thickness"])
            - math.pi * p["holeDia"] ** 2 / 4.0 * p["thickness"])


def build(p):
    """L-bracket: base plate (X-Y) + vertical leg at the back, hole through
    the leg. Pure parametric — no side inputs, no randomness, no clock."""
    w, d, t, h = p["width"], p["depth"], p["thickness"], p["height"]
    hd = p["holeDia"]
    hole_center_z = t + (h - t) / 2.0
    if hd > 0 and (hole_center_z - hd / 2.0 <= t or hole_center_z + hd / 2.0 >= h):
        raise ValueError("hole does not fit inside the vertical leg — raise height or shrink holeDia")
    base = cq.Workplane("XY").box(w, d, t, centered=(False, False, False))
    leg = (cq.Workplane("XY")
           .box(w, t, h - t, centered=(False, False, False))
           .translate((0, d - t, t)))
    model = base.union(leg)
    if hd > 0:
        # cylinder along +Y, through the whole depth; only the leg (Y in
        # [d-t, d], Z in [t, h]) intersects it at this z-height, so the
        # removed volume is exactly pi*hd^2/4*t — the analytic term.
        drill = cq.Solid.makeCylinder(hd / 2.0, d + 1.0,
                                      cq.Vector(w / 2.0, -0.5, hole_center_z),
                                      cq.Vector(0, 1, 0))
        model = model.cut(drill)
    return model
