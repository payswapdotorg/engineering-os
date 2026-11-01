#!/usr/bin/env python3
"""Engineering OS — drop-impact adapter (engine: PyBullet, contract §19.5,
Slice 33 — the physics lane, the LAST Slice-28 license-first candidate:
pybullet 3.2.7, zlib core — the Extras/ThirdPartyLibs exceptions recorded in
the registry row and never imported from here).

Protocol (the rtl_synthesize stdin style — parameters travel on stdin):
  stdin  (JSON): {"storagePath": "<abs path>", "parameters": {}}
                 (simulate_impact takes NO parameters — the mechanism and
                 the drop are frozen at upload; a non-empty parameter set
                 is refused)
  stdout (exit 0): {
    "engineKey":     "pybullet",
    "engineVersion": <pybullet distribution version>,
    "adapterScript": "impact_solve.py",
    "adapterHash":   <sha256 of THIS file's own bytes>,
    "analysis":      "impact_simulation",
    "mechanism": {"kind": "drop_impact", "massKilograms": m,
                  "radiusMeters": r, "restitution": e},
    "drop": {"centerHeightMeters": h,
             "gravityMetersPerSecondSquared": g},
    "timestepSeconds": 0.004166666666666667,
    "samples": [{"index": n, "timeSeconds": t,
                 "centerHeightMeters": z,
                 "velocityZMetersPerSecond": vz}, … every step to the
                horizon: first contact + exactly 240 steps],
    "impact": {"firstContactStep": n, "firstContactTimeSeconds": t_meas,
               "closedFormContactTimeSeconds": t*, "timeResidualSeconds": …,
               "impactSpeedMetersPerSecond": v_meas,
               "closedFormImpactSpeedMetersPerSecond": v*,
               "speedResidualMetersPerSecond": …,
               "reboundPeakHeightMeters": peak,
               "closedFormReboundPeakMeters": r + e²·(h−r),
               "reboundResidualMeters": …},
    "verification": {"maxPreContactHeightError": …,
                     "maxPreContactSpeedError": …}
  }
  stdout (exit 1): {"error": "<honest message>"}  — never a simulated result.

Honest refusals (contract §19.5):
  - invalid model JSON        → the mirrored-§19.2 defense message
  - non-empty parameters      → the frozen-upload refusal
  - pybullet absent           → the engine-unavailable class
  - pre-contact kinematics ≠ the DISCRETE semi-implicit closed form
    (z_n = h − ½g·dt²·n(n+1), vz_n = −g·dt·n) beyond 1e-9 → VERBATIM refusal
  - contact time ≠ t* = √(2(h−r)/g) beyond 2·dt (the 240 Hz quantum)
  - impact speed ≠ v* = √(2g(h−r)) beyond 3·g·dt
  - rebound peak OUTSIDE the energy envelope [r − penetration margin,
    r + e²·(h−r) + solver margin] — the contact solver is dissipative and
    may NEVER return more energy than the configured restitution allows
    (§19.1 probed live: e = 0.6 rebounds at ratio 0.419 — Bullet's LCP
    restitution under-delivers at 240 Hz; the measured peak is pinned as
    engine behavior by the harness, the chip-lane empirical-count precedent)

Live-caught engine realities this adapter honours (the §19.1 probe record,
never remembered source): pybullet's DEFAULT linearDamping is 0.04 — an
undamped free fall REQUIRES changeDynamics(linearDamping=0) or the velocity
gate fails at ~0.4%·t; the ground's DEFAULT restitution is 0.4 — BOTH bodies
carry the configured e; contacts are read as getContactPoints(bodyA)+…(bodyB)
(the pair order is engine-internal); the integrator is SEMI-IMPLICIT Euler
(velocity first) so the pre-contact position is the discrete closed form
h − ½g·dt²·n(n+1), NOT the continuous h − ½g·t² (the probe pins the
distinction: the continuous form is off by ½g·dt·t ≈ 8.8e-3 m at contact).

Determinism (§19.4): DIRECT mode, fixed timestep 1/240, pinned build, fixed
key order, shortest-round-trip float repr, no timestamps, no temp files —
the harness double-run pins byte-identity of the emitted document (same-host
same-build; the registry row records that cross-build determinism is NOT
automatic for the LCP contact solver).
"""

import hashlib
import json
import math
import os
import sys

ENGINE_KEY = "pybullet"
ADAPTER_NAME = "impact_solve.py"

MAX_MASS_KG = 1000.0
MAX_RADIUS_M = 2.0
MAX_CENTER_HEIGHT_M = 50.0
MIN_GRAVITY = 0.1
MAX_GRAVITY = 50.0
TIMESTEP_S = 1.0 / 240.0
POST_CONTACT_STEPS = 240

PRE_CONTACT_TOLERANCE = 1e-9
CONTACT_TIME_QUANTA = 2.0        # × dt (probe: residual ≈ 1.0–1.2 dt)
IMPACT_SPEED_GDT = 3.0           # × g·dt (probe: residual ≈ 0.5 g·dt)
REBOUND_ENERGY_MARGIN_M = 0.01  # above the ideal bound = energy creation → refuse
REBOUND_PENETRATION_MARGIN_M = 0.02  # below r − margin = a vanished/sunk body → refuse


def fail(msg: str) -> None:
    """Print the honest error envelope and exit non-zero. Nothing else on stdout."""
    sys.stdout.write(json.dumps({"error": msg}) + "\n")
    sys.stdout.flush()
    sys.exit(1)


def _finite_number(v) -> bool:
    return (isinstance(v, float) or isinstance(v, int)) and not isinstance(v, bool) and math.isfinite(v)


def validate_model(doc) -> dict:
    """Mirror of contract §19.2 (defense-in-depth; the route zod is the gate)."""
    if not isinstance(doc, dict):
        raise RuntimeError("impact model document must be a JSON object")
    if doc.get("format") != "eos-impact-model/1":
        raise RuntimeError(
            "impact model document format must be \"eos-impact-model/1\" "
            f"(got {json.dumps(doc.get('format'))})"
        )
    name = doc.get("name")
    if not isinstance(name, str) or not (1 <= len(name) <= 200):
        raise RuntimeError("impact model document name must be a string of 1..200 characters")
    mechanism = doc.get("mechanism")
    if not isinstance(mechanism, dict):
        raise RuntimeError("impact model mechanism must be a JSON object")
    if mechanism.get("kind") != "drop_impact":
        raise RuntimeError(
            "impact model mechanism.kind must be \"drop_impact\" "
            "(the v1 mechanism class; every other class is its own future lane) "
            f"(got {json.dumps(mechanism.get('kind'))})"
        )
    mass = mechanism.get("massKilograms")
    if not _finite_number(mass) or not (0 < mass <= MAX_MASS_KG):
        raise RuntimeError(
            f"impact model mechanism.massKilograms must be a finite number > 0 and ≤ {MAX_MASS_KG:g} (kilograms)"
        )
    radius = mechanism.get("radiusMeters")
    if not _finite_number(radius) or not (0 < radius <= MAX_RADIUS_M):
        raise RuntimeError(
            f"impact model mechanism.radiusMeters must be a finite number > 0 and ≤ {MAX_RADIUS_M:g} (meters)"
        )
    restitution = mechanism.get("restitution")
    if not _finite_number(restitution) or not (0 <= restitution <= 1):
        raise RuntimeError(
            "impact model mechanism.restitution must be a finite number ≥ 0 and ≤ 1 (the coefficient of restitution)"
        )
    drop = doc.get("drop")
    if not isinstance(drop, dict):
        raise RuntimeError("impact model drop must be a JSON object")
    height = drop.get("centerHeightMeters")
    if not _finite_number(height) or not (radius < height <= MAX_CENTER_HEIGHT_M):
        raise RuntimeError(
            f"impact model drop.centerHeightMeters must be a finite number > radius ({radius:g} m, the contact height) and ≤ {MAX_CENTER_HEIGHT_M:g} (meters)"
        )
    gravity = drop.get("gravityMetersPerSecondSquared")
    if not _finite_number(gravity) or not (MIN_GRAVITY <= gravity <= MAX_GRAVITY):
        raise RuntimeError(
            f"impact model drop.gravityMetersPerSecondSquared must be a finite number ≥ {MIN_GRAVITY:g} and ≤ {MAX_GRAVITY:g}"
        )
    return {
        "name": name,
        "kind": "drop_impact",
        "massKilograms": float(mass),
        "radiusMeters": float(radius),
        "restitution": float(restitution),
        "centerHeightMeters": float(height),
        "gravityMetersPerSecondSquared": float(gravity),
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
        raise RuntimeError("simulate_impact takes no parameters (the mechanism and the drop are frozen at upload)")
    return {"storagePath": req["storagePath"]}


def main() -> None:
    if sys.stdin.isatty():
        fail("usage: echo '{\"storagePath\": …, \"parameters\": {}}' | impact_solve.py (stdin protocol)")

    adapter_hash = hashlib.sha256(open(os.path.abspath(__file__), "rb").read()).hexdigest()

    # Silence everything except our JSON on stdout: fd-level redirect 1 -> 2
    # (pybullet may print on stdout otherwise).
    saved_fd = os.dup(1)
    os.dup2(2, 1)
    error = None
    payload = None
    try:
        try:
            import pybullet as p
        except Exception as e:
            raise RuntimeError(f"pybullet is not importable in this python ({e})")

        try:
            import importlib.metadata as importlib_metadata
        except Exception:
            import importlib_metadata  # type: ignore
        try:
            engine_version = importlib_metadata.version("pybullet")
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
            raise RuntimeError(f"impact model file is not valid JSON: {e}")
        model = validate_model(doc)

        mass = model["massKilograms"]
        radius = model["radiusMeters"]
        restitution = model["restitution"]
        height = model["centerHeightMeters"]
        gravity = model["gravityMetersPerSecondSquared"]
        dt = TIMESTEP_S

        # the closed forms (§19.1, hand-derived — INDEPENDENT of the engine)
        t_star = math.sqrt(2.0 * (height - radius) / gravity)
        v_star = math.sqrt(2.0 * gravity * (height - radius))
        peak_star = radius + restitution * restitution * (height - radius)

        # safety cap: no contact by 4× the closed-form time + 1 s is an
        # engine failure, never a slow model (h ≤ 50 m bounds t* ≤ 31.6 s
        # at g = 0.1 — the cap is reachable but honest).
        max_pre_contact_steps = int(math.ceil(4.0 * t_star / dt)) + 240

        # --- the frozen v1 world (§19.1): DIRECT mode, sphere + plane, both
        #     bodies carrying the configured e, ALL damping killed.
        cid = p.connect(p.DIRECT)
        try:
            p.resetSimulation(physicsClientId=cid)
            p.setGravity(0, 0, -gravity, physicsClientId=cid)
            p.setTimeStep(dt, physicsClientId=cid)
            sphere_shape = p.createCollisionShape(p.GEOM_SPHERE, radius=radius, physicsClientId=cid)
            sphere = p.createMultiBody(
                baseMass=mass,
                baseCollisionShapeIndex=sphere_shape,
                basePosition=[0.0, 0.0, height],
                physicsClientId=cid,
            )
            ground_shape = p.createCollisionShape(p.GEOM_PLANE, planeNormal=[0, 0, 1], physicsClientId=cid)
            ground = p.createMultiBody(baseMass=0.0, baseCollisionShapeIndex=ground_shape, physicsClientId=cid)
            p.changeDynamics(
                sphere, -1, restitution=restitution,
                linearDamping=0.0, angularDamping=0.0, physicsClientId=cid,
            )
            p.changeDynamics(
                ground, -1, restitution=restitution,
                linearDamping=0.0, angularDamping=0.0, physicsClientId=cid,
            )

            samples = []
            first_contact = None
            step_index = 0
            while True:
                step_index += 1
                p.stepSimulation(physicsClientId=cid)
                pos, _ = p.getBasePositionAndOrientation(sphere, physicsClientId=cid)
                lin, _ = p.getBaseVelocity(sphere, physicsClientId=cid)
                z = float(pos[2])
                vz = float(lin[2])
                samples.append(
                    {
                        "index": step_index,
                        "timeSeconds": step_index * dt,
                        "centerHeightMeters": z,
                        "velocityZMetersPerSecond": vz,
                    }
                )
                if first_contact is None:
                    contacts = p.getContactPoints(bodyA=sphere, physicsClientId=cid) \
                        + p.getContactPoints(bodyB=sphere, physicsClientId=cid)
                    if len(contacts) > 0:
                        first_contact = step_index
                if first_contact is not None and step_index >= first_contact + POST_CONTACT_STEPS:
                    break
                if first_contact is None and step_index >= max_pre_contact_steps:
                    raise RuntimeError(
                        "pybullet never reported ground contact within 4× the closed-form fall time - "
                        "a missing impact is not an option"
                    )
        finally:
            p.disconnect(physicsClientId=cid)

        if first_contact is None:
            raise RuntimeError(
                "pybullet never reported ground contact within 4× the closed-form fall time - "
                "a missing impact is not an option"
            )

        # --- the closed-form gates (§19.5, verbatim refusals) ---------------
        # (1) pre-contact kinematics vs the DISCRETE semi-implicit forms
        max_height_error = 0.0
        max_speed_error = 0.0
        for s in samples[: first_contact - 1]:
            n = s["index"]
            z_cf = height - 0.5 * gravity * dt * dt * n * (n + 1)
            v_cf = -gravity * dt * n
            max_height_error = max(max_height_error, abs(s["centerHeightMeters"] - z_cf))
            max_speed_error = max(max_speed_error, abs(s["velocityZMetersPerSecond"] - v_cf))
        if max_height_error > PRE_CONTACT_TOLERANCE:
            raise RuntimeError(
                f"pybullet's free-fall trajectory disagrees with the discrete "
                f"semi-implicit closed form (max height error {max_height_error:.3e} "
                f"exceeds {PRE_CONTACT_TOLERANCE:g}) - a disagreeing trajectory "
                "is not an option"
            )
        if max_speed_error > PRE_CONTACT_TOLERANCE:
            raise RuntimeError(
                f"pybullet's free-fall velocity disagrees with the discrete "
                f"closed form (max speed error {max_speed_error:.3e} "
                f"exceeds {PRE_CONTACT_TOLERANCE:g}) - a disagreeing trajectory "
                "is not an option"
            )

        # (2) contact time vs t* (the 240 Hz quantum + solver margin)
        t_meas = first_contact * dt
        time_residual = t_meas - t_star
        if abs(time_residual) > CONTACT_TIME_QUANTA * dt:
            raise RuntimeError(
                f"pybullet's first contact time {t_meas:.6f} s disagrees with the "
                f"closed form t* = sqrt(2(h-r)/g) = {t_star:.6f} s (residual "
                f"{time_residual:+.6f} s exceeds {CONTACT_TIME_QUANTA:g} steps at "
                f"240 Hz) - a disagreeing impact time is not an option"
            )

        # (3) impact speed vs v* (the speed at the last pre-contact step,
        #     where the contact solver has not yet acted)
        v_meas = abs(samples[first_contact - 2]["velocityZMetersPerSecond"])
        speed_residual = v_meas - v_star
        if abs(speed_residual) > IMPACT_SPEED_GDT * gravity * dt:
            raise RuntimeError(
                f"pybullet's impact speed {v_meas:.6f} m/s disagrees with the "
                f"closed form v* = sqrt(2g(h-r)) = {v_star:.6f} m/s (residual "
                f"{speed_residual:+.6f} m/s exceeds {IMPACT_SPEED_GDT:g}·g·dt) - "
                "a disagreeing impact speed is not an option"
            )

        # (4) the rebound ENERGY envelope: a dissipative LCP contact solver
        #     may return LESS than the ideal r + e²(h-r) (probed live, §19.1:
        #     e = 0.6 → ratio 0.419) but NEVER more — energy creation is a
        #     refusal — and never a body sunk below the contact height.
        post = samples[first_contact - 1:]
        peak = max(s["centerHeightMeters"] for s in post)
        rebound_residual = peak - peak_star
        if rebound_residual > REBOUND_ENERGY_MARGIN_M:
            raise RuntimeError(
                f"pybullet's rebound peak {peak:.6f} m exceeds the energy bound "
                f"r + e²·(h-r) = {peak_star:.6f} m by {rebound_residual:+.6f} m "
                "(the contact solver returned MORE energy than the configured "
                "restitution allows) - a fabricated rebound is not an option"
            )
        if peak < radius - REBOUND_PENETRATION_MARGIN_M:
            raise RuntimeError(
                f"pybullet's post-impact peak {peak:.6f} m sinks below the contact "
                f"height r = {radius:.6f} m by {radius - peak:.6f} m - "
                "a vanished impact is not an option"
            )

        payload = {
            "engineKey": ENGINE_KEY,
            "engineVersion": engine_version,
            "adapterScript": ADAPTER_NAME,
            "adapterHash": adapter_hash,
            "analysis": "impact_simulation",
            "mechanism": {
                "kind": model["kind"],
                "massKilograms": mass,
                "radiusMeters": radius,
                "restitution": restitution,
            },
            "drop": {
                "centerHeightMeters": height,
                "gravityMetersPerSecondSquared": gravity,
            },
            "timestepSeconds": dt,
            "samples": samples,
            "impact": {
                "firstContactStep": first_contact,
                "firstContactTimeSeconds": t_meas,
                "closedFormContactTimeSeconds": t_star,
                "timeResidualSeconds": time_residual,
                "impactSpeedMetersPerSecond": v_meas,
                "closedFormImpactSpeedMetersPerSecond": v_star,
                "speedResidualMetersPerSecond": speed_residual,
                "reboundPeakHeightMeters": peak,
                "closedFormReboundPeakMeters": peak_star,
                "reboundResidualMeters": rebound_residual,
            },
            "verification": {
                "maxPreContactHeightError": max_height_error,
                "maxPreContactSpeedError": max_speed_error,
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
