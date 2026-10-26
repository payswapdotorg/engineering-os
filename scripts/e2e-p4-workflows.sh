#!/usr/bin/env bash
# scripts/e2e-p4-workflows.sh — NEW Phase-4 workflow-runtime acceptance script
# (AC-P4-01…09, docs/00-architecture/workflow-runtime-contract.md §11).
#
# Against the live dev server it verifies:
#   AC-P4-01 definition validation (422 verbatim joined messages) + agent creators
#   AC-P4-02 durable execution: queue → real cadquery+ifcopenshell steps →
#          awaiting_approval at the gated report step, ADR-0005 evidence on rows
#   AC-P4-04 the approval RED LINE: server-side local-operator approver (a
#          hostile `actor` body field is ignored), report published draft→approved
#   AC-P4-03 retry: geometry-free step fails through maxAttempts, workflow failed
#          with verbatim error; retry resumes from that step (failure retained)
#   AC-P4-05 downstream invalidation: new source revision → mesh+report stale
#   AC-P4-06 recovery: orphaned `running` row → recovery-marked failed + event
#   AC-P4-07 storage orphan scan/cleanup + DB↔store consistency
#   AC-P4-09 regression marker: the e2e-takeoff demo estimate still exports
#
# Runs LAST (after e2e-takeoff / e2e-p3-hardening / e2e-p2-modelviewer) — the
# shared dev DB must survive the workflow tests. The probe project
# "P4 Workflow Probe" is removed at the end on success (KEPT on failure for
# forensics). Final line "N PASS / M FAIL", nonzero exit on any FAIL.
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURES="$REPO/tests/fixtures"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Phase-6 auth (contract §1.5): sign in as the demo operator; ${EOS_AUTH}
# carries the session cookie jar, and $EOS_USER_ID is the signed-in human the
# approve gate must stamp (contract §1.3 session attribution).
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
upload() { # path file kind [explicit artifact name]
  local path="$1" file="$2" kind="$3" name="${4:-}"
  local args=(-F "file=@$file" -F "kind=$kind")
  if [[ -n "$name" ]]; then args+=(-F "name=$name"); fi
  : > "$WORK/http.body" # truncate BEFORE curl: a timed-out request must never report the previous response as BODY (run 42 stale-body lesson)
  STATUS=$(curl -sS -m 180 -o "$WORK/http.body" -w '%{http_code}' -X POST "${args[@]}" "$BASE$path" ${EOS_AUTH:-}) || STATUS="000"
  BODY=$(cat "$WORK/http.body")
}
j() { printf '%s' "$1" | /usr/bin/jq -r "$2"; }
step_of() { # detailJson stepId field
  printf '%s' "$1" | /usr/bin/jq -r ".data.steps[] | select(.stepId == \"$2\") | $3"
}
poll_state() { # workflowId target [tries] [sleepSecs] — sets POLL_BODY/POLL_STATE
  local wf="$1" target="$2" tries="${3:-20}" secs="${4:-2}" i
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
accepted_state() { # queued-or-running marker for racy queue/retry responses
  if [[ "$1" == "queued" || "$1" == "running" ]]; then echo "accepted"; else echo "$1"; fi
}

# ===========================================================================
# 1-2. Cleanup leftover probes → fresh probe project + two-solids.step
# ===========================================================================
(cd "$REPO" && bun scripts/dev-db-cleanup.ts --name "P4 Workflow Probe" >/dev/null 2>&1) || true

cat > "$WORK/proj.json" <<'EOF'
{ "name": "P4 Workflow Probe", "discipline": "structural", "description": "Throwaway workflow-runtime probe (e2e-p4-workflows.sh)" }
EOF
jpost /api/projects "$WORK/proj.json"
PROBE_ID=$(j "$BODY" '.data.project.id')
assert_eq "probe project created (201)" "201|P4 Workflow Probe" "$STATUS|$(j "$BODY" '.data.project.name')"
if [[ -z "$PROBE_ID" ]]; then echo "FATAL: no probe project"; exit 1; fi

upload "/api/projects/$PROBE_ID/artifacts" "$FIXTURES/two-solids.step" model "two-solids.step"
SOLIDS_ID=$(j "$BODY" '.data.artifact.id')
SOLIDS_REV1=$(j "$BODY" '.data.artifact.latestRevision.id')
assert_eq "two-solids.step registered (201, kind model, rev 1)" \
  "201|model|1" "$STATUS|$(j "$BODY" '.data.artifact.kind')|$(j "$BODY" '.data.artifact.latestRevision.revNumber')"

# ===========================================================================
# 3-8. AC-P4-01 definition validation (422 verbatim) + agent creator accepted
# ===========================================================================
jq -n --arg id "$SOLIDS_ID" '{name: "bad-op probe", definition: {steps: [
  {id: "quantities", operation: "render_view", inputs: {artifactId: $id}, parameters: {}, retry: {maxAttempts: 1, backoffMs: 0}, requiresApproval: false, skipOnError: false}
]}}' > "$WORK/wf-badop.json"
jpost "/api/projects/$PROBE_ID/workflows" "$WORK/wf-badop.json"
# AC-P5-07 note (2026-10-22): the operation vocabulary grew with the Phase-5
# broker ops (contract §4); Slice 15 (2026-10-25) added the vector-takeoff
# ops — the pinned message lists all eleven (Slice 16 added rebuild_parametric).
assert_eq "unknown operation → 422 with the joined verbatim message" \
  'invalid workflow definition: steps.0.operation: operation must be one of: derive_quantities, derive_mesh, build_report, fe_mesh, run_powerflow, run_des, convert_document, analyze_schedule, takeoff_sheet, takeoff_drawing, rebuild_parametric' \
  "$(j "$BODY" '.error.message')"

jq -n --arg id "$SOLIDS_ID" '{name: "dup-ids probe", definition: {steps: [
  {id: "quantities", operation: "derive_quantities", inputs: {artifactId: $id}, parameters: {}, retry: {maxAttempts: 1, backoffMs: 0}, requiresApproval: false, skipOnError: false},
  {id: "quantities", operation: "derive_mesh", inputs: {artifactId: $id}, parameters: {}, retry: {maxAttempts: 1, backoffMs: 0}, requiresApproval: false, skipOnError: false}
]}}' > "$WORK/wf-dup.json"
jpost "/api/projects/$PROBE_ID/workflows" "$WORK/wf-dup.json"
assert_eq "duplicate step ids → 422 verbatim" \
  'invalid workflow definition: steps.1.id: duplicate step id "quantities"' \
  "$(j "$BODY" '.error.message')"

jq -n --arg id "$SOLIDS_ID" '{name: "nine-step probe", definition: {steps: [
  range(1; 10) | {id: ("s" + tostring), operation: "derive_quantities", inputs: {artifactId: $id}, parameters: {}, retry: {maxAttempts: 1, backoffMs: 0}, requiresApproval: false, skipOnError: false}
]}}' > "$WORK/wf-9steps.json"
jpost "/api/projects/$PROBE_ID/workflows" "$WORK/wf-9steps.json"
assert_eq "9 steps → 422 verbatim (max is 8)" \
  'invalid workflow definition: steps: at most 8 steps are allowed' \
  "$(j "$BODY" '.error.message')"

jq -n --arg id "$SOLIDS_ID" '{name: "bad-actor probe", createdBy: "agent:BAD NAME", definition: {steps: [
  {id: "quantities", operation: "derive_quantities", inputs: {artifactId: $id}, parameters: {}, retry: {maxAttempts: 1, backoffMs: 0}, requiresApproval: false, skipOnError: false}
]}}' > "$WORK/wf-badactor.json"
jpost "/api/projects/$PROBE_ID/workflows" "$WORK/wf-badactor.json"
assert_eq "createdBy \"agent:BAD NAME\" → 422 verbatim (CREATOR_ACTOR_RE)" \
  'createdBy must be "local-operator" or an agent actor "agent:<name>" (name: ^[a-z0-9-]{1,32}$)' \
  "$(j "$BODY" '.error.message')"

# The Model QA pipeline EXACTLY as the contract §2 template (UI buildDefinition
# semantics: both derive steps take the source model; the report cites the
# SOURCE artifact once — its quantity rows are found via that artifact).
jq -n --arg id "$SOLIDS_ID" '{name: "Model QA pipeline", createdBy: "agent:qa-runner", definition: {steps: [
  {id: "quantities", operation: "derive_quantities", inputs: {artifactId: $id}, parameters: {}, retry: {maxAttempts: 2, backoffMs: 400}, requiresApproval: false, skipOnError: false},
  {id: "mesh", operation: "derive_mesh", inputs: {artifactId: $id}, parameters: {}, retry: {maxAttempts: 1, backoffMs: 0}, requiresApproval: false, skipOnError: false},
  {id: "report", operation: "build_report", inputs: {artifactIds: [$id]}, parameters: {title: "Model QA report"}, retry: {maxAttempts: 1, backoffMs: 0}, requiresApproval: true, skipOnError: false}
]}}' > "$WORK/wf-qa.json"
jpost "/api/projects/$PROBE_ID/workflows" "$WORK/wf-qa.json"
WF1=$(j "$BODY" '.data.workflow.id')
assert_eq "valid agent-created workflow accepted (201, state draft, createdBy agent:qa-runner)" \
  "201|draft|agent:qa-runner" "$STATUS|$(j "$BODY" '.data.workflow.state')|$(j "$BODY" '.data.workflow.createdBy')"

http GET "/api/workflows/$WF1"
assert_eq "workflow.created WorkflowEvent at seq 1, actorType agent, agent:qa-runner, payload carries stepCount 3" \
  "1|workflow.created|agent|agent:qa-runner|3" \
  "$(j "$BODY" '.data.events[] | select(.seq == 1) | .seq')|$(j "$BODY" '.data.events[] | select(.seq == 1) | .kind')|$(j "$BODY" '.data.events[] | select(.seq == 1) | .actorType')|$(j "$BODY" '.data.events[] | select(.seq == 1) | .actorId')|$(j "$BODY" '.data.events[] | select(.seq == 1) | .payload | fromjson | .stepCount')"

# ===========================================================================
# 9-18. AC-P4-02 durable execution: queue → real steps → awaiting_approval
# ===========================================================================
cat > "$WORK/t-ready.json" <<'EOF'
{ "action": "mark-ready" }
EOF
cat > "$WORK/t-queue.json" <<'EOF'
{ "action": "queue" }
EOF
cat > "$WORK/t-retry.json" <<'EOF'
{ "action": "retry" }
EOF
cat > "$WORK/t-approve.json" <<'EOF'
{ "action": "approve", "note": "human review — hostile actor fields are never read" }
EOF
jpost "/api/workflows/$WF1/transition" "$WORK/t-ready.json"
assert_eq "mark-ready: draft → ready (200)" "200|ready" "$STATUS|$(j "$BODY" '.data.workflow.state')"

jpost "/api/workflows/$WF1/transition" "$WORK/t-queue.json"
QUEUE_RESP_STATE=$(j "$BODY" '.data.workflow.state')
assert_eq "queue: ready → queued|running (executor claims; response 200)" "200|accepted" \
  "$STATUS|$(accepted_state "$QUEUE_RESP_STATE")"

if poll_state "$WF1" "awaiting_approval" 20 2; then
  ok "durable run reached awaiting_approval at the gated report step (≤20×2s poll, real cadquery+ifcopenshell steps ran)"
else
  bad "durable run reached awaiting_approval" "last state: $POLL_STATE" "awaiting_approval"
fi
DETAIL1="$POLL_BODY"
printf '%s' "$DETAIL1" > "$WORK/wf1-awaiting.json"
if [[ "$(j "$DETAIL1" '[.data.events[] | select(.kind == "workflow.awaiting_approval")] | length')" == "1" ]]; then
  ok "workflow.awaiting_approval event recorded (the gate pauses AFTER the draft output is written)"
else
  bad "workflow.awaiting_approval event recorded" "$(j "$DETAIL1" '[.data.events[] | .kind] | join(",")')" "workflow.awaiting_approval ×1"
fi

assert_eq "quantities step succeeded with ADR-0005 evidence: engine cadquery 2.6.1, 64-hex adapterHash, exitCode 0" \
  "succeeded|cadquery|2.6.1|true|0" \
  "$(step_of "$DETAIL1" quantities .state)|$(step_of "$DETAIL1" quantities .engineKey)|$(step_of "$DETAIL1" quantities .engineVersion)|$(step_of "$DETAIL1" quantities '.adapterHash | test("^[0-9a-f]{64}$")')|$(step_of "$DETAIL1" quantities .exitCode)"
assert_eq "quantities step: inputs locked at queue time (inputHashes JSON array of 1 sha256; maxAttempts snapshot 2)" \
  "1|1|2|true" \
  "$(step_of "$DETAIL1" quantities '.inputHashes | fromjson | length')|$(step_of "$DETAIL1" quantities '.inputRevisionIds | fromjson | length')|$(step_of "$DETAIL1" quantities .maxAttempts)|$(step_of "$DETAIL1" quantities '.inputHashes | fromjson[0] | test("^[0-9a-f]{64}$")')"
assert_eq "quantities outputSummary: rows 4 with 4 rowIds (the real ledger rows just derived)" \
  "4|4" \
  "$(step_of "$DETAIL1" quantities '.outputSummary | fromjson | .rows')|$(step_of "$DETAIL1" quantities '.outputSummary | fromjson | .rowIds | length')"
assert_eq "quantities op is ledger-only: outputArtifactRevisionId null (no artifact revision produced)" \
  "true" "$(step_of "$DETAIL1" quantities '.outputArtifactRevisionId == null')"

assert_eq "mesh step succeeded: outputSummary {contentHash 64-hex, revisionNumber 1, elementCount 2}" \
  "succeeded|true|1|2|step_mesh.py" \
  "$(step_of "$DETAIL1" mesh .state)|$(step_of "$DETAIL1" mesh '.outputSummary | fromjson | .contentHash | test("^[0-9a-f]{64}$")')|$(step_of "$DETAIL1" mesh '.outputSummary | fromjson | .revisionNumber')|$(step_of "$DETAIL1" mesh '.outputSummary | fromjson | .elementCount')|$(step_of "$DETAIL1" mesh .adapterScript)"
assert_eq "report step awaiting_approval: DRAFT output already written (outputArtifactRevisionId set), summary {sectionCount 1, figureCount 4, sourcesCited 4}" \
  "awaiting_approval|true|1|4|4" \
  "$(step_of "$DETAIL1" report .state)|$(step_of "$DETAIL1" report '.outputArtifactRevisionId != null')|$(step_of "$DETAIL1" report '.outputSummary | fromjson | .sectionCount')|$(step_of "$DETAIL1" report '.outputSummary | fromjson | .figureCount')|$(step_of "$DETAIL1" report '.outputSummary | fromjson | .sourcesCited | length')"

SEQ_OK=$(python3 -c 'import sys, json
detail = json.load(open(sys.argv[1]))
seqs = sorted(e["seq"] for e in detail["data"]["events"])
sys.exit(0 if seqs == list(range(1, len(seqs) + 1)) else 1)' "$WORK/wf1-awaiting.json" && echo ok || echo bad)
assert_eq "WorkflowEvent seq is strictly increasing 1..N with no gaps (event order is content)" "ok" "$SEQ_OK"

STEPID_OK=$(python3 -c 'import sys, json
detail = json.load(open(sys.argv[1]))
bad_count = 0
for e in detail["data"]["events"]:
    if e["kind"].startswith("step."):
        payload = json.loads(e["payload"]) if e["payload"] else {}
        if "stepId" not in payload:
            bad_count += 1
sys.exit(0 if bad_count == 0 else 1)' "$WORK/wf1-awaiting.json" && echo ok || echo bad)
assert_eq "every step.* event payload carries its stepId (failures carry verbatim errors, never paraphrased)" "ok" "$STEPID_OK"

# ===========================================================================
# 19-28. AC-P4-04 the approval RED LINE + AC-P4-08 verbatim report figures
# ===========================================================================
cat > "$WORK/t-approve-hostile.json" <<'EOF'
{ "action": "approve", "actor": "agent:evil-approver", "actorType": "agent", "note": "hostile actor attempt — the route must never read an actor from the body" }
EOF
jpost "/api/workflows/$WF1/transition" "$WORK/t-approve-hostile.json"
APPROVE_STATUS="$STATUS"
if poll_state "$WF1" "succeeded" 15 2; then
  DETAIL2="$POLL_BODY"
  printf '%s' "$DETAIL2" > "$WORK/wf1-succeeded.json"
  APPROVED_EVT=$(j "$DETAIL2" '[.data.events[] | select(.kind == "workflow.approved")][0]')
  RED_LINE=$(if [[ "$APPROVE_STATUS" == "200" && "$(j "$DETAIL2" '[.data.events[] | select(.kind == "workflow.approved")] | length')" == "1" && "$(printf '%s' "$APPROVED_EVT" | /usr/bin/jq -r '.actorType')" == "user" && "$(printf '%s' "$APPROVED_EVT" | /usr/bin/jq -r '.actorId')" == "$EOS_USER_ID" ]]; then echo held; else echo broken; fi)
  assert_eq "RED LINE: approve with a hostile actor field in the body → 200 and the approver is STILL the server-side session human {user, $EOS_USER_ID} (agents never approve — no code path; Phase-6 §1.3 stamps the signed-in user)" \
    "held" "$RED_LINE"
else
  bad "approve published + workflow succeeded" "last state: $POLL_STATE" "succeeded"
  DETAIL2="$POLL_BODY"
fi

WF2_STATE=$(j "$DETAIL2" '.data.workflow.state')
WF2_FINISHED=$(j "$DETAIL2" '.data.workflow.finishedAt != null')
assert_eq "workflow reached succeeded with finishedAt set" "succeeded|true" "$WF2_STATE|$WF2_FINISHED"
assert_eq "workflow.succeeded event recorded exactly once" "1" \
  "$(j "$DETAIL2" '[.data.events[] | select(.kind == "workflow.succeeded")] | length')"

REPORT_ART=$(step_of "$DETAIL1" report '.outputSummary | fromjson | .artifactId')
REPORT_REV=$(step_of "$DETAIL1" report '.outputArtifactRevisionId')
MESH_ART=$(step_of "$DETAIL1" mesh '.outputSummary | fromjson | .artifactId')
http GET "/api/artifacts/$REPORT_ART"
assert_eq "report artifact latest revision PUBLISHED: draft → approved with the workflow approval payload on the note (approvedBy = the session human, Phase-6 §1.3)" \
  "approved|$EOS_USER_ID|$WF1|true" \
  "$(j "$BODY" '.data.artifact.latestRevision.approvalState')|$(j "$BODY" '.data.artifact.latestRevision.note | fromjson | .approvedBy')|$(j "$BODY" '.data.artifact.latestRevision.note | fromjson | .workflowId')|$(j "$BODY" '.data.artifact.latestRevision.note | fromjson | .approvedAt | startswith("20")')"

http GET "/api/artifacts/$MESH_ART"
assert_eq "mesh revision stays DRAFT (only the gated report is published by approval)" \
  "draft" "$(j "$BODY" '.data.artifact.latestRevision.approvalState')"
MESH_UPLOADER=$(j "$BODY" '.data.artifact.latestRevision.uploadedBy')

http GET "/api/events?projectId=$PROBE_ID&limit=200"
assert_eq "audit trail: quantity.derived + mesh.derived + report.built all exist with the AGENT actor agent:qa-runner (one each)" \
  "1|1|1|agent:qa-runner|agent:qa-runner|agent:qa-runner" \
  "$(j "$BODY" '[.data.events[] | select(.action == "quantity.derived")] | length')|$(j "$BODY" '[.data.events[] | select(.action == "mesh.derived")] | length')|$(j "$BODY" '[.data.events[] | select(.action == "report.built")] | length')|$(j "$BODY" '[.data.events[] | select(.action == "quantity.derived")][0].actorId')|$(j "$BODY" '[.data.events[] | select(.action == "mesh.derived")][0].actorId')|$(j "$BODY" '[.data.events[] | select(.action == "report.built")][0].actorId')"
assert_eq "mesh revision provenance stays adapter:cadquery (uploadedBy) while the AUDIT actor is the agent (the pinned W2 seam)" \
  "adapter:cadquery" "$MESH_UPLOADER"

REPORT_PATH="$REPO/data/artifacts/$PROBE_ID/$REPORT_ART/$REPORT_REV/content"
REPORT_OK=$(python3 -c 'import sys, json, os
doc = json.load(open(sys.argv[1]))
wf = doc.get("workflow", {})
figs = [f for s in doc["sections"] for f in s["figures"]]
values = sorted(round(float(f["value"]), 4) for f in figs if f["sourceType"] == "quantity-row")
ok = (
    doc["format"] == "eos-report/1"
    and doc["title"] == "Model QA report"
    and wf.get("workflowId") == sys.argv[2]
    and wf.get("stepId") == "report"
    and wf.get("actor") == "agent:qa-runner"
    and len(doc["sections"]) == 1
    and doc["sections"][0]["kind"] == "quantity-ledger"
    and len(figs) == 4
    and values == [123.3896, 5050.0, 6000.0, 9000.0]
)
sys.exit(0 if ok else 1)' "$REPORT_PATH" "$WF1" 2>/dev/null && echo ok || echo bad)
assert_eq "report content = eos-report/1: workflow block {workflowId, stepId report, actor agent:qa-runner} + quantity-ledger section with the 4 verbatim ledger figures (9000 / 6000 mm³, 5050 mm², bbox)" \
  "ok" "$REPORT_OK"

http GET "/api/projects/$PROBE_ID/quantities"
LEDGER="$BODY"
SRCID_OK=$(python3 -c 'import sys, json
doc = json.load(open(sys.argv[1]))
ledger = json.loads(sys.argv[2])["data"]["quantities"]
ledger_ids = {r["id"] for r in ledger}
figs = [f for s in doc["sections"] for f in s["figures"]]
sys.exit(0 if all(f["sourceType"] == "quantity-row" and f["sourceId"] in ledger_ids for f in figs) else 1)' \
  "$REPORT_PATH" "$LEDGER" && echo ok || echo bad)
assert_eq "AC-P4-08: every figure is a VERBATIM copy with its per-figure sourceId == a real ledger row id (no recomputation)" \
  "ok" "$SRCID_OK"

# ===========================================================================
# 29-31. Illegal transitions → 409 verbatim (ratified W3 deviation: 409, not 422)
# ===========================================================================
jpost "/api/workflows/$WF1/transition" "$WORK/t-queue.json"
assert_eq "queue on succeeded → 409 verbatim" \
  '409|cannot queue a workflow in state "succeeded"' "$STATUS|$(j "$BODY" '.error.message')"

jq -n --arg id "$SOLIDS_ID" '{name: "draft approve-refusal probe", definition: {steps: [
  {id: "quantities", operation: "derive_quantities", inputs: {artifactId: $id}, parameters: {}, retry: {maxAttempts: 1, backoffMs: 0}, requiresApproval: false, skipOnError: false}
]}}' > "$WORK/wf-draft.json"
jpost "/api/projects/$PROBE_ID/workflows" "$WORK/wf-draft.json"
WF_DRAFT=$(j "$BODY" '.data.workflow.id')
jpost "/api/workflows/$WF_DRAFT/transition" "$WORK/t-approve.json"
assert_eq "approve on draft → 409 verbatim" \
  '409|cannot approve a workflow in state "draft"' "$STATUS|$(j "$BODY" '.error.message')"

jpost "/api/workflows/$WF1/transition" "$WORK/t-retry.json"
assert_eq "retry on succeeded → 409 verbatim (succeeded is absolute)" \
  '409|cannot retry a workflow in state "succeeded"' "$STATUS|$(j "$BODY" '.error.message')"

# ===========================================================================
# 32-39. AC-P4-03 retry: forced failure via a geometry-free source, then resume
# ===========================================================================
upload "/api/projects/$PROBE_ID/artifacts" "$FIXTURES/bracket.step" model "bracket.step"
BRACKET_ID=$(j "$BODY" '.data.artifact.id')
jq -n --arg id "$BRACKET_ID" '{name: "Retry probe (geometry-free source)", createdBy: "agent:retry-probe", definition: {steps: [
  {id: "quantities", operation: "derive_quantities", inputs: {artifactId: $id}, parameters: {}, retry: {maxAttempts: 2, backoffMs: 100}, requiresApproval: false, skipOnError: false}
]}}' > "$WORK/wf-retry.json"
jpost "/api/projects/$PROBE_ID/workflows" "$WORK/wf-retry.json"
WF_RETRY=$(j "$BODY" '.data.workflow.id')
RETRY_CREATE=$(if [[ "$STATUS" == "201" && "$(j "$BODY" '.data.workflow.state')" == "draft" && "$(j "$BODY" '.data.workflow.createdBy')" == "agent:retry-probe" ]]; then echo ok; else echo "$STATUS|$(j "$BODY" '.data.workflow.state')|$(j "$BODY" '.data.workflow.createdBy')"; fi)
assert_eq "bracket.step (0 solids) uploaded + retry-probe workflow created (1 step, maxAttempts 2, backoffMs 100, createdBy agent:retry-probe)" \
  "ok" "$RETRY_CREATE"

jpost "/api/workflows/$WF_RETRY/transition" "$WORK/t-ready.json"
R1=$(if [[ "$STATUS" == "200" && "$(j "$BODY" '.data.workflow.state')" == "ready" ]]; then echo ok; else echo "$STATUS"; fi)
jpost "/api/workflows/$WF_RETRY/transition" "$WORK/t-queue.json"
R2=$(if [[ "$STATUS" == "200" ]]; then echo ok; else echo "$STATUS"; fi)
if poll_state "$WF_RETRY" "failed" 20 2; then
  RETRY_DETAIL="$POLL_BODY"
  printf '%s' "$RETRY_DETAIL" > "$WORK/wf-retry-failed.json"
  R3=ok
else
  RETRY_DETAIL="$POLL_BODY"
  printf '%s' "$RETRY_DETAIL" > "$WORK/wf-retry-failed.json"
  R3="last-state:$POLL_STATE"
fi
assert_eq "geometry-free step exhausts retries → workflow FAILED (ready → queue → poll ≤20×2s)" "ok|ok|ok" "$R1|$R2|$R3"

FAILURE_OK=$(python3 -c 'import sys, json
w = json.load(open(sys.argv[1]))["data"]["workflow"]
f = json.loads(w["failure"]) if w["failure"] else {}
ok = (
    f.get("stepId") == "quantities"
    and f.get("attempt") == 2
    and "no solid geometry" in f.get("error", "")
    and "at" in f
)
sys.exit(0 if ok else 1)' "$WORK/wf-retry-failed.json" && echo ok || echo bad)
assert_eq "workflow.failure JSON: {stepId quantities, attempt 2, verbatim 'no solid geometry' error, at}" "ok" "$FAILURE_OK"

# NOTE (worklog p4-scripts): the task sketch said "step.failed events ×2" for a
# maxAttempts-2 step; the CONTRACT semantics (§8 + the ratified W3 record) are
# step.started per attempt + step.retried between attempts + ONE step.failed at
# exhaustion — the product follows the contract, so the script asserts that.
assert_eq "event stream: step.started ×2 (one per attempt) + step.retried ×1 + step.failed ×1 (exhaustion) + workflow.failed ×1" \
  "2|1|1|1" \
  "$(j "$RETRY_DETAIL" '[.data.events[] | select(.kind == "step.started")] | length')|$(j "$RETRY_DETAIL" '[.data.events[] | select(.kind == "step.retried")] | length')|$(j "$RETRY_DETAIL" '[.data.events[] | select(.kind == "step.failed")] | length')|$(j "$RETRY_DETAIL" '[.data.events[] | select(.kind == "workflow.failed")] | length')"
assert_eq "failed step row records attempt 2 (1-based, maxAttempts exhausted)" \
  "failed|2|2" \
  "$(step_of "$RETRY_DETAIL" quantities .state)|$(step_of "$RETRY_DETAIL" quantities .attempt)|$(step_of "$RETRY_DETAIL" quantities .maxAttempts)"

jpost "/api/workflows/$WF_RETRY/transition" "$WORK/t-retry.json"
RETRY_RESP_STATE=$(j "$BODY" '.data.workflow.state')
http GET "/api/workflows/$WF_RETRY"
FAILURE_STILL_SET=$(j "$BODY" '.data.workflow.failure != null')
assert_eq "retry: failed → queued|running (200) with the failure field RETAINED for audit (ratified W3 semantics)" \
  "200|accepted|true" "$STATUS|$(accepted_state "$RETRY_RESP_STATE")|$FAILURE_STILL_SET"

if poll_state "$WF_RETRY" "failed" 20 2; then
  RETRY2="$POLL_BODY"
  printf '%s' "$RETRY2" > "$WORK/wf-retry-failed-2.json"
  R4=ok
else
  RETRY2="$POLL_BODY"
  printf '%s' "$RETRY2" > "$WORK/wf-retry-failed-2.json"
  R4="last-state:$POLL_STATE"
fi
ATTEMPT_RESET=$(python3 -c 'import sys, json
w = json.load(open(sys.argv[1]))["data"]["workflow"]
f = json.loads(w["failure"]) if w["failure"] else {}
step = [s for s in json.load(open(sys.argv[1]))["data"]["steps"] if s["stepId"] == "quantities"][0]
ok = f.get("attempt") == 2 and step["attempt"] == 2 and "no solid geometry" in f.get("error", "")
sys.exit(0 if ok else 1)' "$WORK/wf-retry-failed-2.json" && echo ok || echo bad)
assert_eq "retry resumes from the failed step and fails again honestly (attempt RESET to 2 more; failure overwritten with the fresh run)" \
  "ok|ok" "$R4|$ATTEMPT_RESET"
assert_eq "event totals after the retry: step.started ×4, step.retried ×2, step.failed ×2, workflow.failed ×2 (2 attempts per run, one step.failed at each exhaustion)" \
  "4|2|2|2" \
  "$(j "$RETRY2" '[.data.events[] | select(.kind == "step.started")] | length')|$(j "$RETRY2" '[.data.events[] | select(.kind == "step.retried")] | length')|$(j "$RETRY2" '[.data.events[] | select(.kind == "step.failed")] | length')|$(j "$RETRY2" '[.data.events[] | select(.kind == "workflow.failed")] | length')"

# ===========================================================================
# 40-41. AC-P4-05 downstream invalidation (Journey-G reuse, zero new graph code)
# ===========================================================================
upload "/api/artifacts/$SOLIDS_ID/revisions" "$FIXTURES/two-solids.step" model ""
REV_POST="$BODY"
STALE_OK=$(printf '%s' "$REV_POST" | /usr/bin/jq -r --arg p1 "$SOLIDS_ID,$MESH_ART" --arg p2 "$SOLIDS_ID,$REPORT_ART" \
  '[.data.staleMarked[].path | join(",")] | (length == 2 and (index($p1) != null) and (index($p2) != null))')
assert_eq "new source revision → BOTH workflow outputs marked stale with path evidence ([source,mesh] + [source,report])" \
  "true" "$STALE_OK"

http GET "/api/projects/$PROBE_ID/artifacts"
assert_eq "latest revisions: mesh + report stale, source model current (cascade rode derived_from)" \
  "stale|stale|current" \
  "$(printf '%s' "$BODY" | /usr/bin/jq -r ".data.artifacts[] | select(.id == \"$MESH_ART\") | .latestRevision.staleness")|$(printf '%s' "$BODY" | /usr/bin/jq -r ".data.artifacts[] | select(.id == \"$REPORT_ART\") | .latestRevision.staleness")|$(printf '%s' "$BODY" | /usr/bin/jq -r ".data.artifacts[] | select(.id == \"$SOLIDS_ID\") | .latestRevision.staleness")"

# ===========================================================================
# 42-43. AC-P4-06 recovery: orphaned `running` row → recovery-marked failed
# ===========================================================================
cat > "$WORK/insert-orphan.ts" <<EOF
import path from "node:path"
import { db } from "$REPO/src/lib/db"

async function main() {
  const wf = await db.workflow.create({
    data: {
      id: "wfl_orphan_probe_0001",
      projectId: "$PROBE_ID",
      name: "Orphaned run probe",
      state: "running",
      definition: JSON.stringify({ steps: [] }),
      createdBy: "local-operator",
      currentStateSince: new Date(Date.now() - 10 * 60 * 1000),
    },
  })
  console.log("ORPHAN_ID=" + wf.id)
  console.log("ROOT=" + (process.env.EOS_STORAGE_ROOT ?? path.join(process.cwd(), "data", "artifacts")))
}
main()
EOF
(cd "$REPO" && bun "$WORK/insert-orphan.ts" 2>/dev/null | grep '^ORPHAN_ID=' | cut -d= -f2 > "$WORK/orphan-id.txt")
ORPHAN_ID=$(cat "$WORK/orphan-id.txt")
http GET "/api/projects/$PROBE_ID/workflows" # the list call runs the recovery scan (contract §8)
sleep 1
http GET "/api/workflows/$ORPHAN_ID"
ORPHAN_STATE=$(j "$BODY" '.data.workflow.state')
ORPHAN_FAILURE=$(j "$BODY" '.data.workflow.failure | fromjson | .error')
assert_eq "orphaned running row (currentStateSince now−10min) → recovery-marked FAILED with the pinned failure text" \
  "failed|interrupted: server restarted or executor died (recovery-marked)" \
  "$ORPHAN_STATE|$ORPHAN_FAILURE"
assert_eq "workflow.recovery-marked event by system:recovery (honest: no auto-resume — recovery IS the retry action)" \
  "1|system|system:recovery" \
  "$(j "$BODY" '[.data.events[] | select(.kind == "workflow.recovery-marked")] | length')|$(j "$BODY" '[.data.events[] | select(.kind == "workflow.recovery-marked")][0].actorType')|$(j "$BODY" '[.data.events[] | select(.kind == "workflow.recovery-marked")][0].actorId')"

# ===========================================================================
# 44-47. AC-P4-07 storage orphan scan/cleanup + DB↔store consistency
# ===========================================================================
FAKE_ART="art_orphanprobe01"
FAKE_REV="rev_orphanprobe01"
FAKE_DIR="$REPO/data/artifacts/$PROBE_ID/$FAKE_ART/$FAKE_REV"
FAKE_KEY="$PROBE_ID/$FAKE_ART/$FAKE_REV"
mkdir -p "$FAKE_DIR"
printf 'orphaned bytes (e2e-p4-workflows.sh probe)' > "$FAKE_DIR/content"
http POST /api/admin/storage/scan
assert_eq "storage scan lists the true orphan (revision dir with no DB row; storageKey only, never paths)" \
  "true" "$(j "$BODY" "[.data.orphans[] | select(.storageKey == \"$FAKE_KEY\")] | length == 1")"

cat > "$WORK/no-confirm.json" <<'EOF'
{ "confirm": false }
EOF
http DELETE /api/admin/storage/orphans -H 'Content-Type: application/json' --data-binary @"$WORK/no-confirm.json"
assert_eq "DELETE orphans without {confirm: true} → 422 verbatim (never a blind sweep)" \
  'confirm: confirm must be true to delete orphans (this permanently removes unreferenced content-store directories)' \
  "$(j "$BODY" '.error.message')"

cat > "$WORK/confirm.json" <<'EOF'
{ "confirm": true }
EOF
http DELETE /api/admin/storage/orphans -H 'Content-Type: application/json' --data-binary @"$WORK/confirm.json"
REMOVED_OK=$(if [[ "$STATUS" == "200" && "$(j "$BODY" "[.data.removed[] | select(. == \"$FAKE_KEY\")] | length")" == "1" && "$(j "$BODY" '.data.kept | length')" == "0" ]]; then echo ok; else echo "$STATUS|$(j "$BODY" '.data.removed | join(",")')|$(j "$BODY" '.data.kept | join(",")')"; fi)
assert_eq "DELETE with {confirm: true} removes EXACTLY the orphan (fresh server-side scan; nothing kept)" "ok" "$REMOVED_OK"

cat > "$WORK/consistency.ts" <<EOF
import { existsSync } from "node:fs"
import path from "node:path"
import { db } from "$REPO/src/lib/db"

async function main() {
  const root = process.env.EOS_STORAGE_ROOT ?? path.join(process.cwd(), "data", "artifacts")
  const rows = await db.artifactRevision.findMany({ select: { storageKey: true } })
  let missing = 0
  for (const row of rows) {
    if (!existsSync(path.join(root, row.storageKey, "content"))) missing++
  }
  console.log(missing === 0 ? "CONSISTENT" : "INCONSISTENT:" + missing)
}
main()
EOF
CONSISTENCY=$(cd "$REPO" && bun "$WORK/consistency.ts" 2>/dev/null | tail -1)
http POST /api/admin/storage/scan
RESCAN=$(j "$BODY" '.data.orphans | length')
assert_eq "DB↔store consistency: every ArtifactRevision.storageKey exists on disk AND the re-scan finds zero orphans (walks both ways)" \
  "CONSISTENT|0" "$CONSISTENCY|$RESCAN"

# ===========================================================================
# 48. AC-P4-09 regression marker: the shared dev DB survived the workflow tests
# ===========================================================================
http GET /api/projects
DEMO_ID=$(printf '%s' "$BODY" | /usr/bin/jq -r '[.data.projects[] | select(.name == "Harbour View Extension")][0].id')
http GET "/api/projects/$DEMO_ID/estimates"
DEMO_EST=$(printf '%s' "$BODY" | /usr/bin/jq -r '[.data.estimates[] | select(.status == "approved")][0].id')
STATUS=$(curl -sS -m 180 -o "$WORK/boq.csv" -D "$WORK/boq.headers" -w '%{http_code}' \
  ${EOS_AUTH:-} "$BASE/api/estimates/$DEMO_EST/export?format=csv") || STATUS="000"
CT=$(tr -d '\r' < "$WORK/boq.headers" | grep -i '^content-type:' | cut -d' ' -f2-)
assert_eq "REGRESSION MARKER: the e2e-takeoff demo estimate still exports (200 text/csv) after all workflow tests" \
  "200|text/csv; charset=utf-8" "$STATUS|$CT"

echo
echo "== e2e-p4-workflows.sh: $PASS PASS / $FAIL FAIL =="
if [[ "$FAIL" -ne 0 ]]; then
  echo "probe project $PROBE_ID KEPT for forensics"
  exit 1
fi
(cd "$REPO" && bun scripts/dev-db-cleanup.ts --project "$PROBE_ID" >/dev/null)
echo "probe project removed — dev DB is the demo dataset only"
