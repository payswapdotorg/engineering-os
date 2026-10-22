#!/usr/bin/env python3
"""Engineering OS — power-flow adapter (engine: pandapower, contract §5.2).

Protocol (house style, same as the quantity/tessellation adapters):
  argv[1]        absolute path to a JSON file holding an eos-powerflow-network/1
                 document (contract §3.2 — the create/analyze routes' zod is
                 the primary gate; this adapter DEFENDS ITSELF, mirroring the
                 schema, because stored bytes are not trusted)
  stdout (exit 0): {
    "engineKey":     "pandapower",
    "engineVersion": <real pandapower.__version__>,
    "adapterScript": "powerflow.py",
    "adapterHash":   <sha256 of THIS file's own bytes>,
    "converged":     true,
    "buses":  [{"id", "vmPu", "angleDeg", "pMw", "qMvar"}, ...]   — INPUT order
    "lines":  [{"fromBus", "toBus", "iKa", "pLossMw", "qLossMvar"}, ...] — INPUT order
    "totals": {"lossMw", "loadMw"}
  }
  stdout (exit 1): {"error": "<honest message>"}  — never a simulated result.

Every numeric is copied VERBATIM from the pandapower result frame
(net.res_bus / net.res_line / net.res_load — engine is the source of truth,
ADR-0006 §2; nobody rounds "for presentation").

Honest refusals:
  - invalid/shapeless network JSON          → the mirrored-§3.2 defense message
  - newton-raphson exhaustion               → the pinned non-convergence text
  - islanded bus (NaN results — no path to
    the external grid; observed live: pandapower 3.5.6 converges and reports
    NaN for the island)                      → refusal naming the islanded buses
  - any other pandapower error               → the engine's own text, verbatim

Determinism: runpp(init="flat") on a fixed network is a deterministic
Newton-Raphson solve; the harness double-run enforces byte-identity.
"""

import hashlib
import json
import math
import os
import sys

ENGINE_KEY = "pandapower"
ADAPTER_NAME = "powerflow.py"

ID_RE = __import__("re").compile(r"^[a-z0-9-]{1,32}$")


def fail(msg: str) -> None:
    """Print the honest error envelope and exit non-zero. Nothing else on stdout."""
    sys.stdout.write(json.dumps({"error": msg}) + "\n")
    sys.stdout.flush()
    sys.exit(1)


def is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def check_id(value, what: str) -> str:
    if not isinstance(value, str) or not ID_RE.match(value):
        raise RuntimeError(f"{what} id must match ^[a-z0-9-]{{1,32}}$ (got {json.dumps(value)})")
    return value


def validate_network(doc) -> dict:
    """Mirror of contract §3.2 (defense-in-depth; the route zod is the primary gate)."""
    if not isinstance(doc, dict):
        raise RuntimeError("network document must be a JSON object")
    if doc.get("format") != "eos-powerflow-network/1":
        raise RuntimeError(
            f"network document format must be \"eos-powerflow-network/1\" (got {json.dumps(doc.get('format'))})"
        )
    name = doc.get("name")
    if not isinstance(name, str) or not (1 <= len(name) <= 200):
        raise RuntimeError("network document name must be a string of 1..200 characters")
    base_mva = doc.get("baseMva", 100)
    if not is_num(base_mva) or base_mva <= 0:
        raise RuntimeError("network baseMva must be a number > 0")

    buses = doc.get("buses")
    if not isinstance(buses, list) or not (1 <= len(buses) <= 16):
        raise RuntimeError("network must carry 1..16 buses")
    bus_ids = set()
    for i, b in enumerate(buses):
        if not isinstance(b, dict):
            raise RuntimeError(f"buses[{i}] must be an object")
        bid = check_id(b.get("id"), f"buses[{i}]")
        if bid in bus_ids:
            raise RuntimeError(f'bus id "{bid}" is used more than once')
        bus_ids.add(bid)
        if not is_num(b.get("nominalVk")) or b["nominalVk"] <= 0:
            raise RuntimeError(f"buses[{i}].nominalVk must be a number > 0")

    lines = doc.get("lines")
    if not isinstance(lines, list) or len(lines) > 48:
        raise RuntimeError("network lines must be an array of 0..48 entries")
    line_ids = set()
    for i, l in enumerate(lines):
        if not isinstance(l, dict):
            raise RuntimeError(f"lines[{i}] must be an object")
        lid = check_id(l.get("id"), f"lines[{i}]")
        if lid in line_ids:
            raise RuntimeError(f'line id "{lid}" is used more than once')
        line_ids.add(lid)
        if l.get("fromBus") not in bus_ids:
            raise RuntimeError(f'lines[{i}] references unknown fromBus {json.dumps(l.get("fromBus"))}')
        if l.get("toBus") not in bus_ids:
            raise RuntimeError(f'lines[{i}] references unknown toBus {json.dumps(l.get("toBus"))}')
        if not is_num(l.get("lengthKm")) or l["lengthKm"] <= 0:
            raise RuntimeError(f"lines[{i}].lengthKm must be a number > 0")
        if not is_num(l.get("rOhmPerKm")) or l["rOhmPerKm"] < 0:
            raise RuntimeError(f"lines[{i}].rOhmPerKm must be a number >= 0")
        if not is_num(l.get("xOhmPerKm")) or l["xOhmPerKm"] <= 0:
            raise RuntimeError(f"lines[{i}].xOhmPerKm must be a number > 0")
        if not is_num(l.get("maxCurrentKa", 1)) or l["maxCurrentKa"] <= 0:
            raise RuntimeError(f"lines[{i}].maxCurrentKa must be a number > 0")

    eg = doc.get("externalGrid")
    if not isinstance(eg, dict):
        raise RuntimeError("network externalGrid must be an object")
    if eg.get("busId") not in bus_ids:
        raise RuntimeError(f'externalGrid references unknown busId {json.dumps(eg.get("busId"))}')
    if not is_num(eg.get("vmPu", 1.0)):
        raise RuntimeError("externalGrid.vmPu must be a number")

    loads = doc.get("loads", [])
    if not isinstance(loads, list) or len(loads) > 48:
        raise RuntimeError("network loads must be an array of 0..48 entries")
    load_ids = set()
    for i, ld in enumerate(loads):
        if not isinstance(ld, dict):
            raise RuntimeError(f"loads[{i}] must be an object")
        lid = check_id(ld.get("id"), f"loads[{i}]")
        if lid in load_ids:
            raise RuntimeError(f'load id "{lid}" is used more than once')
        load_ids.add(lid)
        if ld.get("busId") not in bus_ids:
            raise RuntimeError(f'loads[{i}] references unknown busId {json.dumps(ld.get("busId"))}')
        if not is_num(ld.get("pMw")) or ld["pMw"] < 0:
            raise RuntimeError(f"loads[{i}].pMw must be a number >= 0")
        if not is_num(ld.get("qMvar")) or ld["qMvar"] < 0:
            raise RuntimeError(f"loads[{i}].qMvar must be a number >= 0")

    return {
        "baseMva": float(base_mva),
        "buses": buses,
        "lines": lines,
        "externalGrid": eg,
        "loads": loads,
    }


def main() -> None:
    if len(sys.argv) != 2:
        fail("usage: powerflow.py <absolute-path-to-network-json> (exactly one argument required)")
    net_path = os.path.abspath(sys.argv[1])
    if not os.path.isfile(net_path):
        fail(f"file not found: {net_path}")

    adapter_hash = hashlib.sha256(open(os.path.abspath(__file__), "rb").read()).hexdigest()

    # Silence everything except our JSON on stdout: fd-level redirect 1 -> 2.
    saved_fd = os.dup(1)
    os.dup2(2, 1)
    error = None
    payload = None
    try:
        try:
            import pandapower as pp
        except Exception as e:
            raise RuntimeError(f"pandapower is not importable in this python ({e})")

        engine_version = getattr(pp, "__version__", None) or "unknown"

        try:
            with open(net_path, "r", encoding="utf-8") as f:
                doc = json.loads(f.read())
        except Exception as e:
            raise RuntimeError(f"network file is not valid JSON: {e}")

        net_doc = validate_network(doc)

        # Build the pandapower net from the validated §3.2 document.
        net = pp.create_empty_network(sn_mva=net_doc["baseMva"])
        bus_index = {}
        for b in net_doc["buses"]:
            bus_index[b["id"]] = pp.create_bus(net, vn_kv=float(b["nominalVk"]), name=b["id"])
        for l in net_doc["lines"]:
            pp.create_line_from_parameters(
                net,
                from_bus=bus_index[l["fromBus"]],
                to_bus=bus_index[l["toBus"]],
                length_km=float(l["lengthKm"]),
                r_ohm_per_km=float(l["rOhmPerKm"]),
                x_ohm_per_km=float(l["xOhmPerKm"]),
                c_nf_per_km=0.0,  # §3.2 carries no shunt capacitance — honest zero
                max_i_ka=float(l.get("maxCurrentKa", 1)),
                name=l["id"],
            )
        eg = net_doc["externalGrid"]
        pp.create_ext_grid(net, bus=bus_index[eg["busId"]], vm_pu=float(eg.get("vmPu", 1.0)), va_degree=0.0)
        for ld in net_doc["loads"]:
            pp.create_load(
                net,
                bus=bus_index[ld["busId"]],
                p_mw=float(ld["pMw"]),
                q_mvar=float(ld["qMvar"]),
                name=ld["id"],
            )

        try:
            pp.runpp(net, init="flat")
        except Exception as e:
            if type(e).__name__ == "LoadflowNotConverged":
                raise RuntimeError(
                    "power flow did not converge (newton-raphson exhausted) - "
                    "results are not available, and simulated results are not an option"
                )
            raise RuntimeError(f"pandapower runpp failed: {type(e).__name__}: {e}")

        # Islanded defense: pandapower 3.5.6 CONVERGES and reports NaN for
        # buses with no path to the external grid (observed live) — refuse
        # rather than emitting NaN, which is not a result.
        res_bus = net.res_bus
        islanded = []
        for i, b in enumerate(net_doc["buses"]):
            vm = res_bus.vm_pu.iloc[i]
            if vm != vm or not math.isfinite(float(vm)):  # NaN check
                islanded.append(b["id"])
        if islanded:
            raise RuntimeError(
                "power flow did not produce results for all buses (islanded network - "
                f"buses with no path to the external grid: {', '.join(islanded)}) - "
                "results are not available, and simulated results are not an option"
            )

        # Result frames copied VERBATIM (float() casts unwrap numpy scalars
        # bit-identically for JSON; nothing is rounded).
        buses = []
        for i, b in enumerate(net_doc["buses"]):
            buses.append({
                "id": b["id"],
                "vmPu": float(res_bus.vm_pu.iloc[i]),
                "angleDeg": float(res_bus.va_degree.iloc[i]),
                "pMw": float(res_bus.p_mw.iloc[i]),
                "qMvar": float(res_bus.q_mvar.iloc[i]),
            })
        lines = []
        loss_mw = 0.0
        for i, l in enumerate(net_doc["lines"]):
            pl = float(net.res_line.pl_mw.iloc[i])
            loss_mw += pl
            lines.append({
                "fromBus": l["fromBus"],
                "toBus": l["toBus"],
                "iKa": float(net.res_line.i_ka.iloc[i]),
                "pLossMw": pl,
                "qLossMvar": float(net.res_line.ql_mvar.iloc[i]),
            })
        load_mw = float(net.res_load.p_mw.sum()) if len(net_doc["loads"]) else 0.0

        payload = {
            "engineKey": ENGINE_KEY,
            "engineVersion": engine_version,
            "adapterScript": ADAPTER_NAME,
            "adapterHash": adapter_hash,
            "converged": True,
            "buses": buses,
            "lines": lines,
            "totals": {"lossMw": loss_mw, "loadMw": load_mw},
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
