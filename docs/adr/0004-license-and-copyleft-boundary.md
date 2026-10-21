# ADR-0004 — License & copyleft boundary: Apache-2.0 platform, arm's-length engine integration

Status: accepted · Date: 2025 (Phase 0)

## Context

The engine inventory includes strong copyleft projects (GPL-2.0/3.0: LibreCAD, LibreDWG, Blender, QGIS, GRASS, Code_Aster, Elmer, OpenProject; AGPL-3.0: KiCad; LGPL: FreeCAD, IfcOpenShell; permissive: Yosys ISC, OpenROAD BSD, ParaView BSD, …). A prior evaluation in our organization also documented a supply-chain case where a packaged artifact's COPYING.txt (GPLv3) contradicted its declared metadata (MIT) — license fields are data, not truth, until verified against the actual source tree.

## Decision

1. Engineering OS platform code is **Apache-2.0**.
2. Engines are integrated **at arm's length**: separate processes (CLI/server), never linked in-process into platform code. Adapter boundaries (spawn + typed I/O) keep copyleft obligations on the engine side.
   - Exception path: in-process Python/library integration is permitted only after a written license review records the dependency as compatible (e.g. LGPL with dynamic import and no modification), recorded in `docs/08-licenses/license-inventory.md`.
3. Bundling/redistribution of any engine is a release-gate activity: exact upstream repo, tag/commit and license text must be recorded and re-verified at release time. GitHub's API license field is a hint; the governing text is the LICENSE file **in the pinned source tree**.
4. Every candidate engine gets a license-inventory row with SPDX ID, verification date and source URL before any `installed` state is claimed.

## Consequences

- The platform can be permissive while hosting GPL engines without relicensing either side.
- "Works out of the box with FreeCAD" means "detects and drives an installed FreeCAD" — we do not redistribute engines until the Phase-6 release review completes.
- Users install engines from upstream; our installer may detect them, and a future installer can offer engine installation, per engine license, as a separate reviewed step.
