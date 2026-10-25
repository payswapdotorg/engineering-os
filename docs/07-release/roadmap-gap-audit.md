# Roadmap Gap Audit — Product vs Roadmap, Gap-Closure Research, and the Implementation Plan

Date: 2026-10-25 · Auditor: TL · Tree: `bece1a7` (Slice 14 complete) · Method: full documentation sweep (roadmap, canonical status, catalogue, contracts, ADRs, CI) cross-checked against code and live behavior; gap-closure research with **empirical verification in throwaway environments** (no claims from marketing pages); every recommendation below names its evidence.

This report was requested as: *audit issues with respect to the roadmap → research ways to close the gaps → write the report → implement the suggestions*. Sections 1–5 are the audit, §6 the research, §7 the recommendations; §7's "implement now" list is being executed in this same session (results recorded in `implementation-status.md` and the worklog).

---

## 1. Verdict summary

**Roadmap integrity is high.** The canonical chain (release-objectives → implementation-status → acceptance-catalogue → CI runs pinned by SHA) is internally consistent about what is verified — Phases 0/1/3/4 complete with evidence, slices 8/10/11/12/13/14 all closed with forensically-confirmed CI — and about what is honestly open. No mock engines, no dead buttons, no unverifiable claims were found.

**The open product surface**, in priority order: the Phase-2 **editing journey** (limitation #3), the takeoff honest remainder (limitation #5: vector/DXF/DWG takeoff, cutouts, OCR), auth admin bounds (limitation #19), the packaging systemd/recovery boundary, planner prompt-quality iteration, and the Phase-5 pack long tail.

**Two findings classes beyond the feature gaps:**
1. **Documentation drift (~20 items)** — second-tier docs and two limitation-ledger rows contradict the shipped, verified code. The single most consequential: `installation-ubuntu.md` still declares PostgreSQL verification "planned, not done" while Slice 12 closed it with a committed drill that is now a green CI job.
2. **Environment fragility (re-provision class)** — the sandbox re-provisioned twice during this work (Oct 23, Oct 25), each time wiping untracked runtime state: `worklog.md`, the content store, venv engines, and — the damaging one — the non-`DATABASE_URL` lines of `.env` (gitignored), which silently broke NextAuth session verification (`NO_SECRET`, `JWT_SESSION_ERROR`; every API route 401'd until `.env` was rebuilt). Recovery is now fully scripted (worklog Task 16-RECOVERY): ff to `origin/main`, `uv pip install -r tests/validation/engines-requirements.txt`, `setup-engine-libs.sh`, `.env` rebuild with a fresh secret, harness re-earn, `e2e-takeoff.sh` re-provision. The packaging lane already generates install-time secrets correctly on real hosts — this is a dev-sandbox recovery gap, not a product defect.

---

## 2. Roadmap vs delivered (per phase)

Source: `docs/01-product/release-objectives.md` phase table (lines 9–17).

| Phase | Exit criteria (pivotal) | Verdict | What remains |
|---|---|---|---|
| 0 Source-verified audit | Baseline, ADRs, ownership, capability matrix, working gates | ✅ complete | — |
| 1 Working product foundation | Install, project, artifact + revision (hash, download round-trip), engine discovery, audit trail, Ubuntu dev docs | ✅ complete | — |
| 2 CAD & BIM workflows | Real import, **editing through selected editor**, export, revision comparison; a complete CAD **or** BIM journey | 🚧 in progress | **The editing journey** — the viewer is read-only; native editor/authoring adapters recorded environment-blocked (limitation #3). Model-review journey verified end-to-end. |
| 3 Takeoff, estimating, controls | Drawing- AND model-derived quantities, traceable/reviewed; ledger, BOQ, schedule links | ✅ complete | Beyond-criteria gaps recorded honestly: vector/DWG takeoff, cutouts, OCR (symbol auto-count closed in Slice 13 — the Phase-3 row's gap list is stale on this point). |
| 4 Collaboration & agent workflows | Durable execution, retries/recovery, approval gates, staleness, agent runs a real multi-step workflow with review | ✅ complete | Runtime scale bounds open (single-process executor, no scheduler — limitation #4 open half). The LLM planner shipped on top as an untrusted advisor (ADR-0008). |
| 5 Broader engineering packs | Per-pack: capability boundary, real execution test, regression suite, ≥1 end-to-end workflow | 🚧 in progress | First slice verified (FE meshing, power flow, DES, LO conversion, CPM). FEA solving, GIS, EE-desktop, CFD, chip flow, robotics remain planned. 29 of 35 registry engines have no harness case. |
| 6 Hardening & release readiness | Security/performance/recovery; repeatable Ubuntu install + release process; demonstrable launch | 🚧 in progress | Shipped: auth, isolation, signup, packaging lifecycle (CI-proven .deb), PG runtime drill. Remaining: **systemd-host restart/recovery drill** (runners have no systemd — recorded), end-user release drill, admin tooling (#19). |

---

## 3. Open limitations ledger (condensed)

From `implementation-status.md` lines 61–79. **Bold = open and material to this report.**

| # | Status | One-line remainder |
|---|---|---|
| 3 | **OPEN** | Native editor/authoring adapters; viewer read-only |
| 4 | half-open | Single-process executor, no scheduler/multi-instance |
| 5 | core closed, **remainder open** | **Vector/DWG takeoff, cutouts, drawing-text OCR**; matcher raster/scale-naive |
| 6 | open (accepted, pinned) | IfcOpenShell wheel lacks OCC — curved-surface mesh fallback, quantified, harness-guarded |
| 8 | partially closed (ledger text stale) | Sweep timer shipped in packaging but never run on a systemd host |
| 9 | **closed in code, ledger stale** | `futureDatedRate` flag + amber chip shipped (estimate-pricing.ts, takeoff-workspace.tsx) — no e2e pin |
| 13 | **closed in code, ledger stale** | `onMutated` cache-nudge shipped in Studio + Takeoff — ledger still says "waiting for refresh" |
| 12, 14, 15, 16, 17, 18 | open (recorded bounds) | Viewer cross-nav; report-revision semantics; no project DELETE / STEP-only femesh / FIFO DES; click-precision bias; /Rotate 0 assumption; auto-count bounds |
| 19 | **OPEN (Slice 14's boundary)** | Open signup (no closed-signup toggle), no email verification, **no admin tooling for global roles** |

Closed with evidence: #1 (isolation, three-stage), #2 (PG runtime drill), #5 core (markups + auto-count), #7 recompute, #10 upload-tooling bound, #11 harness scope.

---

## 4. Audit finding class A — documentation drift (all items, grouped)

Each item is a doc-vs-truth contradiction found by the sweep; fixes land in §7 item 4.

**Release-facing (highest reader impact):**
1. `installation-ubuntu.md:188–193` — declares PostgreSQL verification "environment-blocked… planned, not done"; Slice 12 closed it (committed `scripts/postgres-runtime-drill.sh`, now the green `postgres-runtime` CI job). **Most severe item.**
2. `README.md:15` — "shipped Phases 0–6 to verified state… latest slice (8)" — contradicts the roadmap's own Phase 2/5/6 "in progress" verdicts and is ten slices stale.
3. `README.md:103` Phase-3 row says in-progress vs `release-objectives.md:14` complete — two phase tables disagree; the roadmap doc is canonical.
4. `release-objectives.md:14` — lists "symbol-count recognition" as an open product gap; Slice 13 closed it (the Phase-6 row already records the closure).

**Limitation-ledger rows contradicting shipped code:**
5. #9 and #13 (see §3) — closed in code, self-labeled in source (`estimate-pricing.ts:41,50,91–102`; `studio-workspace.tsx:122–132`, `takeoff-workspace.tsx:151–165`), ledger not reconciled; #9 also lacks an e2e pin.
6. #8 remainder text vs the shipped `eos-orphan-sweep.timer` (packaging lane; folds into the systemd drill gap).
7. #3's "3 of 35 installed" vs the eleventh-pass "6 of 35" probe figure; engine-detection capability row frozen at Phase 1 ("34 probed, 1 installed").

**Second-tier docs frozen at older phases:**
8. `engine-inventory.md` — "3 engines installed (2026-10-21)", master table predates Phase-5 adapters.
9. `capability-matrix.md` — same engine staleness; Takeoff section still frames calibrated measurement as OpenTakeoff-`planned` (the platform's own Sheet Measure shipped and is verified); BOQ row `planned` vs verified.
10. `license-inventory.md:28` — "no engine is installed or redistributed" vs 6 installed.
11. `test-strategy.md:25` — CI description predates the six-job gate suite.
12. `security-model.md:11` — "local single-operator mode… Phase 4" vs shipped auth/isolation/signup (doc is Phase-1-scoped by declaration, but its target-model section now describes shipped reality — needs a reconciliation note).
13. `workflow-and-agent-runtime.md:25` — "no LLM planning" note predates Slice 11.
14. `quantity-ledger-schema.md:3` — four "still pending" items that all shipped (calibrated measurement, harness, BOQ, recompute).
15. Registry vocabulary: `gmsh/pandapower/simpy/libreoffice` remain `"state": "planned"` in `src/engines/registry.json` while carrying `validation: pass` and verified capability rows (asymmetry recorded as AC-P5-08's "vocabulary unchanged" — now worth reconciling).

**ID/citation drift:**
16. `implementation-status.md:79` cites "AC-I13" (only an in-script comment id); the catalogue row is AC-SU-03. In-script comment headers in `e2e-p6-isolation.sh` still read "AC-I12" for renumbered SU/RP asserts.
17. `release-objectives.md` Phase-6 row's gap list is a subset of the canonical fourteenth-pass forward queue (under-lists; not a contradiction but incomplete).

---

## 5. Audit finding class B — open product gaps (ranked for closure value)

Ranked by: roadmap criticality × user value × implementability in this environment (pip-only, no root, offline CI, Apache-2.0 compatibility).

1. **Vector takeoff (PDF vector + DXF)** — limitation #5's core remainder and the biggest PlanSwift/Bluebeam-parity gap. Click-measurement carries a recorded 0.35% calibration bias; vector extraction is ~3 orders of magnitude more precise (measured, §6.1). Fully implementable now.
2. **Parametric authoring/editing (native editing v1)** — limitation #3's honest core and the Phase-2 "editing journey". A zero-new-dependency path exists and was proven end-to-end (§6.3). This converts Phase 2 from "in progress" toward its exit criteria honestly.
3. **Drawing-text OCR v1** — limitation #5's OCR remainder. The engine is already on the host (verified) and the adapter pattern exists (LibreOffice precedent). Small, bounded scope.
4. **Documentation-truth reconciliation** — §4's ~17 items; cheap, high-integrity value; must include new-feature records.
5. **Admin/settings lane** — limitation #19's product half: global-role PATCH + admin UI, closed-signup toggle. Small, well-scoped, but auth-surface work deserves its own slice with its own e2e battery extension.
6. **systemd restart/recovery drill** — requires a systemd host (CI runners and this sandbox have none). What IS drillable now: the process-level recovery semantics (kill -9 → restart → recovery-marking) and a committed runbook for the first systemd host. Recommendation: do the drillable half + runbook now; the systemd-host execution stays explicitly open.
7. **Planner prompt-quality iteration** — the evidence ledger (AgentPlan rows with verbatim raw responses) exists; iteration is a measured loop (run intents → grade outcomes → adjust prompt → pin regressions). Needs live-LLM budget and a grading rubric; recommend a defined protocol next slice rather than rushing it now.
8. **Deferred with reasoning (§6.4):** DWG round-trip (no open CI-pinnable path exists), FreeCAD/LibreCAD/Bonsai adapters (no pip path; the pip-only engine contract is the real blocker — honest correction to the record, which previously blamed no-root), build123d (lateral move, second OCCT line), bpy (GPL, py3.13-only, no STEP), Phase-5 long tail (FEA solving, GIS, CFD, chip, robotics — each is a slice of its own behind the frozen broker contract).

---

## 6. Research conclusions (with the empirical evidence)

### 6.1 Vector takeoff — **pdfplumber (PDF) + ezdxf (DXF), both MIT**

Tested in a throwaway venv against (a) a hand-written vector PDF with pinned path operators, (b) ezdxf-written deterministic DXF, (c) the repo's own `tests/fixtures/sheet-a102-plan.pdf` (read-only):

- **pdfplumber 0.11.10** (pdfminer.six 20260107 core): extracts lines/rects/curves with exact coordinates. On the repo fixture: **all 7 pinned line ops matched**; takeoff at 1:100 → bar **10.000001 m** (Δ +1.2e-6), wall **3.000001 m**, room perimeter **26.000004 m**, area **40.000013 m²** — rel errors ~1e-6, i.e. the fixture's own 4-dp rounding, vs the click-journey's 0.35% recorded bias. Page-2 symbols: **6/6 exact vector auto-count** from rects. Embedded sheet text (title, tick labels) extracts with bboxes — **vector sheets need no OCR**.
- **Curves nuance (honest):** `curve.pts` gives endpoints only; true arc length needs the pdfminer pathset's 6 control-point floats (proven accessible) + fixed-rate flattening (N=32 → rel 4.0e-5). The adapter must do this and pin N.
- **ezdxf 1.4.5**: reads LWPOLYLINE/LINE/ARC/CIRCLE with `$INSUNITS` (mm) awareness; **deterministic writer** via `write_fixed_meta_data_for_testing` (byte-identical fixtures proven, sha-pinned); read-back math exact (perimeter/area/line/arc deltas **0.00e+00**; arc 1413.716694 mm vs closed form). Already a cadquery 2.6.1 dependency (1.4.3 present in the product venv).
- **Rejected:** PyMuPDF (AGPL vs the project's Apache-2.0 — import makes the combined work AGPL); pypdfium2 as extractor (bbox-only, probed); LibreDWG (GPL is fine for subprocess use but not on PyPI or in any Debian/Ubuntu suite — unpinnable); ODA File Converter (accurate but proprietary freeware — violates open-source-only).
- **DWG verdict:** no acceptable open, CI-pinnable path today. Honest boundary: **DXF-native takeoff + documented operator-side conversion** (ODA at a probe path à la LibreOffice, or operator-built LibreDWG), with DWG artifacts getting a first-class refusal naming the converters. Claiming more would be dishonest.
- **Cost:** two new pin lines in `engines-requirements.txt`; ≈23 MB marginal venv add; pure-python (no LD_LIBRARY_PATH).

### 6.2 Drawing-text OCR — **tesseract 5 on-host now; rapidocr as proven fallback**

- **tesseract 5.5.0 is already installed at `/usr/bin/tesseract`** (platform base image — the same re-provision-survivable class as LibreOffice; Apache-2.0; models bundled, no runtime downloads; CI adds one apt package to the existing line). Empirically: reads `2400` conf 96.6 in 0.09 s (region TSV), title + rotated `1800` via auto-layout, **but never reads Ø natively** (`@400`/`0400` — the number is always right; the glyph needs a documented callout-context normalization with the raw transcript preserved). 4× render is the standard (2× marginal, measured).
- **rapidocr 3.10.0**: models-in-wheel (27 MB), offline-proven under a dead proxy, PP-OCRv6 — a validated fallback if region reads ever need more robustness; not justified for v1 (2.5–4.9 s and ~340 MB vs 0.09 s and 0 MB).
- **easyocr / paddleocr / docling / onnxtr fail the bar** (runtime model downloads — breaks offline CI; torch-scale installs).
- **v1 scope:** operator-driven region reads (Sheet Measure marquee at 4×) → TSV rows `{text, bbox, confidence}` → accept as `text-hits` markup (the auto-count accept precedent) + a dimension cross-check surface (callout value vs saved measured length — a compare badge, never auto-fill). Vendored `eng.traineddata` (4 MB, sha-pinned `7d4322bd…`) for byte-identical CI models; binary drift pinned by the LibreOffice contract-pinning precedent.

### 6.3 Native authoring v1 — **CadQuery parametric rebuild, zero new dependencies**

- **Proven end-to-end** (throwaway venv, cadquery 2.6.1): a parametric bracket model script with an explicit `PARAM_SCHEMA` (JSON-schema: number/min/max/default/unit) + `DEFAULT_PARAMS` + analytic `volume(params)`; the rebuild adapter takes `{modelScript, params}`, validates against the schema, builds, **checks against the analytic ground truth**, exports STEP. Two parameter sets → re-imported volumes **64,651.68146928197** vs **153,989.38070170232 mm³**, both analytically exact (rel-err ~1e-15). Refusals: out-of-range, unknown key, geometry contradiction ("hole does not fit inside the vertical leg") — verbatim errors, zero output bytes. The analytic check **caught a real modeling bug during the research itself** (wrong-plane cut cylinder → refusal fired, no STEP emitted).
- **Determinism nuance (harness-critical):** identical params do NOT yield byte-identical STEPs (OCCT `FILE_NAME` timestamp) → double-run pins must compare **geometry properties** (volume/COM/bbox), never content hashes.
- **Integration shape:** new broker op `rebuild_parametric`; parametric model = a registered `.py` artifact (kind `calculation`); rebuilt STEP = find-or-create kind-`model` artifact linked `derived_from`, sequential revisions, staleness cascade to downstream mesh/quantities (all existing machinery); parameters land in the revision note + audit event; Studio UI renders the parameter form from the schema (values-only editing; script editing = ordinary new revision).
- **build123d rejected** (833 MB, pre-1.0, pulls a second OCCT line — result-divergence hazard, adds nothing this loop needs). **bpy rejected** (GPL-3.0, CPython 3.13-only wheel vs the venv's 3.12, 403 MB, and **no STEP authoring at all** — Blender authors meshes). **FreeCAD:** no pip distribution exists (PyPI 404) — the honest correction: the record's "no-root" blame was wrong; the pip-only engine contract + GB-scale env is the real blocker. **LibreCAD:** no released headless CLI.

### 6.4 Runtime/packaging boundary (research summary)

The `postgres-runtime` CI job already proves the full e2e battery on live postgres:16 — the PG lane is closed. The remaining packaging gap is exactly the **systemd-host execution** of `eos.service` + the sweep timer (CI runners have no systemd; recorded honestly in `ci.yml:427–434`). What can be advanced now: a process-level recovery drill (SIGKILL the server mid-workflow → restart → verify the executor's recovery-marking, Journey H's remainder) and a committed first-systemd-host runbook. Unit hardening (`ProtectSystem=strict`) stays follow-up per `packaging/README.md:98–103`.

---

## 7. Recommendations and implementation plan

### 7.1 Implementation status after this session (the report's own suggestions, executed honestly)

**Outcome column added at session end — the honest reconciliation of what this session shipped vs what moved to the defined next slice:** items 1, 4 shipped complete; item 5's runbook-half + item 2's adapter lane landed smoke-verified but integration moved to Slice 16 (both lane agents hit the platform's agent context deadline mid-run — recorded in the worklog; the TL completed the integration-critical work and scoped the rest honestly rather than shipping unevidenced code); item 3 moved to Slice 16 with its research complete.

**Slice-16 closure (2026-10-25, sixteenth pass): items 2, 3, 5 ALL SHIPPED — the report's forward queue is now fully implemented.** Item 2 (parametric rebuild) shipped as the ELEVENTH broker op + Studio schema form + staleness cascade (e2e-p2 86 PASS, AC-P2-08); item 3 (OCR v1) shipped with the vendored tessdata pin + the documented @400→Ø400 rule (e2e AC-VT-09a…k); item 5 shipped as the process-level drill (16 PASS, CI-pinned) + `packaging/first-systemd-host-runbook.md` committed (the systemd-host EXECUTION stays honestly open). Slice 16-D additionally closed audit finding #15 (registry state-vocabulary reconciliation — 9 `tested` engines in a 38-engine registry) and limitation #9's e2e pin (AC-FR-01).

| # | Item | Closes | Shape |
|---|---|---|---|
| 1 | **SHIPPED** — **Vector takeoff lane**: `takeoff_sheet` (pdfplumber) + `takeoff_drawing` (ezdxf) broker ops + adapters; per-entity measurement → drawing-measured ledger rows with honest provenance (`pdfplumber 0.11.10 via sheet_takeoff.py (vector)`); raster-PDF honest refusal; curve control-point capture + pinned flattening; harness cases on the existing pinned fixture + new deterministic DXF fixtures + a curve fixture (analytic πr/2); e2e acceptance block; Sheet/Takeoff UI action | limitation #5 core remainder; Phase-3 beyond-criteria gap | §6.1 |
| 2 | **SHIPPED in Slice 16-A (sixteenth pass)** — **Parametric rebuild (native authoring v1)**: `rebuild_parametric` — the ELEVENTH broker op — with the proven adapter promoted to product; schema-driven values-only parameter form in Design Studio; find-or-create model artifact + `derived_from` + staleness cascade (shared `src/lib/staleness-cascade.ts`); harness cases (analytic volumes, refusal matrix, geometry-based determinism); e2e block (AC-P2-08, p2 86 PASS) | limitation #3 core; the Phase-2 editing journey | §6.3 |
| 3 | **SHIPPED in Slice 16-B (sixteenth pass)** — **Drawing-text OCR v1**: tesseract adapter (`EOS_TESSERACT` path, LibreOffice pattern) + TSV parse core + Ø-normalization rule (raw transcript always preserved); Sheet Measure region reads → `text-hits` markup accept; vendored sha-pinned `eng.traineddata`; harness case on a committed fixture PNG; e2e block (AC-VT-09a…k) | limitation #5 OCR remainder | §6.2 |
| 4 | **SHIPPED** — **Documentation-truth reconciliation**: all §4 drift items (installation-ubuntu PG note, README status + phase tables, release-objectives Phase-3 gap list, limitation rows #3/#8/#9/#13, second-tier doc headers, registry state vocabulary, AC id citations) + records for items 1–3 + this report linked from implementation-status | audit finding class A | §4 |
| 5 | **SHIPPED in Slice 16-C (sixteenth pass)** — **Recovery-drill half + runbook**: process-level SIGKILL/restart recovery drill on the durable runtime (Journey H remainder — `scripts/e2e-recovery-drill.sh`, 16 PASS, CI-pinned; caught the dev-server.sh quoted-.env defect live) + the committed first-systemd-host runbook (`packaging/first-systemd-host-runbook.md` — the systemd-host EXECUTION stays honestly open) | packaging honest boundary (drillable half) | §6.4 |

### 7.2 Next slice (defined, not started)

- **Admin/settings lane** (limitation #19's product half): `PATCH /api/admin/users/[id]` global-role management (admin-gated, audited, last-admin guard), admin settings surface, closed-signup deployment toggle (env-gated at boot, surfaced honestly in the UI when off), p6 e2e extension. Email verification stays explicitly out (no mail infra — record it).
- **Planner prompt-quality iteration protocol**: pull the persisted AgentPlan evidence ledger → grade a rubric over proposed/failed rows (definition validity, artifact wiring correctness, refusal honesty) → iterate the prompt → pin regressions in unit tests → re-run the live Part B. The chain exists; the loop is a session of measured work.

### 7.3 Deferred with recorded reasoning

DWG round-trip (§6.1: no open CI-pinnable path — DXF-native + documented operator conversion is the honest boundary) · FreeCAD/LibreCAD/Bonsai native adapters (pip-only engine contract; no pip distribution exists — correction to the old "no-root" framing) · build123d (§6.3) · bpy/Blender (§6.3) · Phase-5 long tail (each pack = its own contract + harness + e2e behind the frozen broker pattern) · systemd-host execution of the packaged service (needs a systemd machine; runbook committed now) · email verification (no mail infra).

---

## 8. Acceptance criteria for the implement-now items

Each item ships with the house discipline: unit tests for pure cores; harness cases with analytic ground truths (engines: double-run determinism pinned the right way — bytes where honest, geometry where OCCT stamps time); e2e blocks in the owning suite(s) with verbatim-refusal pins; browser journeys for the golden paths (mobile 390px, dark mode, zero console errors); docs reconciled to one truth; CI pin counts updated; worklog + implementation-status records with evidence links.

- **Vector takeoff:** analytic pins (bar 10 m / perimeter 26 m / area 40 m² rel ≤1e-5 on the fixture; DXF perimeter 14 000 mm / area 12 000 000 mm² exact; arc πr/2 at the pinned flattening); raster-PDF refusal verbatim; DWG refusal naming converters; ledger rows carry entity-level provenance; UI renders results without reload.
- **Parametric rebuild:** defaults vs edited params → distinct analytic volumes (the research transcript's numbers as ground truth); refusal matrix verbatim; downstream mesh goes stale and regenerates (the staleness ride); audit event with parameters; browser journey through the Studio form.
- **OCR v1:** fixture-region transcript pins (2400 conf floor, the @400→Ø400 normalization row with raw preserved); text-hits markup lifecycle (create/list/delete, ledger-separate); cross-check badge compares without writing.
- **Recovery drill:** a queued workflow's process killed hard mid-run → restart → the row reads failed (recovery-marked) with the interrupted-step record intact → retry succeeds end-to-end; the runbook committed.
- **Doc reconciliation:** zero remaining contradictions from §4's list; the new features recorded with evidence; limitation #5/#3 rows rewritten to the new truth; README + installation-ubuntu + release-objectives agree with implementation-status.
