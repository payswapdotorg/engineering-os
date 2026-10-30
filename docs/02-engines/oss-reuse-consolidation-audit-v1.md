# Engineering OS — Open-Source Reuse and Consolidation Audit v1

Owner: TL · Date: **2026-10-31 (Slice 31)** · Directive: the binding open-source reuse directive (all ten §11 items delivered below) · Decisions: [ADR-0009](../adr/0009-oss-reuse-consolidation-decisions.md) · License policy: [ADR-0004](../adr/0004-license-and-copyleft-boundary.md) · Engine contract: [ADR-0005](../adr/0005-engine-integration-contract.md)

**Method (source-verified, never remembered).** All candidates were investigated at their actual upstream repositories: shallow clones read on this host (`/tmp/research/`), full LICENSE/COPYING texts read in-tree, npm/PyPI registries queried directly (the GitHub REST API was rate-limited this run — plain `git clone` + `raw.githubusercontent.com` + registry endpoints were used instead, all cited per record in [registry.json](../../src/engines/registry.json) `upstream.verifiedMethod`). Both takeoff candidates were **live-probed headless against our own representative fixtures** (`tests/fixtures/sheet-a102-plan.pdf`, `sheet-scan-like.pdf`, `sheet-curve-arc.pdf`, `takeoff-room.dxf`, `ocr-callout.png`) — observed outputs are recorded inline in the registry records and §3 below.

---

## §1 Executive summary

1. The platform is **already adapter-first**: 49 registry records, all source-verified; 14 engines `tested` through harness-validated broker adapters (cadquery, IfcOpenShell, gmsh, pandapower, SimPy, pyswmm, scikit-fem, SfePy, amaranth, yowasp-yosys, pdfplumber, ezdxf, tesseract, LibreOffice). The directive's final principle — *reuse the engines, integrate the applications, own the orchestration* — is the architecture this repo has been shipping since ADR-0005.
2. The audit closed every mandated investigation: §4C (takeoff comparative — OpenTakeoff vs pdf2takeoff vs our Sheet Measure), §4E (PM engines), §4F (Temporal/Kestra), §4A/B/D/G/H/I/J (reconciled against the existing registry — the directive's candidate lists were already covered; the five genuine gaps are now filled).
3. Four **BUILD retentions** are recorded with their alternatives in ADR-0009 (workflow executor, CPM core, measurement core, OCR/vector adapters) — each with the investigated alternative and the rejection evidence the directive's §3 requires.
4. Two **honest corrections** to our own assumptions: pdf2takeoff is **TypeScript, not Python** (the directive's text assumed Python), git-distributed only (not on npm/PyPI); OpenTakeoff's npm surface moved 0.9.98 → **0.9.100** (re-verified live, 58 MCP tools probed on our fixture).
5. Implementation began, not stopped at research (directive §11.10): five source-verified registry records added, the license register completed (+25 rows, one supply-chain flag raised), two duplicated UI implementations retired, and the Phase B/C adapter lanes specified for the next slices.

## §2 Current-state inventory (directive §11.1/§11.4 — the five-way classification)

| Subsystem | Custom (ours) | Reused OSS (evidence) | Class |
|---|---|---|---|
| Takeoff measurement core | `src/core/measure.ts` (662 LOC — calibration, polyline, shoelace area, Sutherland–Hodgman convex clipping, `areaWithCutouts` gross/cutout/net) | — | **1. Unique — retain** (frozen contract, no candidate equivalent — §3) |
| Symbol auto-count | `src/core/symbol-match.ts` (NCC + 12-rung ladder, 510 LOC) | — | **1. retain + 3. EXTEND path** (pdf2takeoff CV tier, benchmark-gated) |
| Page-rotation frame | `src/core/page-rotation.ts` (empirically probed against pdfjs-dist@4.10.38) | — | **1. retain** (probed truth; candidates use px-space conventions we would have to re-derive) |
| PDF rendering (client) | — | pdfjs-dist 4.10.38 (Apache-2.0), worker vendored | **2. already replaced by OSS** |
| Vector PDF takeoff | bridge only | pdfplumber + pdfminer.six (MIT) — exact bezier CTM paths | **2/4** |
| DXF takeoff | bridge only | ezdxf (MIT) | **2/4** |
| OCR | bridge only | tesseract 5 binary (Apache-2.0) + pinned tessdata | **2/4** |
| Parametric CAD | bridge + analytic ground-truth gates | cadquery 2.6.1 / OCCT (Apache-2.0, tested) | **2** — the FreeCAD-not-installable boundary is probed & recorded; SolveSpace deferred (D-rules) |
| BIM quantities/mesh | bridges | IfcOpenShell 0.9.0.post1 (LGPL-3.0, §2-exception reviewed) | **2** |
| 3D viewer | framing/palette glue | three.js + @react-three/fiber/drei (MIT) | **2/4** |
| CPM analysis | `src/core/cpm.ts` (273 LOC pure) | — | **1. retain (ADR-0009 D2)** — no maintained library exists |
| Gantt rendering | read-only CSS bars | — | **1. retain** (presentation, not scheduling math) |
| Durable workflow executor | `workflow.ts` + `runtime/executor.ts` (~1,140 LOC) | — | **1. retain (ADR-0009 D1)** — Temporal designated behind a seam |
| LLM planner | planner.ts gating/grading | z-ai-web-dev-sdk (server-side only, ADR-0008) | **4. thin glue — must stay ours** |
| Document conversion | bridge | LibreOffice headless (tested) | **2** |
| PDF generation/annotation | none yet (BOQ export = CSV/JSON; markups = DB rows) | — | **gap → Phase C adopts the pdf2takeoff pattern (pdf-lib, MIT)** |
| Ledger/estimates/authz/graph | `src/core/{ledger,authz,state,graph,markup}.ts` | — | **1/4 — the product's own domain** |
| Engine execution path | `src/engines/broker.ts` + adapters | — | **4. thin glue — must stay ours** (ADR-0005 rule 1) |

**No subsystem falls into class 5 (redundant code to retire) wholesale** — the redundant code found was *duplicated utilities*, not duplicate capabilities, and is dispositioned in §5.

## §3 Takeoff comparative audit (directive §4C — mandated)

### Fact sheets (source-verified)

**OpenTakeoff** (`Kentucky-ai/opentakeoff`, HEAD `c49de42` 2026-10-28): **AGPL-3.0-only** (34.5 KB LICENSE + NOTICE read in-tree; npm `opentakeoff-mcp` AGPL-3.0-only, now **0.9.100**, published 2026-10-25 — 73 versions). 738 commits, 16 contributors, 226 web + 33 MCP test files, real CI, Docker. **58-tool MCP surface (live-verified over stdio on our fixture)**; geometry core in `web/src/lib/` is deliberately pure but **AGPL — never vendorable, never importable as a library**; the MCP server imports it as one engine, two front ends. Unusual terms recorded: AGPL §7(b) attribution requirement for modified distributions; a one-comment CLA; and the NOTICE's irrevocable **Apache-2.0 grant through tag `apache-2.0-final`** (commit `84c7f48e`, 2026-10-10) — recorded as a counsel-only fallback, never relied on. Governance model matches ours by philosophy (scale lands `confirmed:false` until a human confirms — observed live; agent shapes stay proposals; every shape carries `origin{method, actor}` provenance).

**pdf2takeoff** (`ajflow/pdf2takeoff`, HEAD `f5a1c08` 2026-10-29): **Apache-2.0** (the license gap this audit was mandated to close — now closed from tree text). **TypeScript, not Python** (correcting the directive's assumption); not on npm/PyPI — git-distributed (`npx github:ajflow/pdf2takeoff`, Node ≥22.13). ~2 weeks old (first commit 2026-10-16), one human author with disclosed AI co-authorship, 198 commits, real CI (build/bench/round-trip checks), **no test files** (QA via 23 behavioural check scripts + published bench/eval logs). Engine is **CI-enforced environment-agnostic** (`scripts/check-engine.mjs` forbids pdfjs/onnxruntime imports, DOM types, `fetch(` inside `src/engine/`) — separable by design; 16 MCP tools; CLI (`info/scan/export/ocr/compare/annotate/run`). Live-probed on our fixtures: `info` on `sheet-a102-plan.pdf` → 4 pages, rotated p4, **0.62 s**; `ocr` on `sheet-scan-like.pdf` → wasm tesseract functional, honest `wordCount: 0` on the text-free fixture. Watch-items pinned in the registry record: **CVE-stale `xlsx@0.18.5`** (never inherit its export path), **LGPL `libheif-js`** (lazy HEIC-only), commit-pin discipline.

**Ours (baseline)**: the §2 inventory above — calibration m/mm/ft, polyline/area/count tools with durable calibration markups, crossing-cutout math (v1+v2), deterministic NCC auto-count, broker-executed vector (pdfplumber, exact beziers) + DXF (ezdxf) + OCR (tesseract 5, model-pinned), rotated-page correctness (Slice 27), ledger integration with provenance/verification/approval, BOQ CSV/JSON export.

### Capability matrix (✅ full · 🟡 partial · ❌ absent — file evidence in the T2-a record)

| Capability | OpenTakeoff | pdf2takeoff | Engineering OS |
|---|---|---|---|
| Scale calibration | ✅ + detected-scale governance | ✅ + OCR-vote auto-detect | ✅ manual 2-point (durable) |
| Length / area / count | ✅ | ✅ | ✅ |
| Vector interpretation | ✅ strokes + hatch families | ✅ wall runs, dimension reading | ✅ exact bezier CTM (pdfplumber) |
| Raster interpretation | 🟡 Bradley threshold flood | ✅ full pipeline + ONNX | 🟡 browser 2× for NCC only |
| Symbol recognition | ✅ vector fingerprint sweep (≥0.92) | ✅ click-to-teach + ONNX | ✅ NCC + multi-scale ladder |
| Room/region detection | 🟡 gated (`OPENTAKEOFF_ONE_CLICK`) | ✅ Magic Fill + door sealing | ❌ **our biggest gap** |
| Polygon cutouts incl. crossing | ✅ turf boolean | ❌ none | ✅ ours (Sutherland–Hodgman, gross/net) |
| Multi-sheet | ✅ sheet graph | ✅ sets | ✅ per-page markups |
| Revision comparison | 🟡 quantity-level | ✅ pixel + quantity delta | ❌ none |
| PDF annotations (standard) | 🟡 burns pixels (write-only) | ✅ full round-trip | ❌ DB markups only |
| OCR | 🟡 canvas-only (MCP has none) | ✅ tesseract.js wasm | ✅ tesseract 5 binary (provenance-grade) |
| Quantity extraction / materials / BOQ | ✅ flooring-domain | 🟡 templates | ✅ ledger + assemblies + estimates (ours) |
| MCP / agent operations | ✅ 58 tools, governance built-in | ✅ 16 tools | ❌ none (planner → broker today) |
| Provenance & human review | ✅ origin + seals + RFI | ✅ flagged proposals | ✅ ledger states + approval gates |

### Verdicts (ADR-0009 D3/D4 — "one coherent takeoff experience")

- **Retain (BUILD)**: measurement core, cutouts, NCC auto-count, OCR/vector/DXF adapters, ledger/BOQ — system of record. Neither candidate can replace them (no cutouts in p2t; AGPL wall in OT; none understand our ledger semantics).
- **INTEGRATE (adapter-first, Phase B/C)**: room/region fill, revision compare, standard-annotation round-trip, OCR-vote scale auto-detect — via **pdf2takeoff** (Apache-2.0) broker adapters, each behind its own contract addendum, benchmark-gated on the shared fixtures, results entering our ledger with provenance (their flagged-proposal model maps 1:1 onto our quantity review states). Pixel-diff revision results are **review aids, never ledger quantities**.
- **MCP wall**: OpenTakeoff's 58-tool surface is the arm's-length agent-intelligence option (ADR-0009 D5); its canvas-only OCR and AGPL geometry never enter our tree. The planner gains **one** MCP takeoff engine at a time behind the executor, never two user-facing takeoff UIs.
- **Not automatically replaced** (directive §4C's own instruction): our implementation has substantial validated functionality; every candidate component must win the shared-fixture benchmark before any code adoption.

## §4 Workflow orchestration (directive §4F) and PM engines (§4E)

- **Temporal** (MIT server + MIT TS SDK; 10,132 commits; single Go binary, SQLite dev server, PostgreSQL-class production) and **Kestra** (Apache-2.0; 13,459 commits; JVM; own Approval plugin) — both investigated in-tree against our executor (~1,140 LOC: 8-state machine, queue-time input locking, bounded retries, append-only event log, 5-min recovery scan, human-only approval red line, broker-executed steps with ADR-0005 records).
- **Decision (ADR-0009 D1)**: BUILD retained. Scope (1..8 linear steps, single host), the one-engine rule, the broker single-execution-path rule, the approval red line, and deployment weight all hold. **Temporal designated** behind an execution-adapter seam (`enqueue/claim/run-step/approve` — sketched §8 Phase D) with explicit re-evaluation triggers.
- **OpenProject** (GPL-3.0 — REST API v3 work-package endpoints verified in-tree) and **ProjectLibre** (CPAL-1.0 — MSPDI-XML + P6-XER exchange classes verified in-tree): **never embeddable**; arm's-length REST/file-exchange adapters only, for heavy PM features. **No maintained JS/TS CPM library exists** (npm scan recorded in ADR-0009 D2) — `src/core/cpm.ts` stays, honestly engine-free.

## §5 Duplicated-utilities audit (directive §8.5 — retire/freeze candidates, dispositions)

| Duplication | Sites | Disposition (this slice) |
|---|---|---|
| `eos-cpm/1` payload mapping ×2 (byte-identical) | controls-workspace vs sim-workspace | **RETIRED — consolidated** into `format.ts readCpmPayloadView` (the stricter Controls envelope rule kept at its call site; semantics byte-identical) |
| Duration formatter ×2 | sim-workspace vs agents-workspace | **RETIRED — consolidated** into `format.ts formatDuration` |
| Shoelace ×3, distance ×3 | measure.ts vs sheet_takeoff.py vs dxf_takeoff.py | **Accepted, documented**: cross-language (TS pure core / Python subprocess adapters) — cannot share code across the process boundary without breaking the self-containment rule; TS side is internally consolidated |
| `describe()` ×2 | cpm.ts vs measure.ts | **Accepted, frozen**: both cores are under frozen contracts; consolidating requires contract escalation for zero behavioral gain |
| Bridge/adapter boilerplate ×11 TS / ×14 PY | adapters | **Accepted house pattern** (self-contained subprocesses by design, ADR-0005); a shared python module would break the self-containment discipline recorded in the adapters' own headers |
| sha256 direct-hashing bypassing `lib/hash.ts` ×3 | sheet_ocr.ts, harness.ts ×2 | **Deferred**: harness is contract-laden; recorded as a safe-retirement candidate for its next lane |
| STEP unit-scale table ×2 PY | parametric_rebuild.py vs step_quantities.py | **Accepted, self-acknowledged** in the adapter header (subprocess self-containment) |
| Calibration lookup (server vs client) | broker.ts vs sheet-measure.tsx | **Not a duplicate**: different layers (server authority vs UI state) |
| Concave-region clip v3 (Martínez/Weiler–Atherton class) | measure.ts convex lane today | **Deferred by prior house decision** (twenty-first-pass queue): the convex lane covers the drawn-room reality; a library (polygon-clipping-class) is the designated form if a real operator need surfaces — consistent with this directive's default, gated by an exactness contract |
| `sharp` runtime dep, zero import sites | package.json | **Flagged**: remove at the next dependency-hygiene pass or gain its first import site |

## §6 License register completion (directive §7 — done in this slice)

[license-inventory.md](../08-licenses/license-inventory.md) §2 previously listed 15 platform dependencies; the audit found **25 runtime dependencies with no row**. All are now added, each verified against the installed `node_modules` tree text or the package license field (the four field-only packages are recorded as such). Findings: everything is permissive/public-domain — **zero copyleft in the platform runtime tree**. Two flags: `@reactuses/core` is **Unlicense** (public domain, not MIT as commonly assumed); **`z-ai-web-dev-sdk` ships no license text at all** (field-only ISC) — the register's only open supply-chain item, escalated per the §4 source-text-is-truth rule. New engine-candidate rows: pdf2takeoff (Apache-2.0 + watch-items), Temporal (MIT), Kestra (Apache-2.0), SolveSpace (GPL-3.0-or-later), GDAL (MIT-style + enumerated per-file exceptions — re-verify against the pinned build at bundling time).

## §7 Registry reconciliation (directive §11.9)

44 → **49 records**, all source-verified; state split 14 `tested` / 35 `planned`. Added: `pdf2takeoff`, `temporal`, `kestra`, `solvespace`, `gdal` (full records with `verifiedMethod` evidence strings, probes in both house forms, honest limitations). Re-verified: `opentakeoff` (npm 0.9.100; live 58-tool stdio probe on our fixture; AGPL boundary notes + the `apache-2.0-final` fallback recorded). The new GDAL python-module probe passes the slice-24 probe-expr class guard (import-and-print form, module named, no regex classes; probe count 8 → 9 ≥ 8).

## §8 Staged migration plan (directive §11.8 — protects the passing suites)

- **Phase A (this slice — DONE)**: registry + license register + ADR-0009 + this audit + the two UI consolidations. Acceptance protection: the full battery re-earned on the final tree (lint 0 · typecheck · unit · harness · e2e in CI order), no contract touched, no behavior change.
- **Phase B (next takeoff slice)**: `pdf2takeoff` room-detect adapter — new contract addendum (§18-style: input schema, broker op `detect_rooms`-equivalent, payload `eos-rooms/1` proposal-grade with review states, fixture + harness cases + e2e + browser journey), broker-executed via the house stdin/JSON subprocess pattern (git-pinned commit, `--omit=dev --ignore-scripts` install probe). Benchmark gate: shared fixtures, known measurements, our adapters as baseline; adopt code only where the engine wins.
- **Phase C**: standard PDF annotation round-trip (ADOPT the pdf2takeoff pdf-lib pattern — MIT; dormant upstream flagged, pin it) — import external markups into the ledger with provenance, export our markups as standard annotations.
- **Phase D (conditional)**: execution-adapter seam (thin interface over enqueue/claim/run-step/approve) if and only if a contract-scope change re-opens ADR-0009 D1; MCP takeoff engine behind the planner/executor with a tool allowlist.
- **Standing rule**: every phase ships behind its own contract addendum, never modifies frozen APIs, and re-earns the full battery before closure.

## §9 Standing build-versus-buy procedure (directive §3/§10 — now the release gate)

Before any substantial new capability: (1) source-verified candidate search (upstream tree, not marketing page); (2) the directive's evaluation table (functionality, maturity, accuracy, API, data, automation, collaboration, performance, deployment, licensing, integration cost, lock-in); (3) one of ADOPT / INTEGRATE / EXTEND / BUILD — BUILD requires an ADR; (4) working adapter + tests against representative native files + license verification + evidence that existing functionality was not duplicated; (5) a reuse scorecard in the implementation report (§10 below).

## §10 Reuse scorecard (this slice)

| Metric | Required reporting |
|---|---|
| Existing OSS projects investigated | 12 upstream trees read/cloned this run (opentakeoff, pdf2takeoff, temporal, kestra, openproject, projectlibre, solvespace, gdal, pdf.js/pdfjs-dist, pdf-lib, + npm CPM scan across 6 packages); 49 registry records reconciled overall |
| Projects actually reused (this slice) | None newly adopted in-process **by design** — the audit's product is decisions + evidence; runtime reuse stands at the 14 tested engines + pdf.js/three.js/LibreOffice/tesseract/pdfplumber/ezdxf (unchanged) |
| Custom code added | ADR-0009, this audit, 5 registry records, 25 license rows, `format.ts readCpmPayloadView`/`formatDuration` (shared replacements for duplicated code) |
| Existing code replaced | The byte-duplicated eos-cpm/1 mapping (controls + sim workspaces) and the duplicated duration formatter (sim + agents) — replaced by the shared implementations, semantics preserved |
| Upstream contributions | None this slice (no upstream gap encountered; pdf2takeoff's xlsx CVE finding is recorded as an upstream watch-item, not yet a patch) |
| Redundant implementations avoided | Three competing takeoff systems prevented (consolidation policy D3); two orchestration platforms prevented (one-engine rule D1); SolveSpace deferred against cadquery (duplication rule) |
| License review | **Passed** — 25 dependency rows verified (all permissive), 5 new engine candidates tree-verified, 1 supply-chain flag raised (z-ai-web-dev-sdk, no license text shipped) |
