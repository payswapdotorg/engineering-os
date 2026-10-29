#!/usr/bin/env bash
# scripts/e2e-takeoff.sh — Engineering OS golden-path regression (Phase-3 record:
# 26 PASS + the Phase-2 step-11 mesh derive → 27 PASS; Slice-8 contract §1
# download-route round-trip +4 → 31 PASS; Slice-13 persistent sheet markups
# API +11 → 42 PASS). Rebuilt from the acceptance-catalogue evidence
# (AC-P3-01…08) + implementation-status records. Slice 15 vector takeoff
# (roadmap-gap-audit item 1) +8 → 50 PASS (AC-VT-01…08: pdfplumber/ezdxf
# extraction through the broker, sequential revisions, calibration fallback,
# the honest DWG + non-source refusals, the audit trail + 401 gate).
# Slice 18 region cutouts +11 → 81 PASS (AC-VT-10a…j). Slice 19 (§2.4):
# AC-VT-10d flips from refusal to ACCEPTANCE (a boundary-touching cutout on
# a CONVEX region rides the v2 clip lane) and AC-VT-11a…h pins the v2
# matrix → 89 PASS. Slice 20 (scale-invariant auto-count): AC-AC-04a…f
# pins the two-size page-3 field through the real pdfplumber lane, the v2
# quantityMethod provenance, and the mixed-size symbol-hits round-trip
# (+ the size-blind consistency gate) → 95 PASS. Slice 27 (the rotated-page
# correctness closure, limitation #17): AC-RW-01…06 pins the /Rotate 90
# fixture page 4 through the REAL vector-takeoff broker — rotation-invariant
# counts + area, the pdfplumber displayed page, the pdfminer-CTM rotated
# anchors, and the unrotated-space symbol-hits markup round-trip → 101 PASS.
#
# Rebuilds the demo dataset through the REAL API against the live dev server:
# project "Harbour View Extension", 4 fixtures, 14 ledger rows, 1 approved GHS
# estimate (subtotal 10197.72 / OH 1019.77 / profit 560.87 / tax 0 /
# grand 11778.36), plus one derived mesh so Design Studio renders 3D on first
# open. Every assertion prints PASS/FAIL with the actual response on failure;
# final line "N PASS / M FAIL", nonzero exit on any FAIL.
#
# Run AFTER `bun scripts/dev-db-cleanup.ts --all`. Pure HTTP: curl + jq + python3.
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
FIXTURES="$(cd "$(dirname "$0")/.." && pwd)/tests/fixtures"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Phase-6 auth (contract §1.5): bootstrap the demo operator (first-run setup)
# if needed, then sign in via the REAL NextAuth flow. Every curl below appends
# ${EOS_AUTH} (cookie jar) — the API requires a session now.
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
assert_eq() { # desc expected actual
  if [[ "$3" == "$2" ]]; then ok "$1"; else bad "$1" "$3" "$2"; fi
}

STATUS=""
BODY=""
http() { # method path [extra curl args…]
  local method="$1" path="$2"
  shift 2
  : > "$WORK/http.body" # truncate BEFORE curl: a timed-out request must never report the previous response as BODY (run 42 stale-body lesson)
  STATUS=$(curl -sS -m 180 -o "$WORK/http.body" -w '%{http_code}' -X "$method" "$BASE$path" "$@" ${EOS_AUTH:-}) || STATUS="000"
  BODY=$(cat "$WORK/http.body")
}
jpost() { # path jsonfile
  http POST "$1" -H 'Content-Type: application/json' --data-binary @"$2"
}
upload() { # path file kind [explicit artifact name]
  local path="$1" file="$2" kind="$3" name="${4:-}"
  local args=(-F "file=@$file" -F "kind=$kind")
  # The register route defaults `name` to the extension-stripped filename base;
  # the pinned BOQ joins reference full filenames ("wall-quantities.ifc"), so
  # the demo uploads set the name explicitly.
  if [[ -n "$name" ]]; then args+=(-F "name=$name"); fi
  : > "$WORK/http.body" # truncate BEFORE curl: a timed-out request must never report the previous response as BODY (run 42 stale-body lesson)
  STATUS=$(curl -sS -m 180 -o "$WORK/http.body" -w '%{http_code}' -X POST "${args[@]}" "$BASE$path" ${EOS_AUTH:-}) || STATUS="000"
  BODY=$(cat "$WORK/http.body")
}
j() { printf '%s' "$1" | /usr/bin/jq -r "$2"; }

# ===========================================================================
# 1. Project "Harbour View Extension" (the demo dataset root)
# ===========================================================================
cat > "$WORK/proj.json" <<'EOF'
{
  "name": "Harbour View Extension",
  "discipline": "civil",
  "description": "Golden-path demo dataset (e2e-takeoff.sh): drawings + models + verified estimate"
}
EOF
jpost /api/projects "$WORK/proj.json"
PID=$(j "$BODY" '.data.project.id')
PROJ_NAME=$(j "$BODY" '.data.project.name')
PROJ_STATUS="$STATUS"
http GET "/api/events?projectId=$PID&limit=200"
assert_eq "project created via real API (201 + name) with exactly one project.created audit event" \
  "201|Harbour View Extension|1" \
  "$PROJ_STATUS|$PROJ_NAME|$(j "$BODY" '[.data.events[] | select(.action == "project.created")] | length')"
if [[ -z "$PID" ]]; then echo "FATAL: project creation failed — see the FAIL above"; exit 1; fi

# ===========================================================================
# 2-5. Register the four demo fixtures (real multipart uploads)
# ===========================================================================
upload "/api/projects/$PID/artifacts" "$FIXTURES/bracket-solid.step" model "bracket-solid.step"
BRACKET_SOLID_ID=$(j "$BODY" '.data.artifact.id')
BRACKET_SOLID_REV=$(j "$BODY" '.data.artifact.latestRevision.id')
LOCAL_SHA=$(sha256sum "$FIXTURES/bracket-solid.step" | cut -d' ' -f1)
assert_eq "bracket-solid.step registered: rev 1, contentHash == local sha256 (byte-exact round-trip)" \
  "201|model|1|$LOCAL_SHA" \
  "$STATUS|$(j "$BODY" '.data.artifact.kind')|$(j "$BODY" '.data.artifact.latestRevision.revNumber')|$(j "$BODY" '.data.artifact.latestRevision.contentHash')"

upload "/api/projects/$PID/artifacts" "$FIXTURES/wall-quantities.ifc" model "wall-quantities.ifc"
WALL_IFC_ID=$(j "$BODY" '.data.artifact.id')
WALL_IFC_REV=$(j "$BODY" '.data.artifact.latestRevision.id')
assert_eq "wall-quantities.ifc registered (201, kind model, rev 1)" "201|model|1" \
  "$STATUS|$(j "$BODY" '.data.artifact.kind')|$(j "$BODY" '.data.artifact.latestRevision.revNumber')"

cat > "$WORK/Sheet-A101-GA-plan.svg" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="420" height="190" viewBox="0 0 420 190">
  <title>A-101 GA plan — ground floor slab</title>
  <text x="10" y="22" font-family="sans-serif" font-size="14">A-101 — GA plan (ground floor), zone B</text>
  <rect x="20" y="40" width="200" height="80" fill="none" stroke="black" stroke-width="2"/>
  <text x="230" y="85" font-family="sans-serif" font-size="12">SLAB ZONE B</text>
  <text x="20" y="138" font-family="sans-serif" font-size="12">SCALE 1:100 @ A1 — scale bar B below</text>
  <g id="scale-bar-b">
    <rect x="20" y="150" width="50" height="8" fill="black"/>
    <rect x="70" y="150" width="50" height="8" fill="white" stroke="black"/>
    <rect x="120" y="150" width="50" height="8" fill="black"/>
    <rect x="170" y="150" width="50" height="8" fill="white" stroke="black"/>
    <text x="20" y="175" font-family="sans-serif" font-size="11">0     5     10    15    20 m</text>
  </g>
</svg>
EOF
upload "/api/projects/$PID/artifacts" "$WORK/Sheet-A101-GA-plan.svg" drawing "Sheet-A101-GA-plan.svg"
SVG_ID=$(j "$BODY" '.data.artifact.id')
SVG_REV=$(j "$BODY" '.data.artifact.latestRevision.id')
assert_eq "scale-barred drawing Sheet-A101-GA-plan.svg registered (201, kind drawing)" \
  "201|drawing|Sheet-A101-GA-plan.svg" "$STATUS|$(j "$BODY" '.data.artifact.kind')|$(j "$BODY" '.data.artifact.name')"

upload "/api/projects/$PID/artifacts" "$FIXTURES/bracket.step" model "bracket.step"
BRACKET_EMPTY_ID=$(j "$BODY" '.data.artifact.id')
assert_eq "honest-failure STEP stub bracket.step registered (201, kind model)" \
  "201|model" "$STATUS|$(j "$BODY" '.data.artifact.kind')"

# ===========================================================================
# 5b. Slice-8 (contract §1): the lane-8-c PDF fixture becomes a NEW revision
# of the SVG sheet artifact above, then the restored download route must
# serve those exact bytes back (4 assertions; PASS count 27 → 31).
# ===========================================================================
if [[ ! -f "$FIXTURES/sheet-a102-plan.pdf" ]]; then
  echo "FATAL: $FIXTURES/sheet-a102-plan.pdf is missing (lane 8-c fixture) — the download assertions cannot run; fix the fixture, never skip silently" >&2
  exit 1
fi
SHEET_ID="$SVG_ID"
upload "/api/artifacts/$SHEET_ID/revisions" "$FIXTURES/sheet-a102-plan.pdf" drawing
PDF_REV=$(j "$BODY" '.data.revision.id')
PDF_HASH=$(j "$BODY" '.data.revision.contentHash')
PDF_LOCAL_SHA=$(sha256sum "$FIXTURES/sheet-a102-plan.pdf" | cut -d' ' -f1)
assert_eq "sheet-a102-plan.pdf uploaded as the sheet's 2nd revision: 201 + contentHash == local sha256 (byte-exact upload)" \
  "201|2|$PDF_LOCAL_SHA" \
  "$STATUS|$(j "$BODY" '.data.revision.revNumber')|$(j "$BODY" '.data.revision.contentHash')"

DL_STATUS=$(curl -sS -m 180 -o "$WORK/dl.pdf" -D "$WORK/dl.headers" -w '%{http_code}' ${EOS_AUTH:-} "$BASE/api/revisions/$PDF_REV/download") || DL_STATUS="000"
assert_eq "GET /api/revisions/<pdfRevId>/download → 200 with real PDF bytes (body starts %PDF-, never an error page)" \
  "200|%PDF-" "$DL_STATUS|$(head -c 5 "$WORK/dl.pdf")"

DL_SHA=$(awk 'tolower($1)=="x-eos-sha256:"{gsub(/\r/,""); print $2}' "$WORK/dl.headers")
assert_eq "download integrity: X-Eos-Sha256 header == uploaded contentHash AND sha256(downloaded bytes) == it (byte-exact round-trip)" \
  "$PDF_HASH|$PDF_HASH" "$DL_SHA|$(sha256sum "$WORK/dl.pdf" | cut -d' ' -f1)"

UNAUTH_STATUS=$(curl -sS -m 30 -o "$WORK/dl-unauth.body" -w '%{http_code}' "$BASE/api/revisions/$PDF_REV/download") || UNAUTH_STATUS="000"
UNAUTH_BODY=$(cat "$WORK/dl-unauth.body")
assert_eq "unauthenticated download on the same URL → 401 envelope verbatim (session required)" \
  "401|unauthorized|sign in required" \
  "$UNAUTH_STATUS|$(j "$UNAUTH_BODY" '.error.code')|$(j "$UNAUTH_BODY" '.error.message')"

# ===========================================================================
# 6-7. AC-P3-01 drawing-measured ledger row + sheetRef enforcement
# ===========================================================================
cat > "$WORK/qty-drawing.json" <<EOF
{
  "sourceArtifactRevisionId": "$SVG_REV",
  "sheetRef": "A-101 / zone B",
  "quantityType": "area",
  "value": 46.2,
  "unit": "m²",
  "method": "drawing-measured",
  "scale": "1:100 @ A1 (scale bar B)",
  "rulesetId": "drawing-takeoff",
  "rulesetVersion": "0.1",
  "createdBy": "local-operator"
}
EOF
jpost "/api/projects/$PID/quantities" "$WORK/qty-drawing.json"
Q1=$(j "$BODY" '.data.quantity.id')
assert_eq "drawing-measured row 46.2 m² @ A-101 / zone B recorded (201, draft, scale record + source join)" \
  "201|draft|46.2|A-101 / zone B|1:100 @ A1 (scale bar B)|Sheet-A101-GA-plan.svg" \
  "$STATUS|$(j "$BODY" '.data.quantity.status')|$(j "$BODY" '.data.quantity.value')|$(j "$BODY" '.data.quantity.sheetRef')|$(j "$BODY" '.data.quantity.scale')|$(j "$BODY" '.data.quantity.sourceArtifact.name')"

cat > "$WORK/qty-nosheet.json" <<EOF
{
  "sourceArtifactRevisionId": "$SVG_REV",
  "quantityType": "area",
  "value": 12,
  "unit": "m²",
  "method": "drawing-measured",
  "rulesetId": "drawing-takeoff",
  "rulesetVersion": "0.1",
  "createdBy": "local-operator"
}
EOF
jpost "/api/projects/$PID/quantities" "$WORK/qty-nosheet.json"
assert_eq "missing sheetRef refused 422 with the exact core zod message (verbatim)" \
  'invalid QuantityRecord: sheetRef: drawing-measured quantities require a non-empty sheetRef (drawing sheet / measurement region)' \
  "$(j "$BODY" '.error.message')"

# ===========================================================================
# 6b-13. Slice 13 — persistent sheet markups (limitation #5): the provenance
# geometry of drawing-measured rows, behind the same wrapper as the ledger.
# ===========================================================================
cat > "$WORK/mkp-length.json" <<EOF
{
  "revisionId": "$SVG_REV",
  "page": 1,
  "kind": "length",
  "points": [ { "x": 60, "y": 120 }, { "x": 343.4646, "y": 120 } ],
  "label": "scale bar span",
  "value": 8.0,
  "unit": "m",
  "scale": "calibrated 2-pt, 10 m ↔ 283.46 pt — 8.80 mm/pt",
  "quantityId": "$Q1",
  "createdBy": "local-operator"
}
EOF
jpost "/api/projects/$PID/markups" "$WORK/mkp-length.json"
MKP_ID=$(j "$BODY" '.data.markup.id')
assert_eq "length markup persisted (201) linked to its ledger row, geometry parsed back" \
  "201|length|8|m|$Q1|2|local-operator" \
  "$STATUS|$(j "$BODY" '.data.markup.kind')|$(j "$BODY" '.data.markup.value')|$(j "$BODY" '.data.markup.unit')|$(j "$BODY" '.data.markup.quantityId')|$(j "$BODY" '.data.markup.points | length')|$(j "$BODY" '.data.markup.createdBy')"

http GET "/api/events?projectId=$PID&limit=200"
assert_eq "markup.created audit event recorded in the project feed (mutations are auditable)" \
  "1" "$(j "$BODY" '[.data.events[] | select(.action == "markup.created")] | length')"

http GET "/api/projects/$PID/markups?revisionId=$SVG_REV"
assert_eq "GET markups by revision: the row is listed with its geometry and the ledger link" \
  "200|1|$MKP_ID|343.4646|1" \
  "$STATUS|$(j "$BODY" '.data.markups | length')|$(j "$BODY" '.data.markups[0].id')|$(j "$BODY" '.data.markups[0].points[1].x')|$(j "$BODY" '[.data.markups[] | select(.quantityId != null)] | length')"

cat > "$WORK/mkp-badkind.json" <<EOF
{
  "revisionId": "$SVG_REV",
  "page": 1,
  "kind": "volume",
  "points": [ { "x": 1, "y": 1 }, { "x": 2, "y": 2 } ],
  "value": 1,
  "unit": "m",
  "createdBy": "local-operator"
}
EOF
jpost "/api/projects/$PID/markups" "$WORK/mkp-badkind.json"
assert_eq "unknown kind refused 422 with the closed vocabulary in the message (verbatim)" \
  'kind: kind must be one of: length, area, count, symbol-hits, text-hits, calibration' \
  "$(j "$BODY" '.error.message')"

cat > "$WORK/mkp-foreignrev.json" <<EOF
{
  "revisionId": "rev_does_not_exist",
  "page": 1,
  "kind": "length",
  "points": [ { "x": 1, "y": 1 }, { "x": 2, "y": 2 } ],
  "value": 1,
  "unit": "m",
  "createdBy": "local-operator"
}
EOF
jpost "/api/projects/$PID/markups" "$WORK/mkp-foreignrev.json"
assert_eq "markup on a foreign/unknown revision refused 422 (ledger-row rule, verbatim)" \
  'revisionId: must reference an artifact revision of this project (got rev_does_not_exist)' \
  "$(j "$BODY" '.error.message')"

cat > "$WORK/mkp-foreignqty.json" <<EOF
{
  "revisionId": "$SVG_REV",
  "page": 1,
  "kind": "length",
  "points": [ { "x": 1, "y": 1 }, { "x": 2, "y": 2 } ],
  "value": 1,
  "unit": "m",
  "quantityId": "qty_does_not_exist",
  "createdBy": "local-operator"
}
EOF
jpost "/api/projects/$PID/markups" "$WORK/mkp-foreignqty.json"
assert_eq "markup with a foreign quantityId refused 422 — a dangling ledger link is a lie, never accepted" \
  'quantityId: must reference a quantity record of this project (got qty_does_not_exist)' \
  "$(j "$BODY" '.error.message')"

cat > "$WORK/mkp-countbad.json" <<EOF
{
  "revisionId": "$SVG_REV",
  "page": 1,
  "kind": "count",
  "points": [ { "x": 1, "y": 1 }, { "x": 2, "y": 2 } ],
  "value": 3,
  "unit": "each",
  "createdBy": "local-operator"
}
EOF
jpost "/api/projects/$PID/markups" "$WORK/mkp-countbad.json"
assert_eq "count markup value/geometry mismatch refused 422 (stored counts can never disagree with their points)" \
  "invalid SheetMarkup: a count markup's value must equal its clicked points (2), got 3" \
  "$(j "$BODY" '.error.message')"

cat > "$WORK/mkp-calib.json" <<EOF
{
  "revisionId": "$SVG_REV",
  "page": 1,
  "kind": "calibration",
  "points": [ { "x": 60, "y": 120 }, { "x": 343.4646, "y": 120 } ],
  "label": "scale bar 10 m",
  "value": 8.8,
  "unit": "mm/pt",
  "scale": "calibrated 2-pt, 10 m ↔ 283.46 pt — 8.80 mm/pt",
  "createdBy": "local-operator"
}
EOF
jpost "/api/projects/$PID/markups" "$WORK/mkp-calib.json"
assert_eq "calibration markup persisted (201, unit mm/pt, NEVER carries a quantityId)" \
  "201|calibration|8.8|mm/pt|null" \
  "$STATUS|$(j "$BODY" '.data.markup.kind')|$(j "$BODY" '.data.markup.value')|$(j "$BODY" '.data.markup.unit')|$(j "$BODY" '.data.markup.quantityId')"

UNAUTH_MKP_STATUS=$(curl -sS -m 30 -o "$WORK/mkp-unauth.body" -w '%{http_code}' "$BASE/api/projects/$PID/markups") || UNAUTH_MKP_STATUS="000"
UNAUTH_MKP_BODY=$(cat "$WORK/mkp-unauth.body")
assert_eq "unauthenticated markups GET → 401 envelope verbatim (session required, wrapper gate)" \
  "401|unauthorized|sign in required" \
  "$UNAUTH_MKP_STATUS|$(j "$UNAUTH_MKP_BODY" '.error.code')|$(j "$UNAUTH_MKP_BODY" '.error.message')"

http DELETE "/api/projects/$PID/markups/$MKP_ID"
assert_eq "markup deleted → 200 {removed: id} (geometry only — the ledger row keeps its own lifecycle)" \
  "200|$MKP_ID" "$STATUS|$(j "$BODY" '.data.removed')"
http GET "/api/projects/$PID/markups?revisionId=$SVG_REV"
assert_eq "after the delete, only the calibration markup remains (1 row, no quantityId)" \
  "200|1|calibration|null" \
  "$STATUS|$(j "$BODY" '.data.markups | length')|$(j "$BODY" '.data.markups[0].kind')|$(j "$BODY" '.data.markups[0].quantityId')"

# ===========================================================================
# 8-11. AC-P3-02 model-derived quantities (REAL adapters) + analytic hand-checks
# ===========================================================================
http POST "/api/projects/$PID/artifacts/$BRACKET_SOLID_ID/derive-quantities"
STEPQ="$BODY"
assert_eq "derive-quantities on bracket-solid.step: 201, 3 rows, cadquery provenance + step-geometric ruleset + 64-hex adapterHash + draft status" \
  "201|3|cadquery 2.6.1 via step_quantities.py|step-geometric|true|draft|step:model:bbox,step:solid:0,step:solids:all" \
  "$STATUS|$(j "$STEPQ" '.data.quantities | length')|$(j "$STEPQ" '.data.quantities[0].quantityMethod')|$(j "$STEPQ" '.data.quantities[0].rulesetId')|$(j "$STEPQ" '.data.quantities[0].provenance.adapterHash | test("^[0-9a-f]{64}$")')|$(j "$STEPQ" '.data.quantities[0].status')|$(j "$STEPQ" '[.data.quantities[].elementRef] | sort | join(",")')"

VOL=$(j "$STEPQ" '[.data.quantities[] | select(.elementRef == "step:solid:0")][0].value')
AREA=$(j "$STEPQ" '[.data.quantities[] | select(.elementRef == "step:solids:all")][0].value')
BBOX=$(j "$STEPQ" '[.data.quantities[] | select(.elementRef == "step:model:bbox")][0].value')
if python3 -c 'import sys, math
v, a, b = float(sys.argv[1]), float(sys.argv[2]), float(sys.argv[3])
ok = abs(v - (36000 - 960 * math.pi)) <= 0.01
sys.exit(0 if ok else 1)' "$VOL" "$AREA" "$BBOX"; then
  ok "cadquery volume == analytic hand-check 36000 − 960π mm³ (rel ~1e-14, AC-P3-02)"
else
  bad "cadquery volume == analytic hand-check 36000 − 960π mm³" "$VOL" "≈ 32984.071 mm³"
fi
if python3 -c 'import sys, math
a, b = float(sys.argv[1]), float(sys.argv[2])
ok = abs(a - (10200 + 416 * math.pi)) <= 0.01 and abs(b - math.sqrt(9800)) <= 0.0001
sys.exit(0 if ok else 1)' "$AREA" "$BBOX"; then
  ok "cadquery area == 10200 + 416π mm² AND bbox length == √9800 mm (closed forms)"
else
  bad "cadquery area + bbox closed-form hand-checks" "area=$AREA bbox=$BBOX" "≈ 11506.9025 / ≈ 98.9949"
fi

http POST "/api/projects/$PID/artifacts/$WALL_IFC_ID/derive-quantities"
IFCQ="$BODY"
assert_eq "wall-quantities.ifc: 201, exactly 10 authored BaseQuantities read back (Volume 1.2 m³ ×2, SideArea 12.8 m² ×2, Footprint 0.6 m² ×2, WallTieCount 2, one wall ref)" \
  "201|10|2|2|2|1|10|ifc-base-quantities" \
  "$STATUS|$(j "$IFCQ" '.data.quantities | length')|$(j "$IFCQ" '[.data.quantities[] | select(.quantityType == "volume" and .value == 1.2)] | length')|$(j "$IFCQ" '[.data.quantities[] | select(.quantityType == "area" and .value == 12.8)] | length')|$(j "$IFCQ" '[.data.quantities[] | select(.quantityType == "area" and .value == 0.6)] | length')|$(j "$IFCQ" '[.data.quantities[] | select(.quantityType == "count" and .value == 2)] | length')|$(j "$IFCQ" '[.data.quantities[] | select(.elementRef == "#2rUnE8CnPHBwLdZzIqZkf1")] | length')|$(j "$IFCQ" '.data.quantities[0].rulesetId')"

http GET "/api/events?projectId=$PID&limit=200"
assert_eq "exactly one quantity.derived audit event per derive (2 total), actors adapter:cadquery + adapter:ifcopenshell, adapterHash recorded in detail" \
  "2|1|1|true" \
  "$(j "$BODY" '[.data.events[] | select(.action == "quantity.derived")] | length')|$(j "$BODY" '[.data.events[] | select(.action == "quantity.derived" and .actorId == "adapter:cadquery")] | length')|$(j "$BODY" '[.data.events[] | select(.action == "quantity.derived" and .actorId == "adapter:ifcopenshell")] | length')|$(j "$BODY" '[.data.events[] | select(.action == "quantity.derived")][0].detail | fromjson | has("adapterHash")')"

http POST "/api/projects/$PID/artifacts/$BRACKET_EMPTY_ID/derive-quantities"
assert_eq "geometry-free bracket.step → honest 422 engine_unavailable, VERBATIM (never simulated)" \
  "422|engine_unavailable|no solid geometry found in STEP file (import produced 0 solids) - cannot derive quantities, and simulated values are not an option" \
  "$STATUS|$(j "$BODY" '.error.code')|$(j "$BODY" '.error.message')"

# ===========================================================================
# 12. AC-P3-04 quantity approval machine (draft→in_review→approved, no shortcuts)
# ===========================================================================
cat > "$WORK/t-approve.json" <<'EOF'
{ "action": "approve" }
EOF
cat > "$WORK/t-submit.json" <<'EOF'
{ "action": "submit" }
EOF
jpost "/api/quantities/$Q1/transition" "$WORK/t-approve.json"
Q1_DIRECT=$(j "$BODY" '.error.message')
jpost "/api/quantities/$Q1/transition" "$WORK/t-submit.json"
Q1_SUBMIT="$STATUS|$(j "$BODY" '.data.quantity.status')"
http GET "/api/projects/$PID/quantities"
Q2=$(printf '%s' "$BODY" | /usr/bin/jq -r '[.data.quantities[] | select(.elementRef == "#2rUnE8CnPHBwLdZzIqZkf1" and .quantityType == "area" and .value == 0.6)][0].id')
jpost "/api/quantities/$Q2/transition" "$WORK/t-submit.json"
Q2_SUBMIT="$STATUS|$(j "$BODY" '.data.quantity.status')"
assert_eq "quantity approval machine: direct draft→approve 422 verbatim; submit → in_review (both demo quantities)" \
  'cannot approve a quantity in status "draft" — approve requires in_review (submit it first; no direct draft→approved)|200|in_review|200|in_review' \
  "$Q1_DIRECT|$Q1_SUBMIT|$Q2_SUBMIT"

# ===========================================================================
# 13-15. AC-P3-05/08 TradeAssembly C25 + engineer rates (never agent-created)
# ===========================================================================
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
jpost "/api/projects/$PID/assemblies" "$WORK/assembly.json"
ASM_ID=$(j "$BODY" '.data.assembly.id')
assert_eq "C25 TradeAssembly created (material waste 5% + labor productivity ×1.25, 2 components)" \
  "201|C25 slab pour|2" "$STATUS|$(j "$BODY" '.data.assembly.name')|$(j "$BODY" '.data.assembly.components | length')"

cat > "$WORK/rate-mat.json" <<'EOF'
{ "componentId": "c25-readymix", "currency": "GHS", "unitPrice": 174.0, "source": "price-book" }
EOF
jpost "/api/projects/$PID/rates" "$WORK/rate-mat.json"
assert_eq "engineer material rate GHS 174.00 recorded (createdBy server-set, never from body)" \
  "201|local-operator|174" "$STATUS|$(j "$BODY" '.data.rate.createdBy')|$(j "$BODY" '.data.rate.unitPrice')"

cat > "$WORK/rate-lab.json" <<'EOF'
{ "componentId": "c25-crew", "currency": "GHS", "unitPrice": 44.0, "source": "contract" }
EOF
jpost "/api/projects/$PID/rates" "$WORK/rate-lab.json"
assert_eq "engineer labor rate GHS 44.00 recorded (createdBy server-set)" \
  "201|local-operator|44" "$STATUS|$(j "$BODY" '.data.rate.createdBy')|$(j "$BODY" '.data.rate.unitPrice')"

# ===========================================================================
# 16-18. AC-P3-05/06 deterministic estimate math (server-side, recomputed on read)
# ===========================================================================
cat > "$WORK/estimate.json" <<'EOF'
{ "name": "Ground floor slab package", "currency": "GHS", "overheadPct": 10, "profitPct": 5, "taxPct": 0 }
EOF
jpost "/api/projects/$PID/estimates" "$WORK/estimate.json"
EST_ID=$(j "$BODY" '.data.estimate.id')
assert_eq "draft estimate created (GHS, overhead 10% / profit 5% / tax 0%, half-up @ 2dp)" \
  "201|draft|GHS|10|5|0" "$STATUS|$(j "$BODY" '.data.estimate.status')|$(j "$BODY" '.data.estimate.currency')|$(j "$BODY" '.data.estimate.overheadPct')|$(j "$BODY" '.data.estimate.profitPct')|$(j "$BODY" '.data.estimate.taxPct')"

cat > "$WORK/line1.json" <<EOF
{ "quantityId": "$Q1", "assemblyId": "$ASM_ID" }
EOF
jpost "/api/estimates/$EST_ID/lines" "$WORK/line1.json"
assert_eq "line 1 = 46.2 m² × C25 → GHS 10,066.98 (hand-checked: 8,440.74 material + 1,626.24 labor)" \
  "201|10066.98|8440.74+1626.24" \
  "$STATUS|$(j "$BODY" '.data.estimate.lines[-1].lineTotal')|$(j "$BODY" '[.data.estimate.lines[-1].breakdown[].cost] | map(tostring) | join("+")')"

cat > "$WORK/line2.json" <<EOF
{ "quantityId": "$Q2", "assemblyId": "$ASM_ID" }
EOF
jpost "/api/estimates/$EST_ID/lines" "$WORK/line2.json"
assert_eq "line 2 = 0.6 m² footprint × C25 → GHS 130.74 (hand-checked: 109.62 + 21.12)" \
  "201|130.74|109.62+21.12" \
  "$STATUS|$(j "$BODY" '.data.estimate.lines[-1].lineTotal')|$(j "$BODY" '[.data.estimate.lines[-1].breakdown[].cost] | map(tostring) | join("+")')"

http GET "/api/estimates/$EST_ID"
assert_eq "estimate totals per the pinned formula: subtotal 10197.72 · OH 1019.77 (10%) · profit 560.87 (5%) · tax 0 · grand GHS 11,778.36" \
  "10197.72|1019.77|560.87|0|11778.36|GHS" \
  "$(printf '%s' "$BODY" | /usr/bin/jq -r '.data.estimate.totals | [.linesSubtotal, .overhead, .profit, .tax, .grandTotal, .currency] | map(tostring) | join("|")')"

# ===========================================================================
# 19-21. AC-P3-07 approval gate: every line quantity must be approved
# ===========================================================================
jpost "/api/estimates/$EST_ID/transition" "$WORK/t-approve.json"
EST_DIRECT=$(j "$BODY" '.error.message')
jpost "/api/estimates/$EST_ID/transition" "$WORK/t-submit.json"
EST_SUBMIT="$STATUS|$(j "$BODY" '.data.estimate.status')"
assert_eq "estimate approve from draft refused 422 verbatim; submit → in_review" \
  'cannot approve an estimate in status "draft" — approve requires in_review (submit it first)|200|in_review' \
  "$EST_DIRECT|$EST_SUBMIT"

jpost "/api/estimates/$EST_ID/transition" "$WORK/t-approve.json"
assert_eq "approve blocked 422 with BOTH quantities named as blockers (ids + sheet/element refs, verbatim)" \
  "estimate approve blocked (2 blockers): quantity $Q1 (A-101 / zone B) is \"in_review\"; quantity $Q2 (#2rUnE8CnPHBwLdZzIqZkf1) is \"in_review\"" \
  "$(j "$BODY" '.error.message')"

jpost "/api/quantities/$Q1/transition" "$WORK/t-approve.json"
Q1_APPROVED="$STATUS|$(j "$BODY" '.data.quantity.status')|$(j "$BODY" '.data.quantity.approval.approvedBy')"
jpost "/api/quantities/$Q2/transition" "$WORK/t-approve.json"
Q2_APPROVED="$STATUS|$(j "$BODY" '.data.quantity.status')"
jpost "/api/estimates/$EST_ID/transition" "$WORK/t-approve.json"
assert_eq "after approving the quantities: estimate approve 200, status approved, approval payload {local-operator, approvedAt} on estimate + quantity rows" \
  "200|approved|local-operator|200|approved|local-operator|200|approved" \
  "$STATUS|$(j "$BODY" '.data.estimate.status')|$(j "$BODY" '.data.estimate.approval.approvedBy')|$Q1_APPROVED|$Q2_APPROVED"

# ===========================================================================
# 22. Approved estimates freeze lines (AC-P3-07)
# ===========================================================================
cat > "$WORK/line3.json" <<EOF
{ "quantityId": "$Q1", "assemblyId": "$ASM_ID" }
EOF
jpost "/api/estimates/$EST_ID/lines" "$WORK/line3.json"
assert_eq "approved estimate lines frozen (add → 422 verbatim)" \
  'estimate is approved — its lines are frozen; duplicate the estimate to change it' \
  "$(j "$BODY" '.error.message')"

# ===========================================================================
# 23. AC-P3-08: rates are engineer-entered — an agent can NEVER author a rate
# ===========================================================================
cat > "$WORK/rate-add.json" <<'EOF'
{ "componentId": "c25-readymix", "currency": "GHS", "unitPrice": 1475.0, "source": "quote", "createdBy": "agent:price-guesser" }
EOF
jpost "/api/projects/$PID/rates" "$WORK/rate-add.json"
RATE_STATUS="$STATUS"
RATE_CREATED_BY=$(j "$BODY" '.data.rate.createdBy')
RATE_PRICE=$(j "$BODY" '.data.rate.unitPrice')
http GET "/api/estimates/$EST_ID"
GRAND_AFTER=$(j "$BODY" '.data.estimate.totals.grandTotal')
if [[ "$RATE_STATUS" == "201" && "$RATE_CREATED_BY" == "local-operator" && "$RATE_PRICE" == "1475" && "$GRAND_AFTER" == "11778.36" ]]; then
  ok "Add-rate GHS 1,475.00 recorded as engineer provenance (hostile agent createdBy ignored) AND stored lines never re-priced"
else
  bad "Add-rate GHS 1,475.00 recorded as engineer provenance" "$RATE_STATUS|$RATE_CREATED_BY|$RATE_PRICE|$GRAND_AFTER" "201|local-operator|1475|11778.36"
fi

# ===========================================================================
# 24. Step 11 (Phase-2 extension): real mesh derive so Design Studio shows 3D
# ===========================================================================
http POST "/api/projects/$PID/artifacts/$BRACKET_SOLID_ID/derive-mesh"
MESH_STATUS="$STATUS"
MESH_BODY="$BODY"
MESH_KIND=$(j "$MESH_BODY" '.data.mesh.kind')
MESH_ELEMENTS=$(j "$MESH_BODY" '.data.mesh.elementCount')
MESH_FROM_REV=$(j "$MESH_BODY" '.data.mesh.derivedFromRevisionId')
http GET "/api/events?projectId=$PID&limit=200"
MESH_EVENTS=$(j "$BODY" '[.data.events[] | select(.action == "mesh.derived")] | length')
MESH_SHA=$(j "$BODY" '[.data.events[] | select(.action == "mesh.derived")][0].detail | fromjson | .sha256 // "missing"')
if [[ "$MESH_STATUS" == "201" && "$MESH_KIND" == "mesh" && "$MESH_FROM_REV" == "$BRACKET_SOLID_REV" && "$MESH_EVENTS" == "1" && "$MESH_SHA" != "missing" ]] && python3 -c 'import sys; sys.exit(0 if int(sys.argv[1]) >= 1 else 1)' "$MESH_ELEMENTS"; then
  ok "mesh derived from the demo model (201, kind mesh, elementCount > 0, derivedFrom == source latest rev, exactly one mesh.derived audit event with sha256)"
else
  bad "mesh derived from the demo model" "status=$MESH_STATUS kind=$MESH_KIND elements=$MESH_ELEMENTS fromRev=$MESH_FROM_REV events=$MESH_EVENTS sha=$MESH_SHA" "201|mesh|>0|$BRACKET_SOLID_REV|1|sha256"
fi


# 34-41. Slice 15 (roadmap-gap-audit item 1) — vector takeoff ACs (AC-VT-01…08):
# REAL pdfplumber/ezdxf extraction through the broker, the honest DWG and
# non-source refusals, sequential revisions, calibration-scale fallback, and
# the audit trail. The DXF pins mirror the harness case dxf-takeoff-room;
# the sheet pins mirror sheet-vector-plan (the same fixture, page 1).

# AC-VT-01: register the committed DXF fixture as a drawing artifact (r1).
upload "/api/projects/$PID/artifacts" "$FIXTURES/takeoff-room.dxf" drawing "takeoff-room.dxf"
VT_DXF_STATUS="$STATUS"
VT_DXF_BODY="$BODY"
VT_DXF_ID=$(j "$VT_DXF_BODY" '.data.artifact.id // empty')
if [[ "$VT_DXF_STATUS" == "201" && -n "$VT_DXF_ID" ]]; then
  ok "AC-VT-01: DXF fixture registered as a drawing artifact (201, r1)"
else
  bad "AC-VT-01: DXF fixture registered" "status=$VT_DXF_STATUS body=${VT_DXF_BODY:0:200}" "201|id"
fi

# AC-VT-02: vector takeoff of the DXF — per-layer extraction with the
# harness-pinned numbers, persisted as a draft analysis artifact derived_from r1.
http POST "/api/projects/$PID/artifacts/$VT_DXF_ID/vector-takeoff" -H 'Content-Type: application/json' --data-binary '{}'
VT_RUN_STATUS="$STATUS"
VT_RUN_BODY="$BODY"
VT_KIND=$(j "$VT_RUN_BODY" '.data.takeoff.kind')
VT_REV=$(j "$VT_RUN_BODY" '.data.takeoff.revisionNumber')
VT_LAYERS=$(j "$VT_RUN_BODY" '.data.takeoff.layerCount')
VT_ENTITIES=$(j "$VT_RUN_BODY" '.data.takeoff.entityCount')
VT_WALLS_LEN=$(j "$VT_RUN_BODY" '.data.takeoff.document.result.layers[] | select(.name == "WALLS") | .totalLengthMm')
VT_ENGINE=$(j "$VT_RUN_BODY" '.data.takeoff.engineKey')
VT_FROM=$(j "$VT_RUN_BODY" '.data.takeoff.derivedFromRevisionId')
VT_DXF_REV=$(j "$VT_RUN_BODY" '.data.takeoff.sourceLatestRevisionId')
if [[ "$VT_RUN_STATUS" == "201" && "$VT_KIND" == "analysis" && "$VT_REV" == "1" && "$VT_LAYERS" == "3" && "$VT_ENTITIES" == "4" && "$VT_ENGINE" == "ezdxf" && "$VT_FROM" == "$VT_DXF_REV" ]] && python3 -c 'import sys; sys.exit(0 if abs(float(sys.argv[1]) - 14000.0) < 1e-6 else 1)' "$VT_WALLS_LEN" 2>/dev/null; then
  ok "AC-VT-02: DXF vector takeoff (201, analysis r1, 3 layers / 4 entities, WALLS 14000 mm exact, derived_from == source rev)"
else
  bad "AC-VT-02: DXF vector takeoff" "status=$VT_RUN_STATUS kind=$VT_KIND rev=$VT_REV layers=$VT_LAYERS entities=$VT_ENTITIES wallsLen=$VT_WALLS_LEN engine=$VT_ENGINE" "201|analysis|1|3|4|14000.0|ezdxf|fromRev==latest"
fi

# AC-VT-03: rerun appends a sequential revision to the SAME find-or-create artifact (r2).
http POST "/api/projects/$PID/artifacts/$VT_DXF_ID/vector-takeoff" -H 'Content-Type: application/json' --data-binary '{}'
VT_RERUN_REV=$(j "$BODY" '.data.takeoff.revisionNumber')
assert_eq "AC-VT-03: rerun appends a sequential revision (find-or-create, r2)" "2" "$VT_RERUN_REV"

# AC-VT-04: sheet takeoff with an EXPLICIT analytic scale — the harness-pinned
# page-1 counts and the bar's exact 10 m (the click-journey's 0.35% bias does
# not apply: vector reads the drawn operators).
http POST "/api/projects/$PID/artifacts/$SHEET_ID/vector-takeoff" -H 'Content-Type: application/json' --data-binary '{"pageNo":1,"scaleMmPerPt":35.27777777777778}'
VT_SHEET_STATUS="$STATUS"
VT_SHEET_BODY="$BODY"
VT_LINES=$(j "$VT_SHEET_BODY" '.data.takeoff.lineCount')
VT_RECTS=$(j "$VT_SHEET_BODY" '.data.takeoff.rectCount')
VT_TEXTS=$(j "$VT_SHEET_BODY" '.data.takeoff.textCount')
VT_SCALE=$(j "$VT_SHEET_BODY" '.data.takeoff.document.provenance.scaleMmPerPt')
VT_SCALE_SRC=$(j "$VT_SHEET_BODY" '.data.takeoff.document.provenance.scaleSource')
if [[ "$VT_SHEET_STATUS" == "201" && "$VT_LINES" == "5" && "$VT_RECTS" == "2" && "$VT_TEXTS" != "0" && "$VT_SCALE_SRC" == "explicit-parameter" ]] && python3 -c 'import sys; sys.exit(0 if abs(float(sys.argv[1]) - 35.27777777777778) < 1e-9 else 1)' "$VT_SCALE" 2>/dev/null; then
  ok "AC-VT-04: sheet vector takeoff with explicit scale (201, 5 lines / 2 rects / text layer, provenance explicit-parameter)"
else
  bad "AC-VT-04: sheet vector takeoff with explicit scale" "status=$VT_SHEET_STATUS lines=$VT_LINES rects=$VT_RECTS texts=$VT_TEXTS scale=$VT_SCALE src=$VT_SCALE_SRC" "201|5|2|>0|35.277777…|explicit-parameter"
fi

# AC-VT-05: sheet takeoff WITHOUT an explicit scale resolves the revision's
# saved calibration markup. Calibration markups are PER-REVISION by design
# (each revision is its own coordinate space), and the suite's AC-18
# calibration sits on the SVG r1 — so the PDF r2 gets its own 2-point scale
# bar calibration first (the analytic 1:100 value, the same bar geometry).
cat > "$WORK/vt-calib.json" <<EOF
{
  "revisionId": "$PDF_REV",
  "page": 1,
  "kind": "calibration",
  "points": [ { "x": 60, "y": 120 }, { "x": 343.4646, "y": 120 } ],
  "label": "scale bar 10 m (vector-lane calibration)",
  "value": 35.27777777777778,
  "unit": "mm/pt",
  "scale": "calibrated 2-pt, 10 m ↔ 283.46 pt — 35.28 mm/pt",
  "createdBy": "local-operator"
}
EOF
jpost "/api/projects/$PID/markups" "$WORK/vt-calib.json"
VT_CAL_PERSIST="$STATUS|$(j "$BODY" '.data.markup.kind // empty')"
if [[ "$VT_CAL_PERSIST" == "201|calibration" ]]; then
  ok "AC-VT-05a: PDF-revision calibration markup persisted (201, mm/pt, per-revision by design)"
else
  bad "AC-VT-05a: PDF-revision calibration persisted" "$VT_CAL_PERSIST" "201|calibration"
fi
http POST "/api/projects/$PID/artifacts/$SHEET_ID/vector-takeoff" -H 'Content-Type: application/json' --data-binary '{}'
VT_CAL_SRC=$(j "$BODY" '.data.takeoff.document.provenance.scaleSource')
VT_CAL_SCALE=$(j "$BODY" '.data.takeoff.document.provenance.scaleMmPerPt')
if [[ "$VT_CAL_SRC" == "calibration-markup" ]] && python3 -c 'import sys; sys.exit(0 if abs(float(sys.argv[1]) - 35.27777777777778) < 1e-9 else 1)' "$VT_CAL_SCALE" 2>/dev/null; then
  ok "AC-VT-05b: sheet takeoff without scale falls back to the saved calibration markup (scaleSource + the persisted value)"
else
  bad "AC-VT-05b: calibration fallback" "src=$VT_CAL_SRC scale=$VT_CAL_SCALE" "calibration-markup|35.277777…"
fi

# AC-VT-06: DWG is refused with the pinned converter guidance (no open
# CI-pinnable DWG path exists — the honest boundary, 16-R1).
printf 'dummy dwg bytes' > "$WORK/plot.dwg"
upload "/api/projects/$PID/artifacts" "$WORK/plot.dwg" drawing "plot.dwg"
VT_DWG_ID=$(j "$BODY" '.data.artifact.id // empty')
http POST "/api/projects/$PID/artifacts/$VT_DWG_ID/vector-takeoff" -H 'Content-Type: application/json' --data-binary '{}'
VT_DWG_STATUS="$STATUS"
VT_DWG_MSG=$(j "$BODY" '.error.message // empty')
if [[ "$VT_DWG_STATUS" == "422" && "$VT_DWG_MSG" == "DWG is not supported for vector takeoff — convert the drawing to DXF first (ODA File Converter, or LibreDWG's dwg2dxf; both are operator-installed external tools, the LibreOffice probe-path pattern) and register the converted file as a new revision" ]]; then
  ok "AC-VT-06: DWG refused with the pinned converter guidance (422 verbatim)"
else
  bad "AC-VT-06: DWG refused verbatim" "status=$VT_DWG_STATUS msg=$VT_DWG_MSG" "422|DWG is not supported…"
fi

# AC-VT-07: a non-PDF/non-DXF source (the STEP model) is refused verbatim.
http POST "/api/projects/$PID/artifacts/$BRACKET_SOLID_ID/vector-takeoff" -H 'Content-Type: application/json' --data-binary '{}'
VT_MODEL_MSG=$(j "$BODY" '.error.message // empty')
if [[ "$STATUS" == "422" && "$VT_MODEL_MSG" == *"requires a PDF sheet revision"* ]]; then
  ok "AC-VT-07: non-vector source refused (422, verbatim 'requires a PDF sheet revision')"
else
  bad "AC-VT-07: non-vector source refused" "status=$STATUS msg=$VT_MODEL_MSG" "422|requires a PDF sheet revision…"
fi

# AC-VT-08: exactly one takeoff.dxfDerived-style event per run is audited
# (≥1 each for sheet + drawing after this block), and unauthenticated access
# is refused by the wrapper gate (401 envelope).
http GET "/api/events?projectId=$PID&limit=300"
VT_EV_DXF=$(j "$BODY" '[.data.events[] | select(.action == "takeoff.dxfDerived")] | length')
VT_EV_SHEET=$(j "$BODY" '[.data.events[] | select(.action == "takeoff.vectorDerived")] | length')
STATUS=$(curl -sS -m 30 -o "$WORK/http.body" -w '%{http_code}' -X POST "$BASE/api/projects/$PID/artifacts/$VT_DXF_ID/vector-takeoff" -H 'Content-Type: application/json' --data-binary '{}') || STATUS="000"
VT_UNAUTH="$STATUS"
if python3 -c 'import sys; sys.exit(0 if int(sys.argv[1]) >= 2 and int(sys.argv[2]) >= 2 else 1)' "$VT_EV_DXF" "$VT_EV_SHEET" && [[ "$VT_UNAUTH" == "401" ]]; then
  ok "AC-VT-08: audit trail (takeoff.dxfDerived ≥ 2, takeoff.vectorDerived ≥ 2) + unauthenticated 401 envelope"
else
  bad "AC-VT-08: audit trail + unauth gate" "dxfEvents=$VT_EV_DXF sheetEvents=$VT_EV_SHEET unauth=$VT_UNAUTH" "≥2|≥2|401"
fi

# ===========================================================================
# AC-VT-09 (Slice 16-B): sheet-text OCR — region reads through the broker
# (tesseract), the Ø normalization with raw preserved, the text-hits markup
# accept lifecycle, and the honest refusal matrix.
# ===========================================================================
OCR_B64=$(base64 -w0 "$FIXTURES/ocr-callout.png")
cat > "$WORK/ocr.json" <<EOF
{ "imageBase64": "$OCR_B64" }
EOF
http POST "/api/projects/$PID/artifacts/$SHEET_ID/ocr" -H 'Content-Type: application/json' --data-binary @"$WORK/ocr.json"
OCR_RUN="$BODY"
OCR_OK=$(python3 -c 'import sys, json
r = json.loads(sys.argv[1])["data"]
words = {w["text"]: w for w in r["words"]}
checks = [
    r["engineKey"] == "tesseract",
    len(r["words"]) == 8,
    "LOADING" in words and words["LOADING"]["conf"] >= 90,
    "2400" in words and words["2400"]["conf"] >= 90,
    "@400" in words,
    words["@400"]["normalized"]["normalized"] == "Ø400",
    words["@400"]["normalized"]["raw"] == "@400",
    words["@400"]["normalized"]["rule"] == "diameter-glyph",
    "1200" in words and words["1200"]["conf"] >= 90,
    all(isinstance(w["box"]["width"], int) and w["box"]["width"] > 0 for w in r["words"]),
]
sys.exit(0 if all(checks) else 1)' "$OCR_RUN" && echo ok || echo bad)
assert_eq "AC-VT-09a: OCR region read on the sheet revision: 200, tesseract envelope, 8 words, @400→Ø400 with raw preserved" \
  "200|ok|$SHEET_ID" \
  "$STATUS|$OCR_OK|$(j "$OCR_RUN" '.data.sourceArtifactId')"

SVG_REV_LATEST=$(j "$OCR_RUN" '.data.sourceRevisionId')
assert_eq "AC-VT-09b: the read pins the revision it ran against (sourceRevisionId = the sheet's latest)" \
  "set" "$( [[ -n "$SVG_REV_LATEST" && "$SVG_REV_LATEST" != "null" ]] && echo set || echo missing)"

http POST "/api/projects/$PID/artifacts/$(j "$VT_DXF_BODY" '.data.artifact.id')/ocr" -H 'Content-Type: application/json' --data-binary @"$WORK/ocr.json"
DXF_NAME=$(j "$VT_DXF_BODY" '.data.artifact.name')
assert_eq "AC-VT-09c: non-PDF artifact refused (422, the takeoff_sheet signal — verbatim)" \
  "422|takeoff_sheet requires a PDF sheet revision — \"$DXF_NAME\" carries no PDF signal (.pdf name or application/pdf MIME)" \
  "$STATUS|$(j "$BODY" '.error.message')"

http POST "/api/projects/$PID/artifacts/$SHEET_ID/ocr" -H 'Content-Type: application/json' --data-binary '{}'
assert_eq "AC-VT-09d: missing imageBase64 refused (422 verbatim)" \
  "422|sheet_ocr requires parameters.imageBase64 (the base64 PNG of the picked region, rendered by Sheet Measure)" \
  "$STATUS|$(j "$BODY" '.error.message')"

echo '{ "imageBase64": "aGVsbG8gd29ybGQ=" }' > "$WORK/ocr-notpng.json"
http POST "/api/projects/$PID/artifacts/$SHEET_ID/ocr" -H 'Content-Type: application/json' --data-binary @"$WORK/ocr-notpng.json"
assert_eq "AC-VT-09e: base64 that is not a PNG refused (422 verbatim)" \
  "422|sheet_ocr parameters.imageBase64 does not decode to a PNG (magic bytes missing) — Sheet Measure renders PNG regions" \
  "$STATUS|$(j "$BODY" '.error.message')"

# The accept lifecycle: transcript → kind "text-hits" markup with the payload.
OCR_WORDS_JSON=$(python3 -c 'import sys, json
r = json.loads(sys.argv[1])["data"]
print(json.dumps([{"text": w["text"], "conf": w["conf"], "normalized": w.get("normalized")} for w in r["words"]]))' "$OCR_RUN")
OCR_BOXES_JSON=$(python3 -c 'import sys, json
r = json.loads(sys.argv[1])["data"]
# word raster boxes → synthetic PDF-pt boxes (the e2e pins the CONTRACT, not
# geometry: tl/br pairs per word, in image order — the browser journey covers
# the real mapping)
pts = []
for i in range(len(r["words"])):
    pts.append({"x": float(i), "y": 700.0})
    pts.append({"x": float(i) + 10.0, "y": 680.0})
print(json.dumps(pts))' "$OCR_RUN")
cat > "$WORK/ocr-accept.json" <<EOF
{
  "revisionId": "$SVG_REV_LATEST",
  "page": 1,
  "kind": "text-hits",
  "points": $OCR_BOXES_JSON,
  "label": "e2e OCR transcript",
  "value": 8,
  "unit": "each",
  "payload": {
    "words": $(python3 -c 'import sys, json
words = json.loads(sys.argv[1])
print(json.dumps([{"text": w["text"], "conf": w["conf"], "boxIndex": i, **({"normalized": w["normalized"]} if w["normalized"] else {})} for i, w in enumerate(words)]))' "$OCR_WORDS_JSON"),
    "engine": "tesseract",
    "engineVersion": "5.5.0",
    "adapterScript": "sheet_ocr.ts",
    "adapterHash": "0000000000000000000000000000000000000000000000000000000000000000"
  },
  "createdBy": "e2e-operator"
}
EOF
http POST "/api/projects/$PID/markups" -H 'Content-Type: application/json' --data-binary @"$WORK/ocr-accept.json"
OCR_MKP_ID=$(j "$BODY" '.data.markup.id')
assert_eq "AC-VT-09f: transcript accepted — kind text-hits, 201, 16 points (8 word boxes), payload stored" \
  "201|text-hits|8|16|each|tesseract" \
  "$STATUS|$(j "$BODY" '.data.markup.kind')|$(j "$BODY" '.data.markup.value')|$(j "$BODY" '.data.markup.points | length')|$(j "$BODY" '.data.markup.unit')|$(j "$BODY" '.data.markup.payload.engine')"

http GET "/api/projects/$PID/markups?revisionId=$SVG_REV_LATEST"
assert_eq "AC-VT-09g: GET back — the transcript round-trips with the Ø row + raw preserved" \
  "$OCR_MKP_ID|@400|Ø400|diameter-glyph" \
  "$(j "$BODY" '[.data.markups[] | select(.id == "'"$OCR_MKP_ID"'")][0].id')|$(j "$BODY" '[.data.markups[] | select(.id == "'"$OCR_MKP_ID"'")][0].payload.words[4].text')|$(j "$BODY" '[.data.markups[] | select(.id == "'"$OCR_MKP_ID"'")][0].payload.words[4].normalized.normalized')|$(j "$BODY" '[.data.markups[] | select(.id == "'"$OCR_MKP_ID"'")][0].payload.words[4].normalized.rule')"

echo '{ "revisionId": "'"$SVG_REV_LATEST"'", "page": 1, "kind": "text-hits", "points": [{"x":1,"y":1},{"x":2,"y":2}], "value": 2, "unit": "each", "payload": { "words": [{"text":"x","conf":99,"boxIndex":5}], "engine":"tesseract","engineVersion":"5.5.0","adapterScript":"sheet_ocr.ts","adapterHash":"0000000000000000000000000000000000000000000000000000000000000000" }, "createdBy": "e2e-operator" }' > "$WORK/ocr-badbox.json"
http POST "/api/projects/$PID/markups" -H 'Content-Type: application/json' --data-binary @"$WORK/ocr-badbox.json"
assert_eq "AC-VT-09h: a transcript word pointing outside the markup's boxes refused (422 — transcript/geometry can never disagree)" \
  "422|payload.words[].boxIndex: 5 is outside the markup's 1 word boxes — the transcript and the geometry disagree" \
  "$STATUS|$(j "$BODY" '.error.message')"

echo '{ "revisionId": "'"$SVG_REV_LATEST"'", "page": 1, "kind": "text-hits", "points": [{"x":1,"y":1},{"x":2,"y":2}], "value": 7, "unit": "each", "createdBy": "e2e-operator" }' > "$WORK/ocr-badcount.json"
http POST "/api/projects/$PID/markups" -H 'Content-Type: application/json' --data-binary @"$WORK/ocr-badcount.json"
assert_eq "AC-VT-09i: value ≠ word-box count refused (422, the strict consistency rule)" \
  "422|invalid SheetMarkup: a text-hits markup's value must equal its hit-box count (1), got 7" \
  "$STATUS|$(j "$BODY" '.error.message')"

http GET "/api/events?projectId=$PID&limit=200"
OCR_EV=$(j "$BODY" '[.data.events[] | select(.action == "markup.created") | (.detail | fromjson | .kind == "text-hits")] | map(select(. == true)) | length')
assert_eq "AC-VT-09j: the accept is audited (markup.created with kind text-hits in detail)" \
  "1" "$OCR_EV"

STATUS=$(curl -sS -m 30 -o "$WORK/http.body" -w '%{http_code}' -X POST "$BASE/api/projects/$PID/artifacts/$SHEET_ID/ocr" -H 'Content-Type: application/json' --data-binary @"$WORK/ocr.json") || STATUS="000"
assert_eq "AC-VT-09k: unauthenticated OCR read refused (401 envelope)" "401" "$STATUS"

# ===========================================================================
# 4x. Slice 27 — the rotated-page correctness lane (AC-RW-01…06, limitation
# #17 CLOSED): the /Rotate 90 fixture page 4 (page-2-isomorphic socket
# geometry behind a rotated page dictionary, tests/fixtures/build-sheet-pdf.ts)
# through the REAL vector-takeoff broker. Server pins: rotation never moves
# counts or areas; pdfplumber reports the DISPLAYED page (842×1191); the
# pdfminer CTM pins the rotated anchors — probed through the real adapter
# 2026-10-29, the same view pdf.js paints. The storage pin: a rotated page's
# UI picks live in UNROTATED page space (the Slice-8 frozen Pt contract) —
# the page-4 symbol-hits markup round-trips the SAME pt pairs a fixed Sheet
# Measure now stores when the eye boxes that socket on the rotated page. The
# browser half of the closure is the unit battery's empirically probed table
# (src/core/page-rotation.test.ts vs pdfjs-dist@4.10.38's own viewport) +
# the TL journey — the HTTP API cannot click.
# ===========================================================================

# AC-RW-01: page 4 takeoff — 201, pageCount 4, SAME counts as page 2's
# geometry (13 rects / 4 lines — rotation never moves a count).
http POST "/api/projects/$PID/artifacts/$SHEET_ID/vector-takeoff" -H 'Content-Type: application/json' --data-binary '{"pageNo":4,"scaleMmPerPt":35.27777777777778}'
RW4_BODY="$BODY"
RW4_STATUS="$STATUS"
RW4_PAGECOUNT=$(j "$RW4_BODY" '.data.takeoff.document.result.pageCount')
RW4_RECTS=$(j "$RW4_BODY" '.data.takeoff.rectCount')
RW4_LINES=$(j "$RW4_BODY" '.data.takeoff.lineCount')
RW4_AREA=$(j "$RW4_BODY" '.data.takeoff.document.result.entities.rects.totalAreaMm2')
assert_eq "AC-RW-01: /Rotate 90 page 4 vector takeoff (201, pageCount 4, 13 rects / 4 lines — the SAME geometry as page 2)" \
  "201|4|13|4" "$RW4_STATUS|$RW4_PAGECOUNT|$RW4_RECTS|$RW4_LINES"

# AC-RW-02: pdfplumber reports the DISPLAYED page for /Rotate 90 — 842 × 1191
# (the unrotated 1191 × 842 turned upright; the adapter echoes page.width/height).
assert_eq "AC-RW-02: the adapter's page echo is the DISPLAYED size (842 × 1191 — rotation applied, pdfplumber semantics)" \
  "842|1191" "$(j "$RW4_BODY" '.data.takeoff.document.result.page.widthPt')|$(j "$RW4_BODY" '.data.takeoff.document.result.page.heightPt')"

# AC-RW-03: the pdfminer CTM pins the rotated border — the border rect's
# four corners in the (y, W−x) rotated view (probed; == the view pdf.js paints).
assert_eq "AC-RW-03: the rotated border's four corners pinned (24,24)(818,24)(818,1167)(24,1167) — the pdfminer-CTM view" \
  "24,24,818,24,818,1167,24,1167" \
  "$(j "$RW4_BODY" '[.data.takeoff.document.result.items[] | select(.type == "rect" and .pts[0][0] == 24 and .pts[0][1] == 24) | .pts | flatten | @csv] | join("")')"

# AC-RW-04: the rotated socket anchors — one outer at unrotated (440..450,
# 350..360) → (350, 741); one outer at unrotated (200..210, 500..510) →
# (500, 981); the concentric inner at (443..447, 503..507) → (503, 744).
assert_eq "AC-RW-04: three rotated socket anchors pinned in the CTM view ((350,741) outer + (500,981) outer + (503,744) inner)" \
  "3" "$(j "$RW4_BODY" '[.data.takeoff.document.result.items[] | select(.type == "rect" and ((.pts[0][0] == 350 and .pts[0][1] == 741) or (.pts[0][0] == 500 and .pts[0][1] == 981) or (.pts[0][0] == 503 and .pts[0][1] == 744)))] | length')"

# AC-RW-05: rotation never moves an area — page 2's total rect area equals
# page 4's to the printed digit (the geometry is isomorphic by construction).
http POST "/api/projects/$PID/artifacts/$SHEET_ID/vector-takeoff" -H 'Content-Type: application/json' --data-binary '{"pageNo":2,"scaleMmPerPt":35.27777777777778}'
RW2_AREA=$(j "$BODY" '.data.takeoff.document.result.entities.rects.totalAreaMm2')
RW_AREA_EQ=$(python3 -c 'import sys
a, b = float(sys.argv[1]), float(sys.argv[2])
sys.exit(0 if abs(a - b) <= 1e-6 * max(abs(a), 1.0) else 1)' "$RW4_AREA" "$RW2_AREA" && echo same || echo differ)
assert_eq "AC-RW-05: page 4's total rect area == page 2's (rotation-invariant, the isomorphic fixture's proof)" \
  "same" "$RW_AREA_EQ"

# AC-RW-06: the rotated-page STORAGE pin — a page-4 symbol-hits markup in
# UNROTATED page space (what a fixed Sheet Measure saves when the eye boxes
# the (200..210, 350..360) socket on the rotated page) round-trips exactly.
cat > "$WORK/rw-hits.json" <<EOF
{
  "revisionId": "$PDF_REV",
  "page": 4,
  "kind": "symbol-hits",
  "points": [
    { "x": 200, "y": 360 }, { "x": 210, "y": 350 }
  ],
  "label": "rotated-page pick — limitation #17 closed: the eye and the ledger agree",
  "value": 1,
  "unit": "each",
  "createdBy": "local-operator"
}
EOF
jpost "/api/projects/$PID/markups" "$WORK/rw-hits.json"
RW_HIT_STATUS="$STATUS"
RW_HIT_ID=$(j "$BODY" '.data.markup.id')
http GET "/api/projects/$PID/markups?revisionId=$PDF_REV"
RW_HIT_PTS=$(j "$BODY" '[.data.markups[] | select(.id == "'"$RW_HIT_ID"'")][0].points | map([.x, .y]) | flatten | @csv')
assert_eq "AC-RW-06: the rotated page's pick round-trips in unrotated page space (201 → GET byte-equal pt pairs)" \
  "201|200,360,210,350" "$RW_HIT_STATUS|$RW_HIT_PTS"

# The e2e transcript markup is cleaned with the rest of the probe dataset at
# the suite end (dev-db-cleanup); the LEDGER rows are untouched by it (a
# text-hits markup writes NO ledger row — text is evidence, not a quantity).

# ===========================================================================
# AC-FR-01 (Slice 16-D, known-limitation #9 e2e pin): future-dated rates are
# honest evidence — a line priced by a future-dated rate carries the additive
# futureDatedRate: true marker (the UI's amber-chip source), and an
# already-effective rate added later WINS the deterministic preference order.
# Uses its own probe assembly + probe estimate (the demo estimate's pinned
# math is untouched); the probe estimate stays draft (approved-selection
# regression markers elsewhere only ever select approved estimates).
# ===========================================================================
cat > "$WORK/fr-assembly.json" <<'EOF'
{
  "name": "Future-rate probe",
  "trade": "Probes",
  "components": [
    { "id": "frp-material", "kind": "material", "name": "Probe material", "quantityPerUnit": 1, "unit": "m²" }
  ]
}
EOF
jpost "/api/projects/$PID/assemblies" "$WORK/fr-assembly.json"
FR_ASM_ID=$(j "$BODY" '.data.assembly.id')
assert_eq "AC-FR-01a: probe assembly created (1 component, no waste/productivity factors)" \
  "201|Future-rate probe|1" "$STATUS|$(j "$BODY" '.data.assembly.name')|$(j "$BODY" '.data.assembly.components | length')"

cat > "$WORK/fr-rate-future.json" <<'EOF'
{ "componentId": "frp-material", "currency": "GHS", "unitPrice": 100.0, "source": "price-book", "effectiveFrom": "2099-01-01T00:00:00.000Z" }
EOF
jpost "/api/projects/$PID/rates" "$WORK/fr-rate-future.json"
FR_RATE_FUTURE=$(j "$BODY" '.data.rate.id')
assert_eq "AC-FR-01b: engineer records a FUTURE-dated rate (effectiveFrom 2099, the only candidate for its component)" \
  "201|2099" "$STATUS|$(j "$BODY" '.data.rate.effectiveFrom' | cut -c1-4)"

cat > "$WORK/fr-estimate.json" <<'EOF'
{ "name": "Future-dated rate probe", "currency": "GHS", "overheadPct": 0, "profitPct": 0, "taxPct": 0 }
EOF
jpost "/api/projects/$PID/estimates" "$WORK/fr-estimate.json"
FR_EST_ID=$(j "$BODY" '.data.estimate.id')
assert_eq "AC-FR-01c: probe estimate created (draft, GHS, zero overhead/profit/tax so line math is bare)" \
  "201|draft" "$STATUS|$(j "$BODY" '.data.estimate.status')"

cat > "$WORK/fr-line1.json" <<EOF
{ "quantityId": "$Q1", "assemblyId": "$FR_ASM_ID" }
EOF
jpost "/api/estimates/$FR_EST_ID/lines" "$WORK/fr-line1.json"
assert_eq "AC-FR-01d: line priced by the FUTURE-only rate: breakdown carries futureDatedRate true (additive evidence, price still computed — 46.2 m² × GHS 100 = 4620) and rateIds pins the exact rate used" \
  "201|true|100|4620" \
  "$STATUS|$(j "$BODY" '.data.estimate.lines[0].breakdown[0].futureDatedRate')|$(j "$BODY" '.data.estimate.lines[0].breakdown[0].unitPrice')|$(j "$BODY" '.data.estimate.lines[0].breakdown[0].cost')"
assert_eq "AC-FR-01e: the line's rateIds is the future rate (an engineer can always see WHICH rate id priced it — never silent)" \
  "$FR_RATE_FUTURE" "$(j "$BODY" '.data.estimate.lines[0].rateIds[0]')"

http GET "/api/projects/$PID/estimates"
FR_ROUND=$(j "$BODY" "[.data.estimates[] | select(.id == \"$FR_EST_ID\")][0].id")
FR_FLAGGED=$(j "$BODY" "[.data.estimates[] | select(.id == \"$FR_EST_ID\")][0].lines | map(select(.breakdown | map(.futureDatedRate == true) | any)) | length")
assert_eq "AC-FR-01f: GET round-trip — the amber-chip data source persists (the flagged line reads back flagged)" \
  "$FR_EST_ID|1" "$FR_ROUND|$FR_FLAGGED"

cat > "$WORK/fr-rate-effective.json" <<'EOF'
{ "componentId": "frp-material", "currency": "GHS", "unitPrice": 120.0, "source": "contract" }
EOF
jpost "/api/projects/$PID/rates" "$WORK/fr-rate-effective.json"
FR_RATE_NOW=$(j "$BODY" '.data.rate.id')
assert_eq "AC-FR-01g: an ALREADY-EFFECTIVE rate recorded afterwards (no effectiveFrom — effective now, newest createdAt)" \
  "201|null" "$STATUS|$(j "$BODY" '.data.rate.effectiveFrom')"

cat > "$WORK/fr-line2.json" <<EOF
{ "quantityId": "$Q1", "assemblyId": "$FR_ASM_ID" }
EOF
jpost "/api/estimates/$FR_EST_ID/lines" "$WORK/fr-line2.json"
assert_eq "AC-FR-01h: deterministic preference order pinned: already-effective beats future-dated even when the future rate is older — line 2 prices at GHS 120 (46.2 × 120 = 5544), NO futureDatedRate marker, rateIds = the effective rate" \
  "null|120|5544" \
  "$(j "$BODY" '.data.estimate.lines[1].breakdown[0].futureDatedRate')|$(j "$BODY" '.data.estimate.lines[1].breakdown[0].unitPrice')|$(j "$BODY" '.data.estimate.lines[1].breakdown[0].cost')"
assert_eq "AC-FR-01i: line 2's rateIds is the effective rate (the preference is visible, not implied)" \
  "$FR_RATE_NOW" "$(j "$BODY" '.data.estimate.lines[1].rateIds[0]')"

# ===========================================================================
# AC-VT-10 (Slice 18, limitation #5's remainder; v2 evolution in Slice 19):
# region cutouts — an area markup with cutout rings. The SERVER re-derives
# gross/cutout/net from the geometry (src/core/measure.ts §2.2–§2.4 through
# src/core/markup.ts) and refuses any disagreement, so the pinned numbers
# are analytic ground truths on integer coordinates: region 100×50 pt @
# 20 mm/pt = 2.000 m² gross; two 10×5 pt cutouts = 0.020 m² each; net
# 1.960 m² (the ledger value). Slice 19: 10d flips to ACCEPTANCE — a vertex
# ON the boundary of this CONVEX region subtracts the full ring (2 −
# 0.04 = 1.96) — and the AC-VT-11 block below pins the crossing matrix.
# ===========================================================================
cat > "$WORK/vt10-qty.json" <<EOF
{
  "sourceArtifactRevisionId": "$SVG_REV",
  "quantityType": "area",
  "value": 1.96,
  "unit": "m²",
  "method": "drawing-measured",
  "sheetRef": "Sheet-A101-GA-plan.svg — p1",
  "scale": "calibrated 2-pt, 20 mm/pt (fixture)",
  "quantityMethod": "eos-pdf-measure/2 (browser-calibrated, region cutouts)",
  "rulesetId": "drawing-takeoff",
  "rulesetVersion": "0.1",
  "elementRef": "slab S-1 with two openings",
  "createdBy": "local-operator"
}
EOF
jpost "/api/projects/$PID/quantities" "$WORK/vt10-qty.json"
VT10_QTY=$(j "$BODY" '.data.quantity.id')
assert_eq "AC-VT-10a: the NET area lands in the ledger as a drawing-measured row with the cutouts-aware quantityMethod (draft, 1.96 m²)" \
  "201|draft|1.96|area|eos-pdf-measure/2 (browser-calibrated, region cutouts)" \
  "$STATUS|$(j "$BODY" '.data.quantity.status')|$(j "$BODY" '.data.quantity.value')|$(j "$BODY" '.data.quantity.quantityType')|$(j "$BODY" '.data.quantity.quantityMethod')"

cat > "$WORK/vt10-markup.json" <<EOF
{
  "revisionId": "$SVG_REV",
  "page": 1,
  "kind": "area",
  "points": [ { "x": 0, "y": 0 }, { "x": 100, "y": 0 }, { "x": 100, "y": 50 }, { "x": 0, "y": 50 } ],
  "label": "slab S-1 net of openings",
  "value": 1.96,
  "unit": "m²",
  "scale": "calibrated 2-pt, 20 mm/pt (fixture)",
  "quantityId": "$VT10_QTY",
  "cutouts": {
    "rings": [
      [ { "x": 10, "y": 10 }, { "x": 20, "y": 10 }, { "x": 20, "y": 15 }, { "x": 10, "y": 15 } ],
      [ { "x": 30, "y": 10 }, { "x": 40, "y": 10 }, { "x": 40, "y": 15 }, { "x": 30, "y": 15 } ]
    ],
    "mmPerPt": 20,
    "grossValue": 2,
    "cutoutValue": 0.04,
    "netValue": 1.96
  },
  "createdBy": "local-operator"
}
EOF
jpost "/api/projects/$PID/markups" "$WORK/vt10-markup.json"
VT10_MKP=$(j "$BODY" '.data.markup.id')
assert_eq "AC-VT-10b: area-with-cutouts markup created — value is the NET (1.96 m²), the payload echoes the two rings + the re-derived breakdown" \
  "201|area|1.96|m²|2|2|0.04|1.96" \
  "$STATUS|$(j "$BODY" '.data.markup.kind')|$(j "$BODY" '.data.markup.value')|$(j "$BODY" '.data.markup.unit')|$(j "$BODY" '.data.markup.payload.rings | length')|$(j "$BODY" '.data.markup.payload.grossValue')|$(j "$BODY" '.data.markup.payload.cutoutValue')|$(j "$BODY" '.data.markup.payload.netValue')"

http GET "/api/projects/$PID/markups?revisionId=$SVG_REV"
assert_eq "AC-VT-10c: GET round-trip — the cutouts payload persists (rings + breakdown) with the ledger link intact" \
  "200|$VT10_MKP|2|1.96|$VT10_QTY" \
  "$STATUS|$(j "$BODY" "[.data.markups[] | select(.id == \"$VT10_MKP\")][0].id")|$(j "$BODY" "[.data.markups[] | select(.id == \"$VT10_MKP\")][0].payload.rings | length")|$(j "$BODY" "[.data.markups[] | select(.id == \"$VT10_MKP\")][0].value")|$(j "$BODY" "[.data.markups[] | select(.id == \"$VT10_MKP\")][0].quantityId")"

cat > "$WORK/vt10-onedge.json" <<EOF
{
  "revisionId": "$SVG_REV",
  "page": 1,
  "kind": "area",
  "points": [ { "x": 0, "y": 0 }, { "x": 100, "y": 0 }, { "x": 100, "y": 50 }, { "x": 0, "y": 50 } ],
  "value": 1.96,
  "unit": "m²",
  "label": "slab S-1 opening on the edge",
  "cutouts": {
    "rings": [ [ { "x": 0, "y": 10 }, { "x": 20, "y": 10 }, { "x": 20, "y": 15 }, { "x": 0, "y": 15 } ] ],
    "mmPerPt": 20,
    "grossValue": 2,
    "cutoutValue": 0.04,
    "netValue": 1.96
  },
  "createdBy": "local-operator"
}
EOF
jpost "/api/projects/$PID/markups" "$WORK/vt10-onedge.json"
# Slice 19 (§2.4): the former v1 refusal — a cutout vertex ON the boundary of
# a CONVEX region is now ACCEPTED (the v2 clip lane); the numbers the body
# claims are the honest re-derived ones (the 20×5 pt ring clipped by the wall
# subtracts its FULL 0.04 m² — it lies inside-or-on the closed region).
assert_eq "AC-VT-10d: a cutout vertex ON the boundary of a CONVEX region is accepted (v2) — the payload echoes the ring + the re-derived breakdown (2 − 0.04 = 1.96)" \
  "201|area|1.96|2|0.04|1.96" \
  "$STATUS|$(j "$BODY" '.data.markup.kind')|$(j "$BODY" '.data.markup.value')|$(j "$BODY" '.data.markup.payload.grossValue')|$(j "$BODY" '.data.markup.payload.cutoutValue')|$(j "$BODY" '.data.markup.payload.netValue')"

cat > "$WORK/vt10-overlap.json" <<EOF
{
  "revisionId": "$SVG_REV",
  "page": 1,
  "kind": "area",
  "points": [ { "x": 0, "y": 0 }, { "x": 100, "y": 0 }, { "x": 100, "y": 50 }, { "x": 0, "y": 50 } ],
  "value": 1.9,
  "unit": "m²",
  "cutouts": {
    "rings": [
      [ { "x": 10, "y": 10 }, { "x": 20, "y": 10 }, { "x": 20, "y": 20 }, { "x": 10, "y": 20 } ],
      [ { "x": 15, "y": 15 }, { "x": 25, "y": 15 }, { "x": 25, "y": 25 }, { "x": 15, "y": 25 } ]
    ],
    "mmPerPt": 20,
    "grossValue": 2,
    "cutoutValue": 0.1,
    "netValue": 1.9
  },
  "createdBy": "local-operator"
}
EOF
jpost "/api/projects/$PID/markups" "$WORK/vt10-overlap.json"
assert_eq "AC-VT-10e: overlapping cutouts are refused 422 verbatim (double-subtract guard)" \
  'invalid SheetMarkup: areaWithCutouts: cutouts[0] and cutouts[1] overlap (their boundaries touch or cross) — overlapping cutouts would double-subtract the same area' \
  "$(j "$BODY" '.error.message')"

cat > "$WORK/vt10-lied.json" <<EOF
{
  "revisionId": "$SVG_REV",
  "page": 1,
  "kind": "area",
  "points": [ { "x": 0, "y": 0 }, { "x": 100, "y": 0 }, { "x": 100, "y": 50 }, { "x": 0, "y": 50 } ],
  "value": 1.5,
  "unit": "m²",
  "cutouts": {
    "rings": [ [ { "x": 10, "y": 10 }, { "x": 20, "y": 10 }, { "x": 20, "y": 15 }, { "x": 10, "y": 15 } ] ],
    "mmPerPt": 20,
    "grossValue": 2,
    "cutoutValue": 0.02,
    "netValue": 1.98
  },
  "createdBy": "local-operator"
}
EOF
jpost "/api/projects/$PID/markups" "$WORK/vt10-lied.json"
assert_eq "AC-VT-10f: a value that disagrees with the recomputed NET is refused 422 verbatim with BOTH numbers pinned" \
  'invalid SheetMarkup: value (1.5) disagrees with the recomputed NET area (1.98) — the geometry and the number must agree' \
  "$(j "$BODY" '.error.message')"

cat > "$WORK/vt10-wrongkind.json" <<EOF
{
  "revisionId": "$SVG_REV",
  "page": 1,
  "kind": "length",
  "points": [ { "x": 0, "y": 0 }, { "x": 100, "y": 0 } ],
  "value": 2,
  "unit": "m",
  "cutouts": {
    "rings": [ [ { "x": 10, "y": 10 }, { "x": 20, "y": 10 }, { "x": 20, "y": 15 }, { "x": 10, "y": 15 } ] ],
    "mmPerPt": 20,
    "grossValue": 2,
    "cutoutValue": 0.02,
    "netValue": 1.98
  },
  "createdBy": "local-operator"
}
EOF
jpost "/api/projects/$PID/markups" "$WORK/vt10-wrongkind.json"
assert_eq "AC-VT-10g: cutouts on a non-area kind are refused 422 verbatim (the structure is area-only)" \
  'invalid SheetMarkup: cutouts are only accepted for kind "area" markups (kind length carries none)' \
  "$(j "$BODY" '.error.message')"

cat > "$WORK/vt10-bothpayloads.json" <<EOF
{
  "revisionId": "$SVG_REV",
  "page": 1,
  "kind": "area",
  "points": [ { "x": 0, "y": 0 }, { "x": 100, "y": 0 }, { "x": 100, "y": 50 }, { "x": 0, "y": 50 } ],
  "value": 1.98,
  "unit": "m²",
  "payload": { "words": [ { "text": "x", "conf": 90, "boxIndex": 0 } ], "engine": "t", "engineVersion": "1", "adapterScript": "s", "adapterHash": "h" },
  "cutouts": {
    "rings": [ [ { "x": 10, "y": 10 }, { "x": 20, "y": 10 }, { "x": 20, "y": 15 }, { "x": 10, "y": 15 } ] ],
    "mmPerPt": 20,
    "grossValue": 2,
    "cutoutValue": 0.02,
    "netValue": 1.98
  },
  "createdBy": "local-operator"
}
EOF
jpost "/api/projects/$PID/markups" "$WORK/vt10-bothpayloads.json"
assert_eq "AC-VT-10h: a body carrying BOTH payload and cutouts is refused 422 verbatim (ambiguous provenance)" \
  'payload: is only accepted for kind "text-hits" markups — an area-with-cutouts markup carries its rings in the cutouts field, not a payload' \
  "$(j "$BODY" '.error.message')"

STATUS=$(curl -sS -m 30 -o "$WORK/http.body" -w '%{http_code}' -X POST "$BASE/api/projects/$PID/markups" -H 'Content-Type: application/json' --data-binary @"$WORK/vt10-markup.json") || STATUS="000"
assert_eq "AC-VT-10i: unauthenticated markup create is 401 (the cutouts lane rides the same wrapper)" \
  "401" "$STATUS"

http GET "/api/events?projectId=$PID&limit=200"
assert_eq "AC-VT-10j: the markup.created audit event carries the cutouts detail (count + netValue, machine-checkable; detail is a stored JSON string — fromjson, contract §5 — pinned to the TWO-ring row; the Slice-19 10d acceptance adds a one-ring 1.96 row of its own)" \
  "1|2|1.96" \
  "$(j "$BODY" "[.data.events[] | select(.action == \"markup.created\") | .detail | fromjson | select(.kind == \"area\" and .cutouts != null and .value == 1.96 and .cutouts.count == 2)] | length")|$(j "$BODY" "[.data.events[] | select(.action == \"markup.created\") | .detail | fromjson | select(.kind == \"area\" and .cutouts != null and .value == 1.96 and .cutouts.count == 2)][0].cutouts.count")|$(j "$BODY" "[.data.events[] | select(.action == \"markup.created\") | .detail | fromjson | select(.kind == \"area\" and .cutouts != null and .value == 1.96 and .cutouts.count == 2)][0].cutouts.netValue")"

# AC-VT-11 (Slice 19, contract §2.4): boundary-crossing cutouts via polygon
# clipping — a cutout may cross the edge of a CONVEX region and subtracts
# only its CLIPPED intersection; the concave / disjoint / swallower cases
# carry their own honest verbatim refusals; the numbers are exact on the
# integer-crossing fixture (u = 0.5 at x=100).
cat > "$WORK/vt11-crossing.json" <<EOF
{
  "revisionId": "$SVG_REV",
  "page": 1,
  "kind": "area",
  "points": [ { "x": 0, "y": 0 }, { "x": 100, "y": 0 }, { "x": 100, "y": 50 }, { "x": 0, "y": 50 } ],
  "label": "slab S-2 opening crossing the edge",
  "value": 1.98,
  "unit": "m²",
  "scale": "calibrated 2-pt, 20 mm/pt (fixture)",
  "cutouts": {
    "rings": [ [ { "x": 90, "y": 10 }, { "x": 110, "y": 10 }, { "x": 110, "y": 15 }, { "x": 90, "y": 15 } ] ],
    "mmPerPt": 20,
    "grossValue": 2,
    "cutoutValue": 0.02,
    "netValue": 1.98
  },
  "createdBy": "local-operator"
}
EOF
jpost "/api/projects/$PID/markups" "$WORK/vt11-crossing.json"
VT11_MKP=$(j "$BODY" '.data.markup.id')
assert_eq "AC-VT-11a: a boundary-CROSSING cutout is accepted on a convex region — only the inside part subtracts (2 − 0.02 = 1.98, exact on the integer crossing)" \
  "201|area|1.98|1|2|0.02|1.98" \
  "$STATUS|$(j "$BODY" '.data.markup.kind')|$(j "$BODY" '.data.markup.value')|$(j "$BODY" '.data.markup.payload.rings | length')|$(j "$BODY" '.data.markup.payload.grossValue')|$(j "$BODY" '.data.markup.payload.cutoutValue')|$(j "$BODY" '.data.markup.payload.netValue')"

http GET "/api/projects/$PID/markups?revisionId=$SVG_REV"
assert_eq "AC-VT-11b: GET round-trip — the crossing rings + the clipped breakdown persist exactly" \
  "200|$VT11_MKP|4|1.98" \
  "$STATUS|$(j "$BODY" "[.data.markups[] | select(.id == \"$VT11_MKP\")][0].id")|$(j "$BODY" "[.data.markups[] | select(.id == \"$VT11_MKP\")][0].payload.rings[0] | length")|$(j "$BODY" "[.data.markups[] | select(.id == \"$VT11_MKP\")][0].value")"

cat > "$WORK/vt11-concave.json" <<EOF
{
  "revisionId": "$SVG_REV",
  "page": 1,
  "kind": "area",
  "points": [ { "x": 0, "y": 0 }, { "x": 100, "y": 0 }, { "x": 100, "y": 10 }, { "x": 10, "y": 10 }, { "x": 10, "y": 50 }, { "x": 0, "y": 50 } ],
  "value": 0.55,
  "unit": "m²",
  "cutouts": {
    "rings": [ [ { "x": 40, "y": 5 }, { "x": 60, "y": 5 }, { "x": 60, "y": 15 }, { "x": 40, "y": 15 } ] ],
    "mmPerPt": 20,
    "grossValue": 0.56,
    "cutoutValue": 0.02,
    "netValue": 0.54
  },
  "createdBy": "local-operator"
}
EOF
jpost "/api/projects/$PID/markups" "$WORK/vt11-concave.json"
assert_eq "AC-VT-11c: a crossing cutout on a CONCAVE region is refused 422 verbatim (the convex gate)" \
  'invalid SheetMarkup: areaWithCutouts: cutouts[0] touches or crosses the region boundary — v2 boundary-crossing cutouts need a CONVEX region; a concave region accepts only cutouts drawn fully inside' \
  "$(j "$BODY" '.error.message')"

cat > "$WORK/vt11-outside.json" <<EOF
{
  "revisionId": "$SVG_REV",
  "page": 1,
  "kind": "area",
  "points": [ { "x": 0, "y": 0 }, { "x": 100, "y": 0 }, { "x": 100, "y": 50 }, { "x": 0, "y": 50 } ],
  "value": 2,
  "unit": "m²",
  "cutouts": {
    "rings": [ [ { "x": 150, "y": 10 }, { "x": 160, "y": 10 }, { "x": 160, "y": 15 }, { "x": 150, "y": 15 } ] ],
    "mmPerPt": 20,
    "grossValue": 2,
    "cutoutValue": 0,
    "netValue": 2
  },
  "createdBy": "local-operator"
}
EOF
jpost "/api/projects/$PID/markups" "$WORK/vt11-outside.json"
assert_eq "AC-VT-11d: a cutout entirely outside the region is refused 422 verbatim (it would subtract nothing)" \
  'invalid SheetMarkup: areaWithCutouts: cutouts[0] lies entirely outside the region — it would subtract nothing; draw it inside the area or crossing its boundary' \
  "$(j "$BODY" '.error.message')"

cat > "$WORK/vt11-swallower.json" <<EOF
{
  "revisionId": "$SVG_REV",
  "page": 1,
  "kind": "area",
  "points": [ { "x": 0, "y": 0 }, { "x": 100, "y": 0 }, { "x": 100, "y": 50 }, { "x": 0, "y": 50 } ],
  "value": 0.001,
  "unit": "m²",
  "cutouts": {
    "rings": [ [ { "x": -10, "y": -10 }, { "x": 110, "y": -10 }, { "x": 110, "y": 60 }, { "x": -10, "y": 60 } ] ],
    "mmPerPt": 20,
    "grossValue": 2,
    "cutoutValue": 2,
    "netValue": 0
  },
  "createdBy": "local-operator"
}
EOF
jpost "/api/projects/$PID/markups" "$WORK/vt11-swallower.json"
assert_eq "AC-VT-11e: a cutout containing the whole region is refused 422 verbatim (net area 0 — the now-reachable backstop)" \
  'invalid SheetMarkup: areaWithCutouts: the cutouts cancel the region exactly (net area 0) — nothing measurable remains' \
  "$(j "$BODY" '.error.message')"

cat > "$WORK/vt11-lied.json" <<EOF
{
  "revisionId": "$SVG_REV",
  "page": 1,
  "kind": "area",
  "points": [ { "x": 0, "y": 0 }, { "x": 100, "y": 0 }, { "x": 100, "y": 50 }, { "x": 0, "y": 50 } ],
  "value": 1.5,
  "unit": "m²",
  "cutouts": {
    "rings": [ [ { "x": 90, "y": 10 }, { "x": 110, "y": 10 }, { "x": 110, "y": 15 }, { "x": 90, "y": 15 } ] ],
    "mmPerPt": 20,
    "grossValue": 2,
    "cutoutValue": 0.02,
    "netValue": 1.5
  },
  "createdBy": "local-operator"
}
EOF
jpost "/api/projects/$PID/markups" "$WORK/vt11-lied.json"
assert_eq "AC-VT-11f: a claimed net that disagrees with the CLIPPED re-derivation is refused 422 verbatim with BOTH numbers pinned" \
  'invalid SheetMarkup: value (1.5) disagrees with the recomputed NET area (1.98) — the geometry and the number must agree' \
  "$(j "$BODY" '.error.message')"

http GET "/api/events?projectId=$PID&limit=200"
assert_eq "AC-VT-11g: the markup.created audit event carries the CLIPPED net detail (1 crossing cutout, net 1.98)" \
  "1|1|1.98" \
  "$(j "$BODY" "[.data.events[] | select(.action == \"markup.created\") | .detail | fromjson | select(.kind == \"area\" and .cutouts != null and .value == 1.98)] | length")|$(j "$BODY" "[.data.events[] | select(.action == \"markup.created\") | .detail | fromjson | select(.kind == \"area\" and .cutouts != null and .value == 1.98)][0].cutouts.count")|$(j "$BODY" "[.data.events[] | select(.action == \"markup.created\") | .detail | fromjson | select(.kind == \"area\" and .cutouts != null and .value == 1.98)][0].cutouts.netValue")"

STATUS=$(curl -sS -m 30 -o "$WORK/http.body" -w '%{http_code}' -X POST "$BASE/api/projects/$PID/markups" -H 'Content-Type: application/json' --data-binary @"$WORK/vt11-crossing.json") || STATUS="000"
assert_eq "AC-VT-11h: unauthenticated crossing-cutout create is 401 (the v2 lane rides the same wrapper)" \
  "401" "$STATUS"

# ===========================================================================
# AC-AC-04 (Slice 20): scale-invariant auto-count — the two-size fixture
# page through the REAL pdfplumber lane, the mixed-size symbol-hits payload
# round-trip, the v2 quantityMethod provenance, and the unchanged
# count-consistency gate (mixed sizes never weaken it).
# ===========================================================================
http POST "/api/projects/$PID/artifacts/$SHEET_ID/vector-takeoff" -H 'Content-Type: application/json' --data-binary '{"pageNo":3,"scaleMmPerPt":35.27777777777778}'
VT_P3_STATUS="$STATUS"
VT_P3_BODY="$BODY"
VT_P3_RECTS=$(j "$VT_P3_BODY" '.data.takeoff.rectCount')
VT_P3_LINES=$(j "$VT_P3_BODY" '.data.takeoff.lineCount')
VT_P3_LARGE=$(j "$VT_P3_BODY" '[.data.takeoff.document.result.items[] | select(.type == "rect" and .pts[0][0] == 197.5 and .pts[0][1] == 352.5)] | length')
VT_P3_LARGE_AREA=$(j "$VT_P3_BODY" '[.data.takeoff.document.result.items[] | select(.type == "rect" and .pts[0][0] == 197.5 and .pts[0][1] == 352.5)][0].areaMm2')
if [[ "$VT_P3_STATUS" == "201" && "$VT_P3_RECTS" == "21" && "$VT_P3_LINES" == "4" && "$VT_P3_LARGE" == "1" ]] && python3 -c 'import sys; sys.exit(0 if abs(float(sys.argv[1]) - 225 * 35.27777777777778**2) / (225 * 35.27777777777778**2) <= 1e-9 else 1)' "$VT_P3_LARGE_AREA" 2>/dev/null; then
  ok "AC-AC-04a: page-3 two-size field through the REAL pdfplumber lane (201, 21 rects / 4 lines, the 15 pt outer square at (197.5,352.5) with its builder-truth area)"
else
  bad "AC-AC-04a: page-3 two-size vector read" "status=$VT_P3_STATUS rects=$VT_P3_RECTS lines=$VT_P3_LINES large=$VT_P3_LARGE area=$VT_P3_LARGE_AREA" "201|21|4|1|225·s²"
fi

# The v2-method ledger row: a count of TEN (six ×1.0 + four ×1.5 instances)
# with the multi-scale provenance string — the lane the UI saves when the
# "Match other sizes" toggle is on.
cat > "$WORK/ac04-qty.json" <<EOF
{
  "sourceArtifactRevisionId": "$PDF_REV",
  "sheetRef": "EOS DEMO SHEET A-102 P3 — p3",
  "quantityType": "count",
  "value": 10,
  "unit": "each",
  "method": "drawing-measured",
  "quantityMethod": "eos-symbol-template/2 (NCC ≥ 0.85 · scales 0.5–2)",
  "rulesetId": "drawing-takeoff",
  "rulesetVersion": "0.1",
  "createdBy": "local-operator"
}
EOF
jpost "/api/projects/$PID/quantities" "$WORK/ac04-qty.json"
AC04_QID=$(j "$BODY" '.data.quantity.id')
assert_eq "AC-AC-04b: the v2 quantityMethod provenance persists verbatim on the ledger row (count 10 = 6×1.0 + 4×1.5)" \
  "201|each|eos-symbol-template/2 (NCC ≥ 0.85 · scales 0.5–2)" \
  "$STATUS|$(j "$BODY" '.data.quantity.unit')|$(j "$BODY" '.data.quantity.quantityMethod')"

# The mixed-size symbol-hits markup: 10 pairs (20 points) — the six 10 pt
# boxes on the y=560 row + the four 15 pt boxes on the y=360 row, each pair
# [topLeft(higher y), bottomRight] in PDF-page space, linked to the v2 row.
cat > "$WORK/ac04-hits.json" <<EOF
{
  "revisionId": "$PDF_REV",
  "page": 3,
  "kind": "symbol-hits",
  "points": [
    { "x": 200, "y": 565 }, { "x": 210, "y": 555 },
    { "x": 320, "y": 565 }, { "x": 330, "y": 555 },
    { "x": 440, "y": 565 }, { "x": 450, "y": 555 },
    { "x": 560, "y": 565 }, { "x": 570, "y": 555 },
    { "x": 680, "y": 565 }, { "x": 690, "y": 555 },
    { "x": 800, "y": 565 }, { "x": 810, "y": 555 },
    { "x": 197.5, "y": 367.5 }, { "x": 212.5, "y": 352.5 },
    { "x": 317.5, "y": 367.5 }, { "x": 332.5, "y": 352.5 },
    { "x": 437.5, "y": 367.5 }, { "x": 452.5, "y": 352.5 },
    { "x": 557.5, "y": 367.5 }, { "x": 572.5, "y": 352.5 }
  ],
  "label": "panel schedule — two-size scan",
  "value": 10,
  "unit": "each",
  "quantityId": "$AC04_QID",
  "createdBy": "local-operator"
}
EOF
jpost "/api/projects/$PID/markups" "$WORK/ac04-hits.json"
assert_eq "AC-AC-04c: the MIXED-SIZE symbol-hits markup round-trips (201, 10 pairs, linked to the v2 ledger row)" \
  "201|symbol-hits|10|each|$AC04_QID|20" \
  "$STATUS|$(j "$BODY" '.data.markup.kind')|$(j "$BODY" '.data.markup.value')|$(j "$BODY" '.data.markup.unit')|$(j "$BODY" '.data.markup.quantityId')|$(j "$BODY" '.data.markup.points | length')"

http GET "/api/projects/$PID/markups?revisionId=$PDF_REV"
assert_eq "AC-AC-04d: GET round-trip — the mixed-size pairs persist exactly (both sizes' boxes listed under the revision)" \
  "1|20" \
  "$(j "$BODY" '[.data.markups[] | select(.kind == "symbol-hits" and .page == 3)] | length')|$(j "$BODY" '[.data.markups[] | select(.kind == "symbol-hits" and .page == 3)][0].points | length')"

# The count-consistency gate is size-blind by design: 10 pairs with a value
# of 9 is refused verbatim (a stored count can never disagree with its boxes).
cat > "$WORK/ac04-bad.json" <<EOF
{
  "revisionId": "$PDF_REV",
  "page": 3,
  "kind": "symbol-hits",
  "points": [
    { "x": 200, "y": 565 }, { "x": 210, "y": 555 },
    { "x": 320, "y": 565 }, { "x": 330, "y": 555 },
    { "x": 440, "y": 565 }, { "x": 450, "y": 555 },
    { "x": 560, "y": 565 }, { "x": 570, "y": 555 },
    { "x": 680, "y": 565 }, { "x": 690, "y": 555 },
    { "x": 800, "y": 565 }, { "x": 810, "y": 555 },
    { "x": 197.5, "y": 367.5 }, { "x": 212.5, "y": 352.5 },
    { "x": 317.5, "y": 367.5 }, { "x": 332.5, "y": 352.5 },
    { "x": 437.5, "y": 367.5 }, { "x": 452.5, "y": 352.5 },
    { "x": 557.5, "y": 367.5 }, { "x": 572.5, "y": 352.5 }
  ],
  "value": 9,
  "unit": "each",
  "createdBy": "local-operator"
}
EOF
jpost "/api/projects/$PID/markups" "$WORK/ac04-bad.json"
assert_eq "AC-AC-04e: a 10-pair mixed-size markup with value 9 refused 422 verbatim (the gate is size-blind)" \
  "invalid SheetMarkup: a symbol-hits markup's value must equal its hit-box count (10), got 9" \
  "$(j "$BODY" '.error.message')"

STATUS=$(curl -sS -m 30 -o "$WORK/http.body" -w '%{http_code}' -X POST "$BASE/api/projects/$PID/markups" -H 'Content-Type: application/json' --data-binary @"$WORK/ac04-hits.json") || STATUS="000"
assert_eq "AC-AC-04f: unauthenticated mixed-size symbol-hits create is 401 (the v2 lane rides the same wrapper)" \
  "401" "$STATUS"

echo
echo "== e2e-takeoff.sh: $PASS PASS / $FAIL FAIL =="
if [[ "$FAIL" -ne 0 ]]; then exit 1; fi
echo "Demo dataset ready: project $PID (Harbour View Extension), estimate $EST_ID approved (GHS 11,778.36)"
