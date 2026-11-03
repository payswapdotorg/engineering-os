# STATUS (2026-10-30): fully integrated adapter (16-R3 research numbers reproduced exactly:
# defaults 64651.68146928197 / edited 153989.38070170232 mm3, refusals verbatim) — shipped
# since Slice 16-A: harness-integrated (4 corpus cases parametric-schema/-defaults/-edited/
# -refusals in tests/validation/corpus-manifest.json), wired to the broker op
# rebuild_parametric + the route /api/projects/[id]/artifacts/[artifactId]/parametric, and
# invoked by the Design Studio's parametric-model surface (studio-workspace.tsx).
#!/usr/bin/env python3
"""Engineering OS — parametric-rebuild adapter (engine: cadquery, 16-P / Slice 15).

Protocol (the step_femesh.py stdin/stdout house style, contract §5.1):

  stdin  (JSON): {"storagePath": "<abs path to the stored MODEL script bytes>",
                  "mode": "schema" | "build",
                  "parameters": {…}              (build mode only),
                  "outputPath": "<abs path for the STEP>" (build mode only)}

  `storagePath` holds a PARAMETRIC MODEL script — a python module declaring
  PARAM_SCHEMA (JSON-schema style: per-key {type:"number", minimum, maximum,
  default, unit, label}, additionalProperties:false), DEFAULT_PARAMS,
  build(params) and analytic_volume_mm3(params). In the product those bytes
  are the CONTENT of a parametric-model artifact revision (uploaded like any
  artifact; versioned; hash-pinned). The adapter loads the module SAFELY: the
  bytes are read once, compiled once and exec'd in a fresh module namespace —
  the 16-R3 research's approach. A model script is an AUTHORED artifact
  revision, the same trust class as the adapter scripts themselves: it is
  never `exec` of arbitrary unvetted input, and never executed standalone.

  mode "schema" stdout (exit 0):
    {"engineKey":"cadquery","engineVersion":…,"adapterScript":"parametric_rebuild.py",
     "adapterHash":<sha256 of THIS file>,"modelScriptHash":<sha256 of the model
     bytes>,"schema":<PARAM_SCHEMA verbatim>,"defaults":<DEFAULT_PARAMS verbatim>}

  mode "build" stdout (exit 0):
    {"engineKey":"cadquery",…,"modelScriptHash":…,"paramsUsed":<merged params>,
     "volumeMm3":<RE-IMPORTED STEP solid volume>,"areaMm2":<re-imported area>,
     "bboxMm":[x,y,z],"centerOfMassMm":[x,y,z],
     "checks":{"volumeRelErr":<re-imported vs analytic>,"passed":true}}

  stdout (exit 1): {"error": "<honest message>"} — never a partial STEP: every
  refused build DELETES the output file before exiting (a refused rebuild
  leaves no artifact behind).

Analytic ground truth (the discipline that caught the 16-R3 research's own
modeling bug: a first-cut drill on the wrong plane built 65,280 mm³ vs the
analytic 64,651.68 — the refusal fired): BEFORE any STEP is written, the
BUILT solid's volume is checked against the model's analytic_volume_mm3 at
rel ≤ 1e-9; a disagreement refuses the whole build. After export the STEP is
RE-IMPORTED in this same process and every emitted number is the RE-IMPORTED
solid's (round-trip truth, not in-memory truth); checks.volumeRelErr is the
re-imported volume vs the analytic form, and it must also be ≤ 1e-9 for the
STEP to survive.

Unit honesty: the exported STEP's own LENGTH_UNIT declaration is parsed with
the step_quantities.py regex + the pinned UNIT_SCALE_M table (duplicated so
this adapter stays a self-contained subprocess, the house pattern); the
re-imported properties are converted to mm from the DECLARED unit. cadquery
exports mm; anything outside the pinned table is refused, never guessed.

Determinism (16-R3 finding, pinned here): identical parameters do NOT give
byte-identical STEPs — OCCT stamps an export timestamp into the STEP
FILE_NAME header and a per-export counter into PRODUCT(...) — so determinism
is asserted on the GEOMETRY PROPERTIES (volume/area/bbox/centerOfMass/
checks), never on content hashes. The harness double-run compares exactly
those.

Honest refusals (shapes pinned in the harness corpus):
  - corrupt model script (syntax error / import failure) -> the python error
    verbatim ("SyntaxError: …")
  - script without PARAM_SCHEMA -> "this model script declares no
    PARAM_SCHEMA — it is not a parametric model (see the Design Studio
    authoring docs)" (DEFAULT_PARAMS/build/analytic_volume_mm3 likewise)
  - malformed PARAM_SCHEMA / DEFAULT_PARAMS -> the violated authoring rule
  - unknown parameter key -> "unknown parameter(s) rejected: ['bogus']"
  - wrong type -> "parameter 'width' must be a number, got str"
  - out of range -> "parameter 'width' = 10 below minimum 20" / "above maximum 300"
  - non-finite value -> "parameter 'width' must be a finite number, got nan"
  - geometry contradiction authored in the model -> the model's own
    ValueError verbatim ("hole does not fit inside the vertical leg — …")
  - built or re-imported volume vs analytic > 1e-9 -> the pinned
    ground-truth refusal

The engine phase runs with fd1->fd2 so OCCT/cadquery chatter can never
contaminate the JSON protocol (the step_quantities.py idiom).
"""

import hashlib
import json
import math
import os
import re
import sys

ENGINE_KEY = "cadquery"
ADAPTER_NAME = "parametric_rebuild.py"
REL_ERR_LIMIT = 1e-9

# metres per declared STEP length unit — the step_quantities.py table.
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
    """Read + validate the {storagePath, mode, parameters?, outputPath?} envelope."""
    try:
        req = json.loads(sys.stdin.read())
    except Exception as e:
        raise RuntimeError(f"adapter input is not valid JSON on stdin: {e}")
    if not isinstance(req, dict) or not isinstance(req.get("storagePath"), str) or not req["storagePath"]:
        raise RuntimeError("adapter input must be {storagePath, mode} with a non-empty storagePath")
    mode = req.get("mode")
    if mode not in ("schema", "build"):
        raise RuntimeError(f"adapter input mode must be 'schema' or 'build' - got {json.dumps(mode)}")
    if mode == "schema":
        # strict protocol: schema mode answers from the module bytes alone —
        # parameters/outputPath on the wire are refused, never silently ignored
        if "parameters" in req or "outputPath" in req:
            raise RuntimeError("adapter input must not carry parameters/outputPath in schema mode")
        return {"mode": mode, "storagePath": req["storagePath"]}
    params = req.get("parameters", {})
    if not isinstance(params, dict):
        raise RuntimeError("adapter input parameters must be an object")
    out_path = req.get("outputPath")
    if not isinstance(out_path, str) or not out_path:
        raise RuntimeError("adapter input must carry a non-empty outputPath for build mode")
    return {"mode": mode, "storagePath": req["storagePath"], "parameters": params,
            "outputPath": os.path.abspath(out_path)}


def load_model_namespace(model_path: str, model_bytes: bytes) -> dict:
    """Safely load the parametric model: compile its bytes once and exec them
    in a fresh module namespace (the 16-R3 research approach — an authored
    artifact revision, never arbitrary input, never executed standalone)."""
    import builtins
    try:
        text = model_bytes.decode("utf-8")
    except Exception as e:
        raise RuntimeError(f"{type(e).__name__}: {e}")
    try:
        code = compile(text, os.path.basename(model_path), "exec")
    except Exception as e:
        # corrupt model script -> the python error verbatim
        raise RuntimeError(f"{type(e).__name__}: {e}")
    namespace = {"__name__": "eos_parametric_model", "__file__": model_path,
                 "__builtins__": builtins}
    try:
        exec(code, namespace)
    except Exception as e:
        raise RuntimeError(f"{type(e).__name__}: {e}")
    return namespace


def validate_schema_shape(schema) -> None:
    """Well-formedness of PARAM_SCHEMA (the Design Studio authoring contract)."""
    if not isinstance(schema, dict) or schema.get("type") != "object":
        raise RuntimeError('model PARAM_SCHEMA must be an object schema ({type: "object", …})')
    props = schema.get("properties")
    if not isinstance(props, dict) or not props:
        raise RuntimeError("model PARAM_SCHEMA declares no properties — a parametric model needs at least one numeric parameter")
    for name, spec in props.items():
        if not isinstance(spec, dict) or spec.get("type") != "number":
            raise RuntimeError(f"model PARAM_SCHEMA property '{name}' must be a number spec ({{type: \"number\", minimum, maximum, default, …}})")
        for bound_name in ("minimum", "maximum"):
            bound = spec.get(bound_name)
            if bound is not None and (isinstance(bound, bool) or not isinstance(bound, (int, float))):
                raise RuntimeError(f"model PARAM_SCHEMA property '{name}' has a non-numeric {bound_name}")
        lo, hi = spec.get("minimum"), spec.get("maximum")
        if lo is not None and hi is not None and lo > hi:
            raise RuntimeError(f"model PARAM_SCHEMA property '{name}' has minimum {lo} above maximum {hi}")
        default = spec.get("default")
        if isinstance(default, bool) or not isinstance(default, (int, float)) or not math.isfinite(default):
            raise RuntimeError(f"model PARAM_SCHEMA property '{name}' must declare a numeric default")
        if lo is not None and default < lo:
            raise RuntimeError(f"model PARAM_SCHEMA property '{name}' default {default} is below its minimum {lo}")
        if hi is not None and default > hi:
            raise RuntimeError(f"model PARAM_SCHEMA property '{name}' default {default} is above its maximum {hi}")
    required = schema.get("required", [])
    if not isinstance(required, list) or any(not isinstance(r, str) for r in required):
        raise RuntimeError("model PARAM_SCHEMA 'required' must be a list of property names")
    unknown_required = [r for r in required if r not in props]
    if unknown_required:
        raise RuntimeError(f"model PARAM_SCHEMA 'required' names unknown properties: {unknown_required}")
    if schema.get("additionalProperties") is not False:
        raise RuntimeError("model PARAM_SCHEMA must pin additionalProperties: false (unknown keys are refused, never silently dropped)")


def validate_defaults(defaults, schema) -> None:
    """DEFAULT_PARAMS must cover exactly the declared properties, in range."""
    if not isinstance(defaults, dict):
        raise RuntimeError("model DEFAULT_PARAMS must be an object of parameter values")
    props = schema["properties"]
    for name in props:
        if name not in defaults:
            raise RuntimeError(f"model DEFAULT_PARAMS is missing a value for '{name}'")
    for name, v in defaults.items():
        if name not in props:
            raise RuntimeError(f"model DEFAULT_PARAMS carries unknown parameter '{name}'")
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
            raise RuntimeError(f"model DEFAULT_PARAMS['{name}'] must be a finite number")
        spec = props[name]
        if "minimum" in spec and v < spec["minimum"]:
            raise RuntimeError(f"model DEFAULT_PARAMS['{name}'] = {v} below minimum {spec['minimum']}")
        if "maximum" in spec and v > spec["maximum"]:
            raise RuntimeError(f"model DEFAULT_PARAMS['{name}'] = {v} above maximum {spec['maximum']}")


def validate_params(schema: dict, values: dict) -> dict:
    """Minimal JSON-schema object validation (number/finite/range/required/no-
    extra). The TS bridge mirrors these checks verbatim
    (resolveParametricParams) so the broker can refuse before any engine call;
    this adapter re-checks because the broker never trusts a client."""
    if not isinstance(values, dict):
        raise ValueError("parameter values must be a JSON object")
    props = schema.get("properties", {})
    unknown = sorted(k for k in values if k not in props)
    if unknown and schema.get("additionalProperties") is False:
        raise ValueError(f"unknown parameter(s) rejected: {unknown}")
    out = {}
    for name, spec in props.items():
        if name in values:
            out[name] = values[name]
        elif "default" in spec:
            out[name] = spec["default"]
        elif name in schema.get("required", []):
            raise ValueError(f"missing required parameter: {name}")
    for name, v in out.items():
        spec = props[name]
        if spec.get("type") == "number":
            if isinstance(v, bool) or not isinstance(v, (int, float)):
                raise ValueError(f"parameter '{name}' must be a number, got {type(v).__name__}")
            if not math.isfinite(v):
                raise ValueError(f"parameter '{name}' must be a finite number, got {v}")
            if "minimum" in spec and v < spec["minimum"]:
                raise ValueError(f"parameter '{name}' = {v} below minimum {spec['minimum']}")
            if "maximum" in spec and v > spec["maximum"]:
                raise ValueError(f"parameter '{name}' = {v} above maximum {spec['maximum']}")
    return out


def main() -> None:
    adapter_hash = hashlib.sha256(open(os.path.abspath(__file__), "rb").read()).hexdigest()

    # Silence everything except our JSON on stdout: fd-level redirect 1 -> 2.
    # The redirect is ALWAYS restored before any error envelope or result is
    # printed, so the JSON protocol is the only thing that ever hits stdout.
    saved_fd = os.dup(1)
    os.dup2(2, 1)
    error = None
    payload = None
    out_path = None
    try:
        req = read_request()
        model_path = os.path.abspath(req["storagePath"])
        if not os.path.isfile(model_path):
            raise RuntimeError(f"model script not found: {model_path}")
        model_bytes = open(model_path, "rb").read()
        model_hash = hashlib.sha256(model_bytes).hexdigest()

        try:
            import cadquery  # noqa: F401  (engine identity + importers namespace)
        except Exception as e:
            raise RuntimeError(f"cadquery is not importable in this python ({e})")
        engine_version = getattr(cadquery, "__version__", None) or "unknown"

        ns = load_model_namespace(model_path, model_bytes)
        if "PARAM_SCHEMA" not in ns:
            raise RuntimeError("this model script declares no PARAM_SCHEMA — it is not a parametric model (see the Design Studio authoring docs)")
        if "DEFAULT_PARAMS" not in ns:
            raise RuntimeError("this model script declares no DEFAULT_PARAMS — it is not a parametric model (see the Design Studio authoring docs)")
        validate_schema_shape(ns["PARAM_SCHEMA"])
        validate_defaults(ns["DEFAULT_PARAMS"], ns["PARAM_SCHEMA"])

        envelope = {
            "engineKey": ENGINE_KEY,
            "engineVersion": engine_version,
            "adapterScript": ADAPTER_NAME,
            "adapterHash": adapter_hash,
            "modelScriptHash": model_hash,
        }

        if req["mode"] == "schema":
            payload = {
                **envelope,
                "schema": ns["PARAM_SCHEMA"],
                "defaults": ns["DEFAULT_PARAMS"],
            }
        else:
            if "build" not in ns:
                raise RuntimeError("this model script declares no build(params) — it is not a parametric model (see the Design Studio authoring docs)")
            if "analytic_volume_mm3" not in ns:
                raise RuntimeError(
                    "this model script declares no analytic_volume_mm3(params) — its output cannot be "
                    "checked against analytic ground truth, and unchecked geometry is not emitted "
                    "(see the Design Studio authoring docs)"
                )
            out_path = req["outputPath"]
            if os.path.exists(out_path):
                raise RuntimeError(f"output path already exists — refusing to overwrite: {out_path}")
            try:
                params = validate_params(ns["PARAM_SCHEMA"], req["parameters"])
            except ValueError as e:
                raise RuntimeError(str(e))

            try:
                model = ns["build"](dict(params))
            except ValueError as e:
                # a model-authored refusal (e.g. the bracket's geometry
                # contradiction) is an honest authored message — verbatim
                raise RuntimeError(str(e))
            solids = model.solids().vals()
            if len(solids) != 1:
                raise RuntimeError(f"expected exactly one solid from build(params), got {len(solids)}")
            built_volume = float(solids[0].Volume())
            analytic = float(ns["analytic_volume_mm3"](dict(params)))
            if not math.isfinite(analytic) or analytic == 0:
                raise RuntimeError(f"model analytic_volume_mm3 returned {analytic} — a degenerate ground truth cannot certify a build")
            built_rel = abs(built_volume - analytic) / abs(analytic)
            if built_rel > REL_ERR_LIMIT:
                raise RuntimeError(
                    f"analytic ground-truth check failed: built volume {built_volume} vs analytic {analytic} "
                    f"(rel {built_rel:.3e} > {REL_ERR_LIMIT:g}) — the model and its analytic function "
                    "disagree; refusing to emit"
                )

            # STEP written ONLY after the ground-truth check passes
            model.val().exportStep(out_path)

            # RE-IMPORT in the same process: the emitted numbers are the
            # round-trip truth (the fresh-process re-import of 16-R3, folded
            # into one adapter run)
            from cadquery import importers
            reimported = importers.importStep(out_path)
            rsolids = reimported.solids().vals()
            if len(rsolids) != 1:
                raise RuntimeError(f"re-imported STEP carried {len(rsolids)} solids — refusing to emit ambiguous geometry")
            rs = rsolids[0]
            try:
                with open(out_path, "r", encoding="utf-8", errors="replace") as f:
                    step_text = f.read()
            except Exception as e:
                raise RuntimeError(f"could not read the exported STEP for unit detection: {e}")
            unit, unit_evidence = detect_length_unit(step_text)
            if unit is None:
                raise RuntimeError(f"could not determine STEP length unit: {unit_evidence}")
            scale_m = UNIT_SCALE_M.get(unit)
            if scale_m is None:
                raise RuntimeError(f"STEP length unit '{unit}' has no conversion pinned ({unit_evidence}) - refusing to guess a scale")
            k = scale_m * 1000.0  # native -> mm
            volume_mm3 = float(rs.Volume()) * k ** 3
            area_mm2 = float(rs.Area()) * k ** 2
            bb = rs.BoundingBox()
            com = rs.Center()
            reimport_rel = abs(volume_mm3 - analytic) / abs(analytic)
            checks = {"volumeRelErr": reimport_rel, "passed": reimport_rel <= REL_ERR_LIMIT}
            if not checks["passed"]:
                raise RuntimeError(
                    f"analytic ground-truth check failed: re-imported STEP volume {volume_mm3} vs analytic "
                    f"{analytic} (rel {reimport_rel:.3e} > {REL_ERR_LIMIT:g}) — the exported model and its "
                    "analytic function disagree; refusing to emit"
                )
            payload = {
                **envelope,
                "paramsUsed": params,
                "volumeMm3": volume_mm3,
                "areaMm2": area_mm2,
                "bboxMm": [bb.xlen * k, bb.ylen * k, bb.zlen * k],
                "centerOfMassMm": [com.x * k, com.y * k, com.z * k],
                "checks": checks,
            }
    except RuntimeError as e:
        error = str(e)
    except Exception as e:  # unexpected: still an honest error envelope
        error = f"unexpected adapter failure: {type(e).__name__}: {e}"
    finally:
        # a refused build leaves NO output file behind
        if error is not None and out_path is not None and os.path.exists(out_path):
            try:
                os.unlink(out_path)
            except Exception:
                pass
        try:
            sys.stdout.flush()
        except Exception:
            pass
        os.dup2(saved_fd, 1)
        os.close(saved_fd)

    if error is not None:
        fail(error)
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()
    sys.exit(0)


if __name__ == "__main__":
    main()
