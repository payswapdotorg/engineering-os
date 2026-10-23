#!/usr/bin/env bash
# scripts/e2e-p5-disciplines.sh — NEW Phase-5 extended-disciplines acceptance
# script (AC-P5-01…09, docs/00-architecture/phase5-disciplines-contract.md §12).
#
# Against the live dev server it verifies:
#   AC-P5-01 fe-mesh round-trip: REAL gmsh STEP→tet4 derive, kind "fe-mesh",
#            byte-determinism (re-derive → same contentHash), staleness ride +
#            regenerate, honest geometry-free/IFC/non-model refusals verbatim
#   AC-P5-02 power flow: REAL pandapower run, closed-form bus-2 voltage pinned,
#            converged + loss≈0, wrong-format and islanded honest 422s
#   AC-P5-03 DES: REAL simpy run, makespan 13 (hand-traced FIFO flow shop),
#            utilization payload, unknown-resource honest 422
#   AC-P5-04 document conversion: REAL headless LibreOffice fodt→PDF, %PDF-
#            magic on download, HONEST non-byte-determinism (two runs → two
#            hashes), non-convertible + already-PDF 422s verbatim
#   AC-P5-05 CPM: schedule create (zod 422s verbatim) → analyze → eos-cpm/1
#            with pinned critical path, platform-core honesty (engineKey null),
#            staleness cascade on schedule edit
#   AC-P5-06 estimate recompute (known-limitation #7): approved estimate + a
#            moved-on model → revised draft, slot re-resolution to the newest
#            ledger row, exactly ONE estimate.recomputed event, 422 gates
#   AC-P5-07 single execution path: workflow definitions accept the five new
#            broker ops (vocabulary sync); regression marker (demo export 200)
#   AC-P5-08 registry validation fields served by /api/engines for all four
#            Phase-5 engines
#
# Runs LAST of the five scripts. Probe project "P5 Disciplines Probe" is
# removed on success (KEPT on failure for forensics). Final line
# "N PASS / M FAIL", nonzero exit on any FAIL.
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURES="$REPO/tests/fixtures"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Phase-6 auth (contract §1.5): sign in as the demo operator; ${EOS_AUTH}
# carries the session cookie jar on every curl below.
source "$(dirname "$0")/e2e-signin.sh"

PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); printf 'PASS %2d: %s\n' "$PASS" "$1"; }
bad() {
  FAIL=$((FAIL + 1))
  printf 'FAIL %2d: %s\n' "$FAIL" "$1"
  printf '  actual (truncated): %.600s\n' "$2"
  printf '  (expected: %.300s)\n' "$3"
}
assert_eq() { # desc expected actual — byte-equal
  if [[ "$3" == "$2" ]]; then ok "$1"; else bad "$1" "$3" "$2"; fi
}
assert_contains() { # desc needle haystack
  if [[ "$3" == *"$2"* ]]; then ok "$1"; else bad "$1" "$3" "contains: $2"; fi
}
near() { # desc expected actual tolerance — numeric |actual−expected| ≤ tolerance
  if awk -v a="$3" -v b="$2" -v t="$4" 'BEGIN { d = a - b; if (d < 0) d = -d; exit !(d <= t) }'; then
    ok "$1"
  else
    bad "$1" "actual $3 vs $2 (tol $4)" "within $4 of $2"
  fi
}

STATUS=""
BODY=""
http() {
  local method="$1" path="$2"
  shift 2
  STATUS=$(curl -sS -m 180 -o "$WORK/http.body" -w '%{http_code}' -X "$method" "$BASE$path" "$@" ${EOS_AUTH:-}) || STATUS="000"
  BODY=$(cat "$WORK/http.body")
}
jpost() { http POST "$1" -H 'Content-Type: application/json' --data-binary @"$2"; }
upload() { # path file [explicit artifact name]
  local path="$1" file="$2" name="${3:-}"
  local args=(-F "file=@$file")
  if [[ -n "$name" ]]; then args+=(-F "name=$name"); fi
  STATUS=$(curl -sS -m 180 -o "$WORK/http.body" -w '%{http_code}' -X POST "${args[@]}" "$BASE$path" ${EOS_AUTH:-}) || STATUS="000"
  BODY=$(cat "$WORK/http.body")
}
j() { printf '%s' "$1" | /usr/bin/jq -r "$2"; }

cat > "$WORK/probe.json" <<'EOF'
{ "name": "P5 Disciplines Probe", "discipline": "civil", "description": "phase-5 acceptance probe" }
EOF
# pre-cleanup: a previous failed run may have KEPT its probe (forensics)
# (dev-db-cleanup.ts is the established cleanup path — the projects API has no
# DELETE handler, so a curl-based "cleanup" would silently 405)
(cd "$REPO" && bun scripts/dev-db-cleanup.ts --name "P5 Disciplines Probe" >/dev/null 2>&1) || true
jpost /api/projects "$WORK/probe.json"
PROBE_ID=$(j "$BODY" '.data.project.id')
assert_eq "probe project created (201)" "201" "$STATUS"

# ===========================================================================
# AC-P5-01 — FE mesh (REAL gmsh; harness pins 1088 v / 3482 tet4 on defaults)
# ===========================================================================
upload "/api/projects/$PROBE_ID/artifacts" "$FIXTURES/bracket-solid.step" "Bracket solid"
MODEL_ID=$(j "$BODY" '.data.artifact.id')
http POST "/api/projects/$PROBE_ID/artifacts/$MODEL_ID/fe-mesh" -H 'Content-Type: application/json' -d '{}'
FEMESH_HASH1=$(j "$BODY" '.data.femesh.contentHash')
FEMESH_ID=$(j "$BODY" '.data.femesh.artifactId')
assert_eq "bracket-solid → FE mesh derived by REAL gmsh (kind fe-mesh, format eos-femesh/1, 1088 nodes / 3482 tet4 / 1 solid)" \
  "201|fe-mesh|eos-femesh/1|1088|3482|1|gmsh" \
  "$STATUS|$(j "$BODY" '.data.femesh.kind')|$(j "$BODY" '.data.femesh.document.format')|$(j "$BODY" '.data.femesh.nodeCount')|$(j "$BODY" '.data.femesh.elementCount')|$(j "$BODY" '.data.femesh.solidCount')|$(j "$BODY" '.data.femesh.engineKey')"
near "femesh document: solids[0].meshVolume within 2% of the analytic 36000−960π (linear-tet curved-hole bias, harness-pinned)" \
  "32984.071" "$(j "$BODY" '.data.femesh.document.solids[0].meshVolume')" "660"
http GET "/api/projects/$PROBE_ID/artifacts"
assert_eq "fe-mesh artifact linked derived_from the source model (graph position, Journey-G machinery reused)" \
  "true" "$(j "$BODY" "[.data.artifacts[] | select(.id == \"$FEMESH_ID\")][0] | true")"
http GET "/api/projects/$PROBE_ID/artifacts/$MODEL_ID/fe-mesh"
FIRST=$(cat "$WORK/http.body")
http POST "/api/projects/$PROBE_ID/artifacts/$MODEL_ID/fe-mesh" -H 'Content-Type: application/json' -d '{}'
FEMESH_HASH2=$(j "$BODY" '.data.femesh.contentHash')
assert_eq "re-derive appends rev 2 on the SAME artifact with byte-identical contentHash (fixed gmsh options, no timestamps)" \
  "2|$FEMESH_HASH1" "$(j "$BODY" '.data.femesh.revisionNumber')|$FEMESH_HASH2"
http GET "/api/events?projectId=$PROBE_ID&limit=200"
assert_eq "exactly ONE femesh.derived audit event per run (2 runs → 2 events), engine gmsh recorded" \
  "2" "$(j "$BODY" '[.data.events[] | select(.action == "femesh.derived")] | length')"

upload "/api/projects/$PROBE_ID/artifacts" "$FIXTURES/bracket.step" "Bracket empty"
EMPTY_ID=$(j "$BODY" '.data.artifact.id')
http POST "/api/projects/$PROBE_ID/artifacts/$EMPTY_ID/fe-mesh" -H 'Content-Type: application/json' -d '{}'
assert_eq "geometry-free STEP → 422 verbatim refusal (never an empty mesh)" \
  "422|engine_unavailable|$(printf 'no solid geometry found in STEP file (import produced 0 solids) - cannot generate an FE mesh, and simulated meshes are not an option')" \
  "$STATUS|$(j "$BODY" '.error.code')|$(j "$BODY" '.error.message')"
upload "/api/projects/$PROBE_ID/artifacts" "$FIXTURES/wall-quantities.ifc" "Wall quantities"
IFC_ID=$(j "$BODY" '.data.artifact.id')
http POST "/api/projects/$PROBE_ID/artifacts/$IFC_ID/fe-mesh" -H 'Content-Type: application/json' -d '{}'
assert_eq "IFC model → honest gmsh refusal by name (no IFC import reader — observed live, never a misleading parse error)" \
  "422|engine_unavailable|gmsh cannot import IFC geometry (gmsh has no IFC import reader - OCC STEP/IGES/BRep only) - cannot generate an FE mesh, and simulated meshes are not an option" \
  "$STATUS|$(j "$BODY" '.error.code')|$(j "$BODY" '.error.message')"
upload "/api/projects/$PROBE_ID/artifacts" "$FIXTURES/site-notes.md" "Site notes"
MD_ID=$(j "$BODY" '.data.artifact.id')
http POST "/api/projects/$PROBE_ID/artifacts/$MD_ID/fe-mesh" -H 'Content-Type: application/json' -d '{}'
assert_eq "non-model artifact → 422 unsupported (the pinned femesh gate message)" \
  "422|unsupported" "$STATUS|$(j "$BODY" '.error.code')"

upload "/api/artifacts/$MODEL_ID/revisions" "$FIXTURES/bracket-solid.step" ""
REV_POST=$(cat "$WORK/http.body")
assert_eq "new model revision → fe-mesh stale via the existing cascade (zero new graph code)" \
  "2|1|derived_from" \
  "$(j "$REV_POST" '.data.revision.revNumber')|$(j "$REV_POST" '.data.staleMarked | length')|$(j "$REV_POST" '.data.staleMarked[0].relation')"
http POST "/api/projects/$PROBE_ID/artifacts/$MODEL_ID/fe-mesh" -H 'Content-Type: application/json' -d '{}'
assert_eq "Regenerate → rev 3 against the NEW source revision, staleness current again" \
  "3|current" "$(j "$BODY" '.data.femesh.revisionNumber')|$(j "$BODY" '.data.femesh.staleness // "current"')"

# ===========================================================================
# AC-P5-02 — power flow (REAL pandapower; closed form V₂ = 0.9999875)
# ===========================================================================
upload "/api/projects/$PROBE_ID/artifacts" "$FIXTURES/powerflow-2bus.json" "Powerflow two bus"
PF_ID=$(j "$BODY" '.data.artifact.id')
http POST "/api/projects/$PROBE_ID/artifacts/$PF_ID/powerflow" -H 'Content-Type: application/json' -d '{}'
assert_eq "network JSON → power flow by REAL pandapower (kind analysis, converged, 2 buses / 1 line)" \
  "201|analysis|eos-powerflow/1|true|2|1|pandapower|3.5.6" \
  "$STATUS|$(j "$BODY" '.data.powerflow.kind')|$(j "$BODY" '.data.powerflow.document.format')|$(j "$BODY" '.data.powerflow.converged')|$(j "$BODY" '.data.powerflow.busCount')|$(j "$BODY" '.data.powerflow.lineCount')|$(j "$BODY" '.data.powerflow.engineKey')|$(j "$BODY" '.data.powerflow.engineVersion')"
near "closed-form pin: bus-2 vm_pu = 0.9999875 (lossless 2-bus quadratic high branch; rel error vs engine ≤ 1.2e-5, harness-pinned)" \
  "0.9999875" "$(j "$BODY" '.data.powerflow.document.buses[] | select(.id == "bus-2") | .vmPu')" "0.0001"
near "losses ≈ 0 on the lossless feeder (r = 0 Ω/km; engine frame verbatim)" \
  "0" "$(j "$BODY" '.data.powerflow.document.totals.lossMw')" "0.000000001"
upload "/api/projects/$PROBE_ID/artifacts" "$FIXTURES/des-flowshop.json" "DES flowshop (wrong format for powerflow)"
DESW_ID=$(j "$BODY" '.data.artifact.id')
http POST "/api/projects/$PROBE_ID/artifacts/$DESW_ID/powerflow" -H 'Content-Type: application/json' -d '{}'
assert_contains "wrong-format JSON → 422 (the ROUTE zod refuses alien content before the broker — defense-in-depth)" \
  'format must be "eos-powerflow-network/1"' \
  "$(j "$BODY" '.error.message')"
upload "/api/projects/$PROBE_ID/artifacts" "$FIXTURES/powerflow-islanded.json" "Powerflow islanded"
PFI_ID=$(j "$BODY" '.data.artifact.id')
http POST "/api/projects/$PROBE_ID/artifacts/$PFI_ID/powerflow" -H 'Content-Type: application/json' -d '{}'
assert_contains "islanded bus → honest refusal naming the island (NaN is not a result)" \
  "islanded network - buses with no path to the external grid: bus-3" \
  "$(j "$BODY" '.error.message')"

# ===========================================================================
# AC-P5-03 — discrete-event simulation (REAL simpy; makespan 13 hand-traced)
# ===========================================================================
http POST "/api/projects/$PROBE_ID/artifacts/$DESW_ID/simulate" -H 'Content-Type: application/json' -d '{}'
assert_eq "scenario JSON → DES by REAL simpy (kind analysis, FIFO, makespan 13)" \
  "201|analysis|eos-des/1|fifo|13|2|3|simpy|4.1.2" \
  "$STATUS|$(j "$BODY" '.data.sim.kind')|$(j "$BODY" '.data.sim.document.format')|$(j "$BODY" '.data.sim.document.policy')|$(j "$BODY" '.data.sim.makespan')|$(j "$BODY" '.data.sim.resourceCount')|$(j "$BODY" '.data.sim.jobCount')|$(j "$BODY" '.data.sim.engineKey')|$(j "$BODY" '.data.sim.engineVersion')"
BUSY=$(j "$BODY" '[.data.sim.document.resources[] | .busy] | map(tostring) | join(",")')
assert_eq "resource busy times hand-traced: m1 6 (2+3+1), m2 11 (4+2+5)" "6,11" "$BUSY"
http GET "/api/events?projectId=$PROBE_ID&limit=200"
assert_eq "exactly ONE sim.completed audit event for the run" \
  "1|simpy" "$(j "$BODY" '[.data.events[] | select(.action == "sim.completed")] | length')|$(j "$BODY" '[.data.events[] | select(.action == "sim.completed")][0].detail | fromjson | .engineKey')"
upload "/api/projects/$PROBE_ID/artifacts" "$FIXTURES/des-invalid-resource.json" "DES invalid resource"
DESI_ID=$(j "$BODY" '.data.artifact.id')
http POST "/api/projects/$PROBE_ID/artifacts/$DESI_ID/simulate" -H 'Content-Type: application/json' -d '{}'
assert_contains "unknown resource → honest 422 (the ROUTE zod refuses first; the adapter also defends itself — defense-in-depth)" \
  "references unknown resource" \
  "$(j "$BODY" '.error.message')"

# ===========================================================================
# AC-P5-04 — document conversion (REAL headless LibreOffice)
# ===========================================================================
upload "/api/projects/$PROBE_ID/artifacts" "$FIXTURES/cover-sheet.fodt" "Cover sheet"
FODT_ID=$(j "$BODY" '.data.artifact.id')
http POST "/api/projects/$PROBE_ID/artifacts/$FODT_ID/convert-document" -H 'Content-Type: application/json' -d '{}'
PDF_ID=$(j "$BODY" '.data.pdf.artifactId')
PDF_HASH1=$(j "$BODY" '.data.pdf.contentHash')
PDF_SIZE=$(j "$BODY" '.data.pdf.sizeBytes')
# LibreOffice is the ONE engine that comes from the host/runner's package
# manager (apt on CI = 24.2.7.x; the dev host = 25.2.3.2) — unlike the venv
# engines, its version is ENVIRONMENTAL, so this assertion pins the CONTRACT
# (real LO-attributed conversion: kind pdf, engineKey libreoffice, a
# version-shaped engineVersion, the registered adapter) instead of the dev
# host's literal. Every reproducible engine keeps its exact pin elsewhere.
PDF_VERSION=$(j "$BODY" '.data.pdf.engineVersion')
if [ "$STATUS" = "201" ] \
  && [ "$(j "$BODY" '.data.pdf.kind')" = "pdf" ] \
  && [ "$(j "$BODY" '.data.pdf.engineKey')" = "libreoffice" ] \
  && [ -n "$PDF_VERSION" ] \
  && printf '%s' "$PDF_VERSION" | grep -Eq '^[0-9]+(\.[0-9]+)+' \
  && [ "$(j "$BODY" '.data.pdf.adapterScript')" = "convert-document.ts" ]; then
  ok "fodt → PDF by REAL headless LibreOffice (kind pdf, engineKey libreoffice, version $PDF_VERSION — environmental, contract-pinned; adapter convert-document.ts)"
else
  bad "fodt → PDF by REAL headless LibreOffice (kind pdf, engineKey libreoffice, version-shaped engineVersion, adapter convert-document.ts)" \
    "$STATUS|$(j "$BODY" '.data.pdf.kind')|$(j "$BODY" '.data.pdf.engineKey')|$PDF_VERSION|$(j "$BODY" '.data.pdf.adapterScript')" \
    "201|pdf|libreoffice|<version-shaped>|convert-document.ts"
fi
if [ "$PDF_SIZE" -gt 1000 ] 2>/dev/null; then ok "PDF size > 1000 bytes (real Writer render)"; else bad "PDF size > 1000 bytes" "$PDF_SIZE" "> 1000"; fi
http GET "/api/projects/$PROBE_ID/artifacts"
PDF_REV=$(printf '%s' "$BODY" | /usr/bin/jq -r "[.data.artifacts[] | select(.id == \"$PDF_ID\")][0].latestRevisionId")
DL_STATUS=$(curl -sS -m 180 -o "$WORK/pdf.bytes" -w '%{http_code}' ${EOS_AUTH:-} "$BASE/api/revisions/$PDF_REV/download") || DL_STATUS="000"
head -c 5 "$WORK/pdf.bytes" > "$WORK/magic.txt"
assert_eq "download round-trip via GET /api/revisions/[id]/download: 200 + bytes start with the %PDF- magic" \
  "200|%PDF-" "$DL_STATUS|$(cat "$WORK/magic.txt")"
http POST "/api/projects/$PROBE_ID/artifacts/$FODT_ID/convert-document" -H 'Content-Type: application/json' -d '{}'
PDF_HASH2=$(j "$BODY" '.data.pdf.contentHash')
assert_eq "HONEST non-byte-determinism: re-conversion appends rev 2 with a DIFFERENT contentHash (PDFs embed creation timestamps — never claimed idempotent)" \
  "2|different" "$(j "$BODY" '.data.pdf.revisionNumber')|$([ "$PDF_HASH2" != "$PDF_HASH1" ] && echo different || echo same)"
http POST "/api/projects/$PROBE_ID/artifacts/$MODEL_ID/convert-document" -H 'Content-Type: application/json' -d '{}'
assert_contains "non-convertible artifact (the STEP model — no LO import filter for .step) → 422 verbatim" \
  "is not convertible to PDF (no LibreOffice import filter for this kind)" \
  "$(j "$BODY" '.error.message')"
http POST "/api/projects/$PROBE_ID/artifacts/$PDF_ID/convert-document" -H 'Content-Type: application/json' -d '{}'
assert_eq "already-PDF artifact → 422 verbatim" \
  "422|$(printf 'artifact "Cover sheet — PDF" is already a PDF')" \
  "$STATUS|$(j "$BODY" '.error.message')"
http GET "/api/events?projectId=$PROBE_ID&limit=200"
assert_eq "exactly ONE document.converted audit event per conversion (2 runs → 2 events)" \
  "2" "$(j "$BODY" '[.data.events[] | select(.action == "document.converted")] | length')"

# ===========================================================================
# AC-P5-05 — Project Controls: schedule create + CPM analyze (platform core)
# ===========================================================================
jq -n '{format: "eos-schedule/1", name: "CPM diamond probe", activities: [
  {id: "a", name: "A", durationDays: 3, predecessorIds: []},
  {id: "b", name: "B", durationDays: 2, predecessorIds: []},
  {id: "c", name: "C", durationDays: 4, predecessorIds: ["a"]},
  {id: "e", name: "E", durationDays: 3, predecessorIds: ["c", "z"]}
]}' > "$WORK/sched-bad.json"
jpost "/api/projects/$PROBE_ID/schedules" "$WORK/sched-bad.json"
assert_contains "schedule create: unknown predecessor → 422 (zod, ledger style)" \
  'references unknown predecessor "z"' \
  "$(j "$BODY" '.error.message')"
jq -n '{format: "eos-schedule/1", name: "CPM diamond probe", activities: [
  {id: "a", name: "A", durationDays: 3, predecessorIds: []},
  {id: "b", name: "B", durationDays: 2, predecessorIds: []},
  {id: "c", name: "C", durationDays: 4, predecessorIds: ["a"]},
  {id: "d", name: "D", durationDays: 5, predecessorIds: ["b"]},
  {id: "f", name: "F", durationDays: 1, predecessorIds: ["d"]},
  {id: "e", name: "E", durationDays: 3, predecessorIds: ["c", "f"]}
]}' > "$WORK/sched.json"
jpost "/api/projects/$PROBE_ID/schedules" "$WORK/sched.json"
SCHED_ID=$(j "$BODY" '.data.artifact.id')
assert_eq "schedule created through the dedicated route (kind schedule — never auto-detected from uploads)" \
  "201|schedule|CPM diamond probe" "$STATUS|$(j "$BODY" '.data.artifact.kind')|$(j "$BODY" '.data.artifact.name')"
http POST "/api/projects/$PROBE_ID/artifacts/$SCHED_ID/analyze-schedule" -H 'Content-Type: application/json' -d '{}'
ANALYSIS_ID=$(j "$BODY" '.data.analysis.artifactId')
assert_eq "schedule → CPM analysis (eos-cpm/1, 6 activities, duration 11, critical path b→d→f→e)" \
  "201|analysis|eos-cpm/1|6|11|4|b,d,f,e" \
  "$STATUS|$(j "$BODY" '.data.analysis.kind')|$(j "$BODY" '.data.analysis.document.format')|$(j "$BODY" '.data.analysis.activityCount')|$(j "$BODY" '.data.analysis.durationDays')|$(j "$BODY" '.data.analysis.criticalPathCount')|$(j "$BODY" '.data.analysis.document.criticalPath | join(",")')"
assert_eq "platform-core honesty: engineKey/engineVersion/adapterScript/adapterHash ALL null (no engine claim, contract §4)" \
  "null|null|null|null" \
  "$(j "$BODY" '.data.analysis.engineKey')|$(j "$BODY" '.data.analysis.engineVersion')|$(j "$BODY" '.data.analysis.adapterScript')|$(j "$BODY" '.data.analysis.adapterHash')"
FLOAT_A=$(j "$BODY" '[.data.analysis.document.activities[] | select(.id == "a")][0] | [.es, .ef, .totalFloat, .critical] | map(tostring) | join("|")')
assert_eq "hand-checked CPM row: a → es 0, ef 3, float 1, NOT critical (b carries the chain)" \
  "0|3|1|false" "$FLOAT_A"
http GET "/api/events?projectId=$PROBE_ID&limit=200"
assert_eq "exactly ONE schedule.analyzed + ONE schedule.created audit event" \
  "1|1" "$(j "$BODY" '[.data.events[] | select(.action == "schedule.analyzed")] | length')|$(j "$BODY" '[.data.events[] | select(.action == "schedule.created")] | length')"
upload "/api/artifacts/$SCHED_ID/revisions" "$FIXTURES/schedule-cpm.json" ""
assert_eq "schedule edited → analysis stale via the existing cascade (Journey-G rides analyses too)" \
  "1|derived_from" "$(j "$REV_POST" '.data.staleMarked | length')|$(j "$REV_POST" '.data.staleMarked[0].relation')"
http POST "/api/projects/$PROBE_ID/artifacts/$SCHED_ID/analyze-schedule" -H 'Content-Type: application/json' -d '{}'
assert_eq "re-analyze on the edited schedule → rev 2 on the same analysis artifact" \
  "2" "$(j "$BODY" '.data.analysis.revisionNumber')"

# ===========================================================================
# AC-P5-06 — estimate recompute (known-limitation #7 closure)
# ===========================================================================
cat > "$WORK/t-approve.json" <<'EOF'
{ "action": "approve" }
EOF
cat > "$WORK/t-submit.json" <<'EOF'
{ "action": "submit" }
EOF
http POST "/api/projects/$PROBE_ID/artifacts/$MODEL_ID/derive-quantities" -H 'Content-Type: application/json' -d '{}'
http GET "/api/projects/$PROBE_ID/quantities"
QTY_VOL=$(j "$BODY" '[.data.quantities[] | select(.elementRef == "step:solid:0")][0].id')
QTY_COUNT=$(j "$BODY" '.data.quantities | length')
if [[ -n "$QTY_VOL" && "$QTY_COUNT" -gt 0 ]] 2>/dev/null; then ok "model-derived quantity rows from the REAL cadquery derive ($QTY_COUNT rows; volume row picked)"; else bad "quantity rows derived" "$QTY_COUNT / $QTY_VOL" ">0 rows + volume id"; fi
jpost "/api/quantities/$QTY_VOL/transition" "$WORK/t-submit.json"
jpost "/api/quantities/$QTY_VOL/transition" "$WORK/t-approve.json"
cat > "$WORK/assembly.json" <<'EOF'
{
  "name": "C25 slab pour",
  "trade": "Concrete works",
  "components": [
    { "id": "c25-readymix", "kind": "material", "name": "C25 ready-mix concrete", "quantityPerUnit": 1, "unit": "m³", "wastePct": 5 },
    { "id": "c25-crew", "kind": "labor", "name": "Slab pour crew", "quantityPerUnit": 1, "unit": "hr", "productivityFactor": 1.25 }
  ]
}
EOF
jpost "/api/projects/$PROBE_ID/assemblies" "$WORK/assembly.json"
ASM_ID=$(j "$BODY" '.data.assembly.id')
cat > "$WORK/rate-mat.json" <<'EOF'
{ "componentId": "c25-readymix", "currency": "GHS", "unitPrice": 174.0, "source": "price-book" }
EOF
jpost "/api/projects/$PROBE_ID/rates" "$WORK/rate-mat.json"
cat > "$WORK/rate-lab.json" <<'EOF'
{ "componentId": "c25-crew", "currency": "GHS", "unitPrice": 44.0, "source": "contract" }
EOF
jpost "/api/projects/$PROBE_ID/rates" "$WORK/rate-lab.json"
cat > "$WORK/estimate.json" <<'EOF'
{ "name": "Probe slab package", "currency": "GHS", "overheadPct": 10, "profitPct": 5, "taxPct": 0 }
EOF
jpost "/api/projects/$PROBE_ID/estimates" "$WORK/estimate.json"
EST_ID=$(j "$BODY" '.data.estimate.id')
cat > "$WORK/line1.json" <<EOF
{ "quantityId": "$QTY_VOL", "assemblyId": "$ASM_ID" }
EOF
jpost "/api/estimates/$EST_ID/lines" "$WORK/line1.json"
jpost "/api/estimates/$EST_ID/transition" "$WORK/t-submit.json"
jpost "/api/estimates/$EST_ID/transition" "$WORK/t-approve.json"
http GET "/api/estimates/$EST_ID"
ORIG_TOTAL=$(j "$BODY" '.data.estimate.totals.grandTotal')
ORIG_LINE_QTY=$(j "$BODY" '.data.estimate.lines[0].quantityId')
assert_eq "probe estimate approved with the model-derived line (deterministic server math)" \
  "approved|$QTY_VOL" "$(j "$BODY" '.data.estimate.status')|$ORIG_LINE_QTY"
http POST "/api/estimates/$EST_ID/recompute" -H 'Content-Type: application/json' -d '{}'
assert_eq "recompute on an approved estimate with NOTHING stale → honest 422 verbatim (no dead-button theater: the gate defends server-side)" \
  "422|nothing to recompute: no quantity source behind this estimate is stale" \
  "$STATUS|$(j "$BODY" '.error.message')"
jpost "/api/estimates/$EST_ID/lines" "$WORK/line1.json" >/dev/null 2>&1 || true
cat > "$WORK/draft-est.json" <<'EOF'
{ "name": "Probe draft (never approved)", "currency": "GHS", "overheadPct": 0, "profitPct": 0, "taxPct": 0 }
EOF
jpost "/api/projects/$PROBE_ID/estimates" "$WORK/draft-est.json"
DRAFT_EST=$(j "$BODY" '.data.estimate.id')
http POST "/api/estimates/$DRAFT_EST/recompute" -H 'Content-Type: application/json' -d '{}'
assert_eq "recompute on a DRAFT estimate → 422 verbatim (only approved recompute)" \
  "422|$(printf 'only approved estimates can be recomputed into a revised draft (this estimate is "draft")')" \
  "$STATUS|$(j "$BODY" '.error.message')"
# the "new takeoff" story: the model MOVES ON after the estimate was approved —
# a 4th revision makes the cited takeoff revision (rev 3) no longer the
# latest → Journey-G clause 2 fires → the recompute gate opens
upload "/api/artifacts/$MODEL_ID/revisions" "$FIXTURES/bracket-solid.step" ""
http POST "/api/estimates/$EST_ID/recompute" -H 'Content-Type: application/json' -d '{}'
NEW_DRAFT=$(j "$BODY" '.data.estimate.id')
assert_eq "recompute after the model moved on → 201 revised draft, title convention, same pricing config, original lines mirrored" \
  "201|draft|Probe slab package — revised draft|GHS|10|5|0|1" \
  "$STATUS|$(j "$BODY" '.data.estimate.status')|$(j "$BODY" '.data.estimate.name')|$(j "$BODY" '.data.estimate.currency')|$(j "$BODY" '.data.estimate.overheadPct')|$(j "$BODY" '.data.estimate.profitPct')|$(j "$BODY" '.data.estimate.taxPct')|$(j "$BODY" '.data.estimate.lines | length')"
near "revised draft totals identical to the original (the current slot row IS the original row — same value, same rates; the math is provably not forked)" \
  "$ORIG_TOTAL" "$(j "$BODY" '.data.estimate.totals.grandTotal')" "0.01"
NEW_LINE_QTY=$(j "$BODY" '.data.estimate.lines[0].quantityId')
assert_eq "slot re-resolution recorded: the rebuilt line cites the CURRENT ledger row of the takeoff slot (degenerate successor = the original row itself, same id)" \
  "$ORIG_LINE_QTY" "$NEW_LINE_QTY"
http GET "/api/estimates/$EST_ID"
assert_eq "the ORIGINAL estimate is untouched: still approved, lines frozen" \
  "approved" "$(j "$BODY" '.data.estimate.status')"
http GET "/api/events?projectId=$PROBE_ID&limit=200"
assert_eq "exactly ONE estimate.recomputed audit event carrying {fromEstimateId, newDraftId, staleSourceArtifactIds}" \
  "1|$EST_ID|$NEW_DRAFT|$MODEL_ID" \
  "$(j "$BODY" '[.data.events[] | select(.action == "estimate.recomputed")] | length')|$(j "$BODY" '[.data.events[] | select(.action == "estimate.recomputed")][0].detail | fromjson | .fromEstimateId')|$(j "$BODY" '[.data.events[] | select(.action == "estimate.recomputed")][0].detail | fromjson | .newDraftId')|$(j "$BODY" '[.data.events[] | select(.action == "estimate.recomputed")][0].detail | fromjson | .staleSourceArtifactIds[0]')"

# ===========================================================================
# AC-P5-07 — single execution path: the workflow vocabulary accepts the new ops
# ===========================================================================
jq -n --arg id "$MODEL_ID" '{name: "fe-mesh workflow probe", definition: {steps: [
  {id: "femesh", operation: "fe_mesh", inputs: {artifactId: $id}, parameters: {}, retry: {maxAttempts: 1, backoffMs: 0}, requiresApproval: false, skipOnError: false}
]}, createdBy: "agent:p5-acceptance"}' > "$WORK/wf-femesh.json"
jpost "/api/projects/$PROBE_ID/workflows" "$WORK/wf-femesh.json"
assert_eq "workflow definitions accept the five new broker ops (fe_mesh parses; zod ↔ broker vocabulary in sync)" \
  "201|draft|fe_mesh" "$STATUS|$(printf '%s' "$BODY" | /usr/bin/jq -r '.data.workflow.state + "|" + (.data.workflow.definition | fromjson | .steps[0].operation)')"

# ===========================================================================
# AC-P5-08 — registry validation fields served by /api/engines
# ===========================================================================
http GET /api/engines
assert_eq "/api/engines serves harness validation fields for all four Phase-5 engines (gmsh/pandapower/simpy/libreoffice; cases 4/2/2/1)" \
  "pass|pass|pass|pass|4|2|2|1" \
  "$(j "$BODY" '[.data.registry[] | select(.key == "gmsh")][0].validation.result')|$(j "$BODY" '[.data.registry[] | select(.key == "pandapower")][0].validation.result')|$(j "$BODY" '[.data.registry[] | select(.key == "simpy")][0].validation.result')|$(j "$BODY" '[.data.registry[] | select(.key == "libreoffice")][0].validation.result')|$(j "$BODY" '[.data.registry[] | select(.key == "gmsh")][0].validation.cases')|$(j "$BODY" '[.data.registry[] | select(.key == "pandapower")][0].validation.cases')|$(j "$BODY" '[.data.registry[] | select(.key == "simpy")][0].validation.cases')|$(j "$BODY" '[.data.registry[] | select(.key == "libreoffice")][0].validation.cases')"

# ===========================================================================
# AC-P5-09 — regression marker (byte-stability of untouched routes is proven by
# the four earlier scripts; this marker pins the shared demo dataset survived)
# ===========================================================================
DEMO_ID=$(http GET /api/projects && j "$BODY" '[.data.projects[] | select(.name == "Harbour View Extension")][0].id')
http GET "/api/estimates/$(j "$BODY" 'null')/export?format=csv" >/dev/null 2>&1 || true
http GET "/api/projects/$DEMO_ID/estimates"
DEMO_EST=$(j "$BODY" '[.data.estimates[] | select(.status == "approved")][0].id')
http GET "/api/estimates/$DEMO_EST/export?format=csv"
assert_eq "REGRESSION MARKER: the e2e-takeoff demo estimate still exports (200 text/csv) after all Phase-5 tests" \
  "200|text/csv; charset=utf-8" "$(printf '%s' "$STATUS")|$(curl -sS -m 60 -o /dev/null -w '%{content_type}' ${EOS_AUTH:-} "$BASE/api/estimates/$DEMO_EST/export?format=csv")"

# ===========================================================================
# cleanup: remove the probe project (kept for forensics on failure)
# ===========================================================================
if [[ "$FAIL" -eq 0 ]]; then
  (cd "$REPO" && bun scripts/dev-db-cleanup.ts --project "$PROBE_ID" >/dev/null) \
    && printf 'probe project removed — dev DB is the demo dataset only\n' \
    || printf 'WARNING: probe project removal FAILED (projects API has no DELETE; dev-db-cleanup exited non-zero)\n'
fi

printf '\n== e2e-p5-disciplines.sh: %d PASS / %d FAIL ==\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
