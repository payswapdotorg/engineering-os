#!/usr/bin/env bash
# scripts/e2e-p3-hardening.sh — Phase-3 hardening regression (recorded: 40 PASS /
# 0 FAIL). Rebuilt from AC-P3-10 (estimate supersede) + AC-P3-11 (BOQ export)
# evidence in docs/06-qa/acceptance-catalogue.md + implementation-status records.
#
# Supersede probes run in a THROWAWAY probe project (estimates are terminal-
# superseded, never deletable — the demo estimate must stay approved for the
# BOQ export + the AC-P4-09 regression marker). The BOQ export block runs on
# the approved demo estimate built by scripts/e2e-takeoff.sh.
#
# Run AFTER scripts/e2e-takeoff.sh. Pure HTTP: curl + jq + python3.
# Final line "N PASS / M FAIL", nonzero exit on any FAIL. The probe project is
# removed at the end (bun scripts/dev-db-cleanup.ts --project …) — on failure it
# is KEPT for forensics.
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Phase-6 auth (contract §1.5): sign in as the demo operator (bootstrap via the
# first-run setup route when needed); ${EOS_AUTH} carries the session cookie jar.
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
jpost() { http POST "$1" -H 'Content-Type: application/json' --data-binary @"$2"; }
j() { printf '%s' "$1" | /usr/bin/jq -r "$2"; }

# ===========================================================================
# 1-4. Probe project + an empty estimate carried to `approved` (no lines → no
#      blockers; supersede target must preserve a REAL approval payload)
# ===========================================================================
cat > "$WORK/proj.json" <<'EOF'
{ "name": "AC-P3 hardening probe", "discipline": "civil", "description": "Throwaway supersede/export probe (e2e-p3-hardening.sh)" }
EOF
jpost /api/projects "$WORK/proj.json"
PROBE_ID=$(j "$BODY" '.data.project.id')
assert_eq "probe project created (201)" "201" "$STATUS"

cat > "$WORK/est-a.json" <<'EOF'
{ "name": "Supersede probe A", "currency": "GHS", "overheadPct": 10, "profitPct": 5, "taxPct": 0 }
EOF
jpost "/api/projects/$PROBE_ID/estimates" "$WORK/est-a.json"
EST_A=$(j "$BODY" '.data.estimate.id')
assert_eq "probe estimate A created (201, draft)" "201|draft" "$STATUS|$(j "$BODY" '.data.estimate.status')"

cat > "$WORK/t-submit.json" <<'EOF'
{ "action": "submit" }
EOF
jpost "/api/estimates/$EST_A/transition" "$WORK/t-submit.json"
assert_eq "A submit: draft → in_review" "200|in_review" "$STATUS|$(j "$BODY" '.data.estimate.status')"

cat > "$WORK/t-approve.json" <<'EOF'
{ "action": "approve" }
EOF
cat > "$WORK/t-supersede.json" <<'EOF'
{ "action": "supersede" }
EOF
jpost "/api/estimates/$EST_A/transition" "$WORK/t-approve.json"
APPROVED_AT=$(j "$BODY" '.data.estimate.approval.approvedAt')
assert_eq "A approve: in_review → approved with a real approval payload {local-operator, approvedAt}" \
  "200|approved|local-operator" "$STATUS|$(j "$BODY" '.data.estimate.status')|$(j "$BODY" '.data.estimate.approval.approvedBy')"

# ===========================================================================
# 5-9. AC-P3-10 supersede FROM APPROVED: payload preserved, one audit event,
#      terminal, lines frozen
# ===========================================================================
jpost "/api/estimates/$EST_A/transition" "$WORK/t-supersede.json"
assert_eq "supersede from approved → 200, status superseded" "200|superseded" "$STATUS|$(j "$BODY" '.data.estimate.status')"

http GET "/api/estimates/$EST_A"
assert_eq "approval payload preserved byte-identical through supersede (audit trail kept)" \
  "superseded|local-operator|$APPROVED_AT" \
  "$(j "$BODY" '.data.estimate.status')|$(j "$BODY" '.data.estimate.approval.approvedBy')|$(j "$BODY" '.data.estimate.approval.approvedAt')"

http GET "/api/events?projectId=$PROBE_ID&limit=200"
assert_eq "exactly ONE estimate.updated {action: supersede, from approved, to superseded} audit event for A" \
  "1" "$(j "$BODY" "[.data.events[] | select(.action == \"estimate.updated\") | select(.detail | fromjson | .action == \"supersede\" and .from == \"approved\" and .to == \"superseded\") | select(.entityId == \"$EST_A\")] | length")"

jpost "/api/estimates/$EST_A/transition" "$WORK/t-supersede.json"
assert_eq "re-supersede refused 422 verbatim (terminal)" \
  'cannot supersede an estimate in status "superseded"' "$(j "$BODY" '.error.message')"

cat > "$WORK/line.json" <<EOF
{ "quantityId": "qty_nonexistent", "assemblyId": "asm_nonexistent" }
EOF
jpost "/api/estimates/$EST_A/lines" "$WORK/line.json"
assert_eq "superseded estimate lines frozen (add → 422 verbatim)" \
  'estimate is superseded — its lines are frozen; duplicate the estimate to change it' \
  "$(j "$BODY" '.error.message')"

# ===========================================================================
# 10-13. Supersede from draft and from in_review + terminal absoluteness
# ===========================================================================
cat > "$WORK/est-b.json" <<'EOF'
{ "name": "Supersede probe B", "currency": "GHS", "overheadPct": 0, "profitPct": 0, "taxPct": 0 }
EOF
jpost "/api/projects/$PROBE_ID/estimates" "$WORK/est-b.json"
EST_B=$(j "$BODY" '.data.estimate.id')
jpost "/api/estimates/$EST_B/transition" "$WORK/t-supersede.json"
assert_eq "supersede from draft → 200 superseded" "200|superseded" "$STATUS|$(j "$BODY" '.data.estimate.status')"

cat > "$WORK/est-c.json" <<'EOF'
{ "name": "Supersede probe C", "currency": "GHS", "overheadPct": 0, "profitPct": 0, "taxPct": 0 }
EOF
jpost "/api/projects/$PROBE_ID/estimates" "$WORK/est-c.json"
EST_C=$(j "$BODY" '.data.estimate.id')
jpost "/api/estimates/$EST_C/transition" "$WORK/t-submit.json"
C_SUBMIT="$STATUS|$(j "$BODY" '.data.estimate.status')"
jpost "/api/estimates/$EST_C/transition" "$WORK/t-supersede.json"
assert_eq "supersede from in_review → 200 superseded (submit first observed in_review)" \
  "200|in_review|200|superseded" "$C_SUBMIT|$STATUS|$(j "$BODY" '.data.estimate.status')"

jpost "/api/estimates/$EST_B/transition" "$WORK/t-submit.json"
assert_eq "superseded is absolute: submit refused 422 verbatim" \
  'cannot submit an estimate in status "superseded"' "$(j "$BODY" '.error.message')"

# ===========================================================================
# 14. Locate the approved demo estimate (built by e2e-takeoff.sh)
# ===========================================================================
http GET /api/projects
DEMO_ID=$(printf '%s' "$BODY" | /usr/bin/jq -r '[.data.projects[] | select(.name == "Harbour View Extension")][0].id')
http GET "/api/projects/$DEMO_ID/estimates"
DEMO_EST=$(printf '%s' "$BODY" | /usr/bin/jq -r '[.data.estimates[] | select(.status == "approved")][0].id')
DEMO_LINES=$(printf '%s' "$BODY" | /usr/bin/jq -r '[.data.estimates[] | select(.id == "'"$DEMO_EST"'")][0].lines | length')
DEMO_GRAND=$(printf '%s' "$BODY" | /usr/bin/jq -r '[.data.estimates[] | select(.id == "'"$DEMO_EST"'")][0].totals.grandTotal')
assert_eq "regression precondition: the approved demo estimate is served (2 lines, grand 11778.36)" \
  "2|11778.36" "$DEMO_LINES|$DEMO_GRAND"

# ===========================================================================
# 15-19. AC-P3-11 BOQ export gates (each 422 verbatim; unknown id 404)
# ===========================================================================
cat > "$WORK/est-d.json" <<'EOF'
{ "name": "Draft export probe", "currency": "GHS", "overheadPct": 0, "profitPct": 0, "taxPct": 0 }
EOF
jpost "/api/projects/$PROBE_ID/estimates" "$WORK/est-d.json"
EST_D=$(j "$BODY" '.data.estimate.id')
http GET "/api/estimates/$EST_D/export?format=csv"
assert_eq "draft estimate export → 422 verbatim" \
  'only approved estimates can be exported as a BOQ (this estimate is "draft")' "$(j "$BODY" '.error.message')"

http GET "/api/estimates/$EST_A/export?format=csv"
assert_eq "superseded estimate export → 422 verbatim (same form)" \
  'only approved estimates can be exported as a BOQ (this estimate is "superseded")' "$(j "$BODY" '.error.message')"

http GET "/api/estimates/$DEMO_EST/export"
assert_eq "missing format → 422 verbatim" 'format is required (must be one of: csv, json)' "$(j "$BODY" '.error.message')"

http GET "/api/estimates/$DEMO_EST/export?format=xml"
assert_eq "format=xml → 422 verbatim" 'format must be one of: csv, json (got "xml")' "$(j "$BODY" '.error.message')"

http GET "/api/estimates/est_does-not-exist/export?format=csv"
assert_eq "unknown estimate id → 404 verbatim" "404|Estimate not found" "$STATUS|$(j "$BODY" '.error.message')"

# ===========================================================================
# 20-37. Approved demo estimate → deterministic 17-row CSV
# ===========================================================================
# zero-audit-events window opens here (the export block is read-only)
http GET "/api/events?projectId=$DEMO_ID&limit=200"
EVENTS_BEFORE=$(j "$BODY" '.data.events | length')

STATUS=$(curl -sS -m 180 -o "$WORK/boq.csv" -D "$WORK/boq.headers" -w '%{http_code}' \
  ${EOS_AUTH:-} "$BASE/api/estimates/$DEMO_EST/export?format=csv") || STATUS="000"
CT=$(tr -d '\r' < "$WORK/boq.headers" | grep -i '^content-type:' | cut -d' ' -f2-)
CD=$(tr -d '\r' < "$WORK/boq.headers" | grep -i '^content-disposition:' | cut -d' ' -f2-)
assert_eq "CSV export 200 with Content-Type text/csv; charset=utf-8" \
  "200|text/csv; charset=utf-8" "$STATUS|$CT"

assert_eq "Content-Disposition attachment filename=\"boq-<id>.csv\"" \
  "attachment; filename=\"boq-$DEMO_EST.csv\"" "$CD"

# JSON export (also read-only) completes the zero-audit-events window
http GET "/api/estimates/$DEMO_EST/export?format=json"
JSON_EXPORT="$BODY"
http GET "/api/events?projectId=$DEMO_ID&limit=200"
EVENTS_AFTER=$(j "$BODY" '.data.events | length')

ROWS_JSON=$(python3 - "$WORK/boq.csv" <<'PY'
import json, sys
raw = open(sys.argv[1], "rb").read()
lines = raw.decode("utf-8").rstrip("\n").split("\n")
print(json.dumps({
    "bom": raw.startswith(b"\xef\xbb\xbf"),
    "cr": b"\r" in raw,
    "trailing_lf": raw.endswith(b"\n"),
    "rows": len(lines),
    "all_quoted": all(
        __import__("re").fullmatch(r'("(?:[^"]|"")*")(?:,("(?:[^"]|"")*"))*', ln) is not None
        for ln in lines
    ),
    "lines": lines,
}))
PY
)
BOM=$(j "$ROWS_JSON" '.bom'); CR=$(j "$ROWS_JSON" '.cr'); TLF=$(j "$ROWS_JSON" '.trailing_lf')
NROWS=$(j "$ROWS_JSON" '.rows'); ALLQ=$(j "$ROWS_JSON" '.all_quoted')
assert_eq "byte hygiene: UTF-8 with NO BOM and LF-only line endings (no CR bytes)" "false|false" "$BOM|$CR"
assert_eq "byte hygiene: file ends with a trailing LF" "true" "$TLF"
assert_eq "exactly 17 rows in the pinned layout" "17" "$NROWS"
assert_eq "every field quoted (embedded quotes doubled per CSV convention)" "true" "$ALLQ"

row() { j "$ROWS_JSON" ".lines[$1]"; } # -r raw string: the CSV field quotes are part of the row text
assert_eq "row 1: title banner" '"Engineering OS — Bill of Quantities"' "$(row 0)"
assert_eq "row 2: project join" '"Project","Harbour View Extension"' "$(row 1)"
assert_eq "row 3: estimate join" '"Estimate","Ground floor slab package"' "$(row 2)"
assert_eq "row 4: status (hard-coded approved — the gate ran)" '"Status","approved"' "$(row 3)"
assert_eq "row 5: currency" '"Currency","GHS"' "$(row 4)"
if [[ "$(row 5)" =~ ^\"Generated\",\"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z\"$ ]]; then
  ok "row 6: Generated ISO-8601 UTC (the only non-deterministic slot)"
else
  bad "row 6: Generated ISO-8601 UTC" "$(row 5)" '"Generated","<ISO-8601 Z>"'
fi
assert_eq "row 7: blank separator" '""' "$(row 6)"
assert_eq "row 8: items header" '"Item","Description","Quantity","Unit","Line total","GHS"' "$(row 7)"
assert_eq "row 9: line 1 with the REAL joined description (assembly — artifact (sheetRef))" \
  '"1","C25 slab pour — Sheet-A101-GA-plan.svg (A-101 / zone B)","46.2","m²","10066.98","GHS"' "$(row 8)"
# NOTE (recorded honestly in worklog p4-scripts): the AC-P3-11 record quotes the
# line-2 join as "wall-quantities.ifc (#2rUnE8CnPHBwLdZzIqZkf1)" — the artifact+ref
# SEGMENT. The export template is `${assemblyName} — ${artifactName} (${ref})`
# (byte-pinned by boq-csv.test.ts) and AC-P3-05 pins line 2 as "0.6 m² × C25",
# so the full pinned row includes the same C25 assembly prefix as row 9; the
# recorded segment is asserted byte-present inside it.
ROW10_FULL='"2","C25 slab pour — wall-quantities.ifc (#2rUnE8CnPHBwLdZzIqZkf1)","0.6","m²","130.74","GHS"'
assert_eq "row 10: line 2 joined description (recorded segment 'wall-quantities.ifc (#2rUnE8CnPHBwLdZzIqZkf1)' byte-present via the pinned join template)" \
  "$ROW10_FULL" "$(row 9)"
assert_eq "row 11: blank separator" '""' "$(row 10)"
assert_eq "rows 12-16: totals block recomputed at export time" \
  '"Subtotal","10197.72""Overhead (10%)","1019.77""Profit (5%)","560.87""Tax (0%)","0""Grand total","11778.36"' \
  "$(row 11)$(row 12)$(row 13)$(row 14)$(row 15)"
assert_eq "row 17: determinism note" \
  '"Note","Totals recomputed at export time via half-up@2; deterministic"' "$(row 16)"

# ===========================================================================
# 38. Export wrote ZERO audit events (read-only, both formats)
# ===========================================================================
assert_eq "exports wrote ZERO audit events (csv + json both read-only)" "$EVENTS_BEFORE" "$EVENTS_AFTER"

# ===========================================================================
# 39-40. format=json → structured BOQ (project join, 2 lines, recomputed totals)
# ===========================================================================
assert_eq "json export: 200, project join + estimate join + 2 lines + recomputed totals + GHS" \
  "200|Harbour View Extension|$DEMO_EST|approved|2|10197.72|1019.77|560.87|0|11778.36|GHS" \
  "$STATUS|$(j "$JSON_EXPORT" '.data.boq.project.name')|$(j "$JSON_EXPORT" '.data.estimate.id')|$(j "$JSON_EXPORT" '.data.estimate.status')|$(j "$JSON_EXPORT" '.data.lines | length')|$(j "$JSON_EXPORT" '.data.totals | [.linesSubtotal, .overhead, .profit, .tax, .grandTotal] | map(tostring) | join("|")')|$(j "$JSON_EXPORT" '.data.totals.currency')"

assert_eq "json export: both joined descriptions verbatim (same joins as the CSV; line 2 contains the recorded 'wall-quantities.ifc (#2rUnE8CnPHBwLdZzIqZkf1)' segment)" \
  "C25 slab pour — Sheet-A101-GA-plan.svg (A-101 / zone B)|C25 slab pour — wall-quantities.ifc (#2rUnE8CnPHBwLdZzIqZkf1)" \
  "$(j "$JSON_EXPORT" '.data.lines | map(.description) | join("|")')"

echo
echo "== e2e-p3-hardening.sh: $PASS PASS / $FAIL FAIL =="
if [[ "$FAIL" -ne 0 ]]; then
  echo "probe project $PROBE_ID KEPT for forensics"
  exit 1
fi
cd "$HERE/.." && bun scripts/dev-db-cleanup.ts --project "$PROBE_ID" >/dev/null
echo "probe project removed — dev DB is the demo dataset only"
