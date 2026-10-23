#!/usr/bin/env bash
# scripts/e2e-p7-planner.sh — Slice-11 LLM planning-layer acceptance script
# (AC-P1…P11, docs/00-architecture/agent-planning-contract.md §7.2).
# The SEVENTH e2e suite: sources scripts/e2e-signin.sh (operator/admin session)
# like the six before it, then signs in the two demo personas (Kwame engineer,
# Zara viewer) through the SAME real NextAuth credentials flow (_iso_signin,
# password demo1234 — src/lib/demo-accounts.ts).
#
# Two honest parts (contract §7.2):
#   Part A — CONTRACT surface (ALWAYS runs; green in CI without an LLM):
#     fixture  probe project + two-solids.step through the REAL API; Zara
#              granted viewer through the REAL members API; four proposed/
#              failed plan rows seeded via scripts/dev-seed-plan.ts (the
#              documented test-only seam, contract §7.3 — intents always
#              prefixed "[e2e fixture]"); a second throwaway project carries a
#              seeded FAILED plan for the cross-project refusal.
#     AC-P1  isolation: non-member (Kwame, no grant) POST/GET project plans
#            → 404 Project not found; GET plan detail → 404 Plan not found
#            (Slice-10 entity layering: hidden ≡ missing per-entity)
#     AC-P2  project-viewer: Zara POST plans → 403 verbatim read-only; her
#            GET stays 200 (member read)
#     AC-P3  boundary 422s verbatim: too-short intent, too-long intent, bad
#            decision action; decision on a failed row → 409 with its status;
#            double decision → 409 `this plan is already accepted|rejected`
#     AC-P4  cross-project revisesPlanId → 422 `cannot revise a plan from
#            another project`
#     AC-P5  accept path (the HUMAN path, no shortcut): accept the seeded
#            report-shaped plan → plan accepted + workflow.state=draft +
#            createdBy=agent:planner-v1 + name ends " (AI plan)"; the draft
#            carries the workflow.created event + audit parity with the manual
#            route (agent actor); mark-ready → queue → poll awaiting_approval
#            → approve → poll succeeded (ONE build_report step, no engine
#            subprocess — the p6 precedent); plan.accepted + workflow.created
#            audit rows exist with their detail
#     AC-P6  accept-after-artifact-deletion → 422 `plan references unknown
#            artifact "<id>"`; the plan STAYS proposed (defense in depth)
#     AC-P7  reject path → rejected; second decision → 409 verbatim
#     AC-P8  the plans ledger stays honest: all seeded + decided rows present
#            with statuses that agree with the decisions just made
#   Part B — LIVE LLM round trip (runs only when the real planner wire is
#     available — bun probe through src/lib/llm.ts probePlannerLlm; otherwise
#     prints `SKIP (llm unavailable)` and PASSES, the engine-harness skip
#     precedent; CI runners have no LLM):
#     AC-P9  POST a real intent naming a real model artifact → 201 with a
#            persisted row whose status is honestly proposed-or-failed, whose
#            failure (if any) carries the verbatim stage+error, and whose
#            evidence.rawResponse is the VERBATIM LLM text when the LLM
#            produced one; when proposed: rationale + stepSummary non-empty and
#            every wired artifact id is a REAL project artifact
#     AC-P10 regenerate → a NEW row with revisesPlanId = the first row's id
#            (the evidence-based re-plan chain is the auditable link)
#     AC-P11 when a Part B row is proposed: accept → 200 {plan accepted,
#            workflow draft, agent:planner-v1}; the extra draft is cancelled
#            via the HUMAN cancel path so cleanup removes everything
#
# Runs LAST of the seven scripts (after e2e-p6). Creates and removes its OWN
# fixtures through the REAL API + the documented seed/cleanup seams; the two
# fixture projects are removed on success (KEPT on failure for forensics).
# Final line "N PASS / M FAIL", nonzero exit on any FAIL.
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"

ISO_JARS=""
trap 'rm -rf "$WORK" $ISO_JARS' EXIT

# Phase-6 auth (contract §1.5): sign in as the demo operator; ${EOS_AUTH}
# carries the operator cookie jar.
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
assert_eq() { if [[ "$3" == "$2" ]]; then ok "$1"; else bad "$1" "$3" "$2"; fi }
assert_status_in() {
  local desc="$1" s found=0
  shift
  for s in "$@"; do if [[ "$STATUS" == "$s" ]]; then found=1; break; fi; done
  if [[ "$found" == "1" ]]; then ok "$desc"; else bad "$desc" "$STATUS" "one of: $*"; fi
}

STATUS=""
BODY=""
AUTH_ARGS="${EOS_AUTH:-}"
http() {
  local method="$1" path="$2"
  shift 2
  STATUS=$(curl -sS -m 180 -o "$WORK/http.body" -w '%{http_code}' -X "$method" "$BASE$path" "$@" $AUTH_ARGS) || STATUS="000"
  BODY=$(cat "$WORK/http.body")
}
jpost() { http POST "$1" -H 'Content-Type: application/json' --data-binary @"$2"; }
upload() {
  local path="$1" file="$2" kind="$3" name="${4:-}"
  local args=(-F "file=@$file" -F "kind=$kind")
  if [[ -n "$name" ]]; then args+=(-F "name=$name"); fi
  STATUS=$(curl -sS -m 180 -o "$WORK/http.body" -w '%{http_code}' -X POST "${args[@]}" "$BASE$path" $AUTH_ARGS) || STATUS="000"
  BODY=$(cat "$WORK/http.body")
}
j() { printf '%s' "$1" | /usr/bin/jq -r "$2"; }
# seedjson <rawOutput> — the dev prisma client logs `prisma:query` lines to
# stdout ahead of the seed script's single JSON line, so the JSON is the LAST
# line; extract it before jq parsing.
seedjson() { printf '%s\n' "$1" | tail -n1; }
poll_state() {
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

_iso_signin() {
  local email="$1" password="$2" dir jar code csrf
  dir="$(mktemp -d)"
  jar="$dir/cookies.txt"
  ISO_JARS="$ISO_JARS $dir"
  code="$(curl -sS -m 30 -o "$dir/csrf.json" -w '%{http_code}' -c "$jar" "$BASE/api/auth/csrf")" || code="000"
  if [[ "$code" != "200" ]]; then echo "e2e-p7-planner: FATAL — _iso_signin($email): csrf returned $code" >&2; exit 1; fi
  csrf="$(j "$(cat "$dir/csrf.json")" '.csrfToken')"
  if [[ -z "$csrf" || "$csrf" == "null" ]]; then echo "e2e-p7-planner: FATAL — _iso_signin($email): no csrfToken" >&2; exit 1; fi
  code="$(curl -sS -m 30 -o "$dir/callback.json" -w '%{http_code}' \
    -b "$jar" -c "$jar" -X POST -H 'Content-Type: application/x-www-form-urlencoded' \
    --data-urlencode "csrfToken=$csrf" \
    --data-urlencode "email=$email" \
    --data-urlencode "password=$password" \
    --data-urlencode "json=true" \
    "$BASE/api/auth/callback/credentials")" || code="000"
  if [[ "$code" != "200" ]]; then echo "e2e-p7-planner: FATAL — _iso_signin($email): callback returned $code" >&2; cat "$dir/callback.json" >&2 || true; exit 1; fi
  code="$(curl -sS -m 30 -o "$dir/session.json" -w '%{http_code}' -b "$jar" -c "$jar" "$BASE/api/auth/session")" || code="000"
  if [[ "$code" != "200" ]]; then echo "e2e-p7-planner: FATAL — _iso_signin($email): session returned $code" >&2; exit 1; fi
  ISO_JAR="$jar"
  ISO_UID="$(j "$(cat "$dir/session.json")" '.user.id // empty')"
  ISO_ROLE="$(j "$(cat "$dir/session.json")" '.user.role // empty')"
  if [[ -z "$ISO_UID" || -z "$ISO_ROLE" ]]; then echo "e2e-p7-planner: FATAL — _iso_signin($email): no user in session" >&2; exit 1; fi
}

# ===========================================================================
# Fixture: demo roster (idempotent) + personas + probe project + artifact
# ===========================================================================
http POST /api/auth/demo-accounts
assert_status_in "fixture: demo roster provisioned through the REAL route (idempotent ensure: 201 created / 200 already present — never a 4xx)" 200 201

_iso_signin "kwame.demo@eos.local" "demo1234"
KWAME_JAR="$ISO_JAR"
_iso_signin "zara.demo@eos.local" "demo1234"
ZARA_JAR="$ISO_JAR"

(cd "$REPO" && bun scripts/dev-db-cleanup.ts --name "P7 Planner Probe" >/dev/null 2>&1) || true
(cd "$REPO" && bun scripts/dev-db-cleanup.ts --name "P7 Cross Probe" >/dev/null 2>&1) || true

cat > "$WORK/proj.json" <<'EOF'
{ "name": "P7 Planner Probe", "discipline": "structural", "description": "Throwaway LLM-planning probe (e2e-p7-planner.sh)" }
EOF
jpost /api/projects "$WORK/proj.json"
PROBE_ID=$(j "$BODY" '.data.project.id')
assert_eq "probe project created (201)" "201" "$STATUS"
if [[ -z "$PROBE_ID" ]]; then echo "FATAL: no probe project"; exit 1; fi

FIXTURES="$REPO/tests/fixtures"
upload "/api/projects/$PROBE_ID/artifacts" "$FIXTURES/two-solids.step" model "two-solids.step"
SOLIDS_ID=$(j "$BODY" '.data.artifact.id')
assert_eq "two-solids.step registered (201, kind model)" "201|model" "$STATUS|$(j "$BODY" '.data.artifact.kind')"
if [[ -z "$SOLIDS_ID" ]]; then echo "FATAL: no artifact"; exit 1; fi

cat > "$WORK/m-zara.json" <<'EOF'
{ "name": "Zara Ahmed", "role": "viewer", "email": "zara.demo@eos.local" }
EOF
jpost "/api/projects/$PROBE_ID/members" "$WORK/m-zara.json"
assert_status_in "fixture: Zara granted viewer on the probe project via the REAL members API (201/200)" 201 200

# Seeded plan rows (contract §7.3 documented seam — proposed/failed only,
# intents always "[e2e fixture]"-prefixed).
SEED1=$(cd "$REPO" && bun scripts/dev-seed-plan.ts "$PROBE_ID" "$SOLIDS_ID" proposed report)
PLAN_ACCEPT_ID=$(j "$(seedjson "$SEED1")" '.plan.id // .data.plan.id')
assert_eq "fixture: report-shaped proposed plan seeded (seed script prints an id)" "true" "$([[ -n "$PLAN_ACCEPT_ID" ]] && echo true)"

SEED2=$(cd "$REPO" && bun scripts/dev-seed-plan.ts "$PROBE_ID" "$SOLIDS_ID" proposed qa)
PLAN_DELETE_ID=$(j "$(seedjson "$SEED2")" '.plan.id // .data.plan.id')

SEED3=$(cd "$REPO" && bun scripts/dev-seed-plan.ts "$PROBE_ID" "$SOLIDS_ID" proposed report)
PLAN_REJECT_ID=$(j "$(seedjson "$SEED3")" '.plan.id // .data.plan.id')

SEED4=$(cd "$REPO" && bun scripts/dev-seed-plan.ts "$PROBE_ID" "$SOLIDS_ID" failed report)
PLAN_FAILED_ID=$(j "$(seedjson "$SEED4")" '.plan.id // .data.plan.id')

cat > "$WORK/cross-proj.json" <<'EOF'
{ "name": "P7 Cross Probe", "discipline": "structural", "description": "Throwaway cross-project plan carrier (e2e-p7-planner.sh)" }
EOF
jpost /api/projects "$WORK/cross-proj.json"
CROSS_ID=$(j "$BODY" '.data.project.id')
upload "/api/projects/$CROSS_ID/artifacts" "$FIXTURES/two-solids.step" model "two-solids.step"
CROSS_ART_ID=$(j "$BODY" '.data.artifact.id')
CROSS_SEED=$(cd "$REPO" && bun scripts/dev-seed-plan.ts "$CROSS_ID" "$CROSS_ART_ID" failed report)
CROSS_PLAN_ID=$(j "$(seedjson "$CROSS_SEED")" '.plan.id // .data.plan.id')
assert_eq "fixture: cross-project FAILED plan seeded (the AC-P4 carrier)" "true" "$([[ -n "$CROSS_PLAN_ID" ]] && echo true)"

# ===========================================================================
# AC-P1 — non-member isolation (Kwame: no grant on the probe project)
# ===========================================================================
AUTH_ARGS="-b $KWAME_JAR"
cat > "$WORK/intent-ok.json" <<'EOF'
{ "intent": "Run the Model QA pipeline on two-solids and build a reviewable report" }
EOF
jpost "/api/projects/$PROBE_ID/plans" "$WORK/intent-ok.json"
assert_eq "AC-P1: non-member POST /plans → 404 Project not found (hidden ≡ missing)" \
  "404|not_found|Project not found" "$STATUS|$(j "$BODY" '.error.code')|$(j "$BODY" '.error.message')"
http GET "/api/projects/$PROBE_ID/plans"
assert_eq "AC-P1: non-member GET /plans → 404 Project not found" \
  "404|not_found|Project not found" "$STATUS|$(j "$BODY" '.error.code')|$(j "$BODY" '.error.message')"
http GET "/api/plans/$PLAN_ACCEPT_ID"
assert_eq "AC-P1: non-member GET /api/plans/<id> → 404 Plan not found (Slice-10 entity layering)" \
  "404|not_found|Plan not found" "$STATUS|$(j "$BODY" '.error.code')|$(j "$BODY" '.error.message')"

# ===========================================================================
# AC-P2 — project-viewer gates (Zara: viewer grant on the probe project)
# ===========================================================================
AUTH_ARGS="-b $ZARA_JAR"
jpost "/api/projects/$PROBE_ID/plans" "$WORK/intent-ok.json"
# Zara is a GLOBAL viewer AND a project viewer: the wrapper's uniform
# GLOBAL-viewer mutation 403 fires first BY DESIGN (the pinned p6 layering —
# identical for hidden/missing targets, no leak). The message is therefore
# ERR_VIEWER_READ_ONLY, not the project-role one.
assert_eq "AC-P2: viewer POST /plans → the wrapper's uniform global-viewer 403 (pinned layering, verbatim)" \
  "403|forbidden|viewer role is read-only" "$STATUS|$(j "$BODY" '.error.code')|$(j "$BODY" '.error.message')"
http GET "/api/projects/$PROBE_ID/plans"
assert_eq "AC-P2: project-viewer GET /plans stays 200 (member read)" "200" "$STATUS"

# ===========================================================================
# AC-P3 — boundary 422s + decision envelopes (operator session)
# ===========================================================================
AUTH_ARGS="${EOS_AUTH:-}"
printf '{ "intent": "too short" }' > "$WORK/intent-short.json"
jpost "/api/projects/$PROBE_ID/plans" "$WORK/intent-short.json"
assert_eq "AC-P3: too-short intent → 422 verbatim" \
  "422|intent: intent must be between 10 and 2000 characters" "$STATUS|$(j "$BODY" '.error.message')"

jq -n '{ intent: ("x" * 2001) }' > "$WORK/intent-long.json"
jpost "/api/projects/$PROBE_ID/plans" "$WORK/intent-long.json"
assert_eq "AC-P3: too-long intent → 422 verbatim" \
  "422|intent: intent must be between 10 and 2000 characters" "$STATUS|$(j "$BODY" '.error.message')"

printf '{ "action": "maybe" }' > "$WORK/dec-bad.json"
jpost "/api/plans/$PLAN_ACCEPT_ID/decision" "$WORK/dec-bad.json"
assert_eq "AC-P3: bad decision action → 422 verbatim" \
  "422|action: action must be accept or reject" "$STATUS|$(j "$BODY" '.error.message')"

printf '{ "action": "accept" }' > "$WORK/dec-accept.json"
jpost "/api/plans/$PLAN_FAILED_ID/decision" "$WORK/dec-accept.json"
assert_eq "AC-P3: decision on a FAILED row → 409 with its status (terminal per row, §2.1)" \
  "409|this plan is already failed" "$STATUS|$(j "$BODY" '.error.message')"

# ===========================================================================
# AC-P4 — cross-project revisesPlanId refusal
# ===========================================================================
jq -n --arg id "$CROSS_PLAN_ID" '{ intent: "Run the Model QA pipeline on two-solids and build a reviewable report", revisesPlanId: $id }' > "$WORK/intent-cross.json"
jpost "/api/projects/$PROBE_ID/plans" "$WORK/intent-cross.json"
assert_eq "AC-P4: revisesPlanId pointing at ANOTHER project's plan → 422 verbatim" \
  "422|cannot revise a plan from another project" "$STATUS|$(j "$BODY" '.error.message')"

# ===========================================================================
# AC-P5 — the accept path: proposal → HUMAN accept → draft → real run path
# ===========================================================================
jpost "/api/plans/$PLAN_ACCEPT_ID/decision" "$WORK/dec-accept.json"
P5_WF_ID=$(j "$BODY" '.data.workflow.id')
assert_eq "AC-P5: accept → 200 {plan accepted, workflow draft, agent:planner-v1 creator, (AI plan) name}" \
  "200|accepted|draft|agent:planner-v1|true" \
  "$STATUS|$(j "$BODY" '.data.plan.status')|$(j "$BODY" '.data.workflow.state')|$(j "$BODY" '.data.workflow.createdBy')|$(j "$BODY" '(.data.workflow.name | endswith(" (AI plan)"))')"
if [[ -z "$P5_WF_ID" ]]; then echo "FATAL: accept created no workflow"; exit 1; fi

# event + audit parity with POST /workflows (agent actor); at this instant the
# draft carries EXACTLY ONE workflow event (created on accept, none since).
http GET "/api/workflows/$P5_WF_ID"
assert_eq "AC-P5: the draft's workflow event log opens with workflow.created by the AGENT actor trio (parity with the manual route)" \
  "true" "$(j "$BODY" '[.data.events[] | select(.kind == "workflow.created" and .actorType == "agent" and .actorId == "agent:planner-v1")] | length > 0')"

http GET "/api/events?projectId=$PROBE_ID&limit=200"
assert_eq "AC-P5: plan.accepted audit row carries {workflowId, createdBy: agent:planner-v1}" \
  "true" "$(j "$BODY" "[.data.events[] | select(.action == \"plan.accepted\" and .detail != null) | .detail | fromjson | select(.workflowId == \"$P5_WF_ID\" and .createdBy == \"agent:planner-v1\")] | length > 0")"
assert_eq "AC-P5: workflow.created audit row (agent actor — the manual-route parity)" \
  "true" "$(j "$BODY" "[.data.events[] | select(.action == \"workflow.created\" and .actorType == \"agent\" and .actorId == \"agent:planner-v1\")] | length > 0")"

# the real human path: mark-ready → queue → poll awaiting_approval → approve → poll succeeded
printf '{ "action": "mark-ready" }' > "$WORK/t-ready.json"
jpost "/api/workflows/$P5_WF_ID/transition" "$WORK/t-ready.json"
assert_eq "AC-P5: human mark-ready on the plan-created draft → 200 (no shortcut — same route as manual flows)" "200" "$STATUS"
printf '{ "action": "queue" }' > "$WORK/t-queue.json"
jpost "/api/workflows/$P5_WF_ID/transition" "$WORK/t-queue.json"
assert_eq "AC-P5: human queue → 200" "200" "$STATUS"
if poll_state "$P5_WF_ID" "awaiting_approval" 40 3; then
  ok "AC-P5: run reached awaiting_approval (the report step's approval gate — ADR-0006, human-only)"
else
  bad "AC-P5: run reached awaiting_approval" "$(j "$POLL_BODY" '.data.workflow.state')" "awaiting_approval"
fi
printf '{ "action": "approve", "note": "human review — the planner proposed, a human published" }' > "$WORK/t-approve.json"
jpost "/api/workflows/$P5_WF_ID/transition" "$WORK/t-approve.json"
assert_eq "AC-P5: HUMAN approve at the gate → 200 (an agent can never approve — no path exists)" "200" "$STATUS"
if poll_state "$P5_WF_ID" "succeeded" 40 3; then
  ok "AC-P5: workflow SUCCEEDED (deterministic single build_report step — no engine subprocess)"
else
  bad "AC-P5: workflow SUCCEEDED" "$(j "$POLL_BODY" '.data.workflow.state')" "succeeded"
fi

# double decision on the accepted row → 409
jpost "/api/plans/$PLAN_ACCEPT_ID/decision" "$WORK/dec-accept.json"
assert_eq "AC-P3: second decision on the accepted row → 409 verbatim" \
  "409|this plan is already accepted" "$STATUS|$(j "$BODY" '.error.message')"

# ===========================================================================
# AC-P6 — accept-after-artifact-deletion → 422; the plan STAYS proposed
# ===========================================================================
# documented seam: no artifact-DELETE route exists in the product (honest gap),
# so the defense-in-depth path is exercised by removing the wired artifact row
# directly through Prisma (the same SQLite file the dev server runs on).
(cd "$REPO" && ART_ID="$SOLIDS_ID" bun --eval 'const {db} = await import("./src/lib/db"); await db.artifact.delete({where: {id: process.env.ART_ID}}); console.log("artifact row removed: " + process.env.ART_ID)')
jpost "/api/plans/$PLAN_DELETE_ID/decision" "$WORK/dec-accept.json"
assert_eq "AC-P6: accept after the wired artifact was deleted → 422 verbatim existence message" \
  "422|plan references unknown artifact \"$SOLIDS_ID\"" "$STATUS|$(j "$BODY" '.error.message')"
http GET "/api/plans/$PLAN_DELETE_ID"
assert_eq "AC-P6: the plan STAYS proposed (the human may regenerate from the evidence)" \
  "200|proposed" "$STATUS|$(j "$BODY" '.data.plan.status')"

# re-seed the artifact so the Part B catalog stays coherent
upload "/api/projects/$PROBE_ID/artifacts" "$FIXTURES/two-solids.step" model "two-solids.step"
SOLIDS2_ID=$(j "$BODY" '.data.artifact.id')

# ===========================================================================
# AC-P7 — reject path + second-decision 409
# ===========================================================================
printf '{ "action": "reject" }' > "$WORK/dec-reject.json"
jpost "/api/plans/$PLAN_REJECT_ID/decision" "$WORK/dec-reject.json"
assert_eq "AC-P7: reject → 200 {plan rejected, no workflow}" \
  "200|rejected|null" "$STATUS|$(j "$BODY" '.data.plan.status')|$(j "$BODY" '.data.plan.workflowId')"
jpost "/api/plans/$PLAN_REJECT_ID/decision" "$WORK/dec-reject.json"
assert_eq "AC-P7: second decision on the rejected row → 409 verbatim" \
  "409|this plan is already rejected" "$STATUS|$(j "$BODY" '.error.message')"

http GET "/api/events?projectId=$PROBE_ID&limit=200"
assert_eq "AC-P5/AC-P7: plan.rejected audit row exists" \
  "true" "$(j "$BODY" '[.data.events[] | select(.action == "plan.rejected")] | length > 0')"

# ===========================================================================
# AC-P8 — the plans ledger stays honest (all seeded + decided rows present)
# ===========================================================================
http GET "/api/projects/$PROBE_ID/plans"
assert_eq "AC-P8: the probe ledger lists every seeded/decided row (4 rows)" \
  "200|4" "$STATUS|$(j "$BODY" '.data.plans | length')"
assert_eq "AC-P8: statuses agree with the decisions just made (1 accepted, 1 rejected, 1 failed, 1 proposed)" \
  "1|1|1|1" \
  "$(j "$BODY" '[.data.plans[] | select(.status == "accepted")] | length')|$(j "$BODY" '[.data.plans[] | select(.status == "rejected")] | length')|$(j "$BODY" '[.data.plans[] | select(.status == "failed")] | length')|$(j "$BODY" '[.data.plans[] | select(.status == "proposed")] | length')"

# ===========================================================================
# Part B — LIVE LLM round trip (honest skip when no LLM exists)
# ===========================================================================
LLM_AVAILABLE=0
if (cd "$REPO" && bun --eval 'const m = await import("./src/lib/llm"); process.exit((await m.probePlannerLlm()) ? 0 : 3)'); then
  LLM_AVAILABLE=1
  ok "Part B: probePlannerLlm() → true (the LIVE planner wire answered)"
else
  ok "Part B: SKIP (llm unavailable) — probePlannerLlm() could not reach the LLM; the engine-harness skip precedent (contract §7.2)"
fi

if [[ "$LLM_AVAILABLE" == "1" ]]; then
  upload "/api/projects/$PROBE_ID/artifacts" "$FIXTURES/two-solids.step" model "two-solids-live.step"
  LIVE_ART_ID=$(j "$BODY" '.data.artifact.id')

  jq -n '{ intent: "Plan the Model QA pipeline on the two-solids-live.step artifact: derive quantities and a mesh, then build a human-gated report" }' > "$WORK/intent-live.json"
  jpost "/api/projects/$PROBE_ID/plans" "$WORK/intent-live.json"
  LIVE1_ID=$(j "$BODY" '.data.plan.id')
  LIVE1_STATUS=$(j "$BODY" '.data.plan.status')
  LIVE1_RAWLEN=$(j "$BODY" '(.data.plan.evidence.rawResponse // "") | length')
  LIVE1_STAGE=$(j "$BODY" '.data.plan.failure.stage // "none"')
  assert_eq "AC-P9: LIVE POST → 201 with a persisted row (proposed or failed — both honest outcomes)" \
    "201|true" "$STATUS|$([[ -n "$LIVE1_ID" ]] && echo true)"
  assert_eq "AC-P9: status is proposed-or-failed; evidence.rawResponse is the VERBATIM LLM text when one was produced (wire-stage failures honestly carry none)" \
    "true|true" \
    "$([[ "$LIVE1_STATUS" == "proposed" || "$LIVE1_STATUS" == "failed" ]] && echo true)|$([[ "$LIVE1_RAWLEN" -gt 0 || "$LIVE1_STAGE" == "llm" ]] && echo true)"

  if [[ "$LIVE1_STATUS" == "proposed" ]]; then
    assert_eq "AC-P9: LIVE proposed plan has a non-empty rationale + stepSummary" \
      "true|true" \
      "$([[ -n "$(j "$BODY" '.data.plan.rationale')" && "$(j "$BODY" '.data.plan.rationale')" != "null" ]] && echo true)|$([[ "$(j "$BODY" '.data.plan.stepSummary | length')" -gt 0 ]] && echo true)"
    LIVE_IDS=$(j "$BODY" '[.data.plan.definition.steps[].inputs.artifactId // empty, .data.plan.definition.steps[].inputs.artifactIds[]?] | unique | join(",")')
    # membership against the project's LIVE artifact list (the honest catalog —
    # includes run-generated artifacts like AC-P5's report output, which the
    # live LLM legitimately saw and wired)
    http GET "/api/projects/$PROBE_ID/artifacts"
    KNOWN_IDS=$(j "$BODY" '[.data.artifacts[].id] | join(",")')
    ALL_KNOWN=1
    for id in ${LIVE_IDS//,/ }; do
      case ",$KNOWN_IDS," in
        *",$id,"*) ;;
        *) ALL_KNOWN=0 ;;
      esac
    done
    assert_eq "AC-P9: every artifact id the LIVE plan wires is a REAL project artifact (membership vs the live catalog — no invented ids passed the gate)" \
      "true|nonempty" "$([[ "$ALL_KNOWN" == "1" && -n "$LIVE_IDS" ]] && echo true)|$([[ -n "$LIVE_IDS" ]] && echo nonempty)"

    jpost "/api/plans/$LIVE1_ID/decision" "$WORK/dec-accept.json"
    LIVE_WF_ID=$(j "$BODY" '.data.workflow.id')
    assert_eq "AC-P11: LIVE accept → 200 {plan accepted, workflow draft, agent:planner-v1}" \
      "200|accepted|draft|agent:planner-v1" \
      "$STATUS|$(j "$BODY" '.data.plan.status')|$(j "$BODY" '.data.workflow.state')|$(j "$BODY" '.data.workflow.createdBy')"
    # the human cancel path keeps the dev DB lean (the full pipeline belongs to p4)
    printf '{ "action": "cancel" }' > "$WORK/t-cancel.json"
    jpost "/api/workflows/$LIVE_WF_ID/transition" "$WORK/t-cancel.json"
    assert_eq "AC-P11: the live-accepted draft is cancelled via the HUMAN cancel path (cleanup parity)" "200|cancelled" "$STATUS|$(j "$BODY" '.data.workflow.state')"
  else
    ok "AC-P9: LIVE first attempt failed HONESTLY (stage: $LIVE1_STAGE, verbatim error recorded) — the validation chain refused it and the evidence row persisted"
  fi

  http GET "/api/events?projectId=$PROBE_ID&limit=200"
  assert_eq "AC-P8: plan.requested audit row exists for the LIVE request (actorType user)" \
    "true" "$(j "$BODY" '[.data.events[] | select(.action == "plan.requested" and .actorType == "user")] | length > 0')"

  # AC-P10 — regenerate: the revision chain (revisesPlanId) is the auditable link
  jq -n --arg id "$LIVE1_ID" '{ intent: "Revise the plan: same Model QA pipeline on two-solids-live, but give the mesh step a second attempt — the previous proposal did not validate", revisesPlanId: $id }' > "$WORK/intent-revise.json"
  jpost "/api/projects/$PROBE_ID/plans" "$WORK/intent-revise.json"
  assert_eq "AC-P10: regenerate → 201 NEW row with revisesPlanId = the first LIVE row's id" \
    "201|$LIVE1_ID" "$STATUS|$(j "$BODY" '.data.plan.revisesPlanId')"
  if [[ "$(j "$BODY" '.data.plan.status')" == "proposed" ]]; then
    ok "AC-P10: the revision PROPOSED (the prior evidence round-tripped through the planner)"
  else
    ok "AC-P10: the revision failed honestly (persisted with its verbatim evidence — the chain row exists)"
  fi
fi

# ===========================================================================
# Cleanup: remove the fixture projects (KEPT on failure for forensics)
# ===========================================================================
if [[ "$FAIL" -eq 0 ]]; then
  for PID in "$PROBE_ID" "$CROSS_ID"; do
    (cd "$REPO" && bun scripts/dev-db-cleanup.ts --project "$PID" >/dev/null) \
      && printf 'fixture %s removed — dev DB is back to its pre-suite state\n' "$PID" \
      || printf 'WARNING: fixture removal FAILED for %s (dev-db-cleanup exited non-zero)\n' "$PID"
  done
fi

printf '\n== e2e-p7-planner.sh: %d PASS / %d FAIL ==\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
