#!/usr/bin/env python3
"""Engineering OS — steady scalar-transport CFD adapter (engine: SfePy,
contract §16.5, Slice 29). The CFD lane the Slice-28 license-first probe
opened (BSD-3 verified on the sdist's own PKG-INFO + LICENSE).

Protocol (the fea_solve stdin style — parameters travel on stdin):
  stdin  (JSON): {"storagePath": "<abs path>",
                  "parameters": {"meshRefinement": <integer 1..7, default 4>}}
  stdout (exit 0): {
    "engineKey":     "sfepy",
    "engineVersion": <importlib.metadata version of the sfepy distribution>,
    "adapterScript": "transport_solve.py",
    "adapterHash":   <sha256 of THIS file's own bytes>,
    "analysis":      "scalar_transport",
    "mesh": {"elementType": "quad", "approximation": "Q2",
             "refinement": <r>, "elementCount": <N_el>, "nodeCount": <dofs>},
    "domain":   {"lengthM": …, "heightM": …},
    "diffusivityM2PerS": …, "velocityMPerS": …,
    "inletConcentration": …, "outletConcentration": …,
    "pecletNumber":      a·L/D          (the flow Péclet number),
    "meshPecletNumber":  a·h/(2D)       (the element Péclet at the actual mesh),
    "samples":  [{"x","y","concentration"}, ...] — the 5 centerline stations
                 x ∈ {L/8, L/4, L/2, 3L/4, 7L/8} at y = H/2, ascending x
    "minConcentration": <min over all dofs>, "maxConcentration": <max over all dofs>
  }
  stdout (exit 1): {"error": "<honest message>"}  — never a simulated result.

Honest refusals (contract §16.5):
  - invalid model JSON          → the mirrored-§16.2 defense message
  - mesh-Péclet > 2             → the stability refusal VERBATIM (the bound 2
                                  is the PROBED-monotone value: the §16.1
                                  probe found Q2 monotone at Pe_h = 2.0,
                                  over-shooting by 7.5e-3 already at 2.5 —
                                  checked BEFORE the solve, pure math on the
                                  mesh rule)
  - sfepy not importable        → the engine-unavailable class
  - any solver failure          → the engine's own text, verbatim

Determinism (the §16.1 probe record): gen_block_mesh at the frozen square-
element rule (N = 8·2^(r-1) divisions on the longer axis), Q2 field, direct
sparse solve — double-run array-identical; the harness pins byte-identity of
the emitted document.

API traps recorded live by the probe (never remembered): Term.new takes the
BARE term name; pb.set_solver(Newton({}, lin_solver=ScipyDirect({}))) is
required; nodal values = state().reshape(-1) aligned with field.get_coor();
evaluate_at returns shape (n, 1, 1); the velocity material is (2, 1).
"""

import hashlib
import json
import math
import os
import sys

ENGINE_KEY = "sfepy"
ADAPTER_NAME = "transport_solve.py"

# The probed-monotone element-Péclet bound (§16.1): Q2 central-Galerkin is
# monotone through 2.0, over-shoots at 2.5 — refuse above 2.
MESH_PECLET_BOUND = 2.0

# The 5 centerline sample stations (§16.4): fractions of L, ascending.
STATION_FRACTIONS = (0.125, 0.25, 0.5, 0.75, 0.875)


def fail(msg: str) -> None:
    """Print the honest error envelope and exit non-zero. Nothing else on stdout."""
    sys.stdout.write(json.dumps({"error": msg}) + "\n")
    sys.stdout.flush()
    sys.exit(1)


def is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def validate_model(doc) -> dict:
    """Mirror of contract §16.2 (defense-in-depth; the route zod is the gate)."""
    if not isinstance(doc, dict):
        raise RuntimeError("transport model document must be a JSON object")
    if doc.get("format") != "eos-cfd-transport-model/1":
        raise RuntimeError(
            "transport model document format must be \"eos-cfd-transport-model/1\" "
            f"(got {json.dumps(doc.get('format'))})"
        )
    name = doc.get("name")
    if not isinstance(name, str) or not (1 <= len(name) <= 200):
        raise RuntimeError("transport model document name must be a string of 1..200 characters")

    domain = doc.get("domain")
    if not isinstance(domain, dict):
        raise RuntimeError("transport model domain must be a JSON object")
    length = domain.get("lengthM")
    if not is_num(length) or length <= 0 or length > 10000:
        raise RuntimeError("transport model domain.lengthM must be a number > 0 and at most 10000 m")
    height = domain.get("heightM")
    if not is_num(height) or height <= 0 or height > 10000:
        raise RuntimeError("transport model domain.heightM must be a number > 0 and at most 10000 m")

    diffusivity = doc.get("diffusivityM2PerS")
    if not is_num(diffusivity) or diffusivity <= 0 or diffusivity > 10:
        raise RuntimeError("transport model diffusivityM2PerS must be a number > 0 and at most 10 m²/s")
    velocity = doc.get("velocityMPerS")
    if not is_num(velocity) or velocity <= 0 or velocity > 100:
        raise RuntimeError(
            "transport model velocityMPerS must be a number > 0 and at most 100 m/s "
            "(the v1 lane declares left-to-right advective transport)"
        )
    for key in ("inletConcentration", "outletConcentration"):
        if not is_num(doc.get(key)):
            raise RuntimeError(f"transport model {key} must be a finite number")

    return {
        "name": name,
        "lengthM": float(length),
        "heightM": float(height),
        "diffusivityM2PerS": float(diffusivity),
        "velocityMPerS": float(velocity),
        "inletConcentration": float(doc["inletConcentration"]),
        "outletConcentration": float(doc["outletConcentration"]),
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


def mesh_divisions(length_m: float, height_m: float, refinement: int) -> tuple[int, int]:
    """The frozen square-element rule (§16.3): N = 8·2^(r-1) divisions on the
    LONGER axis; the shorter axis gets max(1, round(N·shorter/longer))."""
    n_long = 8 * (2 ** (refinement - 1))
    if length_m >= height_m:
        div_x = n_long
        div_y = max(1, round(n_long * height_m / length_m))
    else:
        div_y = n_long
        div_x = max(1, round(n_long * length_m / height_m))
    return div_x, div_y


def main() -> None:
    if sys.stdin.isatty():
        fail("usage: echo '{\"storagePath\": …, \"parameters\": …}' | transport_solve.py (stdin protocol)")

    adapter_hash = hashlib.sha256(open(os.path.abspath(__file__), "rb").read()).hexdigest()

    # Silence everything except our JSON on stdout: fd-level redirect 1 -> 2
    # (sfepy's solve prints progress on stdout otherwise).
    saved_fd = os.dup(1)
    os.dup2(2, 1)
    error = None
    payload = None
    try:
        try:
            import numpy as np
            import scipy
            import sfepy
            from sfepy.discrete import (
                Equation,
                Equations,
                FieldVariable,
                Integral,
                Material,
                Problem,
            )
            from sfepy.discrete.conditions import Conditions, EssentialBC
            from sfepy.discrete.fem import FEDomain, Field
            from sfepy.mesh.mesh_generators import gen_block_mesh
            from sfepy.solvers.ls import ScipyDirect
            from sfepy.solvers.nls import Newton
            from sfepy.terms import Term
        except Exception as e:
            raise RuntimeError(f"sfepy is not importable in this python ({e})")

        try:
            import importlib.metadata as importlib_metadata
        except Exception:
            import importlib_metadata  # type: ignore
        try:
            engine_version = importlib_metadata.version("sfepy")
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
            raise RuntimeError(f"transport model file is not valid JSON: {e}")
        model = validate_model(doc)

        L = model["lengthM"]
        H = model["heightM"]
        D = model["diffusivityM2PerS"]
        a = model["velocityMPerS"]
        u_in = model["inletConcentration"]
        u_out = model["outletConcentration"]
        refinement = request["meshRefinement"]

        # --- the frozen mesh rule + the mesh-Péclet gate (BEFORE the solve) ---
        div_x, div_y = mesh_divisions(L, H, refinement)
        h_x = L / div_x  # the flow-axis element size
        mesh_peclet = a * h_x / (2.0 * D)
        peclet = a * L / D
        if mesh_peclet > MESH_PECLET_BOUND:
            raise RuntimeError(
                "the mesh does not resolve the transport boundary layer "
                f"(element Péclet {mesh_peclet:.3g} exceeds the stability bound 2) - "
                "refine the mesh (increase meshRefinement) or reduce the flow "
                "Péclet number; an oscillatory solution is not an option"
            )

        # --- deterministic block mesh + Q2 field (the probed API reality) ------
        mesh = gen_block_mesh((L, H), (div_x + 1, div_y + 1), (L / 2.0, H / 2.0), name="block")
        domain = FEDomain("d", mesh)
        omega = domain.create_region("Omega", "all")
        eps_x = 1e-9 * L
        g_in = domain.create_region("GIn", "vertices in (x < %.12f)" % eps_x, "facet")
        g_out = domain.create_region("GOut", "vertices in (x > %.12f)" % (L - eps_x), "facet")

        field = Field.from_args("fc", np.float64, 1, omega, approx_order=2)
        u = FieldVariable("u", "unknown", field)
        v = FieldVariable("v", "test", field, primary_var_name="u")

        m = Material("m", D=D, vel=np.array([[a], [0.0]]))
        integral = Integral("i", order=5)
        t_diff = Term.new("dw_laplace(m.D, v, u)", integral, omega, m=m, v=v, u=u)
        t_adv = Term.new("dw_advect_div_free(m.vel, v, u)", integral, omega, m=m, v=v, u=u)
        eq = Equation("balance", t_diff + t_adv)
        pb = Problem("transport", equations=Equations([eq]))
        pb.set_bcs(ebcs=Conditions([
            EssentialBC("uin", g_in, {"u.0": u_in}),
            EssentialBC("uout", g_out, {"u.0": u_out}),
        ]))
        pb.set_solver(Newton({}, lin_solver=ScipyDirect({})))

        # --- direct solve -------------------------------------------------------
        # save_results=False is REQUIRED (probed live): the default writes a
        # <problem-name>.vtk into the CWD — adapter side-effects on the host
        # are never acceptable (the browser-journey litter catch).
        try:
            state = pb.solve(save_results=False)
        except Exception as e:
            raise RuntimeError(f"sfepy solve failed: {type(e).__name__}: {e}")
        nodal = state().reshape(-1)
        if nodal.shape[0] == 0 or not np.all(np.isfinite(nodal)):
            raise RuntimeError(
                "the solver did not produce a finite solution - results are "
                "not available, and simulated results are not an option"
            )

        # --- the 5 centerline stations (evaluate_at returns (n, 1, 1)) ----------
        pts = np.array(
            [[f * L, H / 2.0] for f in STATION_FRACTIONS], dtype=np.float64
        )
        station_vals = u.evaluate_at(pts).reshape(-1)
        samples = [
            {"x": float(px), "y": float(py), "concentration": float(val)}
            for (px, py), val in zip(pts, station_vals)
        ]

        payload = {
            "engineKey": ENGINE_KEY,
            "engineVersion": engine_version,
            "adapterScript": ADAPTER_NAME,
            "adapterHash": adapter_hash,
            "analysis": "scalar_transport",
            "mesh": {
                "elementType": "quad",
                "approximation": "Q2",
                "refinement": refinement,
                "elementCount": int(mesh.n_el),
                "nodeCount": int(nodal.shape[0]),
            },
            "domain": {"lengthM": L, "heightM": H},
            "diffusivityM2PerS": D,
            "velocityMPerS": a,
            "inletConcentration": u_in,
            "outletConcentration": u_out,
            "pecletNumber": peclet,
            "meshPecletNumber": mesh_peclet,
            "samples": samples,
            "minConcentration": float(nodal.min()),
            "maxConcentration": float(nodal.max()),
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
