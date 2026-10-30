# License Inventory

Owner: TL (platform) + W2 (engines) · Policy: [ADR-0004](../adr/0004-license-and-copyleft-boundary.md)

## 1. Platform license

Engineering OS platform code: **Apache-2.0** (`/LICENSE`).

## 2. Platform dependencies (runtime)

| Package | License (SPDX) | Notes |
|---|---|---|
| next, react, react-dom | MIT | framework |
| prisma / @prisma/client | Apache-2.0 | data layer |
| tailwindcss, tw-animate-css | MIT | styling |
| Radix UI primitives | MIT | component primitives |
| class-variance-authority, clsx, tailwind-merge | Apache-2.0/MIT/… | shadcn/ui toolchain |
| lucide-react | ISC | icons |
| zod | MIT | validation |
| sonner, next-themes, date-fns, uuid, framer-motion | MIT | product UX utilities |
| @tanstack/react-query, react-hook-form, @hookform/resolvers | MIT | client state/forms |
| next-auth | ISC | available; auth lands Phase 4 |

All of the above are permissive (MIT/Apache-2.0/ISC) — no copyleft in the platform's runtime dependency tree. (Exact versions: `package.json`; lockfile `bun.lock`.)

## 3. Engine candidates (upstream)

> **Engine candidates, source-verified 2026-10-21/25/29 + the 2026-10-30 reuse audit** (Worker 2 audits + TL-Audit-v1 per [ADR-0009](../adr/0009-open-source-reuse-consolidation-audit.md); GitHub/GitLab/SourceForge APIs, PyPI/npm registries, and pinned-tree LICENSE/COPYING texts — full method and per-engine evidence in [engine-inventory.md](../02-engines/engine-inventory.md), capability states in [capability-matrix.md](../02-engines/capability-matrix.md)). The register no longer means "all planned": the live registry (`src/engines/registry.json`) carried **44 records at audit close — 14 `tested` with real adapters** (cadquery, IfcOpenShell, gmsh, scikit-fem, SfePy, SimPy, pandapower, pyswmm, pdfplumber, ezdxf, tesseract, amaranth, yowasp-yosys, LibreOffice) **and 30 `planned`**; the pdf2takeoff row added below by the same audit raises it to 45 records / 31 `planned`. `tested` means adapter-verified on the dev host, never redistribution — bundling still requires the Phase-6 re-verification (ADR-0004 §3).
>
> | Engine | License (SPDX / honest text) | Copyleft class | Integration policy (ADR-0004) |
> |---|---|---|---|
> | FreeCAD | LGPL-2.1 | weak copyleft | arm's-length process (§2); LGPL in-process review if ever linked |
> | LibreCAD | GPL-2.0 (tree text; API field NOASSERTION) | strong | arm's-length process only (§2) |
> | LibreDWG | GPL-3.0 | strong | CLI conversion service only (§2) |
> | Blender | GPL-2.0-or-later | strong | arm's-length process only (§2) |
> | IfcOpenShell | LGPL-3.0 | weak | python-module possible after written review (§2 exception) |
> | That Open Engine (components) | MIT | permissive | web-module in-process permitted (§2 exception, MIT) |
> | web-ifc | MPL-2.0 | file-level | web-module in-process permitted (§2 exception, MPL-2.0) |
> | QGIS | GPL-2.0 | strong | arm's-length process only (§2) |
> | GRASS GIS | GPL-2.0-or-later | strong | arm's-length process only (§2) |
> | EPA SWMM | Public Domain (US Gov, per repo README) | none | solver CLI; record public-domain status at pinning (§3) |
> | pyswmm | BSD-2-Clause | permissive | python-module after review (§2 exception) |
> | OpenTakeoff | AGPL-3.0 (npm declares AGPL-3.0-only; re-verified from the repo LICENSE text by the 2026-10-30 reuse audit) | strong + network terms | strict arm's-length MCP/process boundary (§2) |
> | pdf2takeoff | Apache-2.0 (verified from LICENSE text + GitHub REST on audit day 2026-10-30) | permissive | embeddable per Apache-2.0 — arm's-length Node subprocess (`bin/pdf2takeoff.js`) pinned to exact commit (§2/§3); planned Stage-1 ADOPT per [ADR-0009](../adr/0009-open-source-reuse-consolidation-audit.md) |
> | KiCad | GPL-3.0-or-later (tree text; seed AGPL claim corrected) | strong | arm's-length process only (§2) |
> | QElectroTech | GPL-2.0 | strong | arm's-length process only (§2) |
> | ngspice | BSD-3-Clause ("Modified BSD") | permissive | CLI batch + shared-lib review before in-process use |
> | pandapower | BSD-3-Clause | permissive | python-module after review (§2 exception) |
> | GHDL | GPL-2.0 | strong | arm's-length process only (§2) |
> | Yosys | ISC | permissive | arm's-length CLI; in-process not planned |
> | Verilator | LGPL-3.0 OR Artistic-2.0 | weak OR permissive | arm's-length CLI (§2); dual-license choice recorded at pinning |
> | OpenROAD | BSD-3-Clause | permissive | arm's-length CLI |
> | Gmsh | GPL-2.0-or-later (with linking exception) | strong (exception noted) | arm's-length CLI/python; read exception before bundling (§3) |
> | Code_Aster | GPL-3.0 | strong | arm's-length process only (§2) |
> | Elmer FEM | GPL-2.0 | strong | arm's-length process only (§2) |
> | OpenSees | NOASSERTION — custom UC Regents non-commercial license | **not OSI open source — license risk** | no state beyond `planned` without written license review (§1/§2) |
> | OpenFOAM (Foundation) | GPL-3.0-or-later | strong | arm's-length CLI; Foundation/OpenCFD fork choice recorded (§2/§3) |
> | ParaView | BSD-3-Clause | permissive | arm's-length CLI |
> | OpenModelica | AGPL-3.0 OR OSMC-PL-1.8 | strong + network (AGPL path) | arm's-length CLI (omc); license path choice recorded before bundling |
> | DWSIM | GPL-3.0 | strong | arm's-length process only (§2); upstream repo moved (dwsim10) |
> | SimPy | MIT | permissive | python-module after review (§2 exception) |
> | ROS 2 | multi-license (core e.g. rclcpp Apache-2.0) | permissive (per-component) | per-component verification at integration (§4) |
> | Gazebo (gz-sim) | Apache-2.0 | permissive | arm's-length CLI/server |
> | LibreOffice | **conflict**: mirror COPYING = GPL-3.0 text vs libreoffice.org MPL-2.0 OR LGPL-3.0-or-later | strong (unresolved) | resolve against pinned release tree before any bundling (§3) |
> | OpenProject | GPL-3.0 | strong | arm's-length REST/server integration (§2) |
> | ProjectLibre | CPAL-1.0 | attribution + network-use conditions | arm's-length desktop + attribution notices reviewed at adapter time |

Integration policy (ADR-0004): engines run as separate processes; bundling/redistribution requires per-engine re-verification at release time. `installed` state never implies redistribution.

> **2026-10-30 (ADR-0009 reuse-audit license correction):** Windmill (windmill-labs/windmill) was investigated as a workflow-foundation candidate and found **AGPL-3.0** by direct source check — despite GitHub's license API reporting NOASSERTION for the repo (the license-detection false-negative class the §4 supply-chain rule exists for). Windmill is **EXCLUDED** from any integration (ADR-0009 decision 11); no candidate row is added above because it is not a candidate.

## 4. Supply-chain rule

License claims are verified against the **pinned source tree's own LICENSE/COPYING text**, not package metadata fields alone (a prior audit elsewhere in our org found a wheel whose COPYING.txt was pure GPLv3 while METADATA claimed MIT — metadata fields are hints, source text is truth).
