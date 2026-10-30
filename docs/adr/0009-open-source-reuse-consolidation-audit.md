# ADR-0009: Open-Source Reuse and Consolidation Audit v1

Status: accepted (2026-10-30, Audit v1 — binding Open-Source Reuse Directive compliance, delivered before the next capability expansion) · **Stage 1 SHIPPED same day** (see the migration-plan note below: the pdf2takeoff arm's-length bridge is live — 4 broker ops, 9/9 harness cases, registry `tested`) · Supersedes: none · Extends: [ADR-0004](0004-license-and-copyleft-boundary.md) (license boundary), [ADR-0005](0005-engine-integration-contract.md) (engine contract), [ADR-0006](0006-agent-safety-and-approval-gates.md) (approval red line), [ADR-0008](0008-llm-planner-untrusted-advisor.md) (planner contract)

## Context

The binding Open-Source Reuse Directive governs how this repository adds
capability: the default is to **integrate existing OSS before implementing an
equivalent capability**; every new capability requires a mandatory
build-vs-reuse investigation; every investigation ends in one of four recorded
decisions — **ADOPT** (take upstream as the engine of the capability),
**INTEGRATE** (use upstream at arm's length, no code reuse), **EXTEND**
(build narrowly on an already-adopted engine), or **BUILD** (only after the
investigation shows no fit); and releases carry gates plus a **reuse
scorecard** so the ratio is measured, never asserted. This ADR records Audit
v1, the first full-repo compliance audit, delivered before the next
capability expansion.

Investigation summary: a full-repository audit of ~70k LOC across 76 commits,
plus 49 upstream candidates machine-verified via the GitHub REST API on the
audit day (2026-10-30), plus two deep source audits of the candidate takeoff
engines — **OpenTakeoff** (Kentucky-ai/opentakeoff: AGPL-3.0, ~73k LOC, 58
MCP tools) and **pdf2takeoff** (ajflow/pdf2takeoff: Apache-2.0, ~21k LOC, a
DOM-free ports-seamed engine).

### Key finding 1 — the engine layer already complies

All 14 runtime adapters delegate to real pinned OSS engines — CadQuery/OCCT
2.6.1, IfcOpenShell 0.9.0.post1, gmsh 4.15.2, scikit-fem 12.0.2, SfePy
2026.3, pyswmm 2.2.0, pandapower 3.5.6, SimPy 4.1.2, pdfplumber 0.11.10,
ezdxf 1.4.5, tesseract 5.5.0, amaranth 0.5.10 + yowasp-yosys 0.70,
LibreOffice 25.2.3.2 — behind the ADR-0005 arm's-length subprocess contract,
validated by the 42/42 corpus harness (`tests/validation/report.json`).
**No engine duplication was found.** Decision: RETAIN the whole adapter layer.

### Key finding 2 — the duplication that does exist

- **(a) Workflow runtime executor** — `src/core/runtime/executor.ts`
  (786 LOC) is an in-process serial queue: durable records, not durable
  execution. No timers, no distributed workers, no parallelism.
- **(b) CPM core** — `src/core/cpm.ts` (273 LOC) is a textbook CPM
  implementation with no calendars, WBS, relationships, resources or
  baselines.
- **(c) Takeoff surface audited gaps** — no room detection, no revision
  comparison, no native PDF annotation round-trip, no scale auto-detect, no
  XLSX export, no agent/MCP takeoff surface.

## Decision

Per-subsystem, the four-way decisions (every capability lane the audit
touched):

| # | Subsystem | Decision | Rationale |
|---|---|---|---|
| 1 | Takeoff measurement core (`measure.ts` 662, `markup.ts` 392, `ledger.ts` 686 + approval workflow) | **RETAIN** | Provenance geometry + human-only approval + server re-derivation is the product differentiator; 53/39/44 pinned tests. |
| 2 | Vector takeoff adapters (`sheet_takeoff.py` pdfplumber bezier-capture, `dxf_takeoff.py` ezdxf) | **EXTEND** | pdfplumber upstream gap documented: endpoint-only curves under-read ~10% on quarter-arcs; candidate upstream PR queued. |
| 3 | Symbol auto-count (`symbol-match.ts` 510, deterministic NCC + 12-rung ladder) | **RETAIN** as frozen deterministic baseline | Detector tier later via adopted engine. |
| 4 | OCR bridge (`sheet_ocr.ts`, tesseract 5.5.0 pinned traineddata) | **RETAIN** | Deterministic, vendored eng.traineddata, harness-validated (sheet-ocr-callout). |
| 5 | Takeoff gap capabilities: room detection, revision compare, PDF annotation round-trip, scale auto-read, XLSX export, agent takeoff tools | **ADOPT pdf2takeoff** (ajflow/pdf2takeoff, Apache-2.0 verified from LICENSE text — the only permissively-licensed embeddable takeoff engine; DOM-free, ports-seamed, 15 MCP tools, runs from GitHub via pinned commit). | Integration = arm's-length Node subprocess (`bin/pdf2takeoff.js`) behind existing broker ops + harness corpus cases. **NOT BUILD** — this is the highest-value reuse of the audit (est. 10k+ LOC avoided). |
| 6 | OpenTakeoff (Kentucky-ai/opentakeoff, 721★) | **INTEGRATE arm's-length ONLY** | License verified AGPL-3.0-only from LICENSE text: code-level reuse in the Apache-2.0 platform is forbidden (ADR-0004). Optional external engine via `opentakeoff-mcp` stdio process; consume exports as evidence documents. The pre-relicense tag `apache-2.0-final` is stale — do not build on it. |
| 7 | Parametric CAD (`parametric_rebuild.py` via CadQuery/OCCT) | **RETAIN** | Kernel is already OCCT; no custom geometry kernel exists. FreeCAD registry row stays planned for the full authoring lane — never recreate FreeCAD workbenches. |
| 8 | 3D viewer (`model-viewer.tsx` three.js, renders own eos-mesh/1) | **RETAIN now** | web-ifc/That Open Engine viewer components (MPL-2.0) noted as the INTEGRATE candidate when IFC-native viewing lands. |
| 9 | Engine lanes (IFC/STEP quantities, mesh, FEA, CFD, DES, powerflow, SWMM, RTL, document conversion) | **RETAIN** | Verified reuse — every lane is a pinned engine validated by the 42/42 corpus harness. |
| 10 | CPM scheduling (`cpm.ts` + read-only Gantt) | **FREEZE — do not grow** | Full scheduling = INTEGRATE OpenProject (GPL-3.0, arm's-length REST, 16.8k★, v17.9.6) for team PM; ProjectLibre for MS Project/P6 file compat when needed. `cpm.ts` stays as the deterministic platform core. |
| 11 | Durable workflow executor | **FREEZE semantics; Stage-2 spike to choose ONE execution foundation**: Temporal (MIT, v1.32.1) vs Kestra (Apache-2.0, v2.0.7). Windmill EXCLUDED (AGPL-3.0 — GitHub license detection false-negative, verified from repo). | Binding conditions: the approval red line (human-only approve), revision publication, event vocabulary and broker authorization remain platform-owned regardless of foundation; any replacement must pass the same acceptance suite (e2e-p4-workflows 49 PASS + recovery drill 16 PASS) before the current executor is retired. Do not introduce multiple overlapping orchestration platforms. |
| 12 | LLM planner (ADR-0008) | **RETAIN** | Untrusted-advisor contract + deterministic backstops are product-specific; frameworks like LangGraph would replace plumbing the design deliberately omits. |
| 13 | Duplicated client/server mirror utilities (EXT_BY_MIME + extOf mirrored in `docs-workspace.tsx` vs `convert-document.ts`/`artifact-meta.ts`) | **RETIRE by single-sourcing** | Import from `src/lib/artifact-meta` — one implementation, no drift between client and server MIME/extension handling. |

## Scorecard (release-gate §10 metrics)

| Metric | Audit v1 value |
|---|---|
| OSS projects investigated | 49 (machine-verified GitHub REST) + 2 deep source audits |
| Projects reused | 14 live pinned engines today; +1 adopted (pdf2takeoff, Stage 1) = 15 |
| Custom code added by this audit | 0 product-engine LOC (governance only) |
| Existing code replaced | 0 (directive §8 respected — nothing working retired without benchmark; 2 mirror utilities flagged) |
| Upstream contributions | 0 yet; pdfplumber bezier-control-point PR queued as Stage-1+ candidate |
| Redundant implementations avoided | room detection, revision compare, annotation round-trip, scale auto-read, XLSX export, MCP takeoff surface (all adopted, not built) |
| License review | **PASSED** — OpenTakeoff AGPL-3.0-only (arm's-length policy), pdf2takeoff Apache-2.0 (embeddable), Windmill AGPL-3.0 discovered via manual check, ProjectLibre mirror license null (verify upstream before adoption), 14 GitHub NOASSERTION rows queued for manual pinned-tree license verification per the supply-chain rule |

## Migration plan

Staged, acceptance-suite-protected:

- **Stage 0 (this change):** ADR-0009 + docs-drift fixes + registry rows. No
  runtime code touched; CI gates unaffected.
- **Stage 1 (SHIPPED 2026-10-30, same day):** pdf2takeoff arm's-length bridge
  pinned to the exact commit `f5a1c08…`
  (`scripts/setup-pdf2takeoff.sh` + `src/engines/adapters/pdf2takeoff.ts`;
  registry state planned → **tested**), new broker ops (`compare_revisions`,
  `annotate_takeoff`, `export_boq_xlsx`, `fill_area` — BROKER_OPERATIONS
  15 → 19), corpus cases in `tests/validation` (42 → 51; the 9 p2t cases
  pin the A-102 closed forms and four honest refusals, all passing), AC
  items appended to
  [docs/06-qa/acceptance-catalogue.md](../06-qa/acceptance-catalogue.md)
  (AC-P2T-1…12). The unit suite stayed green (791 pass / 0 fail); the
  506-e2e suite runs in CI on the push (the dev sandbox lacks the seeded
  DB — recorded honestly in the AC residuals).
- **Stage 2 (SHIPPED 2026-10-30, same day):** workflow-foundation spike —
  the `WorkflowExecutionFoundation` seam + `EOS_WORKFLOW_RUNTIME` flag
  (fail-fast, default `embedded`), the embedded adapter, route wiring, 10
  seam pins (flag, port shape, describe honesty, §7 vocabulary freeze);
  unit suite 801 pass / 0 fail. Decision recorded in
  [ADR-0010](0010-workflow-foundation-spike.md): RETAIN embedded as the only
  registered foundation; DESIGNATE Temporal (MIT) the single successor lane
  behind explicit trigger criteria; REJECT Kestra (flow-semantics absorption
  of the four binding conditions + JVM footprint); the swap gate
  (e2e-p4 49 PASS + recovery drill 16 PASS on the replacement) unchanged.
- **Stage 3:** OpenProject arm's-length integration; project-graph sync
  adapter; `cpm.ts` remains frozen platform core.
- **Stage 4:** agent takeoff surface over the adopted engine (MCP tools
  exposed through ADR-0006 human-approval gates only).
- **Stage 5:** upstream contributions (pdfplumber PR) and license-register
  closure for NOASSERTION rows.

## Consequences

- One takeoff experience, not three: the adopted pdf2takeoff engine closes
  the audited gap surface behind the same broker, ledger and approval gates,
  instead of growing three parallel takeoff paths.
- Every new capability is pre-screened by the directive's §3 procedure
  (build-vs-reuse investigation with a recorded ADOPT/INTEGRATE/EXTEND/BUILD
  decision) before a line is written.
- Release gates enforce the scorecard: the reuse ratio is measured at every
  release, and the §8 rule (nothing working is retired without a benchmark)
  keeps consolidation honest.
