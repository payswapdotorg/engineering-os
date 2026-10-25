#!/usr/bin/env bash
# scripts/e2e-recovery-drill.sh — the PROCESS-LEVEL recovery drill (Slice 16-C;
# roadmap-gap-audit §6.4's drillable half + §8's acceptance spec).
#
# The DB-level recovery semantics are already pinned by e2e-p4-workflows.sh
# AC-P4-06 (a synthetic orphaned `running` row → recovery-marked). THIS drill
# proves the same semantics against the REAL thing: the dev-server PROCESS
# killed hard (SIGKILL, the whole bun→next tree) while a durable workflow is
# mid-run, then restarted —
#
#   kill -9 mid-run → restart → the row reads failed (recovery-marked, the
#   pinned verbatim error, system:recovery actor event) with the
#   interrupted-step records intact → the explicit `retry` action resumes from
#   the first unfinished step and completes end-to-end.
#
# The 5-minute orphan cutoff (RECOVERY_CUTOFF_MS in src/core/runtime/executor.ts)
# would make the drill wait 5+ minutes; the drill runs its server instances with
# EOS_RECOVERY_CUTOFF_MS=2000 (the EOS_PYTHON/EOS_TESSERACT env-override
# convention; invalid values fall back to the default, floor 1000ms) so the
# recovery scan marks the killed row deterministically. The canonical server
# restored at the end runs with the DEFAULT cutoff.
#
# Server lifecycle (the postgres-runtime-drill precedent): the drill owns
# port 3000 for its duration — it kills whatever serves :3000 (recording the
# act), runs its own instances via setsid process groups (kill -9 -PGID gets
# the whole tree), and ALWAYS restores the canonical launcher
# (scripts/dev-server.sh > dev.log) before exiting, success or failure.
#
# Requires: ss (socket→pid), pgrep, setsid; the engine venv via .env
# EOS_PYTHON (the workflow steps run REAL cadquery derive_quantities ops).
#
# Final line "N PASS / M FAIL", nonzero exit on any FAIL.
set -euo pipefail
BASE="${BASE:-http://localhost:3000}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURES="$REPO/tests/fixtures"
WORK="$(mktemp -d)"
DRILL_LOG="$REPO/server.log" # gitignored; removed on success, KEPT on failure
CUTOFF_MS=2000
TOOK_OVER=0
RESTORED=0

say()  { printf '\n==> %s\n' "$*"; }
die()  { printf 'recovery-drill: FATAL — %s\n' "$*" >&2; exit 1; }

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
accepted_state() { # queued-or-running marker for racy queue/retry responses
  if [[ "$1" == "queued" || "$1" == "running" ]]; then echo "accepted"; else echo "$1"; fi
}

STATUS=""
BODY=""
http() { # method path [extra curl args…]
  local method="$1" path="$2"
  shift 2
  STATUS=$(curl -sS -m 180 -o "$WORK/http.body" -w '%{http_code}' -X "$method" "$BASE$path" "$@" ${EOS_AUTH:-}) || STATUS="000"
  BODY=$(cat "$WORK/http.body")
}
jpost() { http POST "$1" -H 'Content-Type: application/json' --data-binary @"$2"; }
upload() { # path file kind [name]
  local path="$1" file="$2" kind="$3" name="${4:-}"
  local args=(-F "file=@$file" -F "kind=$kind")
  if [[ -n "$name" ]]; then args+=(-F "name=$name"); fi
  STATUS=$(curl -sS -m 180 -o "$WORK/http.body" -w '%{http_code}' -X POST "${args[@]}" "$BASE$path" ${EOS_AUTH:-}) || STATUS="000"
  BODY=$(cat "$WORK/http.body")
}
j() { printf '%s' "$1" | /usr/bin/jq -r "$2"; }

# --- process management ------------------------------------------------------
# SIGKILL a pid AND every descendant, bottom-up (kill -9 does not propagate).
kill_tree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do kill_tree "$child"; done
  kill -9 "$pid" 2>/dev/null || true
}

# The pid owning the :3000 listen socket (ss 'pid=' field), walked UP to the
# topmost ancestor (the `bun run dev` that scripts/dev-server.sh exec'd).
top_server_pid() {
  local pid ppid
  pid=$(ss -ltnp 2>/dev/null | awk '$4 ~ /:3000$/ {print $NF}' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
  [ -n "$pid" ] || return 1
  while :; do
    ppid=$(awk '/^PPid:/{print $2}' "/proc/$pid/status" 2>/dev/null) || break
    [ -n "$ppid" ] && [ "$ppid" != "0" ] && [ "$ppid" != "1" ] || break
    pid="$ppid"
  done
  echo "$pid"
}

port_busy() { ss -ltn 2>/dev/null | grep -qE ':3000(\s|$)'; }
wait_port_free() { # ~20s for the kernel to release the listen socket
  local i
  for i in $(seq 1 40); do
    port_busy || return 0
    sleep 0.5
  done
  port_busy && return 1
  return 0
}

wait_server() { # [tries] [sleepSecs] — /api/status 200 gate
  local tries="${1:-60}" secs="${2:-3}" i
  for i in $(seq 1 "$tries"); do
    STATUS=$(curl -s -m 5 -o "$WORK/http.body" -w '%{http_code}' "$BASE/api/status" || true)
    [ "$STATUS" = "200" ] && return 0
    sleep "$secs"
  done
  return 1
}

# Start a DRILL server: setsid gives it its own process group, so $! is BOTH
# the pid and the PGID — `kill -9 -$!` takes the whole bun→next tree.
# $1 = extra env assignments (e.g. EOS_RECOVERY_CUTOFF_MS=2000)
start_drill_server() {
  local extra_env="$1"
  # shellcheck disable=SC2086 — word-splitting IS the env-assignment transport
  setsid nohup env $extra_env bash scripts/dev-server.sh > "$DRILL_LOG" 2>&1 &
  DRILL_PGID=$!
}
DRILL_PGID=""

kill_drill_server() { # SIGKILL the drill's own group; fall back to the socket
  if [ -n "$DRILL_PGID" ]; then kill -9 -- "-$DRILL_PGID" 2>/dev/null || true; fi
  DRILL_PGID=""
  sleep 1
  local p
  p=$(top_server_pid 2>/dev/null || true)
  if [ -n "$p" ]; then kill_tree "$p"; fi
  wait_port_free || true
  sleep 1
}

restore_canonical() { # kill whatever owns :3000, start the canonical launcher
  say "restore the canonical dev server (default recovery cutoff, canonical launcher + dev.log)"
  local p
  p=$(top_server_pid 2>/dev/null || true)
  if [ -n "$p" ]; then kill_tree "$p"; wait_port_free || true; sleep 1; fi
  nohup bash scripts/dev-server.sh > dev.log 2>&1 &
  if wait_server 80 3; then
    RESTORED=1
    echo "canonical dev server restored (http://localhost:3000/api/status 200)"
  else
    echo "recovery-drill: WARNING — canonical server did not come back up; restart it manually: nohup bash scripts/dev-server.sh > dev.log 2>&1 &" >&2
    tail -30 dev.log >&2 || true
  fi
}

cleanup() { # EXIT: ALWAYS restore the canonical server once we took over :3000
  local rc=$?
  if [ "$TOOK_OVER" = "1" ] && [ "$RESTORED" = "0" ]; then
    kill_drill_server || true
    restore_canonical || true
  fi
  if [ $rc -eq 0 ]; then
    (cd "$REPO" && bun scripts/dev-db-cleanup.ts --name "Recovery Drill Probe" >/dev/null 2>&1) || true
    rm -f "$DRILL_LOG"
  else
    echo "recovery-drill: probe project 'Recovery Drill Probe' and $DRILL_LOG KEPT for forensics" >&2
  fi
  rm -rf "$WORK"
}

# --- phase 0: preflight — the drill owns :3000 for its duration --------------
say "preflight: take over port 3000 (the canonical server is killed and restored at the end)"
command -v ss >/dev/null 2>&1 || die "ss not found (socket→pid resolution)"
command -v setsid >/dev/null 2>&1 || die "setsid not found (drill process groups)"
command -v pgrep >/dev/null 2>&1 || die "pgrep not found (tree kill)"
[ -f "$FIXTURES/two-solids.step" ] || die "tests/fixtures/two-solids.step missing"

PREV_PID=$(top_server_pid 2>/dev/null || true)
if [ -n "$PREV_PID" ]; then
  echo "existing server on :3000 (top pid $PREV_PID) — killed for the drill (restored at the end)"
  kill_tree "$PREV_PID"
  wait_port_free || die "port 3000 did not free after killing the previous server"
else
  echo "no server on :3000 — the drill starts its own"
fi
TOOK_OVER=1
trap cleanup EXIT

say "start drill server A (EOS_RECOVERY_CUTOFF_MS=$CUTOFF_MS — the drillable cutoff)"
start_drill_server "EOS_RECOVERY_CUTOFF_MS=$CUTOFF_MS"
wait_server 100 3 || { tail -40 "$DRILL_LOG" || true; die "drill server A did not come up"; }
ok "drill server A up (port 3000, EOS_RECOVERY_CUTOFF_MS=$CUTOFF_MS — invalid values fall back to the 5-minute default)"

# --- phase A: a real multi-step workflow, started, then SIGKILLed mid-run ----
say "sign in + probe project + two-solids.step"
source "$(dirname "$0")/e2e-signin.sh"

(cd "$REPO" && bun scripts/dev-db-cleanup.ts --name "Recovery Drill Probe" >/dev/null 2>&1) || true
cat > "$WORK/proj.json" <<'EOF'
{ "name": "Recovery Drill Probe", "discipline": "structural", "description": "process-level recovery drill (Slice 16-C)" }
EOF
jpost "/api/projects" "$WORK/proj.json"
PROBE_ID=$(j "$BODY" '.data.project.id')
assert_eq "probe project created (201)" "201|Recovery Drill Probe" "$STATUS|$(j "$BODY" '.data.project.name')"

upload "/api/projects/$PROBE_ID/artifacts" "$FIXTURES/two-solids.step" model "two-solids.step"
SOLIDS_ID=$(j "$BODY" '.data.artifact.id')
assert_eq "two-solids.step registered (201, kind model)" "201|model" "$STATUS|$(j "$BODY" '.data.artifact.kind')"

# Three REAL cadquery steps — each a fresh python spawn (2-4s), so the run's
# window is comfortably longer than the kill's reaction time. No gate: the
# workflow completes (not awaiting_approval) so the retry can reach `completed`.
jq -n --arg id "$SOLIDS_ID" '{name: "Recovery drill three-step run", definition: {steps: [
  {id: "qty-1", operation: "derive_quantities", inputs: {artifactId: $id}, parameters: {}, retry: {maxAttempts: 2, backoffMs: 200}, requiresApproval: false, skipOnError: false},
  {id: "qty-2", operation: "derive_quantities", inputs: {artifactId: $id}, parameters: {}, retry: {maxAttempts: 2, backoffMs: 200}, requiresApproval: false, skipOnError: false},
  {id: "qty-3", operation: "derive_quantities", inputs: {artifactId: $id}, parameters: {}, retry: {maxAttempts: 2, backoffMs: 200}, requiresApproval: false, skipOnError: false}
]}}' > "$WORK/wf.json"
jpost "/api/projects/$PROBE_ID/workflows" "$WORK/wf.json"
WF_ID=$(j "$BODY" '.data.workflow.id')
assert_eq "three-step derive_quantities workflow created (201, draft)" "201|draft|3" \
  "$STATUS|$(j "$BODY" '.data.workflow.state')|$(j "$BODY" '.data.workflow.definition | fromjson | .steps | length')"

cat > "$WORK/t-ready.json" <<'EOF'
{ "action": "mark-ready" }
EOF
cat > "$WORK/t-queue.json" <<'EOF'
{ "action": "queue" }
EOF
cat > "$WORK/t-retry.json" <<'EOF'
{ "action": "retry" }
EOF
jpost "/api/workflows/$WF_ID/transition" "$WORK/t-ready.json"
assert_eq "mark-ready accepted (200, ready)" "200|ready" "$STATUS|$(j "$BODY" '.data.workflow.state')"

jpost "/api/workflows/$WF_ID/transition" "$WORK/t-queue.json"
assert_eq "queue accepted — the durable run is in motion (queued-or-running)" "accepted" \
  "$(accepted_state "$(j "$BODY" '.data.workflow.state')")"

# Poll until the row claims `running`, then IMMEDIATELY SIGKILL the whole tree.
say "polling for state=running, then SIGKILL the drill server process group (kill -9 -PGID)"
KILLED_WHILE_RUNNING=no
for i in $(seq 1 100); do
  http GET "/api/workflows/$WF_ID"
  case "$(j "$BODY" '.data.workflow.state')" in
    running)  KILLED_WHILE_RUNNING=yes; break ;;
    completed|failed) break ;;
  esac
  sleep 0.2
done
assert_eq "the workflow reached state running before the kill (the drill kills a REAL mid-run, not a synthetic row)" \
  "yes" "$KILLED_WHILE_RUNNING"

kill_drill_server
ok "SIGKILL delivered to the drill server's whole process group (bun→next tree), port freed"

# --- phase B: restart → recovery-marked failed, step records intact ----------
say "restart as drill server B (same $CUTOFF_MS cutoff) — the recovery scan must mark the killed row"
start_drill_server "EOS_RECOVERY_CUTOFF_MS=$CUTOFF_MS"
wait_server 100 3 || { tail -40 "$DRILL_LOG" || true; die "drill server B did not come up"; }

# The list route runs recoverOrphanedRuns() synchronously in its GET handler —
# hitting it right after the restart deterministically triggers the scan (the
# module-load scan is fire-and-forget; this makes the drill order-independent).
http GET "/api/projects/$PROBE_ID/workflows"
sleep 1

http GET "/api/workflows/$WF_ID"
RECOVERY_STATE=$(j "$BODY" '.data.workflow.state')
RECOVERY_ERROR=$(j "$BODY" '.data.workflow.failure | fromjson | .error')
RECOVERY_STEP=$(j "$BODY" '.data.workflow.failure | fromjson | .stepId')
assert_eq "after the SIGKILL + restart, the killed run reads failed with the pinned verbatim recovery error (failure.stepId = executor)" \
  "failed|interrupted: server restarted or executor died (recovery-marked)|executor" \
  "$RECOVERY_STATE|$RECOVERY_ERROR|$RECOVERY_STEP"

RECOVERY_EVENT=$(j "$BODY" '[.data.events[] | select(.kind == "workflow.recovery-marked")] | length')
RECOVERY_ACTOR=$(j "$BODY" '[.data.events[] | select(.kind == "workflow.recovery-marked")][0].actorId')
assert_eq "the recovery is AUDITED: exactly one workflow.recovery-marked event by system:recovery" \
  "1|system:recovery" "$RECOVERY_EVENT|$RECOVERY_ACTOR"

STEP_TOTAL=$(j "$BODY" '.data.steps | length')
STEP_STATES=$(j "$BODY" '[.data.steps[].state] | unique | sort | join(",")')
STEP_STATES_OK=$(j "$BODY" '[.data.steps[].state] | all(. == "succeeded" or . == "running" or . == "pending")')
assert_eq "the interrupted-step records are INTACT: 3 rows survive the kill with honest pre-kill states (no fabricated success)" \
  "3|true" "$STEP_TOTAL|$STEP_STATES_OK"
echo "  step states at recovery: [$STEP_STATES] (succeeded rows keep outputs; running/pending are the interrupted truth)"
SUCCEEDED_OUTPUTS=$(j "$BODY" '[.data.steps[] | select(.state == "succeeded")] | map(.outputSummary != null) | all')
assert_eq "every succeeded step kept its structured outputSummary (never silently deleted)" \
  "true" "${SUCCEEDED_OUTPUTS}"

# --- phase C: the explicit retry resumes and completes end-to-end ------------
say "retry the recovery-marked run — recovery IS the explicit retry action (no auto-resume)"
jpost "/api/workflows/$WF_ID/transition" "$WORK/t-retry.json"
assert_eq "retry accepted (queued-or-running — resumed from the first unfinished step)" "accepted" \
  "$(accepted_state "$(j "$BODY" '.data.workflow.state')")"
http GET "/api/workflows/$WF_ID" # events live on the detail GET (the transition returns only the row)
RETRY_RESUMED_FROM=$(j "$BODY" '[.data.events[] | select(.kind == "workflow.queued")][0].payload | fromjson | .resumedFromStepId // "none"')
echo "  retry resumed from step: $RETRY_RESUMED_FROM"

FINAL_STATE=""
for i in $(seq 1 120); do
  http GET "/api/workflows/$WF_ID"
  FINAL_STATE=$(j "$BODY" '.data.workflow.state')
  [ "$FINAL_STATE" = "succeeded" ] && break
  [ "$FINAL_STATE" = "failed" ] && break
  sleep 2
done
ALL_STEPS_DONE=$(j "$BODY" '[.data.steps[] | .state == "succeeded"] | all')
assert_eq "the retried run SUCCEEDED end-to-end: state succeeded, all three steps succeeded" \
  "succeeded|true" "$FINAL_STATE|$ALL_STEPS_DONE"
FINAL_OUTPUTS=$(j "$BODY" '[.data.steps[] | .outputSummary != null] | all')
assert_eq "every step carries its structured outputSummary after the successful retry" \
  "true" "${FINAL_OUTPUTS}"

# --- phase D: restore the canonical server -----------------------------------
kill_drill_server
restore_canonical
if wait_server 40 3; then ok "canonical dev server restored (default 5-minute recovery cutoff, canonical dev.log)"; else
  bad "canonical dev server restored" "no" "yes"
fi

say "== e2e-recovery-drill.sh: $PASS PASS / $FAIL FAIL =="
if [[ "$FAIL" -ne 0 ]]; then exit 1; fi
