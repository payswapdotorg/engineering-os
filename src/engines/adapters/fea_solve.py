#!/usr/bin/env python3
"""Engineering OS — plane-stress FEA adapter (engine: scikit-fem, contract §14.5).

Protocol (the step_femesh stdin style — parameters travel on stdin):
  stdin  (JSON): {"storagePath": "<abs path>",
                  "parameters": {"meshRefinement": <integer 1..7, default 4>}}
  stdout (exit 0): {
    "engineKey":     "scikit-fem",
    "engineVersion": <importlib.metadata version of the scikit-fem distribution>,
    "adapterScript": "fea_solve.py",
    "adapterHash":   <sha256 of THIS file's own bytes>,
    "analysis":      "plane_stress",
    "mesh": {"elementType": "tri6", "refinement": <n>, "elementCount": <N>,
             "nodeCount": <dof point count>},
    "thicknessMm": …, "elasticModulusMpa": …, "poissonRatio": …,
    "samples":  [{"x","y","ux","uy"}, ...]  — the 4 domain corners + center,
                 ascending x then y (deterministic order)
    "maxDisplacementMagnitudeMm": <max hypot(ux,uy) over all dof points>,
    "stress":   {"sigmaXxMinMpa", "sigmaXxMaxMpa", "vonMisesMaxMpa"}
                 — per-element mean stress (P0 mass-lumped projection of
                   C·ε(u); the element mean of a linear field = its centroid
                   value), stats across elements
  }
  stdout (exit 1): {"error": "<honest message>"}  — never a simulated result.

Honest refusals (contract §14.5):
  - invalid model JSON          → the mirrored-§14.2 defense message
  - under-constrained supports  → the rigid-mode refusal naming the free
                                  mode(s) — checked as PURE MATH on the fixed
                                  DOF set before any solve (the three 2D
                                  rigid displacement fields evaluated at the
                                  fixed dofs)
  - skfem not importable        → the engine-unavailable class
  - any solver failure          → the engine's own text, verbatim

Determinism: MeshTri().refined(n).scaled((W,H)) is a fixed uniform mesh; the
plane-stress Lamé first kind is computed from (E, ν) with the closed form; a
DIRECT sparse solve (scipy spsolve) has no iteration, no randomness — the
harness double-run enforces byte-identity of the emitted document.

Unit honesty: the model declares mm/N/MPa; the emitted document carries the
declared values verbatim and every computed number is in those units.
Thickness multiplies BOTH the stiffness form and the load form
(thickness-consistent — the TL probe caught the 10x error class when only
the load carries t).
"""

import hashlib
import json
import math
import os
import sys

ENGINE_KEY = "scikit-fem"
ADAPTER_NAME = "fea_solve.py"

ID_RE = __import__("re").compile(r"^[a-z0-9-]{1,32}$")
EDGES = ("left", "right", "bottom", "top")
# Outward unit normals per edge (mm-space, x right, y up) + the CCW tangent.
OUTWARD_NORMAL = {
    "left": (-1.0, 0.0),
    "right": (1.0, 0.0),
    "bottom": (0.0, -1.0),
    "top": (0.0, 1.0),
}
# CCW traversal tangent per edge — positive shearMPa acts along this direction
# (positive shear on the right edge points DOWN, the natural tip-load reading).
CCW_TANGENT = {
    "left": (0.0, 1.0),
    "right": (0.0, -1.0),
    "bottom": (1.0, 0.0),
    "top": (-1.0, 0.0),
}


def fail(msg: str) -> None:
    """Print the honest error envelope and exit non-zero. Nothing else on stdout."""
    sys.stdout.write(json.dumps({"error": msg}) + "\n")
    sys.stdout.flush()
    sys.exit(1)


def is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def validate_model(doc) -> dict:
    """Mirror of contract §14.2 (defense-in-depth; the route zod is the gate)."""
    if not isinstance(doc, dict):
        raise RuntimeError("FEA model document must be a JSON object")
    if doc.get("format") != "eos-fea-model/1":
        raise RuntimeError(
            f"FEA model document format must be \"eos-fea-model/1\" (got {json.dumps(doc.get('format'))})"
        )
    name = doc.get("name")
    if not isinstance(name, str) or not (1 <= len(name) <= 200):
        raise RuntimeError("FEA model document name must be a string of 1..200 characters")
    if not is_num(doc.get("thicknessMm")) or doc["thicknessMm"] <= 0:
        raise RuntimeError("FEA model thicknessMm must be a number > 0")

    domain = doc.get("domain")
    if not isinstance(domain, dict):
        raise RuntimeError("FEA model domain must be a JSON object")
    if not is_num(domain.get("widthMm")) or domain["widthMm"] <= 0:
        raise RuntimeError("FEA model domain.widthMm must be a number > 0")
    if not is_num(domain.get("heightMm")) or domain["heightMm"] <= 0:
        raise RuntimeError("FEA model domain.heightMm must be a number > 0")

    material = doc.get("material")
    if not isinstance(material, dict):
        raise RuntimeError("FEA model material must be a JSON object")
    if not is_num(material.get("elasticModulusMpa")) or material["elasticModulusMpa"] <= 0:
        raise RuntimeError("FEA model material.elasticModulusMpa must be a number > 0")
    nu = material.get("poissonRatio")
    if not is_num(nu) or not (0 <= nu <= 0.49):
        raise RuntimeError("FEA model material.poissonRatio must be a finite number between 0 and 0.49")

    supports = doc.get("supports")
    if not isinstance(supports, list) or not (1 <= len(supports) <= 4):
        raise RuntimeError("FEA model must carry 1..4 supports")
    seen_support = set()
    for i, s in enumerate(supports):
        if not isinstance(s, dict):
            raise RuntimeError(f"supports[{i}] must be an object")
        edge = s.get("edge")
        if edge not in EDGES:
            raise RuntimeError(f"supports[{i}].edge must be one of: left, right, bottom, top")
        if edge in seen_support:
            raise RuntimeError(f"support edge \"{edge}\" is declared more than once")
        seen_support.add(edge)
        ux, uy = s.get("ux"), s.get("uy")
        if not isinstance(ux, bool) or not isinstance(uy, bool):
            raise RuntimeError(f"supports[{i}].ux and .uy must be booleans")
        if not ux and not uy:
            raise RuntimeError(f"support on edge \"{edge}\" fixes no degree of freedom (set ux and/or uy)")

    loads = doc.get("loads")
    if not isinstance(loads, list) or not (1 <= len(loads) <= 8):
        raise RuntimeError("FEA model must carry 1..8 loads")
    seen_load = set()
    for i, l in enumerate(loads):
        if not isinstance(l, dict):
            raise RuntimeError(f"loads[{i}] must be an object")
        edge = l.get("edge")
        if edge not in EDGES:
            raise RuntimeError(f"loads[{i}].edge must be one of: left, right, bottom, top")
        if edge in seen_load:
            raise RuntimeError(f"load edge \"{edge}\" is declared more than once")
        seen_load.add(edge)
        traction = l.get("tractionMPa", 0)
        shear = l.get("shearMPa", 0)
        for label, v in (("tractionMPa", traction), ("shearMPa", shear)):
            if not is_num(v):
                raise RuntimeError(f"loads[{i}].{label} must be a finite number")
        if traction == 0 and shear == 0:
            raise RuntimeError(
                f"load on edge \"{edge}\" has no effect (set a non-zero tractionMPa and/or shearMPa)"
            )

    return {
        "name": name,
        "thicknessMm": float(doc["thicknessMm"]),
        "widthMm": float(domain["widthMm"]),
        "heightMm": float(domain["heightMm"]),
        "elasticModulusMpa": float(material["elasticModulusMpa"]),
        "poissonRatio": float(nu),
        "supports": supports,
        "loads": loads,
    }

def read_request() -> dict:
    """Read + validate the {storagePath, parameters} stdin envelope."""
    try:
        req = json.loads(sys.stdin.read())
    except Exception as e:
        raise RuntimeError(f"adapter input is not valid JSON on stdin: {e}")
    if not isinstance(req, dict) or not isinstance(req.get("storagePath"), str):
        raise RuntimeError("adapter input must carry {storagePath: string, parameters: object}")
    params = req.get("parameters", {})
    if not isinstance(params, dict):
        raise RuntimeError("adapter parameters must be a JSON object")
    refinement = params.get("meshRefinement", 4)
    if not isinstance(refinement, int) or isinstance(refinement, bool) or not (1 <= refinement <= 7):
        raise RuntimeError("meshRefinement must be an integer between 1 and 7")
    return {"storagePath": req["storagePath"], "meshRefinement": refinement}


def main() -> None:
    if sys.stdin.isatty():
        fail("usage: echo '{\"storagePath\": …, \"parameters\": …}' | fea_solve.py (stdin protocol)")

    adapter_hash = hashlib.sha256(open(os.path.abspath(__file__), "rb").read()).hexdigest()

    # Silence everything except our JSON on stdout: fd-level redirect 1 -> 2.
    saved_fd = os.dup(1)
    os.dup2(2, 1)
    error = None
    payload = None
    try:
        try:
            import numpy as np
            import scipy
            import skfem
            from skfem import (
                Basis,
                ElementDG,
                ElementTriP0,
                ElementTriP2,
                ElementVector,
                FacetBasis,
                LinearForm,
                MeshTri,
                asm,
                condense,
                solve,
            )
            from skfem.helpers import sym_grad
            from skfem.models.elasticity import lame_parameters, linear_elasticity
        except Exception as e:
            raise RuntimeError(f"scikit-fem is not importable in this python ({e})")

        try:
            import importlib.metadata as importlib_metadata
        except Exception:
            import importlib_metadata  # type: ignore
        try:
            engine_version = importlib_metadata.version("scikit-fem")
        except Exception:
            engine_version = "unknown"

        request = read_request()
        model_path = os.path.abspath(request["storagePath"])
        if not os.path.isfile(model_path):
            raise RuntimeError(f"file not found: {model_path}")
        try:
            with open(model_path, "r", encoding="utf-8") as f:
                doc = json.loads(f.read())
        except Exception as e:
            raise RuntimeError(f"FEA model file is not valid JSON: {e}")
        model = validate_model(doc)

        W = model["widthMm"]
        H = model["heightMm"]
        t = model["thicknessMm"]
        E = model["elasticModulusMpa"]
        nu = model["poissonRatio"]
        refinement = request["meshRefinement"]

        # --- deterministic mesh + plane-stress material -------------------
        m = MeshTri().refined(refinement).scaled((W, H))
        lam3d, mu = lame_parameters(E, nu)
        lam_ps = 2.0 * mu * lam3d / (lam3d + 2.0 * mu)  # plane-stress first Lamé

        basis = Basis(m, ElementVector(ElementTriP2()), intorder=4)
        A = t * asm(linear_elasticity(Lambda=lam_ps, Mu=mu), basis)

        # --- supports: per-edge DOF sets (ALL dofs on the edge incl. midside) ---
        tol = 1e-9 * max(W, H)
        edge_facets = {
            "left": m.facets_satisfying(lambda x: x[0] < tol),
            "right": m.facets_satisfying(lambda x: x[0] > W - tol),
            "bottom": m.facets_satisfying(lambda x: x[1] < tol),
            "top": m.facets_satisfying(lambda x: x[1] > H - tol),
        }
        fixed_u1 = []  # ux dof indices
        fixed_u2 = []  # uy dof indices
        for s in model["supports"]:
            facets = edge_facets[s["edge"]]
            if len(facets) == 0:
                raise RuntimeError(f"mesh has no facets on edge \"{s['edge']}\" (degenerate domain?)")
            dofs = basis.get_dofs(facets=facets)
            if s["ux"]:
                fixed_u1.extend(dofs.all(["u^1"]).tolist())
            if s["uy"]:
                fixed_u2.extend(dofs.all(["u^2"]).tolist())
        fixed_u1 = sorted(set(fixed_u1))
        fixed_u2 = sorted(set(fixed_u2))

        # --- rigid-body constraint check (pure math, BEFORE the solve) -----
        # The three 2D rigid displacement fields: r_x=(1,0), r_y=(0,1),
        # r_rot=(-y, x). A mode survives iff it is ZERO at EVERY fixed dof.
        locs = basis.doflocs  # (2, Ndofs)
        free_modes = []
        if fixed_u1:
            pass  # r_x blocked: r_x(u1 dof) = 1 != 0
        else:
            free_modes.append("translation in x")
        if fixed_u2:
            pass  # r_y blocked
        else:
            free_modes.append("translation in y")
        rot_blocked = False
        for d in fixed_u1:
            if abs(locs[1, d]) > tol:  # r_rot(u1 dof) = -y != 0
                rot_blocked = True
                break
        if not rot_blocked:
            for d in fixed_u2:
                if abs(locs[0, d]) > tol:  # r_rot(u2 dof) = x != 0
                    rot_blocked = True
                    break
        if not rot_blocked:
            free_modes.append("rotation about z")
        if free_modes:
            raise RuntimeError(
                "the supports do not constrain the model's rigid-body motion "
                f"(free: {', '.join(free_modes)}) - an unconstrained model "
                "cannot be solved, and simulated results are not an option"
            )

        D = np.array(sorted(fixed_u1 + fixed_u2), dtype=int)

        # --- loads: uniform normal traction per edge (thickness-consistent) -
        from skfem import BilinearForm

        @BilinearForm
        def mass(u, v, w):
            return u * v

        b = np.zeros(basis.N)
        for l in model["loads"]:
            facets = edge_facets[l["edge"]]
            traction = float(l.get("tractionMPa", 0) or 0)
            shear = float(l.get("shearMPa", 0) or 0)
            nx, ny = OUTWARD_NORMAL[l["edge"]]
            tx, ty = CCW_TANGENT[l["edge"]]
            # resultant traction direction per unit edge length (MPa, mm-space)
            qx = traction * nx + shear * tx
            qy = traction * ny + shear * ty

            @LinearForm
            def traction_form(v, w, _qx=qx, _qy=qy):
                return (_qx * v[0] + _qy * v[1]) * t

            fbasis = FacetBasis(m, ElementVector(ElementTriP2()), facets=facets, intorder=4)
            b = b + asm(traction_form, fbasis)

        # --- direct solve ---------------------------------------------------
        try:
            x = solve(*condense(A, b, D=D))
        except Exception as e:
            raise RuntimeError(f"scikit-fem solve failed: {type(e).__name__}: {e}")
        if x is None or not np.all(np.isfinite(x)):
            raise RuntimeError(
                "the solver did not produce a finite solution - results are "
                "not available, and simulated results are not an option"
            )

        # --- samples: 4 corners + center, ascending x then y ----------------
        pts = sorted(
            [(0.0, 0.0), (W, 0.0), (0.0, H), (W, H), (W / 2.0, H / 2.0)],
            key=lambda p: (p[0], p[1]),
        )
        ib = basis.interpolator(x)
        samples = []
        for (px, py) in pts:
            v = ib(np.array([[px], [py]]))
            samples.append({"x": px, "y": py, "ux": float(v[0][0]), "uy": float(v[1][0])})

        # --- max displacement over all dof points ---------------------------
        ux_sol, ux_basis = basis.split(x)[0]
        uy_sol, uy_basis = basis.split(x)[1]
        max_disp = float(np.max(np.hypot(ux_sol, uy_sol)))

        # --- per-element mean stress (P0 mass-lumped projection) ------------
        u_qp = basis.interpolate(x)
        dg0 = Basis(m, ElementDG(ElementTriP0()), intorder=4)

        def _sig(w):
            eps = sym_grad(w["u"])
            e00, e01, e11 = eps[0, 0], eps[0, 1], eps[1, 1]
            tr = e00 + e11
            return 2 * mu * e00 + lam_ps * tr, 2 * mu * e11 + lam_ps * tr, 2 * mu * e01

        @LinearForm
        def f_sxx(v, w):
            return _sig(w)[0] * v

        @LinearForm
        def f_syy(v, w):
            return _sig(w)[1] * v

        @LinearForm
        def f_sxy(v, w):
            return _sig(w)[2] * v

        M = asm(mass, dg0)
        sxx = solve(M, asm(f_sxx, dg0, u=u_qp))
        syy = solve(M, asm(f_syy, dg0, u=u_qp))
        sxy = solve(M, asm(f_sxy, dg0, u=u_qp))
        von = np.sqrt(sxx ** 2 + syy ** 2 - sxx * syy + 3 * sxy ** 2)

        payload = {
            "engineKey": ENGINE_KEY,
            "engineVersion": engine_version,
            "adapterScript": ADAPTER_NAME,
            "adapterHash": adapter_hash,
            "analysis": "plane_stress",
            "mesh": {
                "elementType": "tri6",
                "refinement": refinement,
                "elementCount": int(m.t.shape[1]),
                "nodeCount": int(basis.doflocs.shape[1]),
            },
            "thicknessMm": model["thicknessMm"],
            "elasticModulusMpa": model["elasticModulusMpa"],
            "poissonRatio": model["poissonRatio"],
            "samples": samples,
            "maxDisplacementMagnitudeMm": max_disp,
            "stress": {
                "sigmaXxMinMpa": float(sxx.min()),
                "sigmaXxMaxMpa": float(sxx.max()),
                "vonMisesMaxMpa": float(von.max()),
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
