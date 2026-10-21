# Engine Inventory — source-verified audit

Owner: Worker 2 (Engines & Integration) · Audit date: **2026-10-21** · Registry: [`src/engines/registry.json`](../../src/engines/registry.json) · Contract: [ADR-0005](../adr/0005-engine-integration-contract.md) · License policy: [ADR-0004](../adr/0004-license-and-copyleft-boundary.md)

## Honest status — read first

- **None of the 34 engines below is installed on the dev host.** Every registry `state` is `planned`. No capability is marked complete because a dependency exists; capability states live in [capability-matrix.md](capability-matrix.md).
- **All 34 upstream records were machine-verified during this audit run** (repo, license, latest stable, activity). GitHub's `license.spdx_id` is treated as a hint per ADR-0004; where it returned `NOASSERTION` or conflicted with the source tree, the pinned-tree LICENSE/COPYING text was fetched and cited. 10 of 34 required LICENSE-text resolution (see [License notes](#license-notes)).
- **Bundling/redistribution of any engine is a Phase-6 release-gate activity**: exact upstream repo, tag/commit and license text must be re-verified at release time (ADR-0004 §3). `planned` never implies redistribution.
- Engine integration is arm's-length (separate processes / MCP / REST), driven only by the broker (ADR-0005 rule 1).

## Audit method

Date: **2026-10-21** (UTC). All checks performed live from the audit host; every engine carries `upstream.verifiedAt = 2026-10-21` plus a per-engine `verifiedMethod` in the registry. Endpoints used:

| Source | Endpoints |
|---|---|
| GitHub REST API (`api.github.com`, authenticated) | `GET /repos/{owner}/{repo}` (license.spdx_id, pushed_at, archived, description), `GET /repos/{owner}/{repo}/releases/latest` (tag_name), `GET /repos/{owner}/{repo}/tags` (for repos with no GitHub releases), `GET /repos/{owner}/{repo}/contents/{file}` (raw LICENSE/COPYING text), `GET /orgs/{org}/repos` and `GET /users/{user}/repos`, `GET /search/repositories?q={name}` (OpenTakeoff + slug-404 corrections), `GET /repos/{repo}/git/trees/{branch}?recursive=1` (ProjectLibre license files) |
| GitLab API (`gitlab.com`) | `GET /api/v4/projects/{path}` (codeaster/src, team-simpy/simpy), `GET /api/v4/projects/{path}/repository/tags`, `GET .../repository/tree`, `GET .../repository/files/{file}` (license texts) |
| SourceForge REST | `GET /rest/p/ngspice` (license category), `GET /projects/ngspice/best_release.json`, same for `projectlibre` |
| PyPI JSON API | `GET /pypi/simpy/json`, `GET /pypi/ifcopenshell/json` (version + source URLs); simpy LICENSE read from the sdist tarball |
| npm registry | `GET /registry.npmjs.org/opentakeoff-mcp` (dist-tag, `bin`, license) |
| Upstream docs pages | `gmsh.info` (current stable 4.15.2 + `LICENSE.txt`), `verilator.org/guide/latest` (dual license), `blender.org/about/license/`, `libreoffice.org/download/` + `/about-us/licenses/`, `qgis`/`grass`/etc. COPYING via GitHub contents API |

Unreachable/honest-failure cases: `gitlab.onelab.info` (Gmsh canonical) returns a bot-challenge page to API calls — Gmsh was verified via gmsh.info instead (recorded per-engine); `projectlibre.com` returned HTTP 403 — ProjectLibre verified via SourceForge (its actual distribution channel, per the mirror's homepage field). Where `releases/latest` 404s, the latest stable was taken from `/tags` (or upstream site) and is noted per engine.

## Master audit table (34 engines, all state: `planned`)

| Key | Name | Domain | Canonical upstream | License (SPDX or honest text) | Latest stable (audit) | Verified (date + method) | Registry state | Planned integration |
|---|---|---|---|---|---|---|---|---|
| freecad | FreeCAD | cad | freecad.org (repo FreeCAD/FreeCAD) | LGPL-2.1 (GitHub field; repo LICENSE = LGPL v2.1 text) | 1.1.4 (tag `1.1.4`) | 2026-10-21 · github-api `/repos` + `releases/latest` | planned | cli, python-module, native-process |
| librecad | LibreCAD | cad | librecad.org (repo LibreCAD/LibreCAD) | GPL-2.0 (repo LICENSE text; GitHub field NOASSERTION) | 2.2.1.6 (tag `v2.2.1.6`) | 2026-10-21 · github-api + LICENSE text | planned | cli, native-process |
| libredwg | LibreDWG | cad | savannah.gnu.org (repo LibreDWG/libredwg, official mirror) | GPL-3.0 | 0.14 (tag `0.14`) | 2026-10-21 · github-api + `releases/latest` | planned | cli (dwg2dxf/dwgread/dwgwrite) |
| blender | Blender | cad | blender.org (repo blender/blender, official mirror) | GPL-2.0-or-later (repo COPYING + GPL-license.txt + blender.org) | 5.2.2 (tag `v5.2.2`; no GitHub releases) | 2026-10-21 · github-api + LICENSE text + upstream docs | planned | cli, python-module, native-process |
| ifcopenshell | IfcOpenShell | bim | ifcopenshell.org (repo IfcOpenShell/IfcOpenShell) | LGPL-3.0 (GitHub field) | 0.9.0 (PyPI; GitHub "latest" = Bonsai 0.9.1-alpha) | 2026-10-21 · github-api + PyPI JSON | planned | python-module, cli |
| thatopen-engine | That Open Engine (components) | bim | thatopen.com (repo ThatOpen/engine_components) | MIT | 3.4.9 (tag `v3.4.9`) | 2026-10-21 · github-api (suggested `ThatOpen/engine` 404s — family repos listed via `/orgs/ThatOpen/repos`) | planned | web-module (viewer components) |
| web-ifc | web-ifc | bim | thatopen.com (repo ThatOpen/engine_web-ifc) | MPL-2.0 | 0.78 (tag `0.78`) | 2026-10-21 · github-api | planned | web-module (WASM IFC parsing) |
| qgis | QGIS | gis | qgis.org (repo qgis/QGIS) | GPL-2.0 (GitHub field; repo COPYING = GPLv2 text) | 3.44.15 (tag `final-3_44_15`) | 2026-10-21 · github-api + `releases/latest` | planned | cli (qgis_process), native-process |
| grass | GRASS GIS | gis | grass.osgeo.org (repo OSGeo/grass) | GPL-2.0-or-later (repo COPYING text; GitHub field NOASSERTION) | 8.5.0 (tag `8.5.0`) | 2026-10-21 · github-api + COPYING text | planned | cli, python-module |
| swmm | EPA SWMM | gis | epa.gov (repo USEPA/Stormwater-Management-Model) | Public Domain — US Gov (repo README; no LICENSE file) | 5.2.4 (tag `v5.2.4`) | 2026-10-21 · github-api + README text (suggested slug USEPA/SWMM 404s) | planned | cli (runswmm/swmm5) |
| pyswmm | pyswmm | gis | pyswmm.org (repo pyswmm/pyswmm) | BSD-2-Clause (repo LICENSE.txt text; GitHub field NOASSERTION) | 2.2.0 (tag `v2.2.0`) | 2026-10-21 · github-api + LICENSE text | planned | python-module |
| opentakeoff | OpenTakeoff | takeoff | github.com/Kentucky-ai/opentakeoff | AGPL-3.0 (GitHub field; npm declares AGPL-3.0-only) | 0.9.98 (tag `mcp-v0.9.98` = npm dist-tag) | 2026-10-21 · github search + github-api + npm registry | planned | mcp (opentakeoff-mcp), server |
| kicad | KiCad | ee | gitlab.com/kicad/code/kicad (GitHub mirror KiCad/kicad-source-mirror) | GPL-3.0-or-later (repo LICENSE + LICENSE.README; GitHub field GPL-3.0) | 10.0.7 (tag `10.0.7`) | 2026-10-21 · github-api + LICENSE texts (suggested slug KiCad/kicad redirects to mirror) | planned | cli (kicad-cli), native-process |
| qelectrotech | QElectroTech | ee | qelectrotech.org (repo qelectrotech/qelectrotech-source-mirror) | GPL-2.0 (repo LICENSE = GPLv2 text) | 0.100 (tag `0.100`; README: released 2026-01-25) | 2026-10-21 · github search + github-api + LICENSE text | planned | cli, native-process |
| ngspice | ngspice | ee | sourceforge.net/projects/ngspice (mirror imr/ngspice) | BSD-3-Clause "Modified BSD" (SF license category + mirror COPYING text) | 47 (SF best_release `ngspice-47.tar.gz`, 2026-08-11) | 2026-10-21 · sourceforge REST + github-api (mirror) | planned | cli (batch), server (shared lib after review) |
| pandapower | pandapower | ee | pandapower.org (repo e2nIEE/pandapower) | BSD-3-Clause (repo LICENSE text; GitHub field NOASSERTION) | 3.5.6 (tag `v3.5.6`) | 2026-10-21 · github-api + LICENSE text | planned | python-module |
| ghdl | GHDL | ee | github.com/ghdl/GHDL | GPL-2.0 (GitHub field) | 6.0.0 (tag `v6.0.0`) | 2026-10-21 · github-api + `releases/latest` | planned | cli |
| yosys | Yosys | ee | yosyshq.net (repo YosysHQ/yosys) | ISC | 0.70 (tag `v0.70`) | 2026-10-21 · github-api + `releases/latest` | planned | cli |
| verilator | Verilator | ee | verilator.org (repo verilator/verilator) | LGPL-3.0 OR Artistic-2.0 (upstream guide; repo LICENSE = LGPLv3 text; GitHub field NOASSERTION) | 5.052 (tag `v5.052`; no GitHub releases) | 2026-10-21 · github-api + LICENSE text + upstream docs | planned | cli |
| openroad | OpenROAD | ee | theopenroadproject.org (repo The-OpenROAD-Project/OpenROAD) | BSD-3-Clause | 2.0 (tag `v2.0`; no GitHub releases) | 2026-10-21 · github-api + `/tags` | planned | cli |
| gmsh | Gmsh | simulation | gmsh.info (canonical code host gitlab.onelab.info/gmsh/gmsh) | GPL-2.0-or-later with linking exception (gmsh.info/LICENSE.txt) | 4.15.2 ("Current stable release", 2026-03-24, gmsh.info) | 2026-10-21 · upstream docs page + LICENSE.txt (canonical GitLab API bot-challenged — noted) | planned | cli, python-module |
| code-aster | Code_Aster | simulation | code-aster.org (repo gitlab.com/codeaster/src) | GPL-3.0 (repo LICENSE = GPLv3 text, gitlab-api) | 17.5.8 (gitlab tags; 18.1.x dev series present) | 2026-10-21 · gitlab-api project + tree + file + tags | planned | cli (as_run), python-module |
| elmerfem | Elmer FEM | simulation | elmerfem.org (repo ElmerCSC/elmerfem) | GPL-2.0 (repo LICENSE.md "GPL 2.0"; GitHub field NOASSERTION) | 26.2 (tag `release-26.2`) | 2026-10-21 · github-api + LICENSE text | planned | cli, native-process |
| opensees | OpenSees | simulation | opensees.berkeley.edu (repo OpenSees/OpenSees) | **NOASSERTION — custom UC Regents license** (repo COPYRIGHT: educational/research/non-profit **noncommercial**; other entities internal use; commercial needs UC license) | 3.8.0 (tag `v3.8.0`) | 2026-10-21 · github-api + COPYRIGHT text | planned | cli, python-module (pending license review) |
| openfoam | OpenFOAM (Foundation) | simulation | openfoam.org (repo OpenFOAM/OpenFOAM-14) | GPL-3.0-or-later (repo COPYING text) | 14 (repo `OpenFOAM-14`, tag `version-14`) | 2026-10-21 · github-api (user repos) + COPYING text | planned | cli (solvers/utilities) |
| paraview | ParaView | simulation | paraview.org (repo Kitware/paraview) | BSD-3-Clause | 6.2.0 (tag `v6.2.0`; no GitHub releases) | 2026-10-21 · github-api + `/tags` | planned | cli (pvpython/pvbatch), native-process |
| openmodelica | OpenModelica | simulation | openmodelica.org (repo OpenModelica/OpenModelica) | AGPL-3.0 OR OSMC-PL-1.8 (repo OSMC-License.txt; GitHub field NOASSERTION) | 1.27.1 (tag `v1.27.1`) | 2026-10-21 · github-api + OSMC-License text | planned | cli (omc), native-process |
| dwsim | DWSIM | simulation | dwsim.org (repo DanWBR/dwsim10; historical DanWBR/dwsim **ARCHIVED**) | GPL-3.0 (GitHub field) | 10.2.12 (tag `v10.2.12`) | 2026-10-21 · github search + github-api (suggested slug DWSIM/DWSIM 404s) | planned | native-process, cli |
| simpy | SimPy | simulation | simpy.readthedocs.io (repo gitlab.com/team-simpy/simpy) | MIT (PyPI sdist LICENSE text) | 4.1.2 (gitlab tags + PyPI) | 2026-10-21 · PyPI JSON + gitlab-api (github simpy/simpy 404s — project moved to GitLab) | planned | python-module |
| ros2 | ROS 2 | simulation | github.com/ros2 + docs.ros.org (repo ros2/ros2 superproject) | null (superproject; core e.g. ros2/rclcpp Apache-2.0 — per-component verification) | "Lyrical" distribution (tag `release-lyrical-20260807`) | 2026-10-21 · github-api superproject + rclcpp | planned | cli (ros2), server (DDS) |
| gazebo | Gazebo (gz-sim) | simulation | gazebosim.org (repo gazebosim/gz-sim) | Apache-2.0 | 10.0.0 (tag `gz-sim10_10.0.0`) | 2026-10-21 · github-api + `releases/latest` | planned | cli (gz sim), server (headless) |
| libreoffice | LibreOffice | docs | libreoffice.org (mirror repo LibreOffice/core) | GPL-3.0 per mirror COPYING (v3 text) — **conflicts with libreoffice.org dual MPL-2.0/LGPL-3.0-or-later statement**; Phase-6 resolution required | 26.8 (libreoffice.org; 26.2 also listed; no GitHub releases/tags) | 2026-10-21 · github-api + COPYING text + upstream site | planned | cli (headless convert), native-process |
| openproject | OpenProject | controls | openproject.org (repo opf/openproject) | GPL-3.0 (GitHub field) | 17.9.2 (tag `v17.9.2`) | 2026-10-21 · github-api + `releases/latest` | planned | server (REST API), cli (packaged) |
| projectlibre | ProjectLibre | controls | sourceforge.net/projects/projectlibre (mirror smartqubit/projectlibre) | CPAL-1.0 (SF license category + mirror license dir; no LICENSE at repo root) | 1.9.8 (SF best_release, 2025-04-28) | 2026-10-21 · github-api (mirror, inactive since 2022) + sourceforge REST | planned | native-process, cli |

## Per-domain notes — role in Engineering OS

- **cad** — FreeCAD is the parametric modeling core (Phase 2); LibreCAD covers 2D drafting; LibreDWG is the DWG↔DXF compatibility boundary (never in-process, GPLv3); Blender hosts the Bonsai IFC authoring workflow.
- **bim** — IfcOpenShell (python) is the validation/quantity engine (Phase 3); web-ifc + That Open Engine components power the in-app 3D/IFC viewer (Phase 2). No-probe rows: JS/WASM modules detected by package-lock inspection at adapter time, not PATH probing.
- **gis** — QGIS (qgis_process) and GRASS provide geospatial processing and CRS handling for site/civil context; EPA SWMM + pyswmm cover drainage/stormwater analysis (civil), with pyswmm as the in-process python option (BSD-2).
- **takeoff** — OpenTakeoff (AGPL-3.0) is the first agent-drivable PDF takeoff engine (MCP) plus a human canvas; drawing-derived quantities from it feed the shared quantity ledger strictly separated from model-derived ones.
- **ee** — KiCad (PCB/schematic, kicad-cli), QElectroTech (electrical diagrams), ngspice (SPICE), pandapower (power systems), and the open chip-design flow GHDL → Yosys → Verilator → OpenROAD (Phase 5 EE pack).
- **simulation** — Gmsh (meshing), Code_Aster/Elmer/OpenSees (structural FEA), OpenFOAM (CFD), ParaView (post-processing/visualization), OpenModelica (system dynamics/Modelica), DWSIM (chemical process), SimPy (discrete-event), ROS 2 + Gazebo (robotics).
- **docs/controls** — LibreOffice headless for document conversion; OpenProject (REST server) and ProjectLibre (desktop) for construction controls/scheduling (Phase 3/5).

## OpenTakeoff candidate audit (mandated)

Searched `GET /search/repositories?q=opentakeoff` on 2026-10-21. **Result: credible, active project FOUND.**

- **[Kentucky-ai/opentakeoff](https://github.com/Kentucky-ai/opentakeoff)** — 638 stars, last push 2026-10-21 (same day), not archived, not a fork. Self-described "Open-source (AGPL-3.0) PDF takeoff for construction & flooring — the first engine an AI agent drives natively over MCP". 53 MCP tools + browser canvas; npm package `opentakeoff-mcp` (dist-tag 0.9.98, `bin: opentakeoff-mcp`, license AGPL-3.0-only); live demo + MCP registry entry + multi-lingual docs; frequent dated releases (`mcp-v0.9.98`).
- Other hits are clearly secondary (9-star academy site; small personal clones of the same project; 0-star namesakes) — not credible alternates.
- **Recorded** as registry key `opentakeoff`: state `planned`, `verified: true` (method: github search + repo API + npm registry). Honest caveats: pre-1.0 (0.9.98), AGPL-3.0 (npm metadata declares AGPL-3.0-only) → strict arm's-length process/network integration (ADR-0004), pin exact tag at integration.

## License notes (NOASSERTION resolutions, conflicts, surprises)

1. **NOASSERTION resolved by reading the pinned tree** (per ADR-0004 — GitHub's field is a hint, the tree text is truth): LibreCAD (GPLv2), GRASS (GPL-2.0-or-later), pandapower (BSD-3-Clause), pyswmm (BSD-2-Clause), Elmer (GPL-2.0), OpenModelica (AGPL-3.0 OR OSMC-PL-1.8), Verilator (LGPLv3 text; upstream guide states LGPL-3.0 or Artistic-2.0), OpenSees (custom UC Regents — see 3), ngspice ("Modified BSD" = BSD-3-Clause via SF + mirror COPYING), code_aster (GPLv3 via gitlab-api), gmsh (GPLv2-or-later with exception via gmsh.info/LICENSE.txt).
2. **LibreOffice conflict (flagged, unresolved)**: the GitHub mirror's `COPYING` at `master` is pure GPLv3 text (674 lines; GitHub license field `GPL-3.0`), while libreoffice.org/about-us/licenses describes a dual **MPL-2.0 OR LGPL-3.0-or-later** scheme. This is exactly the metadata-vs-text class of risk ADR-0004 was written for; resolved only by pinning the release tree at Phase 6.
3. **OpenSees is NOT OSI open source**: repo `COPYRIGHT` grants noncommercial educational/research/non-profit use and internal-only use for others; commercial incorporation needs a UC license. Treated as a license-risk row — no `available` state until a written review exists.
4. **KiCad seed corrected**: the Phase-0 seed registry claimed AGPL-3.0. The pinned tree (`LICENSE`, `LICENSE.README`) at HEAD states **GPLv3-or-later** ("majority of KiCad's source code … under the terms of the GPLv3 or later"), consistent with GitHub's `GPL-3.0` field. The registry now records GPL-3.0-or-later.
5. **DWSIM moved**: historical repo `DanWBR/dwsim` is **archived**; active development is `DanWBR/dwsim10` (v10.2.12). Registry tracks the new repo.
6. **SimPy moved**: `simpy/simpy` on GitHub 404s — PyPI machine-verifies the move to **gitlab.com/team-simpy/simpy** (MIT, 4.1.2).
7. **Public-domain special case**: EPA SWMM has no SPDX id — repo README states the source "is released in the Public Domain" (US Government work); recorded honestly as `Public Domain (US Gov)`.
8. **GitHub legacy license ids**: GitHub returns shorthand ids (`LGPL-2.1`, `GPL-3.0`, `GPL-2.0`) rather than modern SPDX `-only/-or-later` forms; where the "or later" scope matters, the tree text was read (GRASS, OpenFOAM, gmsh, Blender) or the scope is flagged for Phase-6 pinning (FreeCAD, QGIS, KiCad).

## Detection probes

Probe design and mechanics (executable / python-module, 4s timeout, presence-only rows, empty `probes: []` for web-module engines) are defined in `src/engines/index.ts` and tested in `src/engines/detect.test.ts` (5 passing tests; no network, no real engines — fixture registry + temp-dir executables only).
