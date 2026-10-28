#!/usr/bin/env python3
"""Engineering OS — stormwater drainage adapter (engine: pyswmm/SWMM5, contract §15.5).

Protocol (the fea_solve.py stdin style — parameters travel on stdin):
  stdin  (JSON): {"storagePath": "<abs path>",
                  "parameters": {"routingStepSec": <integer 1..60, default 10>}}
  stdout (exit 0): {
    "engineKey":     "pyswmm",
    "engineVersion": <importlib.metadata version of the pyswmm distribution>,
    "adapterScript": "swmm_run.py",
    "adapterHash":   <sha256 of THIS file's own bytes>,
    "analysis":      "drainage",
    "rain":   {"intensityMMperHr", "durationMin", "totalDepthMm", "totalVolumeM3"},
    "routing": {"model": "kinematic_wave", "routingStepSec": <n>},
    "continuity": {"runoffErrorPct", "routingErrorPct"} — parsed from the
                   engine's own .rpt honesty blocks,
    "outfallVolumeM3":  <trapezoid-integrated outfall inflow over the run>,
    "volumeBalancePct": <100*(outfall - rain)/rain — our honesty metric>,
    "peaks":  {"maxRunoffCms", "maxConduitFlowCms"},
    "depths": [{"id", "maxDepthM"}, ...] — every node + conduit, ascending id
              (the Manning normal-depth pin rides here)
  }
  stdout (exit 1): {"error": "<honest message>"} — never a simulated result.

Honest refusals (contract §15.5):
  - invalid model JSON          → the mirrored-§15.2 defense message
  - a network with no outfall   → the §15.2 refusal (pure graph check BEFORE
                                  the engine opens — the rigid-mode analog)
  - dangling node references    → refused before the engine opens
  - an unresolvable/conflicting invert derivation → refused with the node and
                                  both values named (pure math, no engine call)
  - a zero-intensity storm      → refused (produces no runoff)
  - pyswmm not importable       → the engine-unavailable class
  - any engine failure          → the engine's own text, verbatim

Determinism: the INP text is generated from the model with FIXED constants
(start date 06/01/2026, SI/CMS, KINWAVE, 60 s wet step, the request's routing
step, 5-minute gage cadence); the SWMM5 engine has no RNG; the trapezoid
accumulation and peak tracking run in doubles — the harness double-run enforces
byte-identity of the emitted document.

INP-generation truths (§15.1, live-caught):
  - an INTENSITY rain gage consumes its TIMESERIES PER RECORDING INTERVAL — a
    two-entry series rains for exactly one 5-minute slot (observed: rel volume
    error 0.96). The adapter spreads the uniform event as per-interval entries
    at the fixed 5-minute cadence.
  - [SUBAREA] requires 7 tokens (RouteTo) in swmm 5.2.4 via swmm-toolkit
    0.17.0 — the 6-token form dies with ERROR 203.

Unit honesty: the model declares SI (mm/hr, ha, m, %); flows are read in CMS
(m³/s) from the engine; the emitted document carries every computed number in
those units. Conduit inverts are DERIVED from slopePct backward from the
outfall datum (§15.5): to + length*slope = from; junction.invertElevM is used
verbatim only when no conduit derives it (an isolated flooding node).
"""

import hashlib
import json
import math
import os
import re
import shutil
import sys
import tempfile

ENGINE_KEY = "pyswmm"
ADAPTER_NAME = "swmm_run.py"

ID_RE = re.compile(r"^[A-Za-z0-9_.-]{1,32}$")
# Fixed canonical run window — deterministic by construction.
START_DATE = "06/01/2026"
START_TIME = "00:00:00"


def fail(msg: str) -> None:
    """Print the honest error envelope and exit non-zero. Nothing else on stdout."""
    sys.stdout.write(json.dumps({"error": msg}) + "\n")
    sys.stdout.flush()
    sys.exit(1)


def is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _check_id(v, label: str) -> str:
    if not isinstance(v, str) or not ID_RE.match(v):
        raise RuntimeError(
            f"{label} must be 1..32 characters (letters, digits, dot, underscore, dash)"
        )
    return v


def validate_model(doc) -> dict:
    """Mirror of contract §15.2 (defense-in-depth; the route zod is the gate)."""
    if not isinstance(doc, dict):
        raise RuntimeError("SWMM model document must be a JSON object")
    if doc.get("format") != "eos-swmm-model/1":
        raise RuntimeError(
            f"SWMM model document format must be \"eos-swmm-model/1\" (got {json.dumps(doc.get('format'))})"
        )
    name = doc.get("name")
    if not isinstance(name, str) or not (1 <= len(name) <= 200):
        raise RuntimeError("SWMM model document name must be a string of 1..200 characters")

    simulation = doc.get("simulation")
    if not isinstance(simulation, dict):
        raise RuntimeError("SWMM model simulation must be a JSON object")
    duration = simulation.get("durationMin")
    if not isinstance(duration, int) or isinstance(duration, bool) or not (1 <= duration <= 1440):
        raise RuntimeError("simulation.durationMin must be an integer between 1 and 1440 minutes")

    rainfall = doc.get("rainfall")
    if not isinstance(rainfall, dict):
        raise RuntimeError("SWMM model rainfall must be a JSON object")
    intensity = rainfall.get("intensityMMperHr")
    if not is_num(intensity) or intensity <= 0:
        raise RuntimeError("rainfall.intensityMMperHr must be a number > 0 (a zero-intensity storm produces no runoff)")
    rain_duration = rainfall.get("durationMin")
    if (
        not isinstance(rain_duration, int)
        or isinstance(rain_duration, bool)
        or not (5 <= rain_duration <= 720)
    ):
        raise RuntimeError("rainfall.durationMin must be an integer between 5 and 720 minutes")
    if rain_duration % 5 != 0:
        raise RuntimeError("rainfall.durationMin must be a multiple of 5 (the gage cadence)")
    if duration <= rain_duration:
        raise RuntimeError(
            "simulation.durationMin must exceed rainfall.durationMin (the network needs post-rain drainage time to reach a volume balance)"
        )

    subcatchments = doc.get("subcatchments")
    if not isinstance(subcatchments, list) or not (1 <= len(subcatchments) <= 50):
        raise RuntimeError("SWMM model must carry 1..50 subcatchments")
    seen_sub = set()
    for i, s in enumerate(subcatchments):
        if not isinstance(s, dict):
            raise RuntimeError(f"subcatchments[{i}] must be an object")
        sid = _check_id(s.get("id"), f"subcatchments[{i}].id")
        if sid in seen_sub:
            raise RuntimeError(f"subcatchment id \"{sid}\" is declared more than once")
        seen_sub.add(sid)
        outlet = _check_id(s.get("outletNodeId"), f"subcatchments[{i}].outletNodeId")
        for field, lo, hi in (
            ("areaHA", 0.0001, 1000.0),
            ("widthM", 0.1, 10000.0),
            ("slopePct", 0.01, 100.0),
            ("manningNImperv", 0.001, 1.0),
        ):
            v = s.get(field)
            if not is_num(v) or not (lo <= v <= hi):
                raise RuntimeError(f"subcatchments[{i}].{field} must be a number between {lo} and {hi}")
        dstore = s.get("depressionStorageMM")
        if not is_num(dstore) or not (0 <= dstore <= 500):
            raise RuntimeError(f"subcatchments[{i}].depressionStorageMM must be a number between 0 and 500 mm")

    nodes = doc.get("nodes")
    if not isinstance(nodes, list) or not (1 <= len(nodes) <= 200):
        raise RuntimeError("SWMM model must carry 1..200 nodes")
    node_ids = set()
    has_outfall = False
    for i, n in enumerate(nodes):
        if not isinstance(n, dict):
            raise RuntimeError(f"nodes[{i}] must be an object")
        kind = n.get("kind")
        if kind not in ("junction", "outfall"):
            raise RuntimeError(f"nodes[{i}].kind must be \"junction\" or \"outfall\"")
        nid = _check_id(n.get("id"), f"nodes[{i}].id")
        if nid in node_ids:
            raise RuntimeError(f"node id \"{nid}\" is declared more than once")
        node_ids.add(nid)
        if not is_num(n.get("invertElevM")):
            raise RuntimeError(f"nodes[{i}].invertElevM must be a finite number")
        if kind == "outfall":
            has_outfall = True
        elif kind == "junction":
            max_depth = n.get("maxDepthM")
            if not is_num(max_depth) or max_depth <= 0:
                raise RuntimeError(f"nodes[{i}].maxDepthM must be a number > 0")
    if not has_outfall:
        raise RuntimeError(
            "the network has no outfall - runoff cannot leave the model, and simulated results are not an option"
        )

    conduits = doc.get("conduits")
    if not isinstance(conduits, list) or len(conduits) > 250:
        raise RuntimeError("SWMM model must carry at most 250 conduits")
    seen_conduit = set()
    for i, c in enumerate(conduits):
        if not isinstance(c, dict):
            raise RuntimeError(f"conduits[{i}] must be an object")
        cid = _check_id(c.get("id"), f"conduits[{i}].id")
        if cid in seen_conduit:
            raise RuntimeError(f"conduit id \"{cid}\" is declared more than once")
        seen_conduit.add(cid)
        for field in ("fromNodeId", "toNodeId"):
            ref = _check_id(c.get(field), f"conduits[{i}].{field}")
            if ref not in node_ids:
                raise RuntimeError(f"conduit \"{cid}\" references unknown {field.replace('NodeId', ' node ')}\"{ref}\"")
        for field, lo, hi in (
            ("lengthM", 0.01, 100000.0),
            ("manningN", 0.001, 1.0),
            ("slopePct", 0.0001, 100.0),
            ("heightM", 0.01, 20.0),
            ("widthM", 0.01, 50.0),
        ):
            v = c.get(field)
            if not is_num(v) or not (lo <= v <= hi):
                raise RuntimeError(f"conduits[{i}].{field} must be a number between {lo} and {hi}")

    for i, s in enumerate(subcatchments):
        if s["outletNodeId"] not in node_ids:
            raise RuntimeError(
                f"subcatchment \"{s['id']}\" outlets into unknown node \"{s['outletNodeId']}\""
            )

    return {
        "name": name,
        "durationMin": duration,
        "intensity": float(intensity),
        "rainDurationMin": rain_duration,
        "subcatchments": subcatchments,
        "nodes": nodes,
        "conduits": conduits,
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
    routing_step = params.get("routingStepSec", 10)
    if not isinstance(routing_step, int) or isinstance(routing_step, bool) or not (1 <= routing_step <= 60):
        raise RuntimeError("routingStepSec must be an integer between 1 and 60")
    return {"storagePath": req["storagePath"], "routingStepSec": routing_step}


def derive_inverts(model: dict) -> dict:
    """Conduit upstream inverts derive BACKWARD from the outfall datum (§15.5).

    Outfalls keep their model invert; each conduit demands
    from = to + length * slope. A junction reachable by two paths with
    conflicting derived inverts, or a conduit headwater that never drains to
    an outfall, is refused honestly — pure math, before the engine opens.
    """
    nodes = model["nodes"]
    known = {}
    for n in nodes:
        if n["kind"] == "outfall":
            known[n["id"]] = float(n["invertElevM"])
    conduits = model["conduits"]
    pending = list(range(len(conduits)))
    for _ in range(len(conduits) + 1):
        if not pending:
            break
        progressed = False
        still = []
        for idx in pending:
            c = conduits[idx]
            if c["toNodeId"] in known:
                candidate = known[c["toNodeId"]] + c["lengthM"] * c["slopePct"] / 100.0
                if c["fromNodeId"] in known:
                    if abs(candidate - known[c["fromNodeId"]]) > 1e-9:
                        raise RuntimeError(
                            f"conduit slopes derive conflicting inverts for node \"{c['fromNodeId']}\" "
                            f"({candidate:.6g} m vs {known[c['fromNodeId']]:.6g} m) - the network geometry is inconsistent"
                        )
                else:
                    known[c["fromNodeId"]] = candidate
                    progressed = True
            else:
                still.append(idx)
        if not progressed:
            break
        pending = still
    unresolved = sorted(
        {conduits[i]["fromNodeId"] for i in pending if conduits[i]["fromNodeId"] not in known}
    )
    if unresolved:
        raise RuntimeError(
            "the network does not drain to an outfall (unresolved upstream nodes: "
            + ", ".join(f"\"{n}\"" for n in unresolved)
            + ") - runoff cannot leave the model, and simulated results are not an option"
        )
    # Isolated junctions (no conduit derives them) keep their model invert.
    inverts = {}
    for n in nodes:
        inverts[n["id"]] = known.get(n["id"], float(n["invertElevM"]))
    return inverts


def _fmt_step(seconds: int) -> str:
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


def _fmt_minutes(total_min: int) -> str:
    d, rem = divmod(total_min, 1440)
    day = 1 + d  # fixed start 06/01/2026
    h, m = divmod(rem, 60)
    return f"06/{day:02d}/2026 {h:02d}:{m:02d}"


def build_inp(model: dict, inverts: dict, routing_step_sec: int) -> str:
    """Deterministic canonical INP text (§15.5; the two §15.1 truths baked in)."""
    duration = model["durationMin"]
    rain_duration = model["rainDurationMin"]
    intensity = model["intensity"]

    lines = []
    lines.append("[TITLE]")
    # Whitespace-collapse + cap: the title is one INP line — a newline in a
    # model name would corrupt the file structure.
    safe_title = re.sub(r"\s+", " ", model["name"]).strip()[:120]
    lines.append(f"EOS swmm_run.py canonical model: {safe_title}")
    lines.append("")
    lines.append("[OPTIONS]")
    lines.append("FLOW_UNITS           CMS")
    lines.append("INFILTRATION         HORTON")
    lines.append("FLOW_ROUTING         KINWAVE")
    lines.append("LINK_OFFSETS         DEPTH")
    lines.append("MIN_SLOPE            0.0")
    lines.append("ALLOW_PONDING        NO")
    lines.append("SKIP_STEADY_STATE   NO")
    lines.append(f"START_DATE           {START_DATE}")
    lines.append(f"START_TIME           {START_TIME}")
    lines.append(f"END_DATE             {_fmt_minutes(duration).split(' ')[0]}")
    lines.append(f"END_TIME             {_fmt_minutes(duration).split(' ')[1]}:00")
    lines.append("SWEEP_START          01/01")
    lines.append("SWEEP_END            12/31")
    lines.append("DRY_DAYS             0")
    lines.append("REPORT_STEP          00:05:00")
    lines.append("WET_STEP             00:01:00")
    lines.append("DRY_STEP             00:05:00")
    lines.append(f"ROUTING_STEP         {_fmt_step(routing_step_sec)}")
    lines.append("RULE_STEP            00:00:00")
    lines.append("")
    lines.append("[EVAPORATION]")
    lines.append("CONSTANT   0.0")
    lines.append("DRY_ONLY   NO")
    lines.append("")
    lines.append("[RAINGAGES]")
    lines.append("RG1  INTENSITY  0:05  1.0  TIMESERIES  storm")
    lines.append("")
    lines.append("[TIMESERIES]")
    # §15.1 truth 1: per-recording-interval entries at the fixed 5-minute cadence.
    t = 0
    while t < rain_duration:
        lines.append(f"storm  {_fmt_minutes(t)}  {intensity!r}")
        t += 5
    lines.append(f"storm  {_fmt_minutes(rain_duration)}  0.0")
    lines.append("")
    lines.append("[SUBCATCHMENTS]")
    for s in model["subcatchments"]:
        # Name Gage Outlet Area(ha) %Imperv Width(m) %Slope CurbLen — %Imperv
        # is pinned to 100 by the §15.6/§15.7 impervious-scope exclusion.
        lines.append(
            f"{s['id']}  RG1  {s['outletNodeId']}  {s['areaHA']!r}  100.0  "
            f"{s['widthM']!r}  {s['slopePct']!r}  0"
        )
    lines.append("")
    lines.append("[SUBAREA]")
    for s in model["subcatchments"]:
        # §15.1 truth 2: 7 tokens (RouteTo) — the 6-token form dies ERROR 203.
        lines.append(
            f"{s['id']}  {s['manningNImperv']!r}  0.15  {s['depressionStorageMM']!r}  5.0  0  OUTLET"
        )
    lines.append("")
    lines.append("[INFILTRATION]")
    for s in model["subcatchments"]:
        # Never applied at 100 % impervious — constants only satisfy the parser.
        lines.append(f"{s['id']}  25.0  5.0  4.0  7.0  0.5")
    lines.append("")
    lines.append("[JUNCTIONS]")
    for n in model["nodes"]:
        if n["kind"] == "junction":
            lines.append(f"{n['id']}  {inverts[n['id']]!r}  {n['maxDepthM']!r}  0.0  0.0  0")
    lines.append("")
    lines.append("[OUTFALLS]")
    for n in model["nodes"]:
        if n["kind"] == "outfall":
            lines.append(f"{n['id']}  {inverts[n['id']]!r}  FREE  NO")
    lines.append("")
    lines.append("[CONDUITS]")
    for c in model["conduits"]:
        lines.append(
            f"{c['id']}  {c['fromNodeId']}  {c['toNodeId']}  {c['lengthM']!r}  "
            f"{c['manningN']!r}  0.0  0.0  0.0  0"
        )
    lines.append("")
    lines.append("[XSECTIONS]")
    for c in model["conduits"]:
        # RECT_CLOSED: Geom1 = full height, Geom2 = base width.
        lines.append(f"{c['id']}  RECT_CLOSED  {c['heightM']!r}  {c['widthM']!r}  0  1")
    lines.append("")
    lines.append("[REPORT]")
    lines.append("INPUT      NO")
    lines.append("CONTINUITY YES")
    lines.append("FLOWSTATS  YES")
    lines.append("SUBCATCHMENTS ALL")
    lines.append("NODES      ALL")
    lines.append("LINKS      ALL")
    lines.append("")
    return "\n".join(lines) + "\n"


CONTINUITY_RE = {
    "runoff": re.compile(
        r"Runoff Quantity Continuity.*?Continuity Error \(%\)\s*\.+\s*([-\d.]+)", re.S
    ),
    "routing": re.compile(
        r"Flow Routing Continuity.*?Continuity Error \(%\)\s*\.+\s*([-\d.]+)", re.S
    ),
}


def parse_continuity(rpt_text: str) -> dict:
    """Parse the engine's own continuity honesty blocks from the .rpt text."""
    runoff = CONTINUITY_RE["runoff"].search(rpt_text)
    routing = CONTINUITY_RE["routing"].search(rpt_text)
    if runoff is None or routing is None:
        raise RuntimeError("could not parse the SWMM engine's continuity report (the .rpt honesty blocks are missing)")
    return {"runoffErrorPct": float(runoff.group(1)), "routingErrorPct": float(routing.group(1))}


def main() -> None:
    if sys.stdin.isatty():
        fail("usage: echo '{\"storagePath\": …, \"parameters\": …}' | swmm_run.py (stdin protocol)")

    adapter_hash = hashlib.sha256(open(os.path.abspath(__file__), "rb").read()).hexdigest()

    # Silence everything except our JSON on stdout: fd-level redirect 1 -> 2.
    saved_fd = os.dup(1)
    os.dup2(2, 1)
    error = None
    payload = None
    try:
        try:
            import pyswmm
        except Exception as e:
            raise RuntimeError(f"pyswmm is not importable in this python ({e})")

        try:
            import importlib.metadata as importlib_metadata
        except Exception:
            import importlib_metadata  # type: ignore
        try:
            engine_version = importlib_metadata.version("pyswmm")
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
            raise RuntimeError(f"SWMM model file is not valid JSON: {e}")
        model = validate_model(doc)
        routing_step_sec = request["routingStepSec"]

        # Pure-math graph checks BEFORE the engine opens (§15.5).
        inverts = derive_inverts(model)
        inp_text = build_inp(model, inverts, routing_step_sec)

        total_area_m2 = sum(s["areaHA"] * 10000.0 for s in model["subcatchments"])
        total_depth_mm = model["intensity"] * model["rainDurationMin"] / 60.0
        rain_volume_m3 = total_depth_mm / 1000.0 * total_area_m2

        workdir = tempfile.mkdtemp(prefix="eos-swmm-")
        try:
            inp_path = os.path.join(workdir, "model.inp")
            rpt_path = os.path.join(workdir, "model.rpt")
            out_path = os.path.join(workdir, "model.out")
            with open(inp_path, "w", encoding="utf-8") as f:
                f.write(inp_text)

            # The engine run: stepwise, trapezoid volume integration at every
            # sample (first sample carries no dt), peaks/max depths in doubles.
            outfall_volume = 0.0
            max_runoff = 0.0
            max_conduit_flow = 0.0
            node_max_depth = {}
            conduit_max_depth = {}
            prev_t = None
            prev_q = {}  # outfall id -> previous flow (CMS)
            try:
                from pyswmm import Links, Nodes, Simulation, Subcatchments

                with Simulation(inp_path, rpt_path, out_path) as sim:
                    nodes_api = Nodes(sim)
                    links_api = Links(sim)
                    subs_api = Subcatchments(sim)
                    node_objs = {n["id"]: nodes_api[n["id"]] for n in model["nodes"]}
                    link_objs = {c["id"]: links_api[c["id"]] for c in model["conduits"]}
                    sub_objs = {s["id"]: subs_api[s["id"]] for s in model["subcatchments"]}
                    outfall_ids = [n["id"] for n in model["nodes"] if n["kind"] == "outfall"]
                    for nid in node_objs:
                        node_max_depth[nid] = 0.0
                    for cid in link_objs:
                        conduit_max_depth[cid] = 0.0
                    for _ in sim:
                        now = sim.current_time
                        for oid in outfall_ids:
                            q = float(node_objs[oid].total_inflow)
                            if prev_t is not None:
                                dt = (now - prev_t).total_seconds()
                                outfall_volume += 0.5 * (q + prev_q[oid]) * dt
                            prev_q[oid] = q
                        for nid, obj in node_objs.items():
                            d = float(obj.depth)
                            if d > node_max_depth[nid]:
                                node_max_depth[nid] = d
                        for cid, obj in link_objs.items():
                            d = float(obj.depth)
                            if d > conduit_max_depth[cid]:
                                conduit_max_depth[cid] = d
                            f = float(obj.flow)
                            if f > max_conduit_flow:
                                max_conduit_flow = f
                        for obj in sub_objs.values():
                            r = float(obj.runoff)
                            if r > max_runoff:
                                max_runoff = r
                        prev_t = now
            except RuntimeError:
                raise
            except Exception as e:
                raise RuntimeError(f"the SWMM engine rejected the model: {e}")

            with open(rpt_path, "r", encoding="utf-8", errors="replace") as f:
                rpt_text = f.read()
            continuity = parse_continuity(rpt_text)

            depths = [
                {"id": nid, "maxDepthM": node_max_depth[nid]} for nid in node_max_depth
            ] + [
                {"id": cid, "maxDepthM": conduit_max_depth[cid]} for cid in conduit_max_depth
            ]
            depths.sort(key=lambda e: e["id"])

            volume_balance_pct = 100.0 * (outfall_volume - rain_volume_m3) / rain_volume_m3
            payload = {
                "engineKey": ENGINE_KEY,
                "engineVersion": engine_version,
                "adapterScript": ADAPTER_NAME,
                "adapterHash": adapter_hash,
                "analysis": "drainage",
                "rain": {
                    "intensityMMperHr": model["intensity"],
                    "durationMin": model["rainDurationMin"],
                    "totalDepthMm": total_depth_mm,
                    "totalVolumeM3": rain_volume_m3,
                },
                "routing": {"model": "kinematic_wave", "routingStepSec": routing_step_sec},
                "continuity": continuity,
                "outfallVolumeM3": outfall_volume,
                "volumeBalancePct": volume_balance_pct,
                "peaks": {"maxRunoffCms": max_runoff, "maxConduitFlowCms": max_conduit_flow},
                "depths": depths,
            }
        finally:
            shutil.rmtree(workdir, ignore_errors=True)
    except Exception as e:
        error = str(e) or e.__class__.__name__
    finally:
        os.dup2(saved_fd, 1)
        os.close(saved_fd)

    if error is not None:
        fail(error)
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()
    sys.exit(0)


if __name__ == "__main__":
    main()
