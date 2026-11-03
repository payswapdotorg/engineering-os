#!/usr/bin/env python3
"""Engineering OS — kinematic-analysis adapter (engine: Pinocchio, contract
§18.5, Slice 32). The robotics lane the Slice-28 license-first probe opened
(pin BSD — the wheel's bundled LICENSE is the 2-clause text; the PyPI
distribution named 'pinocchio' is an UNRELATED package — the real library
distributes as 'pin', import name 'pinocchio').

Protocol (the rtl_synthesize stdin style — parameters travel on stdin):
  stdin  (JSON): {"storagePath": "<abs path>", "parameters": {}}
                 (solve_kinematics takes NO parameters — the mechanism and
                 the configuration set are frozen at upload; a non-empty
                 parameter set is refused)
  stdout (exit 0): {
    "engineKey":     "pin",
    "engineVersion": <pin distribution version>,
    "adapterScript": "kinematics_solve.py",
    "adapterHash":   <sha256 of THIS file's own bytes>,
    "analysis":      "kinematic_analysis",
    "mechanism": {"kind": "planar_2r", "linkCount": 2,
                  "linkLengthsMeters": [L1, L2]},
    "configurations": [
      {"index": 1, "jointsRad": [q1, q2],
       "endEffector": {"xMeters": x, "yMeters": y, "thetaRad": t},
       "jacobianRowMajor": [12 numbers — the 6x2 LOCAL_WORLD_ALIGNED frame
                            Jacobian, row-major],
       "verification": {"fkMaxAbsError": e1, "jacobianMaxAbsError": e2}},
      …]
  }
  stdout (exit 1): {"error": "<honest message>"}  — never a simulated result.

Honest refusals (contract §18.5):
  - invalid model JSON          → the mirrored-§18.2 defense message
  - non-empty parameters        → the frozen-upload refusal
  - pinocchio absent            → the engine-unavailable class
  - FK ≠ closed form (> 1e-12)  → the closed-form gate VERBATIM
  - Jacobian ≠ closed form      → the closed-form gate VERBATIM

Live-caught engine realities this adapter honours (the §18.1 probe record,
never remembered source): computeFrameJacobian returns the FULL 6x2 spatial
Jacobian (rows [vx, vy, vz, wx, wy, wz] — the planar block is rows 0/1/5,
rows 2/3/4 identically zero for RZ joints); thetaRad is read as
atan2(R[1,0], R[0,0]) ∈ (-π, π] so the FK gate compares WRAPPED; the
mechanism is BUILT programmatically (JointModelRZ x2 + SE3 placements +
an OP_FRAME "ee"), never loaded from URDF.

Determinism (§18.4): pinned engine, fixed key order, shortest-round-trip
float repr, no timestamps, no temp files — the harness double-run pins
byte-identity of the emitted document.
"""

import hashlib
import json
import math
import os
import sys

ENGINE_KEY = "pin"
ADAPTER_NAME = "kinematics_solve.py"

MAX_LINK_METERS = 10.0
MAX_CONFIGURATIONS = 8
CLOSED_FORM_TOLERANCE = 1e-12


def fail(msg: str) -> None:
    """Print the honest error envelope and exit non-zero. Nothing else on stdout."""
    sys.stdout.write(json.dumps({"error": msg}) + "\n")
    sys.stdout.flush()
    sys.exit(1)


def validate_model(doc) -> dict:
    """Mirror of contract §18.2 (defense-in-depth; the route zod is the gate)."""
    if not isinstance(doc, dict):
        raise RuntimeError("robot model document must be a JSON object")
    if doc.get("format") != "eos-robot-arm-model/1":
        raise RuntimeError(
            "robot model document format must be \"eos-robot-arm-model/1\" "
            f"(got {json.dumps(doc.get('format'))})"
        )
    name = doc.get("name")
    if not isinstance(name, str) or not (1 <= len(name) <= 200):
        raise RuntimeError("robot model document name must be a string of 1..200 characters")
    mechanism = doc.get("mechanism")
    if not isinstance(mechanism, dict):
        raise RuntimeError("robot model mechanism must be a JSON object")
    if mechanism.get("kind") != "planar_2r":
        raise RuntimeError(
            "robot model mechanism.kind must be \"planar_2r\" "
            "(the v1 mechanism class; every other class is its own future lane) "
            f"(got {json.dumps(mechanism.get('kind'))})"
        )
    lengths = mechanism.get("linkLengthsMeters")
    if not isinstance(lengths, list) or len(lengths) != 2:
        raise RuntimeError("robot model mechanism.linkLengthsMeters must be an array of exactly 2 numbers")
    for i, v in enumerate(lengths):
        if not isinstance(v, float) and not isinstance(v, int) or isinstance(v, bool):
            raise RuntimeError("robot model mechanism.linkLengthsMeters must be an array of exactly 2 numbers")
        if not (math.isfinite(v) and 0 < v <= MAX_LINK_METERS):
            raise RuntimeError(
                f"robot model mechanism.linkLengthsMeters[{i}] must be a finite number > 0 and ≤ {MAX_LINK_METERS:g} (meters)"
            )
    configurations = doc.get("configurations")
    if not isinstance(configurations, list) or not (1 <= len(configurations) <= MAX_CONFIGURATIONS):
        raise RuntimeError(
            f"robot model configurations must be a JSON array of 1..{MAX_CONFIGURATIONS} items"
        )
    parsed_configs = []
    for cfg in configurations:
        if not isinstance(cfg, dict):
            raise RuntimeError("each configuration must be a JSON object")
        joints = cfg.get("jointsRad")
        if not isinstance(joints, list) or len(joints) != 2:
            raise RuntimeError("configurations.jointsRad must be an array of exactly 2 numbers")
        for i, v in enumerate(joints):
            if not isinstance(v, float) and not isinstance(v, int) or isinstance(v, bool):
                raise RuntimeError("configurations.jointsRad must be an array of exactly 2 numbers")
            if not math.isfinite(v):
                raise RuntimeError(f"configurations.jointsRad[{i}] must be a finite number (radians)")
        parsed_configs.append((float(joints[0]), float(joints[1])))
    return {
        "name": name,
        "kind": "planar_2r",
        "linkLengthsMeters": [float(lengths[0]), float(lengths[1])],
        "configurations": parsed_configs,
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
    if len(params) != 0:
        raise RuntimeError("solve_kinematics takes no parameters (the mechanism and configurations are frozen at upload)")
    return {"storagePath": req["storagePath"]}


def wrap_pi(a: float) -> float:
    """Wrap to (-π, π] — the thetaRad comparison convention (§18.1)."""
    return (a + math.pi) % (2.0 * math.pi) - math.pi


def planar_closed_form(l1: float, l2: float, q1: float, q2: float):
    """The hand-derived planar-2R closed forms (§18.1) — INDEPENDENT of the
    engine: plain libm trig, the same formulas the harness re-derives."""
    x = l1 * math.cos(q1) + l2 * math.cos(q1 + q2)
    y = l1 * math.sin(q1) + l2 * math.sin(q1 + q2)
    theta = wrap_pi(q1 + q2)
    # the 6x2 LOCAL_WORLD_ALIGNED frame Jacobian, row-major (rows vx,vy,vz,wx,wy,wz)
    jac = [0.0] * 12
    jac[0] = -l1 * math.sin(q1) - l2 * math.sin(q1 + q2)   # vx / dq1
    jac[1] = -l2 * math.sin(q1 + q2)                        # vx / dq2
    jac[2] = l1 * math.cos(q1) + l2 * math.cos(q1 + q2)     # vy / dq1
    jac[3] = l2 * math.cos(q1 + q2)                         # vy / dq2
    # rows 2..4 (vz, wx, wy) stay identically zero for RZ joints
    jac[10] = 1.0                                           # wz / dq1
    jac[11] = 1.0                                           # wz / dq2
    return x, y, theta, jac


def main() -> None:
    if sys.stdin.isatty():
        fail("usage: echo '{\"storagePath\": …, \"parameters\": {}}' | kinematics_solve.py (stdin protocol)")

    adapter_hash = hashlib.sha256(open(os.path.abspath(__file__), "rb").read()).hexdigest()

    # Silence everything except our JSON on stdout: fd-level redirect 1 -> 2
    # (pinocchio's bindings may print on stdout otherwise).
    saved_fd = os.dup(1)
    os.dup2(2, 1)
    error = None
    payload = None
    try:
        try:
            import numpy as np
            import pinocchio as pin
        except Exception as e:
            raise RuntimeError(f"pinocchio is not importable in this python ({e})")

        try:
            import importlib.metadata as importlib_metadata
        except Exception:
            import importlib_metadata  # type: ignore
        try:
            engine_version = importlib_metadata.version("pin")
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
            raise RuntimeError(f"robot model file is not valid JSON: {e}")
        model = validate_model(doc)
        l1, l2 = model["linkLengthsMeters"]

        # --- the frozen v1 mechanism, BUILT programmatically (§18.1):
        #     joint1 at the world origin, joint2 at (L1, 0, 0), the "ee"
        #     OP_FRAME at (L2, 0, 0) — never loaded from URDF.
        pmodel = pin.Model()
        j1 = pmodel.addJoint(0, pin.JointModelRZ(), pin.SE3.Identity(), "j1")
        j2 = pmodel.addJoint(
            j1, pin.JointModelRZ(), pin.SE3(np.eye(3), np.array([l1, 0.0, 0.0])), "j2"
        )
        ee_id = pmodel.addFrame(
            pin.Frame(
                "ee",
                j2,
                0,
                pin.SE3(np.eye(3), np.array([l2, 0.0, 0.0])),
                pin.FrameType.OP_FRAME,
            )
        )
        data = pmodel.createData()

        configurations = []
        for i, (q1, q2) in enumerate(model["configurations"], start=1):
            q = np.array([q1, q2])
            pin.framesForwardKinematics(pmodel, data, q)
            placement = data.oMf[ee_id]
            # the FULL 6x2 spatial frame Jacobian (the §18.1 shape trap —
            # NOT the 3x2 planar block)
            jac = pin.computeFrameJacobian(
                pmodel, data, q, ee_id, pin.ReferenceFrame.LOCAL_WORLD_ALIGNED
            )
            jac_row_major = [float(v) for v in jac.reshape(-1)]

            x_engine = float(placement.translation[0])
            y_engine = float(placement.translation[1])
            rotation = placement.rotation
            theta_engine = math.atan2(float(rotation[1, 0]), float(rotation[0, 0]))

            x_cf, y_cf, theta_cf, jac_cf = planar_closed_form(l1, l2, q1, q2)

            fk_error = max(
                abs(x_engine - x_cf),
                abs(y_engine - y_cf),
                abs(wrap_pi(theta_engine - theta_cf)),
            )
            jac_error = max(abs(a - b) for a, b in zip(jac_row_major, jac_cf))

            # --- the closed-form gates (§18.5, verbatim refusals) -----------
            if fk_error > CLOSED_FORM_TOLERANCE:
                raise RuntimeError(
                    f"pinocchio's forward kinematics disagrees with the planar "
                    f"closed form (configuration {i}: max error {fk_error:.3e} "
                    f"exceeds {CLOSED_FORM_TOLERANCE:g}) - a disagreeing "
                    "kinematics result is not an option"
                )
            if jac_error > CLOSED_FORM_TOLERANCE:
                raise RuntimeError(
                    f"pinocchio's geometric Jacobian disagrees with the planar "
                    f"closed form (configuration {i}: max error {jac_error:.3e} "
                    f"exceeds {CLOSED_FORM_TOLERANCE:g}) - a disagreeing "
                    "Jacobian is not an option"
                )

            configurations.append(
                {
                    "index": i,
                    "jointsRad": [q1, q2],
                    "endEffector": {
                        "xMeters": x_engine,
                        "yMeters": y_engine,
                        "thetaRad": theta_engine,
                    },
                    "jacobianRowMajor": jac_row_major,
                    "verification": {
                        "fkMaxAbsError": fk_error,
                        "jacobianMaxAbsError": jac_error,
                    },
                }
            )

        payload = {
            "engineKey": ENGINE_KEY,
            "engineVersion": engine_version,
            "adapterScript": ADAPTER_NAME,
            "adapterHash": adapter_hash,
            "analysis": "kinematic_analysis",
            "mechanism": {
                "kind": model["kind"],
                "linkCount": 2,
                "linkLengthsMeters": [l1, l2],
            },
            "configurations": configurations,
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
