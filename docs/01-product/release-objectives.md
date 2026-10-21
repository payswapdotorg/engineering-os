# Release Objectives — Phase Exit Criteria

Owner: TL · A phase is done when its exit criteria are **demonstrated**, not documented.

| Phase | Exit criteria | Status |
|---|---|---|
| **0 — Source-verified audit** | Baseline established; ownership map; ADRs for architecture, storage, licensing, engine contract, agent safety; first capability matrix; working test/build commands; tasks assigned to W1/W2/W3 | ✅ complete (2025) |
| **1 — Working product foundation** | App installable & launches reliably; creates a persistent project; records a real source artifact and its revision (content hash, download round-trip); engine discovery shows real installed/not-installed states; audit trail visible; Ubuntu dev-install documented | 🚧 in progress — see [acceptance catalogue](../06-qa/acceptance-catalogue.md) |
| **2 — CAD & BIM workflows** | Real file import (FCStd/IFC/DWG/PDF…), editing through selected editor, export, revision comparison; unsupported formats/operations surfaced explicitly; a complete CAD **or** BIM journey against real files | planned |
| **3 — Takeoff, estimating, controls** | Drawing-derived **and** model-derived quantity workflows produce traceable, reviewed results and a usable estimate; shared quantity ledger; BOQ + schedule links; OpenTakeoff source-audited (integrate only if viable) | planned |
| **4 — Collaboration & agent workflows** | Durable tool execution with retries/recovery; real adapter calls; approval gates enforced; downstream invalidation runs; an agent executes a real multi-step workflow on persisted artifacts and obtains review before publishing | planned |
| **5 — Broader engineering packs** | GIS, E/E, structural, CFD, systems, industrial, robotics: each pack has documented capability boundary, real execution test, regression suite, ≥1 useful end-to-end workflow | planned |
| **6 — Hardening & release readiness** | Security/performance/recovery work; repeatable Ubuntu installation + release process with system requirements, logs, troubleshooting; demonstrable launch | planned |

Progress is tracked by acceptance items, never by code volume, tool count or screen count.
