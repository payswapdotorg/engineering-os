#!/usr/bin/env bash
# /opt/engineering-os/bin/orphan-sweep.sh — scheduled storage-orphan sweep.
#
# Phase-6 packaging (contract §2; closes known-limitation #8's remaining half).
# Runs daily via eos-orphan-sweep.timer (systemd Type=oneshot, User=eos) and
# performs the REAL sweep through the local HTTP API — NEVER a blind
# filesystem sweep:
#   1. GET    /api/status                        — skip gracefully if the app is down
#   2. POST   /api/admin/storage/scan           — server-side read-only fresh scan
#   3. DELETE /api/admin/storage/orphans {"confirm":true}
#      The SAFETY MECHANISM is server-side (Phase-4 semantics, see
#      src/app/api/admin/storage/orphans/route.ts): the delete re-runs a FRESH
#      scan inside that request and re-checks every directory against the DB
#      right before removal — a client-listed key is never trusted, and
#      anything that re-appeared or vanished in between is KEPT.
#
# AUTH (honest design note): the admin storage routes require a signed-in
# session (Phase-6 auth lane). There is no API-token system in the product,
# so this script signs in through the REAL NextAuth credentials flow
# (GET /api/auth/csrf → POST /api/auth/callback/credentials, cookie jar)
# using an operator-provided service account from /etc/eos/eos.env:
#
#   EOS_SWEEP_EMAIL / EOS_SWEEP_PASSWORD
#
# The account MUST have the ADMIN role — viewer accounts are read-only and
# engineer accounts cannot call admin routes; "scheduled sweep needs an admin
# service account" is the accepted, documented pattern here (recorded for the
# security model; see docs/07-release/installation-ubuntu.md §Orphan sweep).
# Until the credentials are configured, the sweep logs one honest skip line
# and exits 0 — it never performs any admin call.
set -uo pipefail

BASE="${NEXTAUTH_URL:-http://localhost:3000}"
BASE="${BASE%/}"

log()  { echo "orphan-sweep: $*"; }
fail() { echo "orphan-sweep: $*" >&2; exit 1; }

# --- JSON helper (exact when python3 exists; sed fallback is best-effort,
# used only for the one-line summary — the safety lives server-side anyway).
eos_json_string() { # stdin: JSON text; $1: key -> scalar string value
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json,sys; print(json.load(sys.stdin).get(sys.argv[1], ""))' "$1" 2>/dev/null
  else
    sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -n1
  fi
}
eos_json_count() { # stdin: JSON text; $1: key -> element count of that array
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json,sys; v=json.load(sys.stdin).get(sys.argv[1], []); print(len(v) if isinstance(v, list) else 0)' "$1" 2>/dev/null
  else
    # best-effort (no python3): count quoted elements inside "key":[ ... ]
    # (matched text = key with its 2 quotes + 2 quotes per element -> (n-2)/2;
    #  storage keys are [A-Za-z0-9_-/] so elements never embed quotes)
    grep -o "\"$1\"[[:space:]]*:[[:space:]]*\[[^]]*\]" | grep -o '"' | awk '{n++} END{if (NR==0) print ""; else print int((n-2)/2)}'
  fi
}

# --- 1) is the app up? (skip gracefully — a stopped product is not an error)
if ! curl -sf -m 10 -o /dev/null "$BASE/api/status" 2>/dev/null; then
  log "app not reachable at $BASE/api/status — skipping sweep (exit 0)"
  exit 0
fi

# --- 2) credentials configured? (skip honestly until the operator sets them)
if [ -z "${EOS_SWEEP_EMAIL:-}" ] || [ -z "${EOS_SWEEP_PASSWORD:-}" ]; then
  log "EOS_SWEEP_EMAIL/EOS_SWEEP_PASSWORD not set in /etc/eos/eos.env — skipping sweep (no admin calls made; see docs/07-release/installation-ubuntu.md)"
  exit 0
fi

# --- 3) sign in through the real NextAuth credentials flow (cookie jar)
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

CSRF="$(curl -sf -m 10 -c "$JAR" "$BASE/api/auth/csrf" 2>/dev/null | eos_json_string csrfToken || true)"
if [ -z "$CSRF" ]; then
  log "could not obtain a CSRF token at $BASE/api/auth/csrf — skipping sweep (is the app serving auth routes?)"
  exit 0
fi
if ! curl -sf -m 15 -b "$JAR" -c "$JAR" \
      --data-urlencode "csrfToken=$CSRF" \
      --data-urlencode "email=$EOS_SWEEP_EMAIL" \
      --data-urlencode "password=$EOS_SWEEP_PASSWORD" \
      --data-urlencode "callbackUrl=$BASE/" \
      --data-urlencode "json=true" \
      "$BASE/api/auth/callback/credentials" -o /dev/null 2>/dev/null; then
  log "sign-in failed for the configured sweep account — check EOS_SWEEP_EMAIL/EOS_SWEEP_PASSWORD in /etc/eos/eos.env"
  exit 0
fi
if ! grep -q "next-auth.session-token" "$JAR" 2>/dev/null; then
  log "no session cookie after sign-in — credentials rejected (check the sweep account in /etc/eos/eos.env)"
  exit 0
fi

# --- 4) the real sweep: server-side scan, then confirm-gated cleanup
SCAN="$(curl -sf -m 300 -b "$JAR" -X POST "$BASE/api/admin/storage/scan" 2>/dev/null)" \
  || fail "POST /api/admin/storage/scan failed (HTTP error) — is the sweep account admin-role? run this manually: curl -b <jar> -X POST $BASE/api/admin/storage/scan"
FOUND="$(printf '%s' "$SCAN" | eos_json_count orphans)"
if [ -z "$FOUND" ]; then
  fail "scan response could not be parsed (expected {orphans:[…]}) — aborting before any DELETE call"
fi

CLEANUP="$(curl -sf -m 300 -b "$JAR" -X DELETE \
  -H 'Content-Type: application/json' -d '{"confirm":true}' \
  "$BASE/api/admin/storage/orphans" 2>/dev/null)" \
  || fail "DELETE /api/admin/storage/orphans failed (HTTP error) — nothing assumed; inspect manually with journalctl -u eos-orphan-sweep"
REMOVED="$(printf '%s' "$CLEANUP" | eos_json_count removed)"
KEPT="$(printf '%s' "$CLEANUP" | eos_json_count kept)"
if [ -z "$REMOVED" ] || [ -z "$KEPT" ]; then
  fail "cleanup response could not be parsed (expected {removed:[…], kept:[…]}) — the API call itself may have succeeded; verify via the in-product event feed (storage.orphans-removed)"
fi

# --- 5) exactly one summary line (the timer's journald output)
log "scan found $FOUND orphan(s); cleanup removed ${REMOVED:-?}, kept ${KEPT:-?} (admin-API fresh-scan semantics — never a filesystem sweep)"
