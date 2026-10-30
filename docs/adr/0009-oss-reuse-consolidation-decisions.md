# ADR-0009 — Open-Source Reuse & Consolidation Decisions v1

Status: **Accepted** · Date: 2026-10-31 · Owner: TL
Directive: the binding open-source reuse directive — §3: *every BUILD decision requires an ADR naming the alternatives investigated and why they were rejected*; §4C/§4E/§4F: *immediate, mandatory investigations*.
Evidence base: [OSS Reuse & Consolidation Audit v1](../02-engines/oss-reuse-consolidation-audit-v1.md) — source-verified throughout: upstream trees cloned and read on this host, both takeoff candidates **live-probed against our own fixtures**, npm/PyPI registries queried, license claims read from tree text (never remembered).
Policy parents: [ADR-0004](0004-license-and-copyleft-boundary.md) · [ADR-0005](0005-engine-integration-contract.md) · [ADR-0006](0006-agent-safety-and-approval-gates.md) · [ADR-0008](0008-llm-planner-untrusted-advisor.md)

## Context

The binding open-source reuse directive arrived after Slice 30. Its core rule — *integrate an existing solution before implementing an equivalent capability ourselves* — demanded (1) a repo-wide reuse audit of every custom implementation, (2) the mandated comparative audit of our Sheet Measure vs OpenTakeoff vs pdf2takeoff (§4C), (3) the workflow-orchestration audit against Temporal/Kestra (§4F) and PM engines (§4E), and (4) registry/license-register completions, all before the next capability expansion. The audit (v1, same date) performed all of this; this ADR records the decisions. Context that shaped them: the platform is already adapter-first (ADR-0005 — the broker is the single execution path; 14 engines `tested` through harness-validated adapters), the deployment target is a single Ubuntu host with systemd (ADR-0001/0003), and the acceptance battery (unit 820/0 · harness 42/42 · e2e 535/0 at decision time) must never regress for a reuse swap.

## Decision

### D1 — Durable workflow executor: **BUILD (retain)** — Temporal/Kestra investigated and rejected *for now*

- **Investigated (source-verified)**: Temporal — MIT server (10,132 commits, active daily), MIT TypeScript SDK, single Go binary, dev server runs SQLite, production needs PostgreSQL/MySQL/Cassandra + optional ES; durable execution via event-history replay; human-in-the-loop is a *pattern* (signals/updates), not an approver-identity model. Kestra — Apache-2.0 (13,459 commits, active), JVM + H2-embedded/external-DB personas; YAML task-runner; ships its own `Approval` plugin with a review UI/API.
- **Rejected for now because**: (a) contract scope — our executor is 1..8 linear sequential steps, single host, single operator (workflow-runtime-contract §10 exclusions: no concurrency, no eventing, no scheduling); the machinery these engines commoditize is explicitly out of scope; (b) product semantics stay ours by directive — session-user approver red line (ADR-0006), artifact approval/supersede machine, broker execution records (ADR-0005), staleness cascade; Kestra's Approval surface would *move approvals outside our auth + audit model* and its task-runner execution would bypass the broker (rule 1 violation); (c) deployment weight — an always-on Go server + DB (Temporal) or a JVM + DB (Kestra) added to a single-systemd-unit host for capabilities the contract excludes.
- **Standing designation**: Temporal is the *single* designated scale-out candidate, to be evaluated ONLY behind a thin **execution-adapter seam** (interface over enqueue/claim/run-step/approve, sketched in the audit §8) if concurrency, scheduling or multi-node execution ever enters contract scope. The one-engine rule (directive §4F) forbids adopting any orchestration platform alongside another.
- **Re-evaluation triggers**: contract-scope change (concurrency/multi-node/scheduled triggers), or a demonstrated durability defect in our recovery-scan model that a retry-driven reimplementation cannot close.

### D2 — CPM schedule core (`src/core/cpm.ts`): **BUILD (retain)** — no maintained library alternative exists

- **Investigated**: npm registry scan — `@korastd/critical-path-method` (MIT, v0.1.0, created 2026-08-20, single version, single maintainer — not a serious candidate); `critical-path` (ISC, last publish 2015), `pert` (MIT, 2015), `cpm` (MIT, 2014) — all dead ~10 years; `toposort`/`graphlib`/`dagre` — graph utilities/layout with **no CPM arithmetic** (no floats, no critical path). Gantt UI widgets (`frappe-gantt`, `gantt-task-react`, dhtmlx community) are presentation, not scheduling math. OpenProject (GPL-3.0, Rails monolith) and ProjectLibre (CPAL-1.0, Java Swing desktop) are **never embeddable** — verified in-tree; they stay arm's-length candidates for REST/file-format interop (OpenProject API v3; ProjectLibre MSPDI-XML / P6-XER exchange classes) for heavy PM features, never replacements for the in-app analysis.
- **Retained because**: the 273-line pure core is byte-deterministic by construction, pins §3.1-verbatim error semantics, and is validated by 15 unit tests + the harness's 28-pin 6-activity case; the broker op `analyze_schedule` renders it honestly as platform math (engineKey absent). Replacing it with any investigated candidate is a strict regression.

### D3 — Takeoff: ours stays the system of record; **one coherent takeoff experience** (consolidation policy)

- **Retained (BUILD)**: `src/core/measure.ts` (frozen API; our cutout semantics — v1 strictly-inside shoelace + v2 crossing-boundary Sutherland–Hodgman with gross/cutout/net accounting — have no equivalent in pdf2takeoff, and OpenTakeoff's turf-based `cut_out` is AGPL-walled), `src/core/symbol-match.ts` (deterministic zoom-independent NCC + 12-rung ladder), the pdfplumber vector adapter (exact bezier CTM paths), the ezdxf adapter (mm-gated), the tesseract OCR adapter (binary + model-pinned tessdata + Ø-normalization), page-rotation.ts (empirically probed against our exact pdfjs pin).
- **Consolidation rule (directive §4C: "one coherent takeoff experience, not three competing systems")**: **pdf2takeoff (Apache-2.0)** is the designated *adapter-first* source for the four capability deltas the platform lacks — room/region fill (`fill_area`/Magic Fill), revision compare (pixel diff + quantity delta), standard PDF annotation round-trip (Bluebeam/Acrobat), OCR-vote scale auto-detect. Each ships as a broker adapter behind its own contract addendum (audit §8 Phase B/C), is benchmark-gated against our adapters on the shared fixtures, and never becomes a second user-facing takeoff UI. **OpenTakeoff (AGPL-3.0-only)** contributes agent intelligence through the MCP wall only — never vendored, never an imported dependency (D5); its `apache-2.0-final` tag is recorded as a counsel-only fallback, never relied on. Watch-items for pdf2takeoff are pinned in its registry record (CVE-stale `xlsx` dep, LGPL `libheif-js`, two-week-old single-author project — pin the exact commit).
- **ADOPT (pattern)**: standard-annotation round-trip follows pdf2takeoff's Apache-2.0 `read.ts`/`annotate.ts` (pdf-lib) pattern when that lane ships — the only one of the three stacks that reads annotations back instead of burning pixels (OT) or storing DB-only markups (ours).

### D4 — Symbol auto-count: **BUILD (retain) + EXTEND path**

Ours is deterministic and provenance-grade; OpenTakeoff's vector-fingerprint sweep is AGPL (stays behind the MCP wall); pdf2takeoff's `scan-vector.ts`/`scan-cv.ts` CV tier is an Apache-2.0 **EXTEND** candidate behind a broker adapter, adoptable only if it wins the shared-fixture benchmark. No swap without the benchmark.

### D5 — MCP-over-stdio is arm's-length (ADR-0004 §2 clarification, codified)

Running an unmodified AGPL engine as a **separate process** speaking MCP/JSON-RPC over stdio is a process-boundary integration — the same class as the LibreOffice/pdfplumber/tesseract process boundaries the broker already uses. Importing the AGPL package as a library dependency, vendoring its source, or bundling its dist is NOT arm's-length and remains forbidden. Verification evidence: the opentakeoff-mcp 0.9.100 server probed live on this host against `tests/fixtures/sheet-a102-plan.pdf` — 58 tools via `tools/list`; `load_plan` detected 1:100 on all 4 pages including the rotated p4; `set_scale use_detected` returned the exact metric calibration with `confirmed:false` (the human-confirm governance gate observed live); `measure_polygon` reproduced the analytic rectangle (9846 SF / 405.09 LF at printed precision).

### D6 — Registry + license-register completions (done in this slice)

Five source-verified registry records added (44 → 49): `pdf2takeoff` (Apache-2.0 — the directive's "Python" assumption corrected: it is TypeScript, git-distributed only), `temporal` (MIT), `kestra` (Apache-2.0), `solvespace` (GPL-3.0-or-later — deferred; cadquery already serves the parametric lane), `gdal` (MIT-style core + enumerated per-file exceptions). The platform-dependency license table gained 25 previously-missing rows (all permissive/public-domain); `z-ai-web-dev-sdk` is flagged: it ships **no license text at all** (field-only ISC) — the register's only open supply-chain item, escalated for vendor follow-up. UI-side duplicated code retired: the byte-identical `eos-cpm/1` payload mapping (×2) and the duration formatter (×2) consolidated into `format.ts` — semantics preserved exactly (the stricter Controls envelope rule kept at its call site).

## Alternatives investigated (summary)

| Subsystem | Alternatives (evidence in audit v1) | Decision |
|---|---|---|
| Workflow executor | Temporal (MIT), Kestra (Apache-2.0) | BUILD retained; Temporal = designated seam candidate (D1) |
| CPM core | npm scan (no maintained library); OpenProject, ProjectLibre (arm's-length only) | BUILD retained (D2) |
| Measurement core / cutouts | OpenTakeoff (turf, AGPL), pdf2takeoff (no cutouts) | BUILD retained (D3) |
| Symbol auto-count | OpenTakeoff sweep (AGPL), pdf2takeoff CV tier (Apache-2.0) | BUILD retained + EXTEND path (D4) |
| OCR | OpenTakeoff canvas-only (AGPL, headless-unusable), pdf2takeoff tesseract.js (wasm, browser-grade) | BUILD retained (tesseract binary, model-pinned) |
| Vector/DXF extraction | OpenTakeoff `get_sheet_vectors` (MCP), pdf2takeoff pdf.js scan tier | BUILD retained (pdfplumber CTM-exact, ezdxf) |
| Room detection / rev-compare / annotations | pdf2takeoff (Apache-2.0, adapter-first), OpenTakeoff (MCP wall) | INTEGRATE via broker adapters, benchmark-gated (D3) |
| Parametric CAD | SolveSpace (GPL-3.0+) | Deferred — cadquery (tested) already serves it |
| Duplicated UI normalization/formatting | — (internal duplication) | Retired: consolidated into format.ts |

## Consequences

- The acceptance battery is untouched by the decisions (the frozen contracts stay frozen; the consolidated UI helpers are semantics-preserving and re-verified by the existing unit + e2e suites).
- Future takeoff lanes have a fixed order: benchmark on the shared fixtures first, contract addendum second, broker adapter third, benchmark re-earn on every upstream bump (the pdf2takeoff commit pin).
- The one-engine rule is now enforceable in review: any proposal introducing an orchestration platform, a second takeoff UI, or an in-process AGPL dependency is rejected by this ADR.
- The `z-ai-web-dev-sdk` license-text gap is tracked until the vendor ships a LICENSE file or a replacement is selected.

## Re-evaluation triggers

- Executor: contract-scope change (concurrency / scheduled triggers / multi-node), or a durability defect class the recovery-scan model cannot close → evaluate Temporal behind the seam.
- Takeoff: pdf2takeoff goes inactive or its engine loses the shared-fixture benchmark → re-open the audit's Phase B/C decisions (OpenTakeoff MCP wall unchanged).
- CPM: a maintained, harness-comparable CPM library appearing in the npm registry → re-run D2 against it.
