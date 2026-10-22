#!/usr/bin/env bash
# scripts/e2e-signin.sh — Phase-6 e2e auth helper (contract §1.5). SOURCED by
# every e2e script (never executed directly): bootstraps the demo operator
# through the REAL first-run setup flow when the User table is empty, signs
# in via the REAL NextAuth credentials flow (csrf → callback → cookie jar),
# and exports:
#   EOS_AUTH       "-b <jar> -c <jar>" — append to every curl needing a session
#   EOS_USER_ID    signed-in operator's user id (pinned-actor assertions)
#   EOS_USER_NAME  signed-in operator's display name
#
# Idempotent: re-sourcing re-runs the sign-in with a FRESH jar (setup POSTs
# only while zero users exist). The jar lives in its own mktemp dir; the EXIT
# trap below CHAINS onto any trap the sourcing script already registered.
#
# Demo operator (DEV-ONLY credentials, documented in the release docs):
#   name "Local Operator" · email operator@eos.local · password operator-demo-2026

# --- All-caps exports + _eos-prefixed internals: no collisions with the
# --- sourcing scripts' variables/functions (http, jpost, j, WORK, PASS…).
EOS_SIGNIN_DIR="$(mktemp -d)"
EOS_SIGNIN_JAR="$EOS_SIGNIN_DIR/cookies.txt"

# Chain our cleanup onto the sourcing script's existing EXIT trap (bash
# traps are per-shell: a plain `trap` here would silently DROP the
# script's own `rm -rf "$WORK"`).
_eos_prev_trap="$(trap -p EXIT)"
_eos_prev_body="${_eos_prev_trap#trap -- }"
_eos_prev_body="${_eos_prev_body% EXIT}"
# `trap -p` serializes the command with surrounding single quotes — strip
# that outer pair so the body re-evaluates verbatim at EXIT time (our five
# scripts all use simple single-command traps like rm -rf "$WORK").
_eos_prev_body="${_eos_prev_body#\'}"
_eos_prev_body="${_eos_prev_body%\'}"
if [[ -n "${_eos_prev_body//\'/}" ]]; then
  # shellcheck disable=SC2064 — expanded at definition on purpose: prev body
  # keeps its own quoting; our part expands at EXIT time.
  trap "${_eos_prev_body}; rm -rf \"\$EOS_SIGNIN_DIR\"" EXIT
else
  trap 'rm -rf "$EOS_SIGNIN_DIR"' EXIT
fi
unset _eos_prev_trap _eos_prev_body

_eos_jq() { printf '%s' "$1" | /usr/bin/jq -r "$2"; }

_eos_base="${BASE:-http://localhost:3000}"
_eos_name="Local Operator"
_eos_email="operator@eos.local"
_eos_password="operator-demo-2026"

# 1. First-run check (public route). Any HTTP failure is fatal — the e2e
#    scripts cannot run without a session, and pretending otherwise would
#    turn every assertion into a 401-read.
_eos_code="$(curl -sS -m 30 -o "$EOS_SIGNIN_DIR/setup.json" -w '%{http_code}' \
  "$_eos_base/api/auth/setup")" || _eos_code="000"
if [[ "$_eos_code" != "200" ]]; then
  echo "e2e-signin: FATAL — GET /api/auth/setup returned $_eos_code:" >&2
  cat "$EOS_SIGNIN_DIR/setup.json" >&2 || true
  exit 1
fi
_eos_needed="$(_eos_jq "$(cat "$EOS_SIGNIN_DIR/setup.json")" '.data.needed // empty')"
if [[ "$_eos_needed" == "true" ]]; then
  printf '{"name":"%s","email":"%s","password":"%s"}' \
    "$_eos_name" "$_eos_email" "$_eos_password" > "$EOS_SIGNIN_DIR/setup-post.json"
  _eos_code="$(curl -sS -m 30 -o "$EOS_SIGNIN_DIR/setup-resp.json" -w '%{http_code}' \
    -X POST -H 'Content-Type: application/json' \
    --data-binary @"$EOS_SIGNIN_DIR/setup-post.json" \
    "$_eos_base/api/auth/setup")" || _eos_code="000"
  if [[ "$_eos_code" != "201" ]]; then
    echo "e2e-signin: FATAL — first-run setup POST returned $_eos_code:" >&2
    cat "$EOS_SIGNIN_DIR/setup-resp.json" >&2 || true
    exit 1
  fi
fi

# 2. Real NextAuth credentials sign-in: csrf token first (cookie jar captures
#    the csrf cookie), then the form-encoded credentials callback (json=true
#    keeps the response machine-readable; Set-Cookie lands in the jar).
_eos_code="$(curl -sS -m 30 -o "$EOS_SIGNIN_DIR/csrf.json" -w '%{http_code}' \
  -c "$EOS_SIGNIN_JAR" "$_eos_base/api/auth/csrf")" || _eos_code="000"
if [[ "$_eos_code" != "200" ]]; then
  echo "e2e-signin: FATAL — GET /api/auth/csrf returned $_eos_code" >&2
  exit 1
fi
_eos_csrf="$(_eos_jq "$(cat "$EOS_SIGNIN_DIR/csrf.json")" '.csrfToken')"
if [[ -z "$_eos_csrf" || "$_eos_csrf" == "null" ]]; then
  echo "e2e-signin: FATAL — no csrfToken in the csrf response" >&2
  exit 1
fi

_eos_code="$(curl -sS -m 30 -o "$EOS_SIGNIN_DIR/callback.json" -w '%{http_code}' \
  -b "$EOS_SIGNIN_JAR" -c "$EOS_SIGNIN_JAR" \
  -X POST -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "csrfToken=$_eos_csrf" \
  --data-urlencode "email=$_eos_email" \
  --data-urlencode "password=$_eos_password" \
  --data-urlencode "json=true" \
  "$_eos_base/api/auth/callback/credentials")" || _eos_code="000"
if [[ "$_eos_code" != "200" ]]; then
  echo "e2e-signin: FATAL — credentials callback returned $_eos_code:" >&2
  cat "$EOS_SIGNIN_DIR/callback.json" >&2 || true
  exit 1
fi

# 3. Prove the session works: /api/auth/session must serve the operator with
#    the id + role the JWT/session callbacks carry (W3-g SessionUser shape).
_eos_code="$(curl -sS -m 30 -o "$EOS_SIGNIN_DIR/session.json" -w '%{http_code}' \
  -b "$EOS_SIGNIN_JAR" -c "$EOS_SIGNIN_JAR" "$_eos_base/api/auth/session")" || _eos_code="000"
if [[ "$_eos_code" != "200" ]]; then
  echo "e2e-signin: FATAL — GET /api/auth/session returned $_eos_code:" >&2
  cat "$EOS_SIGNIN_DIR/session.json" >&2 || true
  exit 1
fi
EOS_USER_ID="$(_eos_jq "$(cat "$EOS_SIGNIN_DIR/session.json")" '.user.id // empty')"
EOS_USER_NAME="$(_eos_jq "$(cat "$EOS_SIGNIN_DIR/session.json")" '.user.name // empty')"
EOS_USER_ROLE="$(_eos_jq "$(cat "$EOS_SIGNIN_DIR/session.json")" '.user.role // empty')"
if [[ -z "$EOS_USER_ID" || -z "$EOS_USER_NAME" ]]; then
  echo "e2e-signin: FATAL — session has no user.id/user.name (callback/jwt wiring broken?):" >&2
  cat "$EOS_SIGNIN_DIR/session.json" >&2 || true
  exit 1
fi

# Every subsequent curl in the sourcing script appends $EOS_AUTH (unquoted so
# it word-splits into -b/-c args).
EOS_AUTH="-b $EOS_SIGNIN_JAR -c $EOS_SIGNIN_JAR"

unset _eos_code _eos_base _eos_name _eos_email _eos_password _eos_csrf _eos_needed
unset -f _eos_jq
