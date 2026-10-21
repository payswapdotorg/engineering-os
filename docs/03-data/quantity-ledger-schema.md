# Quantity Ledger & Estimating Schema

Version: 0.1 (defined in Phase 0) · **Data plane + Takeoff UI shipped 2026-10-21 (Phase-3 slice; AC-P3-01…08)** — quantity ledger rows (drawing-measured **and** model-derived via real cadquery/IfcOpenShell adapters), versioned engineer-only rates, deterministic estimates with approval gates are live. Still pending in this schema's roadmap: calibrated PDF measurement tooling, the reference-dataset validation harness (§3.3), BOQ export formats, and recompute-as-new-revision flows (Phase 4 runtime). · Owner: TL (schema) + W3 (domain logic in `src/core/ledger.ts`)

The shared quantity ledger supports **both** PDF/drawing-derived measurements **and** BIM/model-derived quantities — kept distinct, never silently merged.

## 1. QuantityRecord

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | `qty_<uuid>` | ✔ | stable identifier |
| `projectId` / `sourceArtifactRevisionId` | id refs | ✔ | ledger rows always point at a **revision**, not a mutable artifact |
| `sheetRef` | string | drawing-derived | drawing sheet / measurement region |
| `elementRef` | string | model-derived | IFC element reference (e.g. `#IfcWallGuid`) |
| `quantityType` | enum-ish string | ✔ | `length|area|volume|count|mass|time|other` (ruleset-validated) |
| `value` + `unit` | number + string | ✔ | unit string is explicit; SI preferred; conversions only via ruleset |
| `method` | enum | ✔ | `drawing-measured` \| `model-derived` — the two are never merged silently |
| `scale` / `quantityMethod` | string | calibrated-scale record for drawings; quantity-extraction method for models | |
| `rulesetId` + `rulesetVersion` | string | ✔ | which measurement/quantity rules produced it |
| `status` | enum | ✔ | `draft \| in_review \| approved \| superseded` |
| `tradeAssemblyId` | id ref | | associated trade/assembly |
| `verification` | object | | status, checker, evidence (validation run, benchmark comparison) |
| `reviewer` / `approval` | identity refs | | who reviewed/approved, when |
| `provenance` | object | ✔ | creation context, recompute history, source measurement/geometry reference |

## 2. Estimating model

- **Assembly**: trade/work breakdown with material + labor components, waste %, productivity factors, rounding rules.
- **Rate**: versioned unit rates with currency, effective dates, source (price book, contract, quote) — engineer-approved rates are never silently replaced by agent-generated assumptions.
- **EstimateLine**: quantity (by id) × assembly/rate → computed line; recalculation is deterministic and re-runnable (same inputs → same outputs).
- **Estimate**: overhead, profit, taxes, currency, assumptions (visible and versioned), approval state, export targets (BOQ report formats).

## 3. Determinism & validation rules

1. Every number of record is computed by deterministic code (no LLM arithmetic; ADR-0006).
2. Recomputation of an approved quantity/line creates a **new revision** with provenance; it never overwrites the approved row.
3. Validation harness (Phase 3): known datasets for (a) measured drawing quantities (calibrated scale, cutouts, symbol counts where supported) and (b) IfcOpenShell-derived quantities on reference IFC models; results must match known answers within stated tolerance before any capability is marked `tested`.
4. Bluebeam/PlanSwift parity is **not** claimed until benchmark tests cover measurement accuracy, annotations, calibrated scales, multi-sheet, cutouts, revision comparison, assemblies, pricing, reports and interoperability.
