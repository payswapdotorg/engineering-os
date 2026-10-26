# Slice 8 — Integrity + Takeoff Tools — Binding Contract (frozen 2026-10-22, TL)

Eighth integration pass. This document is the frozen contract for the three
parallel lanes **8-a (W3) · 8-b (W1) · 8-c (core)**. Any deviation must be
recorded in the lane's worklog entry with a reason. Standing red lines apply:
no mocks masquerading as real integrations, no fake data, no silent drops, no
dead buttons, honest limitations recorded, every state claim backed by live
evidence.

## 0. Why this slice exists (read first)

Two verified findings from the TL recon at the start of the pass:

1. **Dead download link (red-line regression).** `GET /api/revisions/[id]/download`
   returns **404 live** (verified with a signed-in session against the running
   dev server). The artifact dialog has linked there since Phase 1
   (`src/components/product/artifact-dialogs.tsx:230`), e2e-p5 asserts it
   (P17–22), and two docs record it as "built in Phase 5 with live 200
   evidence" — yet the route file **never entered git history**
   (`git log --all --diff-filter=A -- "*download*"` is empty). Root cause: the
   route existed only in the fifth-pass session's working tree and was never
   staged into the amended integration commit. This is exactly the
   "dead button + false evidence" failure the acceptance policy rejects. Lane
   8-a restores it for real; the TL corrects the record honestly at integration
   (corrections appended, history not rewritten).
2. **Journey D is the remaining partial.** Acceptance-catalogue Journey D
   ("Drawing → takeoff → estimate") is `🚧 partial` with "calibrated PDF
   measurement tooling pending" and implementation-status known-limitation #5
   records the same gap. The quantity API already accepts calibrated
   drawing-measured rows (`sheetRef` required, free-text `scale` record); only
   the real measurement surface is missing.

## 1. Lane 8-a (W3) — restore `GET /api/revisions/[id]/download`

New file `src/app/api/revisions/[id]/download/route.ts` (nothing else).

- `GET` only, wrapped in the **default** `handler()` (session required — 401
  envelope verbatim; GET is non-mutating so the viewer role CAN download).
- Unknown revision id → `ERR.notFound("Revision")` (404 envelope).
- Load the revision with `artifact: { select: { id, name, kind, projectId } }`;
  read bytes via `readRevisionFile(revision.storageKey)`
  (`src/lib/artifact-store.ts` — the regex-guarded reader; never construct
  paths by hand).
- Response headers:
  - `Content-Type: <revision.mimeType ?? "application/octet-stream">`
  - `Content-Length: <byteLength>`
  - `X-Eos-Sha256: <revision.contentHash>` (integrity surface for e2e)
  - `Content-Disposition: attachment; filename="<ascii>"; filename*=UTF-8''<rfc5987>`
    where the filename is `rev-r<revNumber>-<slugify(artifact.name)>.<ext>`
    (`slugify` from `src/app/api/_lib/route-helpers.ts`; ext from a small
    MIME→ext map inside the route: pdf→pdf, svg→svg, step/stp→step,
    stl→stl, json→json, txt→txt, png→png, jpeg→jpg, zip→zip,
    everything else→bin; the ASCII fallback strips non-ASCII, the
    `filename*` form carries the full UTF-8 name percent-encoded).
- No audit event (reads are not mutations; the upload/derive routes already
  own the event vocabulary).
- **e2e extension (in-place, no new script):** extend
  `scripts/e2e-takeoff.sh` AFTER the existing SVG-sheet upload block:
  1. `upload "/api/artifacts/$SHEET_ID" "$FIXTURES/sheet-a102-plan.pdf"` → 201
     (fixture delivered by lane 8-c; assert the file exists first and FAIL
     LOUDLY if missing — never skip silently);
  2. capture `contentHash` from the upload response JSON;
  3. `GET $BASE/api/revisions/<pdfRevId>/download` → assert 200, bytes start
     `%PDF-`, `X-Eos-Sha256` header equals the captured hash, and
     `sha256(downloaded bytes)` equals it too (byte-exact round-trip);
  4. unauthenticated download attempt on the same URL → 401 envelope.
  The takeoff PASS count grows 27 → 31 (documented in the worklog; the
  header note in the script listing the count must be updated to match).
- Lane verification (live, in-session, server already on :3000 — do NOT start a
  second instance): sign in via the documented operator flow
  (`scripts/e2e-signin.sh` pattern or inline csrf→callback curl), then curl:
  401 unauth · 404 unknown id · 200 + `%PDF-` + hash equality on a real
  revision (the demo dataset already has 5). Record the transcript.
- Do NOT edit any docs — the TL owns the honest corrections.

## 2. Lane 8-c (core) — deterministic measure math + real sheet fixture

New files `src/core/measure.ts`, `tests/fixtures/build-sheet-pdf.ts`,
`tests/fixtures/sheet-a102-plan.pdf` (+ this fixture only). No other files.

### 2.1 `src/core/measure.ts` — pure, typed, no DOM, no pdfjs

Exports (FROZEN — lane 8-b codes against these signatures):

```ts
export class MeasureError extends Error { constructor(message: string) }

/** PostScript point → millimetres (exact): 1 pt = 25.4/72 mm. */
export const PT_MM = 25.4 / 72

export interface Pt { x: number; y: number }

/**
 * Calibration: `points` are two canvas/pdf-page-space picks (in PDF points),
 * `realLength` the real-world distance the user says they span, `realUnit`
 * one of "m" | "mm" | "ft". Returns the real-millimetres-per-point factor.
 * Throws MeasureError on <2 points, coincident points, non-finite, or
 * non-positive length.
 */
export function calibrate(points: [Pt, Pt], realLength: number, realUnit: "m" | "mm" | "ft"): number

/** Real-world polyline length (mm) in the calibrated space; >=2 points. */
export function polylineLength(points: Pt[], mmPerPt: number): number

/** Real-world polygon area (mm²) via the shoelace formula; >=3 points. */
export function polygonArea(points: Pt[], mmPerPt: number): number

/** Segment distance between two points in PDF-point space. */
export function distance(a: Pt, b: Pt): number

/**
 * Human-facing value+unit for a ledger row from raw millimetres:
 * length → metres (m), area → square metres (m²), count → "each".
 * Values are NOT rounded for storage — the returned `value` is the honest
 * measured number; `display` is a 3-decimal formatting string only.
 */
export function toLedgerQuantity(
  rawMm: number,
  type: "length" | "area" | "count",
  count?: number,
): { value: number; unit: "m" | "m²" | "each"; display: string }
```

All math deterministic; degenerate inputs throw `MeasureError` (never NaN).

### 2.2 Fixture — a REAL vector PDF with pinned geometry

`tests/fixtures/build-sheet-pdf.ts` exports `buildSheetPdf(): Uint8Array`
— a dependency-free, byte-deterministic PDF writer (objects, streams, xref
computed programmatically; no external libs). Geometry is pinned in the
module as constants and mirrored in this contract:

- One page, MediaBox `0 0 1191 842` (A3 landscape: 420×297 mm; the pt↔mm
  constant above makes 1190.55×841.89 — round to whole pt for clean ops).
- Sheet furniture: title text `EOS DEMO SHEET A-102 — FLOOR PLAN @ 1:100`,
  a border rectangle, and a **scale bar**: horizontal line exactly
  `283.4646 pt` (= 100 paper-mm = 10.000 m real @ 1:100) with end ticks,
  drawn as its own PDF ops so the pdf.js text/content parse is irrelevant to
  calibration (the user calibrates on clicks, not OCR).
- Pinned elements (all line ops at exact coordinates, stroke only):
  - Room outline rectangle 80×50 paper-mm (= 8.000×5.000 m real; perimeter
    26.000 m, area 40.000 m² @ 1:100);
  - Interior wall 30 paper-mm (= 3.000 m real);
  - Three door-swing arcs? NO — keep it lines only (arcs are not needed; every
    drawn op is a straight segment, all values hand-verifiable).
- `tests/fixtures/sheet-a102-plan.pdf` is generated ONCE by running the
  module (`bun -e 'import ... buildSheetPdf ... writeFileSync'`), committed,
  and byte-compared against a re-run in the lane verification (proves
  determinism of BOTH the generator and the fixture).
- **No new unit-test files this slice** (standing session constraint,
  recorded honestly — same precedent as §1.8). Lane verification for the
  math: a live `bun -e` harness exercising the six exports against the
  pinned constants (calibration on the 100-paper-mm bar → exactly ×100 factor;
  room perimeter 26.000 m; area 40.000 m²; degenerate inputs throw), plus
  generator/fixture byte-identity. The TL re-checks the same numbers via the
  browser journey on lane 8-b's surface.

### 2.3 Region cutouts — the Slice 18 ADDITIVE extension (frozen 2026-10-26)

`src/core/measure.ts` grew three exports + one result type, ADDITIVE to the
frozen §2.1 list (the §2.1 signatures are untouched byte-for-byte; the
standing "changes escalate to the TL" rule was exercised with the TL as the
author — recorded here so the freeze stays honest):

- `pointStrictlyInsidePolygon(p, ring)` — even-odd ray cast with an explicit
  on-boundary exclusion: a point ON an edge or vertex is NOT strictly inside.
- `ringsTouchOrCross(a, b)` — any-contact detection between two closed
  rings' boundaries (proper crossing, endpoint touch, collinear overlap).
- `areaWithCutouts(region, cutouts, mmPerPt)` → `{ grossMm2, cutoutMm2[],
  cutoutsMm2, netMm2 }` — the same shoelace arithmetic as `polygonArea`
  (gross is BIT-IDENTICAL to `polygonArea(region, mmPerPt)` on the same
  ring), with the pinned validation matrix, every violation throwing a
  `MeasureError` whose message the markups route returns verbatim as a 422:
  region ≥3 points enclosing positive area; each cutout ring ≥3 points
  enclosing positive area; each cutout STRICTLY inside the region (all
  vertices strictly inside; zero boundary contact — v1 bounds, honest: a
  cutout poking out has no exact shoelace-only answer, so it is refused);
  cutouts pairwise non-overlapping (no boundary contact, no nesting —
  overlapping cutouts would double-subtract the same mm²); net > 0.
- Boundary-contact detection is exact-arithmetic on the given doubles
  (orientation products with `=== 0`); the defensive net-zero refusal is
  provably unreachable through the strict-inside rules and is documented as
  a backstop, not pinned by test.

The unit battery `src/core/measure.test.ts` (NEW — the §2.1 "no new test
files" constraint was Slice-8-scoped; Slice 18 ships the module's own file)
pins: §2.1 arithmetic sanity (gross bit-identity included), the
strict-inside/contact predicates (concave L-shape cases), analytic
cutout ground truths on integer coordinates (2.000 m² − 0.02 − 0.02 =
1.960 m², exact), and the full refusal matrix verbatim.

### 2.4 Cutout v2 — boundary-crossing cutouts via polygon clipping (Slice 19, frozen 2026-10-26)

The eighteenth-pass forward queue's first drillable product-depth item,
closing the v1 bound recorded above ("a cutout poking out has no exact
shoelace-only answer, so it is refused"). `src/core/measure.ts` grew two
exports, ADDITIVE to the §2.1/§2.3 lists (those signatures untouched
byte-for-byte), and `areaWithCutouts` evolved its RULES (the result type
gained one field; the §2.3 numbers are bit-identical for §2.3-shaped inputs):

- `isConvexRing(ring)` — exact-sign convexity (consecutive cross products all
  ≥ 0 or all ≤ 0, collinear allowed; mixed signs = concave).
- `clipToConvexRegion(subject, region)` — orientation-aware Sutherland–Hodgman
  against the CONVEX ring `region` (points ON a plane are kept). Degenerate
  bridges/duplicates the algorithm leaves when a subject splits or runs along
  the boundary contribute exactly 0 to the shoelace, so the clipped AREA is
  the true intersection area — the classical S-H property, honestly recorded:
  the SHAPE at the bridges is degenerate on purpose and never stored (the
  caller only measures the piece; the payload keeps the operator's original
  rings as the evidence).
- `areaWithCutouts` v2 lane classification, per cutout: fully-inside rings
  (zero boundary contact + every vertex strictly inside) ride the v1 lane —
  the ring's own shoelace, no clip ever runs, BIT-IDENTICAL to Slice 18;
  rings touching/crossing the boundary — or containing the region whole —
  ride the v2 lane: the region must be CONVEX (the honest v2 bound:
  Sutherland–Hodgman is exact for a convex clip window; a concave region is
  refused with a message that says exactly that), and the subtracted amount
  is the CLIPPED INTERSECTION area — only the square millimetres inside the
  region, so a boundary-crossing opening can no longer lie by subtracting
  its outside part. Result type gains `clipped: boolean[]` (per cutout, true
  = v2 lane) — the UI shows which rings cross the edge.
- The refusal matrix, v2 additions/changes (verbatim 422s; the unchanged
  rows — degenerate rings, pairwise overlap, mmPerPt, both-payloads — keep
  their §2.3 texts byte-for-byte):
  - disjoint cutout (no boundary contact, no vertex of either ring inside
    the other): `…lies entirely outside the region — it would subtract
    nothing; draw it inside the area or crossing its boundary`;
  - boundary contact on a CONCAVE region: `…touches or crosses the region
    boundary — v2 boundary-crossing cutouts need a CONVEX region; a concave
    region accepts only cutouts drawn fully inside`;
  - the former strictly-inside-vertex message is DEAD (a vertex ON the
    boundary of a convex region is now accepted — the clip keeps the
    boundary, the intersection IS the ring); its e2e pin (AC-VT-10d)
    flipped from refusal to acceptance with the honest numbers the fixture
    itself claimed;
  - the net-area-0 refusal is now REACHABLE (a crossing cutout whose
    intersection is the whole region) and is pinned by test — no longer a
    documented backstop only;
  - the defensive not-a-simple-ring branch (vertices inside and outside
    with zero boundary contact — impossible for a simple ring by the Jordan
    curve argument) refuses honestly rather than guessing.
- Pairwise rule unchanged and now a RECORDED CONSERVATIVE BOUND: cutouts may
  not touch, cross, or nest ANYWHERE — even in the part outside the region.
  Overlap detection runs on the ORIGINAL rings; overlap-only-outside is
  geometrically harmless but refused anyway because it costs one honest
  sentence and removes a whole class of double-subtract subtleties.
- Exactness posture (unchanged in kind): all arithmetic is exactly-specified
  IEEE-754 on the given doubles; the pinned fixtures cross region edges at
  INTEGER coordinates (the clip's u = fs/(fs−ft) divides evenly, e.g. the
  e2e's 0.5 at x=100), so every pinned product is exact. Crossings at
  non-representable coordinates carry float ulps by construction — the
  SERVER re-derives with the same deterministic core, so storage can never
  disagree with the stored geometry (the 1e-9 relative window of the markup
  gate absorbs only engine-level ulps, never a real mismatch).
- The unit battery pins: `isConvexRing` (rect/L/triangle/bowtie/collinear),
  `clipToConvexRegion` (fully-inside vertex-for-vertex bit-identity; integer
  crossing; corner overlap; swallower; disjoint; CONCAVE subject with
  bridges; boundary-sharing wall; CW orientation), and the v2 lane matrix
  (v1 regression bit-identity, on-boundary acceptance, crossing exactness,
  mixed lanes, swallower net-0, concave gate, conservative pairwise,
  wall-touch refusal, gross bit-identity) — 32 → 53 tests. The e2e battery
  pins AC-VT-10d flipped + AC-VT-11a…h (acceptance, round-trip, concave
  gate, disjoint, swallower, both-numbers disagreement, clipped audit
  detail, 401): takeoff 81 → 89.

## 3. Lane 8-b (W1) — Sheet Measure tab (Takeoff workspace)

Files: new `src/components/product/sheet-measure.tsx`; edit
`src/components/product/takeoff-workspace.tsx` (add the tab) and
`src/components/product/api.ts` (one fetch helper + types, mirroring the
`exportEstimateBoqCsv` blob pattern around api.ts:520). `package.json` gains
exactly one dependency: `pdfjs-dist@4.10.38` (pinned exact). Copy
`node_modules/pdfjs-dist/build/pdf.worker.min.mjs` →
`public/vendor/pdf.worker.min.mjs` (vendored copy of the pinned dep,
committed; documented in the component header).

### 3.1 Viewer

- `pdfjs` is imported DYNAMICICALLY client-side only
  (`await import("pdfjs-dist")` inside the effect; never at module scope) with
  `GlobalWorkerOptions.workerSrc = "/vendor/pdf-worker..."` — exact path from
  the vendored copy. Rationale: no SSR evaluation, no build-time bundling of
  the worker.
- Sheet picker: project artifacts where `kind === "drawing"` AND the latest
  revision `mimeType === "application/pdf"` (from the existing
  `useApi` artifacts list). Empty state is honest copy ("No PDF drawing sheets
  in this project yet — upload one from Artifacts"), never a dead control.
- Fetch bytes via `GET /api/revisions/<latestRevisionId>/download`
  (same-origin fetch carries the session cookie by default — verify 401
  surfaces as a verbatim toast, never a silent blank canvas).
- Render page N of M into a `<canvas>` with fit-width default scale, zoom
  +/- buttons (clamp 0.5–4× page scale), page prev/next. All measurement math
  happens in PDF-point space: canvas click coordinates are divided by the
  render scale to recover points before any `src/core/measure` call.

### 3.2 Calibration + tools

- **Calibrate tool**: two clicks on the sheet → prompt-inline input for the
  real distance + unit (m/mm/ft) → `calibrate()` → store `mmPerPt` in state;
  the sheet header shows the derived ratio as `1:X` where
  `X = round(1000 / (PT_MM * mmPerPt * 100))`? NO — honest form: show
  `mm/pt` and the equivalent `1:<n>` rounded to 3 significant figures, plus
  a `scale` record string `calibrated: 2-pt, <len><unit> ↔ <px>pt` — the
  exact string persisted on each saved row is defined in §3.3.
  Uncalibrated + measure attempt → inline warning, tool disabled (no dead
  buttons: the buttons exist and explain themselves).
- **Length tool**: click points, running total via `polylineLength`, finish
  on double-click/Enter, Esc cancels. Live readout with 3-decimal display.
- **Area tool**: click ≥3 points, live shoelace readout, close/finish like
  length.
- **Count tool**: click points, tally badge.
- Crosshair cursor + last-segment rubber-band rendering on an overlay
  `<canvas>` above the pdf canvas (redraw on zoom/page change; measurements
  do not survive a page switch — switching pages clears the in-progress
  measurement with an honest inline notice; saved rows are already in the
  ledger, never lost silently).

### 3.3 Save → ledger row (the real API, no shortcuts)

Per finished measurement, a small save panel: label (→ `elementRef`), the
computed `value` + `unit` (read-only display — the honest measured number),
ruleset fields default `eos-pdf-measure` / `1` (editable), and:

- `POST /api/projects/<id>/quantities` with
  `method: "drawing-measured"`, `sheetRef: "<artifact name> — p<page>"`,
  `scale: "calibrated 2-pt, <real><unit> @ sheet A-102 1:100 target — <mmPerPt> mm/pt"`
  (the exact format: `calibrated 2-pt, 10 m ↔ 283.46 pt — 8.80 mm/pt`),
  `quantityType` = length|area|count, `unit` = m|m²|each,
  `sourceArtifactRevisionId` = the rendered revision,
  `quantityMethod: "eos-pdf-measure/1 (browser-calibrated)"`,
  `createdBy` per the existing RecordQuantityDialog semantics (session user).
- 201 → toast + Takeoff ledger list refresh (the established cache-nudge
  pattern for this workspace); server 422s surface verbatim in toasts.
- Viewer role: tools usable, Save disabled with the pinned tooltip
  "viewer role is read-only" (GuardedButton pattern — visible but disabled).
- NO estimate math client-side; nothing optimistic; refetch after save.

### 3.4 Lane verification (agent-browser, in-session)

Fixture upload via the REAL API first (documented workaround for the
tool-level file-input limitation, acceptance catalogue #10): register
artifact `Sheet-A102-plan.pdf` (kind `drawing`) on the demo project, upload
`tests/fixtures/sheet-a102-plan.pdf` bytes, then browser-journey: Takeoff →
Sheet Measure tab → sheet renders (canvas non-blank) → calibrate on the scale
bar (click both ticks, enter 10 m) → measure the room perimeter → readout
≈ 26.000 m (±0.3 m click tolerance) → measure the room area → ≈ 40.000 m² →
count 3 clicks → save each → rows appear in the Quantity Ledger tab with the
amber drawing-measured badge and the scale record → zero console errors →
390 px width spot check (no horizontal overflow) → footer still bottom-stuck.
Record evidence screenshots/notes in the worklog entry.

## 4. Ownership (no overlaps)

| Seam | Owner |
|---|---|
| `src/app/api/revisions/[id]/download/route.ts`, `scripts/e2e-takeoff.sh` | 8-a |
| `src/core/measure.ts`, `tests/fixtures/build-sheet-pdf.ts`, `tests/fixtures/sheet-a102-plan.pdf` | 8-c |
| `src/components/product/sheet-measure.tsx`, `takeoff-workspace.tsx`, `api.ts`, `package.json`/lockfile, `public/vendor/*` | 8-b |
| `docs/**`, README, worklog integration entry, commit | TL |

- No lane edits `prisma/schema.prisma` (zero schema changes this slice).
- No lane edits docs or commits — hand back via the worklog only.
- The dev server on :3000 is shared. Do NOT start a second instance. If it
  dies: `(bun run dev > dev.log 2>&1 &)` from `/home/z/my-project` and say so
  in your worklog entry.
- 8-b may type-fail until 8-c's `src/core/measure.ts` lands — expected;
  code against the frozen signatures in §2.1.

## 5. Verification standard + hand-back

Every lane, before handing back:

1. `bun run lint` 0 errors · `bun run typecheck` clean (8-b: after 8-c lands
   or with the signatures stubbed locally then reverted).
2. `bun test src/` — the existing 329 tests stay green (no new test files).
3. Your lane's live verification from §1/§2.2/§3.4, transcript/notes recorded.
4. Append your worklog entry to `/home/z/my-project/worklog.md` (append,
   never overwrite): Task ID, agent, task, work log, stage summary, every
   deviation with a reason.
5. Do NOT `git commit` — the TL integrates, runs the full gate (all five
   e2e scripts in one session), does browser acceptance, corrects the docs,
   and commits.
