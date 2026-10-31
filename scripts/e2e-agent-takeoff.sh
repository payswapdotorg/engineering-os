#!/usr/bin/env bash
# e2e-agent-takeoff.sh — the agent takeoff surface (ADR-0011 Stage 4, the
# EIGHTH e2e suite): FOUR thin HTTP routes over runBrokerOperation on the
# ADOPTED pdf2takeoff engine (fill-area · annotate-takeoff · export-boq ·
# project-scoped compare-revisions), the exactly-2 [old, new] pair at the
# workflow schema, and a compare-pair workflow running draft → ready →
# queued → succeeded through the REAL executor with BOTH revisions locked.
#
# Runs against the real dev server (BASE, default http://localhost:3000),
# real NextAuth (e2e-signin.sh), the real pinned engine (f5a1c08…) and the
# real A-102 fixture — every value below is a corpus-pin twin or an exact
# verbatim refusal from the broker core. An agent can propose, never approve
# (ADR-0006): every route here is the proposing surface only.
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURES="$REPO/tests/fixtures"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

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
near() { # desc expected actual tolerance
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
  : > "$WORK/http.body" # truncate BEFORE curl (the run-42 stale-body lesson)
  STATUS=$(curl -sS -m 180 -o "$WORK/http.body" -w '%{http_code}' -X "$method" "$BASE$path" "$@" ${EOS_AUTH:-}) || STATUS="000"
  BODY=$(cat "$WORK/http.body")
}
jpost() { local path="$1" data="$2"; http POST "$1" -H 'Content-Type: application/json' -d "$2"; }
upload() { # path file kind [explicit artifact name]
  local path="$1" file="$2" kind="$3" name="${4:-}"
  local args=(-F "file=@$file" -F "kind=$kind")
  if [[ -n "$name" ]]; then args+=("-F name=$name"); fi
  : > "$WORK/http.body"
  STATUS=$(curl -sS -m 180 -o "$WORK/http.body" -w '%{http_code}' -X POST "${args[@]}" "$BASE$path" ${EOS_AUTH:-}) || STATUS="000"
  BODY=$(cat "$WORK/http.body")
}
j() { printf '%s' "$1" | /usr/bin/jq -r "$2"; }
step_of() { printf '%s' "$1" | /usr/bin/jq -r ".data.steps[] | select(.stepId == \"$2\") | $3"; }
poll_state() { # workflowId target [tries] [sleepSecs] — sets POLL_BODY/POLL_STATE
  local wf="$1" target="$2" tries="${3:-30}" secs="${4:-2}" i
  POLL_STATE=""; POLL_BODY=""
  for ((i = 0; i < tries; i++)); do
    http GET "/api/workflows/$wf"
    POLL_BODY="$BODY"
    POLL_STATE=$(j "$POLL_BODY" '.data.workflow.state')
    if [[ "$POLL_STATE" == "$target" ]]; then return 0; fi
    sleep "$secs"
  done
  return 1
}

# ===========================================================================
# 1-2. Cleanup leftover probes → fresh probe project + the A-102 fixture
# ===========================================================================
(cd "$REPO" && bun scripts/dev-db-cleanup.ts --name "Agent Takeoff Probe" >/dev/null 2>&1) || true

cat > "$WORK/proj.json" <<'EOF'
{ "name": "Agent Takeoff Probe", "discipline": "civil", "description": "Throwaway agent-takeoff-surface probe (e2e-agent-takeoff.sh)" }
EOF
jpost /api/projects "$(cat "$WORK/proj.json")"
PROBE_ID=$(j "$BODY" '.data.project.id')
assert_eq "probe project created (201)" "201" "$STATUS"
if [[ -z "$PROBE_ID" ]]; then echo "FATAL: no probe project"; exit 1; fi

upload "/api/projects/$PROBE_ID/artifacts" "$FIXTURES/sheet-a102-plan.pdf" drawing "A-102 plan"
A_ID=$(j "$BODY" '.data.artifact.id')
assert_eq "A-102 fixture uploaded (201, drawing kind)" "201|drawing" "$STATUS|$(j "$BODY" '.data.artifact.kind')"
if [[ -z "$A_ID" ]]; then echo "FATAL: no artifact id"; exit 1; fi

# ===========================================================================
# 3-7. fill-area — Magic Fill over HTTP (the corpus p2t-fill-area-room twin)
# ===========================================================================
cat > "$WORK/fill.json" <<'EOF'
{ "at": [560, 460], "pageNo": 1, "label": "Room 101", "scaleMmPerPt": 35.27777777777778 }
EOF
jpost "/api/projects/$PROBE_ID/artifacts/$A_ID/fill-area" "$(cat "$WORK/fill.json")"
FILL_VALUE=$(j "$BODY" '.data.fill.value')
assert_eq "fill-area 201: vertices 8, unit m2, scale explicit-parameter, engine pdf2takeoff" \
  "201|8|m2|explicit-parameter|pdf2takeoff" \
  "$STATUS|$(j "$BODY" '.data.fill.vertices')|$(j "$BODY" '.data.fill.unit')|$(j "$BODY" '.data.fill.scaleSource')|$(j "$BODY" '.data.fill.engineKey')"

near "fill-area value: the analytic 8×5 m room at abs 0.1 (the corpus pin 39.4009 — inner-wall-face inset)" \
  "39.4009" "$FILL_VALUE" "0.1"

jpost "/api/projects/$PROBE_ID/artifacts/$A_ID/fill-area" '{ "pageNo": 1, "scaleMmPerPt": 35.27777777777778 }'
assert_eq "fill-area without at → 422 verbatim (the broker's pinned refusal)" \
  '422|fill_area requires parameters.at — a finite [x, y] point INSIDE the room, PDF points' \
  "$STATUS|$(j "$BODY" '.error.message')"

jpost "/api/projects/$PROBE_ID/artifacts/$A_ID/fill-area" '{ "at": [560, 460] }'
assert_eq "fill-area with NEITHER scale NOR calibration → 422 verbatim (the calibration red line)" \
  '422|no calibration for this revision — calibrate the sheet in Sheet Measure first, or pass parameters.scaleMmPerPt explicitly to fill_area' \
  "$STATUS|$(j "$BODY" '.error.message')"

: > "$WORK/http.body"
UNAUTH_STATUS=$(curl -sS -m 30 -o "$WORK/http.body" -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"at":[560,460]}' "$BASE/api/projects/$PROBE_ID/artifacts/$A_ID/fill-area") || UNAUTH_STATUS="000"
UNAUTH_BODY=$(cat "$WORK/http.body")
assert_eq "fill-area unauthenticated → the pinned 401 envelope" \
  "401|unauthorized" "$UNAUTH_STATUS|$(j "$UNAUTH_BODY" '.error.code')"

# ===========================================================================
# 8-10. annotate-takeoff — standard PDF annotations (the corpus roundtrip twin)
# ===========================================================================
cat > "$WORK/annotate.json" <<'EOF'
{ "markups": [
  { "type": "length", "label": "Scale bar", "page": 1, "points": [[60, 400], [343.4646, 400]] },
  { "type": "area", "label": "Room 101", "page": 1, "points": [[500, 400], [726.7717, 400], [726.7717, 541.7323], [500, 541.7323]] },
  { "type": "count", "label": "Socket", "page": 2, "points": [[205, 505]] }
] }
EOF
jpost "/api/projects/$PROBE_ID/artifacts/$A_ID/annotate-takeoff" "$(cat "$WORK/annotate.json")"
ANNOTATED_ID=$(j "$BODY" '.data.annotate.artifactId')
assert_eq "annotate-takeoff 201: markupCount 3, kept 0, kind pdf (standard annotations, Bluebeam/Acrobat-openable)" \
  "201|3|0|pdf" \
  "$STATUS|$(j "$BODY" '.data.annotate.markupCount')|$(j "$BODY" '.data.annotate.kept')|$(j "$BODY" '.data.annotate.kind')"
if [[ -z "$ANNOTATED_ID" ]]; then echo "FATAL: no annotated artifact"; exit 1; fi

jpost "/api/projects/$PROBE_ID/artifacts/$A_ID/annotate-takeoff" '{}'
assert_eq "annotate-takeoff with NO markups and NO Sheet Measure rows → 422 verbatim (nothing invented)" \
  '422|no markups to annotate — measure the sheet in Sheet Measure first, or pass parameters.markups explicitly' \
  "$STATUS|$(j "$BODY" '.error.message')"

jpost "/api/projects/$PROBE_ID/artifacts/$A_ID/annotate-takeoff" '{ "markups": [{ "type": "area", "points": [[0, 0]] }] }'
assert_eq "annotate-takeoff malformed spec (an area markup with a single point) → 422, the bridge validation verbatim" \
  "422" "$STATUS"
assert_contains "…the refusal names the shape (markups[0].points)" "markups[0].points must be an array of" "$(j "$BODY" '.error.message')"

# ===========================================================================
# 11-15. export-boq — the BOQ table (XLSX default / CSV explicit)
# ===========================================================================
jpost "/api/projects/$PROBE_ID/artifacts/$ANNOTATED_ID/export-boq" '{ "format": "csv", "scaleMmPerPt": 35.27777777777778 }'
CSV_EXPORT_ID=$(j "$BODY" '.data.export.artifactId')
assert_eq "export-boq CSV EXPLICIT → 201, formatRequested csv, rowCount 3 (the three markups)" \
  "201|csv|3" "$STATUS|$(j "$BODY" '.data.export.format')|$(j "$BODY" '.data.export.rowCount')"

http GET "/api/artifacts/$CSV_EXPORT_ID"
CSV_REV=$(j "$BODY" '.data.artifact.latestRevision.id')
CSV_TEXT=$(curl -sS -m 60 ${EOS_AUTH:-} "$BASE/api/revisions/$CSV_REV/download")
assert_contains "the CSV carries the scale-bar closed form (283.4646 pt × 0.03527778 m/pt)" "10.000001166666667" "$CSV_TEXT"
assert_contains "the CSV carries the room closed form (226.7717 × 141.7323 pt at 1:100)" "40.00001783583051" "$CSV_TEXT"

jpost "/api/projects/$PROBE_ID/artifacts/$ANNOTATED_ID/export-boq" '{ "scaleMmPerPt": 35.27777777777778 }'
assert_eq "export-boq XLSX DEFAULT (no format) → 201, rowCount HONESTLY 0 (the binary workbook's rows are not re-parsed)" \
  "201|xlsx|0|document" \
  "$STATUS|$(j "$BODY" '.data.export.format')|$(j "$BODY" '.data.export.rowCount')|$(j "$BODY" '.data.export.kind')"

jpost "/api/projects/$PROBE_ID/artifacts/$A_ID/export-boq" '{ "format": "csv", "scaleMmPerPt": 35.27777777777778 }'
assert_eq "export-boq from an UNANNOTATED PDF → 422, the engine's own honest refusal surfaced verbatim" \
  "422" "$STATUS"
assert_contains "…the refusal says what happened (no pdf2takeoff annotations)" "no pdf2takeoff annotations found" "$(j "$BODY" '.error.message')"

# ===========================================================================
# 16-21. compare-revisions — the PROJECT-scoped pair route
# ===========================================================================
upload "/api/projects/$PROBE_ID/artifacts" "$FIXTURES/sheet-a102-plan.pdf" drawing "A-102 plan (rev 2)"
B_ID=$(j "$BODY" '.data.artifact.id')
assert_eq "second A-102 upload (the new revision of the pair)" "201" "$STATUS"

jpost "/api/projects/$PROBE_ID/compare-revisions" "{ \"artifactIds\": [\"$A_ID\", \"$B_ID\"] }"
assert_eq "compare-revisions 201 on the IDENTICAL fixtures (the corpus p2t-compare-identical twin): 4 compared, 0 changed" \
  "201|4|0|0|0" \
  "$STATUS|$(j "$BODY" '.data.compare.comparedSheets')|$(j "$BODY" '.data.compare.changedSheets')|$(j "$BODY" '.data.compare.onlyInOld')|$(j "$BODY" '.data.compare.onlyInNew')"
assert_eq "the [old, new] pair order is recorded verbatim (oldArtifactId → newArtifactId)" \
  "$A_ID|$B_ID" "$(j "$BODY" '.data.compare.oldArtifactId')|$(j "$BODY" '.data.compare.newArtifactId')"

jpost "/api/projects/$PROBE_ID/compare-revisions" "{ \"artifactIds\": [\"$A_ID\", \"$A_ID\"] }"
assert_eq "compare-revisions SELF-PAIR → 422 verbatim (a revision cannot be compared with itself)" \
  '422|inputs.artifactIds for compare_revisions must be two DIFFERENT artifacts — a revision cannot be compared with itself' \
  "$STATUS|$(j "$BODY" '.error.message')"

jpost "/api/projects/$PROBE_ID/compare-revisions" "{ \"artifactIds\": [\"$A_ID\", \"$B_ID\", \"$A_ID\"] }"
assert_eq "compare-revisions with THREE ids → 422 (exactly 2, the pair shape)" "422" "$STATUS"

jpost "/api/projects/$PROBE_ID/compare-revisions" "{ \"artifactIds\": [\"$A_ID\", \"art_does_not_exist\"] }"
assert_eq "compare-revisions with an unknown artifact → 404 (the project scope is the boundary)" "404" "$STATUS"

# ===========================================================================
# 22-23. the compare-pair WORKFLOW through the REAL executor
# ===========================================================================
cat > "$WORK/wf.json" <<EOF
{ "name": "compare-pair probe", "definition": { "steps": [
  { "id": "compare", "operation": "compare_revisions", "inputs": { "artifactIds": ["$A_ID", "$B_ID"] }, "parameters": {}, "retry": { "maxAttempts": 1, "backoffMs": 0 }, "requiresApproval": false, "skipOnError": false }
] } }
EOF
jpost "/api/projects/$PROBE_ID/workflows" "$(cat "$WORK/wf.json")"
WF_ID=$(j "$BODY" '.data.workflow.id')
R_CREATE="$STATUS"
printf '{ "action": "mark-ready" }' > "$WORK/t1.json"
jpost "/api/workflows/$WF_ID/transition" "$(cat "$WORK/t1.json")"
R_READY="$STATUS"
printf '{ "action": "queue" }' > "$WORK/t2.json"
jpost "/api/workflows/$WF_ID/transition" "$(cat "$WORK/t2.json")"
R_QUEUE="$STATUS"
assert_eq "the compare-pair WORKFLOW: created, marked ready, queued (draft → ready → queued)" \
  "201|200|200" "$R_CREATE|$R_READY|$R_QUEUE"

if poll_state "$WF_ID" "succeeded" 30 2; then
  ok "the compare-pair workflow SUCCEEDED through the real executor (≤30×2s poll)"
else
  bad "the compare-pair workflow SUCCEEDED through the real executor" "last state: $POLL_STATE" "succeeded"
fi

assert_eq "the compare step: succeeded, BOTH revisions locked (inputRevisionIds length 2), comparedSheets 4, engine pdf2takeoff" \
  "succeeded|2|4|pdf2takeoff" \
  "$(step_of "$POLL_BODY" compare .state)|$(step_of "$POLL_BODY" compare '.inputRevisionIds | fromjson | length')|$(step_of "$POLL_BODY" compare '.outputSummary | fromjson | .comparedSheets')|$(step_of "$POLL_BODY" compare .engineKey)"

# ===========================================================================
# 24. the schema's self-comparison refusal over HTTP (the workflow-create gate)
# ===========================================================================
cat > "$WORK/wf-self.json" <<EOF
{ "name": "self-pair probe", "definition": { "steps": [
  { "id": "compare", "operation": "compare_revisions", "inputs": { "artifactIds": ["$A_ID", "$A_ID"] }, "parameters": {}, "retry": { "maxAttempts": 1, "backoffMs": 0 }, "requiresApproval": false, "skipOnError": false }
] } }
EOF
jpost "/api/projects/$PROBE_ID/workflows" "$(cat "$WORK/wf-self.json")"
assert_eq "a compare-pair WORKFLOW with the SELF-PAIR → 422 verbatim (the schema pins the pair at creation)" \
  '422|invalid workflow definition: steps.0.inputs: inputs.artifactIds for compare_revisions must be two DIFFERENT artifacts — a revision cannot be compared with itself' \
  "$STATUS|$(j "$BODY" '.error.message')"

# ===========================================================================
printf '\n== e2e-agent-takeoff.sh: %d PASS / %d FAIL ==\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
