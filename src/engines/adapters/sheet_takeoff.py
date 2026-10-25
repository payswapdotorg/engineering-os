#!/usr/bin/env python3
"""Engineering OS — vector sheet takeoff adapter (engine: pdfplumber, 16-V).

Protocol (the step_femesh.py stdin/stdout house style, contract §5.1):

  stdin  (JSON): {"storagePath": "<abs path>",
                  "parameters": {"pageNo": <int, default 1>,
                                  "scaleMmPerPt": <number, REQUIRED>,
                                  "flattenSegments": <int, default 32,
                                                      range 4..256>}}

  `scaleMmPerPt` is the calibrated drawing scale (true millimetres per PDF
  point) — the BROKER resolves it from the revision's calibration record
  before calling; this adapter re-validates it (defense in depth, mirroring
  validateFeMeshParameters on the TS side). `flattenSegments` is the fixed
  per-segment sampling count for bezier flattening (a resolution knob: values
  outside 4..256 are clamped into the range, never rejected; the clamped
  value is echoed in the payload so nothing is silent).

  Because the content-addressed store keeps files under an extensionless
  `content` key, the stored bytes are copied to a temp `.pdf` first (the
  femesh pattern; bytes in -> identical geometry out).

  stdout (exit 0): {
    "engineKey":     "pdfplumber",
    "engineVersion": <pdfplumber.__version__>,
    "adapterScript": "sheet_takeoff.py",
    "adapterHash":   <sha256 of THIS file's own bytes>,
    "pageCount": <int>, "pageNo": <echo>, "scaleMmPerPt": <echo>,
    "flattenSegments": <echo>,
    "page": {"widthPt": <>, "heightPt": <>},
    "entities": {
      "lines":  {"count": <>, "totalLengthMm": <>},
      "rects":  {"count": <>, "totalPerimeterMm": <>, "totalAreaMm2": <>},
      "curves": {"count": <>, "totalLengthMm": <>, "totalClosedAreaMm2": <>}},
    "items": [ <= 400, sorted by (type asc line<rect<curve, then x, y, length)
      {"type":"line","pts":[[x,y],[x,y]],"stroke":<>,"lengthMm":<>} |
      {"type":"rect","pts":[[x,y] x4 corners],"stroke":<>,"fill":<>,
       "perimeterMm":<>,"areaMm2":<>} |
      {"type":"curve","pts":[flattened polyline],"stroke":<>,"fill":<>,
       "lengthMm":<>,"closedAreaMm2":<only when closed>}],
    "text": [ <= 200, sorted by (y, x, str)
      {"str": <>, "bbox": [x0, y0, x1, y1]}]
  }
  stdout (exit 1): {"error": "<honest message>"}  — never simulated geometry.

COORDINATES: all x/y in the payload are PDF-NATIVE (bottom-left origin) page
space, exactly as pdfminer's CTM-transformed path coordinates carry them
(pdfplumber's own `pts` keys are top-origin — deliberately NOT used). Text
rows are visual text lines (pdfplumber extract_text_lines defaults) with
their bbox converted back to bottom-origin.

CURVES — the reason this adapter exists (worklog 16-R1(d)): pdfplumber's
default curve objects carry segment ENDPOINTS only (naive chord reads ~10%
low on a quarter-arc — measured 282.84 vs 314.20 at r=200). This adapter
runs a pdfminer.six PDFPageAggregator subclass whose paint_path records the
FULL CTM-transformed pathset — ('m',(x,y)), ('l',(x,y)),
('c',(x1,y1),(x2,y2),(x3,y3)), ('h') — and classifies each recorded path by
the very object pdfminer itself created from it (the subclass observes
cur_item before/after super().paint_path, so the classification can never
drift from pdfplumber's page.lines/rects/curves; the per-class counts are
additionally cross-checked against pdfplumber and any disagreement is an
honest refusal). Each cubic segment is then flattened deterministically at
`flattenSegments` sample points (t = k/N, k = 1..N, De Casteljau-free direct
Bernstein evaluation, fixed operation order) and lengths/areas are computed
on the flattened polyline: length = sum of chord distances (incl. the
implicit 'h' closing chord); closed curves additionally carry the shoelace
area over the flattened ring. Lines are exact; rects are exact (perimeter
2*(w+h), area w*h on the normalized bbox).

Honest refusals (verbatim shapes pinned in the harness corpus):
  - no/invalid scaleMmPerPt ->
      "scaleMmPerPt must be a positive number — calibrate the sheet first
       or pass it explicitly"
  - pageNo out of range -> "pageNo N is outside this document (1..M)"
  - zero path operators on the page ->
      "this sheet page has no vector path operators — it is a scan or
       raster-only page; vector takeoff is not available for it, and
       simulated geometry is not an option"
  - unreadable/corrupt PDF -> pdfminer's own error class + message, verbatim
  - classification disagreement between the control-point pass and
    pdfplumber -> refused (adapter bug guard; the numbers are never guessed)

Determinism (contract §5.1): pure parsing + fixed-rate flattening + fixed
sort orders — identical input bytes give identical output bytes. No clock,
no random, no locale. The harness double-run enforces byte-identity.
"""

import hashlib
import json
import math
import os
import shutil
import sys
import tempfile

ENGINE_KEY = "pdfplumber"
ADAPTER_NAME = "sheet_takeoff.py"

DEFAULT_PAGE_NO = 1
DEFAULT_FLATTEN_SEGMENTS = 32
FLATTEN_MIN, FLATTEN_MAX = 4, 256
ITEMS_CAP = 400
TEXT_CAP = 200


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

    page_no = params.get("pageNo", DEFAULT_PAGE_NO)
    if isinstance(page_no, bool) or not isinstance(page_no, int) or page_no < 1:
        raise RuntimeError(f"parameters.pageNo must be an integer >= 1 - got {json.dumps(params.get('pageNo'))}")

    # REQUIRED calibration — the same verbatim refusal the TS bridge throws
    # (resolveSheetTakeoffParams), so a direct adapter call can never sneak
    # past an uncalibrated sheet.
    scale = params.get("scaleMmPerPt")
    if isinstance(scale, bool) or not isinstance(scale, (int, float)) or not (scale > 0):
        raise RuntimeError(
            "scaleMmPerPt must be a positive number — calibrate the sheet first or pass it explicitly"
        )

    # Resolution knob: truncate toward zero, then clamp into [4, 256] — the
    # SAME policy resolveSheetTakeoffParams applies (the bridge always sends
    # an in-range int; this defends direct calls).
    seg = params.get("flattenSegments", DEFAULT_FLATTEN_SEGMENTS)
    if isinstance(seg, bool) or not isinstance(seg, (int, float)) or not math.isfinite(seg):
        raise RuntimeError(f"parameters.flattenSegments must be a finite number - got {json.dumps(params.get('flattenSegments'))}")
    seg = int(seg)  # truncation toward zero (matches Math.trunc on the bridge)
    seg = max(FLATTEN_MIN, min(FLATTEN_MAX, seg))

    return {
        "storagePath": req["storagePath"],
        "pageNo": page_no,
        "scaleMmPerPt": float(scale),
        "flattenSegments": seg,
    }


class PathsetRecorder:
    """pdfminer.six pass capturing FULL bezier control points per painted path.

    Built as a wrapper around pdfminer.converter.PDFPageAggregator: the inner
    device's paint_path is patched (per instance) to (1) call the original
    implementation — so pdfminer performs its own path classification and
    cur_item bookkeeping EXACTLY as pdfplumber's own pass does — and
    (2) record, for every paint call that created exactly one layout object,
    the CTM-transformed pathset (all control points) together with the class
    pdfminer itself chose (LTLine/LTRect/LTCurve) and the stroke/fill flags.

    The multi-subpath recursion in pdfminer's paint_path re-enters the patch
    per subpath; only calls that created exactly ONE object are recorded, so
    a multi-subpath path yields one record per subpath (matching pdfplumber's
    per-subpath objects) and pure-recursion calls are skipped.
    """

    def __init__(self, rsrcmgr, pageno: int, laparams=None):
        from pdfminer.converter import PDFPageAggregator
        from pdfminer.utils import apply_matrix_pt

        self._apply_matrix_pt = apply_matrix_pt
        self.records: list = []
        self._depth = 0

        self._inner = PDFPageAggregator(rsrcmgr, pageno=pageno, laparams=laparams)

        inner_paint = self._inner.paint_path

        def patched(gstate, stroke, fill, evenodd, path):
            self._depth += 1
            try:
                n_before = len(self._inner.cur_item._objs)
                inner_paint(gstate, stroke, fill, evenodd, path)
                created = self._inner.cur_item._objs[n_before:]
                if len(created) == 1 and self._depth == 1:
                    ctm = self._inner.ctm
                    # path items are flat tuples ('m', x, y) / ('c', x1,y1,
                    # x2,y2, x3,y3) / ('h',); re-emit as (tag, pt, pt, ...)
                    # with every operand pair CTM-transformed — the same
                    # transform pdfminer applies to build its layout objects.
                    transformed = [
                        tuple(
                            [
                                str(op[0]),
                                *(
                                    self._apply_matrix_pt(ctm, (float(a), float(b)))
                                    for a, b in zip(op[1::2], op[2::2])
                                ),
                            ]
                        )
                        for op in path
                    ]
                    self.records.append(
                        {
                            "cls": type(created[0]).__name__,
                            "path": transformed,
                            "stroke": bool(stroke),
                            "fill": bool(fill),
                        }
                    )
            finally:
                self._depth -= 1

        self._inner.paint_path = patched

    @property
    def device(self):
        """The pdfminer device to hand to PDFPageInterpreter.process_page()."""
        return self._inner


def dist(p, q) -> float:
    return math.sqrt((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2)


def cubic_point(p0, p1, p2, p3, t: float):
    """Point on the cubic bezier at t (direct Bernstein form, fixed op order)."""
    mt = 1.0 - t
    a = mt * mt * mt
    b = 3.0 * mt * mt * t
    c = 3.0 * mt * t * t
    d = t * t * t
    return (a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
            a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1])


def shoelace(pts) -> float:
    """|2*A| over a ring (implicit closure) — the planar-area house formula."""
    total = 0.0
    n = len(pts)
    for i in range(n):
        x0, y0 = pts[i]
        x1, y1 = pts[(i + 1) % n]
        total += x0 * y1 - x1 * y0
    return abs(total) / 2.0


def entity_from_record(rec: dict, n_seg: int) -> dict:
    """Geometry for one recorded pathset, in POINTS (pdf-native bottom origin)."""
    kind = rec["cls"]
    path = rec["path"]
    if kind == "LTLine":
        # ('m',(x,y)), ('l',(x,y)) — pdfminer only classifies ml/mlh as lines
        p0 = path[0][1]
        p1 = path[-1][1]
        return {"type": "line", "pts": [[p0[0], p0[1]], [p1[0], p1[1]]],
                "stroke": rec["stroke"], "fill": rec["fill"],
                "lengthPt": dist(p0, p1)}
    if kind == "LTRect":
        corners = [(op[1][0], op[1][1]) for op in path if op[0] in ("m", "l")]
        xs = [p[0] for p in corners]
        ys = [p[1] for p in corners]
        x0, x1 = min(xs), max(xs)
        y0, y1 = min(ys), max(ys)
        w = x1 - x0
        h = y1 - y0
        return {"type": "rect",
                "pts": [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
                "stroke": rec["stroke"], "fill": rec["fill"],
                "perimeterPt": 2.0 * (w + h), "areaPt2": w * h}
    # LTCurve (pdfminer's catch-all: mlllh non-square, c, v, y, multi-op shapes)
    pts: list = []
    closed = False
    length_pt = 0.0
    cur = None
    start = None
    for op in path:
        tag = op[0]
        if tag == "m":
            cur = op[1]
            start = cur
            pts.append([cur[0], cur[1]])
        elif tag == "l":
            p = op[1]
            length_pt += dist(cur, p)
            pts.append([p[0], p[1]])
            cur = p
        elif tag == "c":
            p1, p2, p3 = op[1], op[2], op[3]
            prev = cur
            for k in range(1, n_seg + 1):
                t = k / n_seg
                b = cubic_point(cur, p1, p2, p3, t)
                length_pt += dist(prev, b)
                pts.append([b[0], b[1]])
                prev = b
            cur = p3
        elif tag == "h":
            closed = True
            if dist(cur, start) > 0.0:
                length_pt += dist(cur, start)
                pts.append([start[0], start[1]])
            cur = start
        else:
            # 'v'/'y' shorthand beziers are translated to 'c' by pdfminer's
            # interpreter before paint_path; anything else is a parser change
            # the counts cross-check will catch loudly.
            raise RuntimeError(
                f"unsupported path operator '{tag}' in a painted path - refusing to guess its geometry"
            )
    item = {"type": "curve", "pts": pts, "stroke": rec["stroke"], "fill": rec["fill"],
            "lengthPt": length_pt, "closed": closed}
    return item


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
            import pdfplumber
        except Exception as e:
            raise RuntimeError(f"pdfplumber is not importable in this python ({e})")

        engine_version = getattr(pdfplumber, "__version__", None) or "unknown"

        # pdfplumber dispatches by extension-neutral file handle, but the temp
        # .pdf copy keeps the contract identical to the femesh adapter and
        # guarantees the stored bytes are what gets parsed.
        tmp_dir = tempfile.mkdtemp(prefix="eos-sheet-takeoff-")
        pdf_path = os.path.join(tmp_dir, "sheet.pdf")
        shutil.copyfile(model_path, pdf_path)

        def verbatim_error(e: Exception) -> RuntimeError:
            # pdfplumber wraps pdfminer's own errors in PdfminerException(e) —
            # unwrap so the envelope carries pdfminer's error class verbatim.
            inner = e.args[0] if e.args and isinstance(e.args[0], BaseException) else None
            if inner is not None:
                return RuntimeError(f"{type(inner).__name__}: {inner}")
            return RuntimeError(f"{type(e).__name__}: {e}")

        try:
            pdf = pdfplumber.open(pdf_path)
        except Exception as e:
            raise verbatim_error(e)

        try:
            page_count = len(pdf.pages)
            if req["pageNo"] > page_count:
                raise RuntimeError(f"pageNo {req['pageNo']} is outside this document (1..{page_count})")
            page = pdf.pages[req["pageNo"] - 1]
            width_pt = float(page.width)
            height_pt = float(page.height)

            # --- vector entities: the control-point pass (full bezier truth) ---
            from pdfminer.pdfinterp import PDFPageInterpreter

            recorder = PathsetRecorder(pdf.rsrcmgr, pageno=page.page_number, laparams=None)
            PDFPageInterpreter(pdf.rsrcmgr, recorder.device).process_page(page.page_obj)
            records = recorder.records

            # classification cross-check against pdfplumber's own object pass
            mine = {"LTLine": 0, "LTRect": 0, "LTCurve": 0}
            for r in records:
                mine[r["cls"]] += 1
            theirs = {"LTLine": len(page.lines), "LTRect": len(page.rects), "LTCurve": len(page.curves)}
            if mine != theirs:
                raise RuntimeError(
                    "internal path-classification disagreement between the control-point pass and pdfplumber "
                    f"(pass {mine} vs pdfplumber {theirs}) - refusing to emit takeoff numbers that could be wrong"
                )

            lines = [r for r in records if r["cls"] == "LTLine"]
            rects = [r for r in records if r["cls"] == "LTRect"]
            curves = [r for r in records if r["cls"] == "LTCurve"]
            if not records:
                raise RuntimeError(
                    "this sheet page has no vector path operators — it is a scan or raster-only page; "
                    "vector takeoff is not available for it, and simulated geometry is not an option"
                )

            s = req["scaleMmPerPt"]
            entities = {
                "lines": {"count": 0, "totalLengthMm": 0.0},
                "rects": {"count": 0, "totalPerimeterMm": 0.0, "totalAreaMm2": 0.0},
                "curves": {"count": 0, "totalLengthMm": 0.0, "totalClosedAreaMm2": 0.0},
            }
            items = []
            for rec in lines:
                e = entity_from_record(rec, req["flattenSegments"])
                entities["lines"]["count"] += 1
                entities["lines"]["totalLengthMm"] += e["lengthPt"] * s
                items.append({"type": "line", "pts": e["pts"], "stroke": e["stroke"],
                              "lengthMm": e["lengthPt"] * s})
            for rec in rects:
                e = entity_from_record(rec, req["flattenSegments"])
                entities["rects"]["count"] += 1
                entities["rects"]["totalPerimeterMm"] += e["perimeterPt"] * s
                entities["rects"]["totalAreaMm2"] += e["areaPt2"] * s * s
                items.append({"type": "rect", "pts": e["pts"], "stroke": e["stroke"], "fill": e["fill"],
                              "perimeterMm": e["perimeterPt"] * s, "areaMm2": e["areaPt2"] * s * s})
            for rec in curves:
                e = entity_from_record(rec, req["flattenSegments"])
                entities["curves"]["count"] += 1
                entities["curves"]["totalLengthMm"] += e["lengthPt"] * s
                item = {"type": "curve", "pts": e["pts"], "stroke": e["stroke"], "fill": e["fill"],
                        "lengthMm": e["lengthPt"] * s}
                if e["closed"]:
                    area_mm2 = shoelace(e["pts"]) * s * s
                    entities["curves"]["totalClosedAreaMm2"] += area_mm2
                    item["closedAreaMm2"] = area_mm2
                items.append(item)

            type_rank = {"line": 0, "rect": 1, "curve": 2}
            items.sort(key=lambda it: (
                type_rank[it["type"]],
                it["pts"][0][0],
                it["pts"][0][1],
                it.get("lengthMm", it.get("perimeterMm", 0.0)),
                json.dumps(it),
            ))
            items = items[:ITEMS_CAP]

            # --- text: visual text lines, bbox back to bottom-origin ---
            text_rows = []
            for tl in page.extract_text_lines():
                text_rows.append({
                    "str": tl.get("text", ""),
                    "bbox": [tl["x0"], height_pt - tl["bottom"], tl["x1"], height_pt - tl["top"]],
                })
            text_rows.sort(key=lambda r: (r["bbox"][1], r["bbox"][0], r["str"]))
            text_rows = text_rows[:TEXT_CAP]

            payload = {
                "engineKey": ENGINE_KEY,
                "engineVersion": engine_version,
                "adapterScript": ADAPTER_NAME,
                "adapterHash": adapter_hash,
                "pageCount": page_count,
                "pageNo": req["pageNo"],
                "scaleMmPerPt": req["scaleMmPerPt"],
                "flattenSegments": req["flattenSegments"],
                "page": {"widthPt": width_pt, "heightPt": height_pt},
                "entities": entities,
                "items": items,
                "text": text_rows,
            }
        finally:
            pdf.close()
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
