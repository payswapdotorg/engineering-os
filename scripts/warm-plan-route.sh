#!/usr/bin/env bash
# scripts/warm-plan-route.sh — pre-compile the plan-detail route (the
# run-42/43/44 compile-deadlock class) BEFORE the e2e suites hit it.
#
# WHY (recorded 2026-10-27, run 44's full forensic read): GET /api/plans/[id]
# is the one route whose on-demand Turbopack compile has WEDGED on CI runners
# — three times across three runs (42: sqlite p7, 43: postgres p7, 44: sqlite
# p7): always THIS route, always 0 bytes at the suites' 180s curl ceiling
# (twice per affected runner in run 44 — a wedged compile never serves again
# for the job's remaining life), always with the same product code green in
# 12s on unaffected runners (run 43's sqlite p7 34/0) and 40/0 with the
# live-LLM Part B on the dev host. The two suite FAILs a wedge causes read
# as PRODUCT failures and burn 360s of wall time before anyone can classify
# them.
#
# THE FIX (two layers):
#   1. COMPILE EARLY: an unauthenticated GET /api/plans/<bogus> forces the
#      route's on-demand compile while the Turbopack worker pool is fresh
#      (the wedge only ever struck a LATE first-hit, after six suites of
#      compiles). ANY HTTP answer proves the module built — the 401 arrives
#      before the route's own 404 logic, and only after the compile served.
#   2. FAIL NAMED, FAIL CHEAP: if the probe still hangs, optionally restart
#      the dev server ONCE via the caller's command (a fresh process re-runs
#      the compile — the wedge is a per-process race, not machine hardware:
#      run 42's failed-job re-run attempt 2 was all-green), then fail HERE
#      with the class named on the step label — a 90s named failure instead
#      of 360s of misleading suite FAILs. Re-run the job for a fresh runner.
#
# Usage:
#   scripts/warm-plan-route.sh [BASE] [--restart-cmd '<restart command>']
#     BASE        defaults to http://localhost:3000
#     --restart-cmd  optional: a shell command that restarts the dev server
#                   (must return before the server answers; the script
#                   polls /api/status for up to 180s after running it).
# Exit:
#   0  warm — prints "plan-detail route compiled and answering: HTTP <code>"
#   1  wedged (or the server did not come back after the restart)
set -uo pipefail

BASE="${1:-http://localhost:3000}"
RESTART=""
if [ "${2:-}" = "--restart-cmd" ]; then RESTART="${3:-}"; fi

probe() {
  # -m 90: the ceiling is OURS — a healthy first compile answers in a few
  # seconds even on a cold runner (run 43's unaffected sqlite runner served
  # this route's first hit inside the suite's 12s total).
  curl -s -m 90 -o /dev/null -w '%{http_code}' \
    "$BASE/api/plans/warmup-compile-probe" || echo 000
}

CODE="$(probe)"

if [ "$CODE" = "000" ] && [ -n "$RESTART" ]; then
  echo "warm-plan-route: the probe hung — restarting the dev server once (a fresh process re-runs the compile)"
  eval "$RESTART" || true
  up=""
  for i in $(seq 1 60); do
    sleep 3
    if curl -sf -m 3 "$BASE/api/status" >/dev/null 2>&1; then up=1; break; fi
  done
  if [ -z "$up" ]; then
    echo "ERROR: warm-plan-route: the dev server did not come back after the restart"
    exit 1
  fi
  CODE="$(probe)"
fi

if [ "$CODE" = "000" ]; then
  echo "ERROR: plan-detail route compile DEADLOCKED on this runner (the run-42/43/44 class) — re-run the job for a fresh runner"
  exit 1
fi

echo "plan-detail route compiled and answering: HTTP $CODE (401 without a session — any answer proves the module built)"
