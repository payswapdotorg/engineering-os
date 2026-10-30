#!/usr/bin/env python3
"""Engineering OS — RTL synthesis adapter (engines: amaranth + yowasp-yosys,
contract §17.5, Slice 30). The chip lane the Slice-28 license-first probe
opened (BSD-2 + ISC, both verified on the wheels' own METADATA/LICENSE).

Protocol (the transport_solve stdin style — parameters travel on stdin):
  stdin  (JSON): {"storagePath": "<abs path>", "parameters": {}}
                 (synthesize_rtl takes NO parameters — the yosys script is
                 frozen; a non-empty parameter set is refused)
  stdout (exit 0): {
    "engineKey":     "amaranth"  (the front-end: elaboration + RTLIL + pysim),
    "engineVersion": <amaranth distribution version>,
    "adapterScript": "rtl_synthesize.py",
    "adapterHash":   <sha256 of THIS file's own bytes>,
    "analysis":      "rtl_synthesis",
    "device": {"kind": "enable_counter", "widthBits": W},
    "rtlil":  {"sha256": …, "charCount": …},
    "netlist": {"sha256": …, "charCount": …, "totalCells": N,
                "flipFlopCount": W, "cellHistogram": {type: count, sorted}},
    "synthesis": {"engineKey": "yowasp-yosys", "engineVersion": …,
                  "script": "hierarchy -top top; proc; opt; memory; techmap; opt"},
    "simulation": {"engine": "amaranth.sim (pysim)",
                   "pattern": "18 enabled, 1 disabled, 6 enabled (25 cycles)",
                   "steps": [{"cycle", "enabled", "count"}, …]}
  }
  stdout (exit 1): {"error": "<honest message>"}  — never a simulated result.

Honest refusals (contract §17.5):
  - invalid model JSON          → the mirrored-§17.2 defense message
  - non-empty parameters        → the frozen-script refusal
  - amaranth/yowasp-yosys absent→ the engine-unavailable class
  - flip-flop count ≠ widthBits → the closed-form gate VERBATIM (a W-bit
                                  register has exactly W storage elements —
                                  probed at every width §17.1)
  - trajectory ≠ modular counts → the closed-form gate VERBATIM
  - any yosys failure           → the engine's own text, verbatim

Live-caught API traps this adapter honours (the §17.1 probe record, never
remembered source): yowasp-yosys runs in a WASI sandbox that preopens ONLY
the CWD — it MUST be spawned with cwd=<tempdir> + RELATIVE file names; the
amaranth 0.5.10 simulator is RFC-27 (async testbench + ctx.set/ctx.get +
await ctx.tick(); bare `yield`/`await Tick()` are TypeErrors); the ports=
tuple on rtlil.convert is REQUIRED. The temp dir is ALWAYS removed (the
s29 d.vtk litter lesson).

Determinism (§17.1): pinned engines, frozen yosys script, fixed key order,
sorted histogram, integer-only values — the harness double-run pins
byte-identity of the emitted document (probed: RTLIL + netlist JSON both
byte-identical across runs).
"""

import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile

ENGINE_KEY = "amaranth"
ADAPTER_NAME = "rtl_synthesize.py"

# The frozen synthesis script (contract §17.3 — no knobs by design). The
# trailing attrmap pair strips the `src` source-location attributes amaranth
# embeds in the RTLIL (and yosys preserves into write_json) — probed live:
# without the strip the netlist bytes depend on the ADAPTER FILE'S ABSOLUTE
# PATH (host-dependent); with it the netlist is byte-identical across hosts
# (the §17.1 cross-path probe: three different source paths → identical
# bytes). The RTLIL sha256 stays per-host provenance, by design.
YOSYS_SCRIPT = (
    "hierarchy -top top; proc; opt; memory; techmap; opt; "
    "attrmap -remove src; attrmap -modattr -remove src"
)

# The frozen behavioral stimulus (§17.4): 18 enabled, 1 disabled, 6 enabled.
SIM_PATTERN = [1] * 18 + [0] + [1] * 6
SIM_PATTERN_LABEL = "18 enabled, 1 disabled, 6 enabled (25 cycles)"

MAX_WIDTH = 64


def fail(msg: str) -> None:
    """Print the honest error envelope and exit non-zero. Nothing else on stdout."""
    sys.stdout.write(json.dumps({"error": msg}) + "\n")
    sys.stdout.flush()
    sys.exit(1)


def validate_model(doc) -> dict:
    """Mirror of contract §17.2 (defense-in-depth; the route zod is the gate)."""
    if not isinstance(doc, dict):
        raise RuntimeError("rtl model document must be a JSON object")
    if doc.get("format") != "eos-chip-rtl-model/1":
        raise RuntimeError(
            "rtl model document format must be \"eos-chip-rtl-model/1\" "
            f"(got {json.dumps(doc.get('format'))})"
        )
    name = doc.get("name")
    if not isinstance(name, str) or not (1 <= len(name) <= 200):
        raise RuntimeError("rtl model document name must be a string of 1..200 characters")
    device = doc.get("device")
    if not isinstance(device, dict):
        raise RuntimeError("rtl model device must be a JSON object")
    if device.get("kind") != "enable_counter":
        raise RuntimeError(
            "rtl model device.kind must be \"enable_counter\" "
            "(the v1 device class; every other class is its own future lane) "
            f"(got {json.dumps(device.get('kind'))})"
        )
    width = device.get("widthBits")
    if (
        not isinstance(width, int)
        or isinstance(width, bool)
        or not (1 <= width <= MAX_WIDTH)
    ):
        raise RuntimeError(f"rtl model device.widthBits must be an integer between 1 and {MAX_WIDTH}")
    return {"name": name, "kind": "enable_counter", "widthBits": width}


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
        raise RuntimeError("synthesize_rtl takes no parameters (the synthesis script is frozen)")
    return {"storagePath": req["storagePath"]}


def yowasp_yosys_binary() -> str:
    """The yowasp-yosys entry point next to THIS interpreter (the venv bin)."""
    sibling = os.path.join(os.path.dirname(os.path.abspath(sys.executable)), "yowasp-yosys")
    if os.path.isfile(sibling) and os.access(sibling, os.X_OK):
        return sibling
    found = shutil.which("yowasp-yosys")
    if found:
        return found
    raise RuntimeError(
        "yowasp-yosys is not runnable (no entry point beside "
        f"{sys.executable} and none on PATH) - the engine venv is not deployed on this host"
    )


def main() -> None:
    if sys.stdin.isatty():
        fail("usage: echo '{\"storagePath\": …, \"parameters\": {}}' | rtl_synthesize.py (stdin protocol)")

    adapter_hash = hashlib.sha256(open(os.path.abspath(__file__), "rb").read()).hexdigest()

    # Silence everything except our JSON on stdout: fd-level redirect 1 -> 2
    # (amaranth's simulator + yosys may print on stdout otherwise).
    saved_fd = os.dup(1)
    os.dup2(2, 1)
    error = None
    payload = None
    tmpdir = None
    try:
        try:
            from amaranth import Elaboratable, Module, Signal, unsigned
            from amaranth.back import rtlil
            from amaranth.hdl import Fragment
            from amaranth.sim import Simulator
        except Exception as e:
            raise RuntimeError(f"amaranth is not importable in this python ({e})")

        try:
            import importlib.metadata as importlib_metadata
        except Exception:
            import importlib_metadata  # type: ignore
        try:
            engine_version = importlib_metadata.version("amaranth")
        except Exception:
            engine_version = "unknown"
        try:
            yosys_version = importlib_metadata.version("yowasp-yosys")
        except Exception:
            yosys_version = "unknown"

        request = read_request()
        model_path = os.path.abspath(request["storagePath"])
        if not os.path.isfile(model_path):
            raise RuntimeError(f"file not found: {model_path}")
        try:
            with open(model_path, "r", encoding="utf-8") as f:
                doc = json.loads(f.read())
        except Exception as e:
            raise RuntimeError(f"rtl model file is not valid JSON: {e}")
        model = validate_model(doc)
        width = model["widthBits"]

        # --- the frozen device: clk, en, count[W] — count <= en ? count+1 : count
        class EnableCounter(Elaboratable):
            def __init__(self, w: int):
                self.en = Signal()
                self.count = Signal(unsigned(w))

            def elaborate(self, platform):
                m = Module()
                with m.If(self.en):
                    m.d.sync += self.count.eq(self.count + 1)
                return m

        dut = EnableCounter(width)
        # ports= is REQUIRED (the §17.1 trap — TypeError without it).
        rtlil_text = rtlil.convert(Fragment.get(dut, None), ports=(dut.en, dut.count))

        # --- yowasp-yosys in a temp dir: cwd + RELATIVE names (the WASI trap).
        yosys_bin = yowasp_yosys_binary()
        tmpdir = tempfile.mkdtemp(prefix="eos-rtl-")
        il_name, js_name = "design.il", "netlist.json"
        with open(os.path.join(tmpdir, il_name), "w", encoding="utf-8") as f:
            f.write(rtlil_text)
        try:
            proc = subprocess.run(
                [yosys_bin, "-q", "-p", YOSYS_SCRIPT, "-o", js_name, il_name],
                capture_output=True, text=True, timeout=180, cwd=tmpdir,
            )
        except subprocess.TimeoutExpired:
            raise RuntimeError("yowasp-yosys timed out after 180s and was terminated")
        if proc.returncode != 0:
            tail = (proc.stderr or "").strip()[-400:]
            raise RuntimeError(
                f"yowasp-yosys failed with exit code {proc.returncode}"
                + (f": {tail}" if tail else "")
            )
        with open(os.path.join(tmpdir, js_name), "rb") as f:
            netlist_bytes = f.read()
        try:
            netlist = json.loads(netlist_bytes)
        except Exception as e:
            raise RuntimeError(f"yowasp-yosys wrote a netlist that is not valid JSON: {e}")

        # --- the cell histogram (sorted by type → byte-deterministic key order)
        cells: dict = {}
        total_cells = 0
        for mod in netlist.get("modules", {}).values():
            if not isinstance(mod, dict):
                continue
            for cell in mod.get("cells", {}).values():
                if not isinstance(cell, dict):
                    continue
                ctype = cell.get("type")
                if not isinstance(ctype, str):
                    continue
                cells[ctype] = cells.get(ctype, 0) + 1
                total_cells += 1
        if total_cells == 0:
            raise RuntimeError(
                "yowasp-yosys produced an empty netlist - results are not "
                "available, and simulated results are not an option"
            )
        histogram = {k: cells[k] for k in sorted(cells)}
        flip_flops = sum(v for k, v in histogram.items() if "DFF" in k)

        # --- the flip-flop closed-form gate (§17.1: exactly W at every width)
        if flip_flops != width:
            raise RuntimeError(
                f"the synthesized netlist carries {flip_flops} flip-flops for a "
                f"{width}-bit register (expected exactly {width}) - the netlist "
                "does not implement the device, and a wrong netlist is not an option"
            )

        # --- the behavioral trajectory (RFC-27 pysim, the §17.1 probed API) ----
        sim_dut = EnableCounter(width)
        steps = []

        async def bench(ctx):
            for en in SIM_PATTERN:
                ctx.set(sim_dut.en, en)
                await ctx.tick()
                steps.append({"cycle": len(steps) + 1, "enabled": en, "count": int(ctx.get(sim_dut.count))})

        sim = Simulator(sim_dut)
        sim.add_clock(1e-6)
        sim.add_testbench(bench)
        sim.run()

        # --- the trajectory closed-form gate: count == enabled_so_far mod 2^W,
        #     a disabled cycle holds — pure modular arithmetic, never trusted.
        enabled_so_far = 0
        for step in steps:
            enabled_so_far += step["enabled"]
            expected = enabled_so_far % (2 ** width)
            if step["count"] != expected:
                raise RuntimeError(
                    "the elaborated design does not implement an enable counter "
                    f"(cycle {step['cycle']}: count {step['count']}, expected "
                    f"{expected}) - a disagreeing netlist is not an option"
                )

        payload = {
            "engineKey": ENGINE_KEY,
            "engineVersion": engine_version,
            "adapterScript": ADAPTER_NAME,
            "adapterHash": adapter_hash,
            "analysis": "rtl_synthesis",
            "device": {"kind": model["kind"], "widthBits": width},
            "rtlil": {
                "sha256": hashlib.sha256(rtlil_text.encode("utf-8")).hexdigest(),
                "charCount": len(rtlil_text),
            },
            "netlist": {
                "sha256": hashlib.sha256(netlist_bytes).hexdigest(),
                "charCount": len(netlist_bytes),
                "totalCells": total_cells,
                "flipFlopCount": flip_flops,
                "cellHistogram": histogram,
            },
            "synthesis": {
                "engineKey": "yowasp-yosys",
                "engineVersion": yosys_version,
                "script": YOSYS_SCRIPT,
            },
            "simulation": {
                "engine": "amaranth.sim (pysim)",
                "pattern": SIM_PATTERN_LABEL,
                "steps": steps,
            },
        }
    except RuntimeError as e:
        error = str(e)
    except Exception as e:  # unexpected: still an honest error envelope
        error = f"unexpected adapter failure: {type(e).__name__}: {e}"
    finally:
        if tmpdir is not None:
            shutil.rmtree(tmpdir, ignore_errors=True)  # never litter the host
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
