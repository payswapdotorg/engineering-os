#!/usr/bin/env bash
# scripts/e2e-p6-isolation.sh — Slice-10 project-level read isolation acceptance
# script (AC-I1…I10 + Slice-13 AC-I3b + Slice-14 AC-SU-01…03 / AC-RP-01…02,
# docs/00-architecture/project-isolation-contract.md §7).
# The SIXTH e2e suite: sources scripts/e2e-signin.sh (operator/admin session)
# like the five before it, then additionally signs in the two demo personas
# (Kwame engineer, Zara viewer) through the SAME real NextAuth credentials
# flow via a local second/third-jar helper (_iso_signin; password demo1234 —
# src/lib/demo-accounts.ts).
#
# Against the live dev server it verifies (80 PASS expected):
#   fixture  demo roster provisioned via POST /api/auth/demo-accounts
#           (idempotent: 201 created / 200 already present — never a 4xx);
#           both personas signed in via the real credentials flow; the three
#           fixture projects created through the REAL API (Alpha + Gamma by
#           the operator, Beta by Kwame so its auto-owner row links to him);
#           a real drawing revision on Beta (the download-isolation carrier);
#           a member-created + member-queued workflow on Beta (the simplest
#           passing definition shape from e2e-p4-workflows.sh: ONE pure
#           build_report step — no engine subprocess, deterministic run to
#           succeeded, so the cleanup below can never race a live executor)
#   AC-I1   linked grants via the REAL members API: userId == the demo
#           account id, roster match by email; duplicate linked grant → 409
#           verbatim; pending row (unknown email) → userId null
#   AC-I2   list isolation: Kwame sees EXACTLY {Alpha,Beta,Gamma}, Zara sees
#           EXACTLY {Alpha}, operator sees ⊇ all (admin superuser)
#   AC-I3   read isolation: non-member 404s (never 403) on project /
#           quantities / artifact / revision-download, all with the pinned
#           not_found envelopes; member reads stay 200 with byte round-trip
#   AC-I3b  (Slice 13) the SAME isolation on the sheet-markups seam:
#           non-member GET → the project 404; global-viewer POST → the
#           wrapper's uniform 403 (AC-I8 layering); owner read → 200 + geometry
#   AC-I4   events: Zara's global feed carries ONLY Alpha (+ null-projectId
#           system) events, non-vacuously; ?projectId=Beta → 404 for Zara,
#           200 for Kwame; the hidden Beta events provably exist (Kwame sees
#           them — they are filtered, not absent)
#   AC-I5   project-viewer write: Kwame (global engineer, Gamma viewer) POSTs
#           an artifact → 403 verbatim "your role on this project is
#           read-only"; his Gamma READ stays 200
#   AC-I6   manage gates: Kwame PATCH Gamma → 403 manage-only verbatim; Kwame
#           POST Gamma members → 403 member-management verbatim; operator
#           DELETE Beta's only owner row → 409 last-owner verbatim; operator
#           DELETE Zara's Alpha grant → 200 {removed}, then Zara GET Alpha →
#           404 (revoke works end-to-end)
#   AC-I7   admin storage: Kwame POST scan + DELETE orphans → 403 verbatim
#           "only an admin can manage platform storage"
#   AC-I8   workflows: Zara GETs the Beta workflow → 404 Workflow not
#           found; Zara's POST hits the wrapper's uniform GLOBAL-viewer 403
#           first (documented layering — no leak); Kwame GET → 200. The TRUE
#           non-member write-404 is pinned with a non-member ENGINEER on an
#           Alpha workflow after the operator revokes his grant (TL-ratified)
#   AC-I9   audit: Alpha's feed carries member.added {linked:true, userId}
#           and member.removed {hadAccess:true} (detail is a stored JSON
#           string — parsed with fromjson, contract §5)
#   AC-I10  regression: the operator (superuser) still reaches every fixture
#           route (Gamma project 200 + Gamma events 200)
#   AC-SU-01  (Slice 14) general signup core: POST /api/auth/signup is PUBLIC;
#           201 creates an engineer account; duplicate email → 409 verbatim;
#           short password / bad email → 422; the account signs in through
#           the REAL credentials flow
#   AC-SU-02  (Slice 14) invitation SELF-ACTIVATION — the Slice-10 §9 closure:
#           a pending invitation row (email, no account) links to the new
#           account at signup; the signup response carries the activation;
#           the new user's list is EXACTLY the invited project; non-member
#           routes stay 404-no-leak; the roster row shows the linked userId;
#           the audit trail carries member.activated {via:signup}
#   AC-SU-03  (Slice 14) zero-invitation signup isolation floor: a fresh
#           account with no invitations sees EXACTLY [] and 404s every
#           project route (isolation bounds what a signup can learn)
#   AC-RP-01  (Slice 14) member role PATCH: member-but-not-manager → 403
#           member-management verbatim; non-member engineer → 404 Project
#           (no-leak); global viewer → the wrapper's uniform 403; manager
#           PATCHes a real role change → 200 + audit member.roleChanged;
#           idempotent same-role PATCH → 200 no-op; PROMOTION works; demoting
#           the only linked owner → 409 verbatim; unknown row → 404 Member
#           not found; invalid role → 422
#   AC-RP-02  (Slice 14) the roleChanged audit detail carries {from, to}
#
# Runs LAST of the six scripts (after e2e-p5). Creates and removes its OWN
# fixtures through the REAL API + the established dev-db-cleanup path; the
# three fixture projects are removed on success (KEPT on failure for
# forensics). Final line "N PASS / M FAIL", nonzero exit on any FAIL.
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"

# ISO_JARS accumulates the _iso_signin mktemp dirs (removed by THIS trap; the
# sourced e2e-signin.sh chains only its OWN jar onto whatever trap exists).
ISO_JARS=""
trap 'rm -rf "$WORK" $ISO_JARS' EXIT

# Phase-6 auth (contract §1.5): sign in as the demo operator; ${EOS_AUTH}
# carries the operator cookie jar. Source BEFORE any _iso_signin call.
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
assert_status_in() { # desc expected1 expected2… — asserts $STATUS is one of them
  local desc="$1" s found=0
  shift
  for s in "$@"; do
    if [[ "$STATUS" == "$s" ]]; then found=1; break; fi
  done
  if [[ "$found" == "1" ]]; then ok "$desc"; else bad "$desc" "$STATUS" "one of: $*"; fi
}

STATUS=""
BODY=""
# Per-actor session args: the five earlier suites only ever need the operator,
# so http()/upload() hard-append ${EOS_AUTH}. This suite swaps actors, so the
# helpers append $AUTH_ARGS instead — set to ${EOS_AUTH} right after sourcing
# (operator default) and reassigned to $KWAME_AUTH/$ZARA_AUTH per block.
# Unquoted on purpose: word-splits into -b/-c args (the EOS_AUTH convention).
AUTH_ARGS="${EOS_AUTH:-}"
http() { # method path [extra curl args…]
  local method="$1" path="$2"
  shift 2
  STATUS=$(curl -sS -m 180 -o "$WORK/http.body" -w '%{http_code}' -X "$method" "$BASE$path" "$@" $AUTH_ARGS) || STATUS="000"
  BODY=$(cat "$WORK/http.body")
}
jpost() { http POST "$1" -H 'Content-Type: application/json' --data-binary @"$2"; }
upload() { # path file kind [explicit artifact name]
  local path="$1" file="$2" kind="$3" name="${4:-}"
  local args=(-F "file=@$file" -F "kind=$kind")
  if [[ -n "$name" ]]; then args+=(-F "name=$name"); fi
  STATUS=$(curl -sS -m 180 -o "$WORK/http.body" -w '%{http_code}' -X POST "${args[@]}" "$BASE$path" $AUTH_ARGS) || STATUS="000"
  BODY=$(cat "$WORK/http.body")
}
j() { printf '%s' "$1" | /usr/bin/jq -r "$2"; }
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

# Second/third sign-in helper (contract §7): the exact mechanics of
# scripts/e2e-signin.sh — GET /api/auth/csrf (cookie jar captures the csrf
# cookie), POST form-encoded to /api/auth/callback/credentials with json=true
# (Set-Cookie lands in the jar), then a session proof. Local to this script,
# exports NOTHING: the caller copies the globals per actor.
_iso_signin() { # email password → sets ISO_JAR / ISO_UID / ISO_ROLE (globals)
  local email="$1" password="$2" dir jar code csrf
  dir="$(mktemp -d)"
  jar="$dir/cookies.txt"
  ISO_JARS="$ISO_JARS $dir" # removed by this script's EXIT trap
  code="$(curl -sS -m 30 -o "$dir/csrf.json" -w '%{http_code}' -c "$jar" "$BASE/api/auth/csrf")" || code="000"
  if [[ "$code" != "200" ]]; then
    echo "e2e-p6-isolation: FATAL — _iso_signin($email): GET /api/auth/csrf returned $code" >&2
    exit 1
  fi
  csrf="$(j "$(cat "$dir/csrf.json")" '.csrfToken')"
  if [[ -z "$csrf" || "$csrf" == "null" ]]; then
    echo "e2e-p6-isolation: FATAL — _iso_signin($email): no csrfToken in the csrf response" >&2
    exit 1
  fi
  code="$(curl -sS -m 30 -o "$dir/callback.json" -w '%{http_code}' \
    -b "$jar" -c "$jar" \
    -X POST -H 'Content-Type: application/x-www-form-urlencoded' \
    --data-urlencode "csrfToken=$csrf" \
    --data-urlencode "email=$email" \
    --data-urlencode "password=$password" \
    --data-urlencode "json=true" \
    "$BASE/api/auth/callback/credentials")" || code="000"
  if [[ "$code" != "200" ]]; then
    echo "e2e-p6-isolation: FATAL — _iso_signin($email): credentials callback returned $code:" >&2
    cat "$dir/callback.json" >&2 || true
    exit 1
  fi
  code="$(curl -sS -m 30 -o "$dir/session.json" -w '%{http_code}' \
    -b "$jar" -c "$jar" "$BASE/api/auth/session")" || code="000"
  if [[ "$code" != "200" ]]; then
    echo "e2e-p6-isolation: FATAL — _iso_signin($email): GET /api/auth/session returned $code:" >&2
    cat "$dir/session.json" >&2 || true
    exit 1
  fi
  ISO_JAR="$jar"
  ISO_UID="$(j "$(cat "$dir/session.json")" '.user.id // empty')"
  ISO_ROLE="$(j "$(cat "$dir/session.json")" '.user.role // empty')"
  if [[ -z "$ISO_UID" || -z "$ISO_ROLE" ]]; then
    echo "e2e-p6-isolation: FATAL — _iso_signin($email): session carries no user.id/user.role:" >&2
    cat "$dir/session.json" >&2 || true
    exit 1
  fi
}

# ===========================================================================
# Fixture pre-cleanup: a previous FAILED run may have KEPT its fixtures
# (forensics). dev-db-cleanup.ts is the established removal path (the
# projects API has no DELETE handler).
# ===========================================================================
for NAME in "Iso Alpha Contract" "Iso Beta Works" "Iso Gamma Study"; do
  (cd "$REPO" && bun scripts/dev-db-cleanup.ts --name "$NAME" >/dev/null 2>&1) || true
done
# Slice-14 pre-clean: signup test users from a prior FAILED run. dev-db-cleanup
# NEVER touches users (contract §1.5), so the suite owns its fixture accounts —
# deleting the user cascades their TeamMember rows (onDelete: Cascade). Without
# this, a re-run would hit the 409 duplicate-email refusal with a stale password.
(cd "$REPO" && bun -e 'const {db} = await import("./src/lib/db"); await db.user.deleteMany({where: {email: {in: ["abi.signup@eos.test", "kojo.signup@eos.test"]}}}); await db.$disconnect();' >/dev/null 2>&1) || true

# ===========================================================================
# Fixtures — everything through the REAL API (operator = admin session from
# e2e-signin.sh; then the two demo personas)
# ===========================================================================
http POST /api/auth/demo-accounts
assert_status_in "fixture: demo roster provisioned through the REAL route (idempotent ensure: 201 created / 200 already present — never a 4xx)" 200 201
http GET /api/auth/demo-accounts
KWAME_DEMO_ID=$(j "$BODY" '[.data.accounts[] | select(.email == "kwame.demo@eos.local")][0].id')
ZARA_DEMO_ID=$(j "$BODY" '[.data.accounts[] | select(.email == "zara.demo@eos.local")][0].id')

_iso_signin "kwame.demo@eos.local" "demo1234"
KWAME_JAR="$ISO_JAR"
KWAME_ID="$ISO_UID"
KWAME_ROLE="$ISO_ROLE"
KWAME_AUTH="-b $KWAME_JAR -c $KWAME_JAR"
_iso_signin "zara.demo@eos.local" "demo1234"
ZARA_JAR="$ISO_JAR"
ZARA_ID="$ISO_UID"
ZARA_ROLE="$ISO_ROLE"
ZARA_AUTH="-b $ZARA_JAR -c $ZARA_JAR"
assert_eq "fixture: both personas sign in via the REAL credentials flow — session ids equal the roster ids, roles engineer/viewer pinned" \
  "$KWAME_DEMO_ID|engineer|$ZARA_DEMO_ID|viewer" "$KWAME_ID|$KWAME_ROLE|$ZARA_ID|$ZARA_ROLE"

cat > "$WORK/alpha.json" <<'EOF'
{ "name": "Iso Alpha Contract", "discipline": "civil", "description": "Slice-10 isolation fixture (e2e-p6-isolation.sh): operator-owned; Kwame editor + Zara viewer grants" }
EOF
jpost /api/projects "$WORK/alpha.json"
ALPHA_ID=$(j "$BODY" '.data.project.id')
assert_eq "fixture: Alpha created by the operator (201 — auto-owner row links to the operator)" "201" "$STATUS"

AUTH_ARGS="$KWAME_AUTH"
cat > "$WORK/beta.json" <<'EOF'
{ "name": "Iso Beta Works", "discipline": "structural", "description": "Slice-10 isolation fixture (e2e-p6-isolation.sh): Kwame-created, Kwame auto-owner" }
EOF
jpost /api/projects "$WORK/beta.json"
BETA_ID=$(j "$BODY" '.data.project.id')
assert_eq "fixture: Beta created BY KWAME (201 — the auto-owner row links to Kwame, the engineer)" "201" "$STATUS"

AUTH_ARGS="${EOS_AUTH:-}"
cat > "$WORK/gamma.json" <<'EOF'
{ "name": "Iso Gamma Study", "discipline": "civil", "description": "Slice-10 isolation fixture (e2e-p6-isolation.sh): operator-owned; Kwame viewer grant → project-read-only case" }
EOF
jpost /api/projects "$WORK/gamma.json"
GAMMA_ID=$(j "$BODY" '.data.project.id')
assert_eq "fixture: Gamma created by the operator (201)" "201" "$STATUS"
if [[ -z "$ALPHA_ID" || -z "$BETA_ID" || -z "$GAMMA_ID" ]]; then
  echo "FATAL: fixture project creation failed — see the FAIL above" >&2
  exit 1
fi

cat > "$WORK/iso-beta-plan.svg" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="220" height="90" viewBox="0 0 220 90">
  <title>Iso Beta Works — revision carrier sheet</title>
  <text x="8" y="20" font-family="sans-serif" font-size="12">Iso Beta Works — isolation probe sheet</text>
  <rect x="10" y="32" width="180" height="40" fill="none" stroke="black" stroke-width="2"/>
</svg>
EOF
AUTH_ARGS="$KWAME_AUTH"
upload "/api/projects/$BETA_ID/artifacts" "$WORK/iso-beta-plan.svg" drawing "iso-beta-plan.svg"
BETA_SVG_ID=$(j "$BODY" '.data.artifact.id')
BETA_SVG_REV=$(j "$BODY" '.data.artifact.latestRevision.id')
assert_eq "fixture: Kwame registers a REAL drawing revision on Beta (201, kind drawing, rev 1 — the download-isolation carrier)" \
  "201|drawing|1" "$STATUS|$(j "$BODY" '.data.artifact.kind')|$(j "$BODY" '.data.artifact.latestRevision.revNumber')"

jq -n --arg id "$BETA_SVG_ID" '{name: "Iso Beta isolation report", definition: {steps: [
  {id: "report", operation: "build_report", inputs: {artifactIds: [$id]}, parameters: {title: "Iso Beta isolation report"}, retry: {maxAttempts: 1, backoffMs: 0}, requiresApproval: false, skipOnError: false}
]}}' > "$WORK/wf-beta.json"
jpost "/api/projects/$BETA_ID/workflows" "$WORK/wf-beta.json"
BETA_WF_ID=$(j "$BODY" '.data.workflow.id')
assert_eq "fixture: Kwame creates a workflow on Beta through the REAL API (201, draft — the simplest passing definition shape from e2e-p4: one PURE build_report step, no engine subprocess)" \
  "201|draft" "$STATUS|$(j "$BODY" '.data.workflow.state')"

cat > "$WORK/t-ready.json" <<'EOF'
{ "action": "mark-ready" }
EOF
cat > "$WORK/t-queue.json" <<'EOF'
{ "action": "queue" }
EOF
jpost "/api/workflows/$BETA_WF_ID/transition" "$WORK/t-ready.json"
WF_READY="$STATUS|$(j "$BODY" '.data.workflow.state')"
jpost "/api/workflows/$BETA_WF_ID/transition" "$WORK/t-queue.json"
WF_QUEUED="$STATUS|$(accepted_state "$(j "$BODY" '.data.workflow.state')")"
assert_eq "fixture: Kwame (Beta owner) marks the workflow ready and queues it — member writes pass the isolation gates (200/200; queue lands queued|running)" \
  "200|ready|200|accepted" "$WF_READY|$WF_QUEUED"
if poll_state "$BETA_WF_ID" "succeeded" 15 2; then
  ok "fixture: the member-queued workflow RUNS to succeeded (real executor, pure build_report over the member's drawing — deterministic; cleanup can never race a live run)"
else
  bad "fixture: member-queued workflow reached succeeded" "$POLL_STATE" "succeeded"
fi

# ===========================================================================
# AC-I1 — grants through the REAL members API (operator session)
# ===========================================================================
AUTH_ARGS="${EOS_AUTH:-}"
cat > "$WORK/m-kwame.json" <<'EOF'
{ "name": "Kwame Mensah", "role": "editor", "email": "kwame.demo@eos.local" }
EOF
jpost "/api/projects/$ALPHA_ID/members" "$WORK/m-kwame.json"
assert_status_in "AC-I1: linked grant POST (Kwame → Alpha editor) → 201/200" 201 200

cat > "$WORK/m-kwame-dup.json" <<'EOF'
{ "name": "Kwame Second Row", "role": "viewer", "email": "kwame.demo@eos.local" }
EOF
jpost "/api/projects/$ALPHA_ID/members" "$WORK/m-kwame-dup.json"
assert_eq "AC-I1: duplicate linked grant (same email, DIFFERENT roster name so the name-duplicate 409 does not fire first) → 409 verbatim, naming the ACCOUNT identity" \
  '409|"Kwame Mensah" already has access to this project' \
  "$STATUS|$(j "$BODY" '.error.message')"

cat > "$WORK/m-pending.json" <<'EOF'
{ "name": "Nana Pending", "role": "viewer", "email": "nana.pending@nowhere.example" }
EOF
jpost "/api/projects/$ALPHA_ID/members" "$WORK/m-pending.json"
assert_status_in "AC-I1: pending invitation POST (unknown email) → 201/200 (honest pending semantics — grants nothing)" 201 200

cat > "$WORK/m-zara.json" <<'EOF'
{ "name": "Zara Ahmed", "role": "viewer", "email": "zara.demo@eos.local" }
EOF
jpost "/api/projects/$ALPHA_ID/members" "$WORK/m-zara.json"
assert_status_in "AC-I1: linked grant POST (Zara → Alpha viewer) → 201/200" 201 200

http GET "/api/projects/$ALPHA_ID/members"
ZARA_ROW_ID=$(j "$BODY" "[.data.members[] | select(.email == \"zara.demo@eos.local\")][0].id")
assert_eq "AC-I1: roster fetched by email — Kwame's row userId == the demo account id (real grant) + role editor; Zara's row linked too (id captured for the revoke below)" \
  "$KWAME_ID|editor|$ZARA_ID|viewer" \
  "$(j "$BODY" "[.data.members[] | select(.email == \"kwame.demo@eos.local\")][0] | \"\\(.userId)|\\(.role)\"")|$(j "$BODY" "[.data.members[] | select(.email == \"zara.demo@eos.local\")][0] | \"\\(.userId)|\\(.role)\"")"
assert_eq "AC-I1: the pending row's userId is null on the roster (display/pending row — NO access, by contract §1 rule 2)" \
  "null" "$(j "$BODY" "[.data.members[] | select(.email == \"nana.pending@nowhere.example\")][0].userId")"

# Gamma: Kwame gets a VIEWER grant (the project-read-only fixture)
cat > "$WORK/m-kwame-gamma.json" <<'EOF'
{ "name": "Kwame Mensah", "role": "viewer", "email": "kwame.demo@eos.local" }
EOF
jpost "/api/projects/$GAMMA_ID/members" "$WORK/m-kwame-gamma.json"
assert_status_in "AC-I1: linked grant POST (Kwame → Gamma viewer — the project-read-only case) → 201/200" 201 200

# ===========================================================================
# AC-I2 — list isolation (GET /api/projects is membership-filtered)
# ===========================================================================
AUTH_ARGS="$KWAME_AUTH"
http GET /api/projects
assert_eq "AC-I2: Kwame's list is EXACTLY his membership {Alpha editor, Beta owner, Gamma viewer} — nothing else, no extra rows" \
  "true" "$(j "$BODY" "([.data.projects[].id] | sort) == ([\"$ALPHA_ID\",\"$BETA_ID\",\"$GAMMA_ID\"] | sort)")"
AUTH_ARGS="$ZARA_AUTH"
http GET /api/projects
assert_eq "AC-I2: Zara's list is EXACTLY {Alpha} (single viewer grant — Beta and Gamma are invisible to her)" \
  "true" "$(j "$BODY" "([.data.projects[].id] | sort) == ([\"$ALPHA_ID\"] | sort)")"
AUTH_ARGS="${EOS_AUTH:-}"
http GET /api/projects
assert_eq "AC-I2: the operator (global admin) still sees ⊇ all three fixtures — the superuser rule pinned (the five earlier suites depend on it)" \
  "true" "$(j "$BODY" "([.data.projects[].id]) as \$all | ([\"$ALPHA_ID\",\"$BETA_ID\",\"$GAMMA_ID\"] | inside(\$all))")"

# ===========================================================================
# AC-I3 — read isolation (non-member ⇒ 404, same envelope as missing)
# ===========================================================================
AUTH_ARGS="$ZARA_AUTH"
http GET "/api/projects/$BETA_ID"
assert_eq "AC-I3: Zara GETs a non-member project → 404 not_found verbatim (hidden — never a 403 that confirms it exists)" \
  "404|not_found|Project not found" "$STATUS|$(j "$BODY" '.error.code')|$(j "$BODY" '.error.message')"
http GET "/api/projects/$BETA_ID/quantities"
assert_eq "AC-I3: Zara GETs a non-member project's quantities → the SAME 404 envelope (indistinguishable from a missing project)" \
  "404|not_found|Project not found" "$STATUS|$(j "$BODY" '.error.code')|$(j "$BODY" '.error.message')"
AUTH_ARGS="$KWAME_AUTH"
http GET "/api/projects/$BETA_ID"
assert_eq "AC-I3: Kwame (Beta owner) reads Beta → 200 (member read unaffected)" \
  "200|$BETA_ID" "$STATUS|$(j "$BODY" '.data.project.id')"
AUTH_ARGS="$ZARA_AUTH"
http GET "/api/artifacts/$BETA_SVG_ID"
assert_eq "AC-I3: Zara GETs a non-member artifact → 404 Artifact not found (entity-scoped isolation)" \
  "404|not_found|Artifact not found" "$STATUS|$(j "$BODY" '.error.code')|$(j "$BODY" '.error.message')"
http GET "/api/revisions/$BETA_SVG_REV/download"
assert_eq "AC-I3: Zara GETs a non-member revision download → 404 Revision not found (not one byte leaks)" \
  "404|not_found|Revision not found" "$STATUS|$(j "$BODY" '.error.code')|$(j "$BODY" '.error.message')"
AUTH_ARGS="$KWAME_AUTH"
http GET "/api/revisions/$BETA_SVG_REV/download"
assert_eq "AC-I3: Kwame downloads the SAME revision → 200 with the exact uploaded SVG bytes (member read round-trip)" \
  "200|<?xml" "$STATUS|$(head -c 5 "$WORK/http.body")"

# ===========================================================================
# AC-I3b — Slice 13: the SAME isolation on the sheet-markups seam (the
# provenance-geometry API). Fixture: Kwame (Beta owner) persists one markup
# on Beta's drawing revision through the REAL API, then the two viewers'
# perspectives are pinned. Layering matches AC-I8: Zara is a GLOBAL viewer,
# so her write POST hits the wrapper's uniform 403 first (documented
# layering — identical for hidden/missing, no leak).
# ===========================================================================
AUTH_ARGS="$KWAME_AUTH"
cat > "$WORK/iso-beta-markup.json" <<EOF
{
  "revisionId": "$BETA_SVG_REV",
  "page": 1,
  "kind": "length",
  "points": [ { "x": 10, "y": 10 }, { "x": 90, "y": 10 } ],
  "label": "iso probe span",
  "value": 2.5,
  "unit": "m",
  "createdBy": "kwame-demo"
}
EOF
jpost "/api/projects/$BETA_ID/markups" "$WORK/iso-beta-markup.json"
ISO_MKP_ID=$(j "$BODY" '.data.markup.id')
assert_eq "AC-I3b: Kwame (Beta owner) persists a markup on Beta's revision → 201 (the isolation fixture row)" \
  "201|length|2.5|m" "$STATUS|$(j "$BODY" '.data.markup.kind')|$(j "$BODY" '.data.markup.value')|$(j "$BODY" '.data.markup.unit')"
AUTH_ARGS="$ZARA_AUTH"
http GET "/api/projects/$BETA_ID/markups"
assert_eq "AC-I3b: Zara (non-member) GETs Beta markups → the SAME project 404 envelope (hidden ≡ missing; not one geometry point leaks)" \
  "404|not_found|Project not found" "$STATUS|$(j "$BODY" '.error.code')|$(j "$BODY" '.error.message')"
http POST "/api/projects/$BETA_ID/markups" -H 'Content-Type: application/json' --data-binary @"$WORK/iso-beta-markup.json"
assert_eq "AC-I3b: Zara (global viewer) POSTs a Beta markup → the wrapper's uniform global-viewer 403 (documented layering, AC-I8's rule)" \
  "403|forbidden|viewer role is read-only" "$STATUS|$(j "$BODY" '.error.code')|$(j "$BODY" '.error.message')"
AUTH_ARGS="$KWAME_AUTH"
http GET "/api/projects/$BETA_ID/markups?revisionId=$BETA_SVG_REV"
assert_eq "AC-I3b: Kwame reads Beta markups back → 200 with the row and parsed geometry (member read unaffected)" \
  "200|1|$ISO_MKP_ID|90" \
  "$STATUS|$(j "$BODY" '.data.markups | length')|$(j "$BODY" '.data.markups[0].id')|$(j "$BODY" '.data.markups[0].points[1].x')"

# ===========================================================================
# AC-I4 — events feed isolation (Zara's feed BEFORE her revoke — order matters)
# ===========================================================================
AUTH_ARGS="$ZARA_AUTH"
http GET "/api/events?limit=200"
ZARA_FEED="$BODY"
assert_eq "AC-I4: Zara's global feed — ZERO events outside her membership (every non-null projectId == Alpha) AND non-vacuous (≥1 Alpha event visible)" \
  "0|true" \
  "$(j "$ZARA_FEED" "[.data.events[] | select(.projectId != null and .projectId != \"$ALPHA_ID\")] | length")|$(j "$ZARA_FEED" "[.data.events[] | select(.projectId == \"$ALPHA_ID\")] | length > 0")"
AUTH_ARGS="$KWAME_AUTH"
http GET "/api/events?limit=200"
assert_eq "AC-I4: the SAME feed as Kwame DOES carry Beta events (≥1) — they exist and are filtered away from Zara, not absent (non-vacuous isolation)" \
  "true" "$(j "$BODY" "[.data.events[] | select(.projectId == \"$BETA_ID\")] | length > 0")"
AUTH_ARGS="$ZARA_AUTH"
http GET "/api/events?projectId=$BETA_ID"
assert_eq "AC-I4: Zara filters the feed to a non-member project → 404 Project not found (the projectId filter is isolation-checked too)" \
  "404|not_found|Project not found" "$STATUS|$(j "$BODY" '.error.code')|$(j "$BODY" '.error.message')"
AUTH_ARGS="$KWAME_AUTH"
http GET "/api/events?projectId=$ALPHA_ID"
assert_eq "AC-I4: Kwame filters the feed to Alpha (member) → 200" "200" "$STATUS"

# ===========================================================================
# AC-I5 — project-viewer write refusal (global engineer, project-level viewer)
# ===========================================================================
AUTH_ARGS="$KWAME_AUTH"
cat > "$WORK/iso-gamma-probe.svg" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60" viewBox="0 0 120 60">
  <title>Iso Gamma — refused write probe</title>
  <text x="6" y="16" font-family="sans-serif" font-size="10">must never be stored</text>
</svg>
EOF
upload "/api/projects/$GAMMA_ID/artifacts" "$WORK/iso-gamma-probe.svg" drawing "iso-gamma-probe.svg"
assert_eq "AC-I5: Kwame (Gamma VIEWER) POSTs an artifact → 403 verbatim — the project-level read-only envelope (distinct from the global-viewer 403 the wrapper fires for Zara)" \
  "403|forbidden|your role on this project is read-only" "$STATUS|$(j "$BODY" '.error.code')|$(j "$BODY" '.error.message')"
http GET "/api/projects/$GAMMA_ID"
assert_eq "AC-I5: the same Kwame still READS Gamma → 200 (read need passes, write need refuses)" \
  "200|$GAMMA_ID" "$STATUS|$(j "$BODY" '.data.project.id')"

# ===========================================================================
# AC-I6 — manage gates + last-owner guard + revoke end-to-end
# ===========================================================================
AUTH_ARGS="$KWAME_AUTH"
cat > "$WORK/gamma-rename.json" <<'EOF'
{ "name": "Iso Gamma Study (unauthorized rename attempt)" }
EOF
http PATCH "/api/projects/$GAMMA_ID" -H 'Content-Type: application/json' --data-binary @"$WORK/gamma-rename.json"
assert_eq "AC-I6: Kwame (Gamma viewer) PATCHes the project → 403 manage-only verbatim (tightens the old any-engineer-can-rename gap)" \
  "403|forbidden|only the project owner or an admin can manage this project" "$STATUS|$(j "$BODY" '.error.code')|$(j "$BODY" '.error.message')"
cat > "$WORK/m-gamma.json" <<'EOF'
{ "name": "Tsuru Guest", "role": "viewer" }
EOF
jpost "/api/projects/$GAMMA_ID/members" "$WORK/m-gamma.json"
assert_eq "AC-I6: Kwame (Gamma viewer) POSTs a member → 403 with the EXISTING pinned member-management envelope (isolation read passes; the manage gate fires)" \
  "403|forbidden|only the project owner or an admin can manage team members" "$STATUS|$(j "$BODY" '.error.code')|$(j "$BODY" '.error.message')"

AUTH_ARGS="${EOS_AUTH:-}"
http GET "/api/projects/$BETA_ID/members"
BETA_OWNER_ROW_ID=$(j "$BODY" "[.data.members[] | select(.role == \"owner\" and .userId == \"$KWAME_ID\")][0].id")
http DELETE "/api/projects/$BETA_ID/members/$BETA_OWNER_ROW_ID"
assert_eq "AC-I6: operator DELETEs Beta's only LINKED owner row → 409 last-owner guard verbatim (a project can never be stranded without an owner)" \
  "409|conflict|cannot remove the only owner of the project" "$STATUS|$(j "$BODY" '.error.code')|$(j "$BODY" '.error.message')"
http DELETE "/api/projects/$ALPHA_ID/members/$ZARA_ROW_ID"
assert_eq "AC-I6: operator DELETEs Zara's Alpha grant → 200 {removed} (real revoke through the NEW members API)" \
  "200|$ZARA_ROW_ID" "$STATUS|$(j "$BODY" '.data.removed')"
AUTH_ARGS="$ZARA_AUTH"
http GET "/api/projects/$ALPHA_ID"
assert_eq "AC-I6: after the revoke, Zara GET Alpha → 404 — revoke works end-to-end (her only access is gone; the list filter and the read gate agree)" \
  "404|not_found|Project not found" "$STATUS|$(j "$BODY" '.error.code')|$(j "$BODY" '.error.message')"

# ===========================================================================
# AC-I7 — admin storage gates (cross-project READ + DESTRUCTIVE paths closed)
# ===========================================================================
AUTH_ARGS="$KWAME_AUTH"
http POST /api/admin/storage/scan
assert_eq "AC-I7: Kwame (engineer) POSTs the storage scan → 403 admin-only verbatim (cross-project storage read closed)" \
  "403|forbidden|only an admin can manage platform storage" "$STATUS|$(j "$BODY" '.error.code')|$(j "$BODY" '.error.message')"
http DELETE /api/admin/storage/orphans
assert_eq "AC-I7: Kwame DELETEs orphans → the SAME 403 (the cross-project DESTRUCTIVE gap closed)" \
  "403|forbidden|only an admin can manage platform storage" "$STATUS|$(j "$BODY" '.error.code')|$(j "$BODY" '.error.message')"

# ===========================================================================
# AC-I8 — workflow isolation (entity-scoped: a 409 would leak its existence)
# ===========================================================================
AUTH_ARGS="$ZARA_AUTH"
http GET "/api/workflows/$BETA_WF_ID"
assert_eq "AC-I8: Zara GETs the Beta workflow → 404 Workflow not found (hidden entity, same envelope as a missing one)" \
  "404|not_found|Workflow not found" "$STATUS|$(j "$BODY" '.error.code')|$(j "$BODY" '.error.message')"
jpost "/api/workflows/$BETA_WF_ID/transition" "$WORK/t-queue.json"
# TL-ratified (2026-10-22, first live run): Zara is a GLOBAL viewer, so the
# wrapper's uniform viewer 403 fires BEFORE any handler logic — the documented
# layering (ADR-0007 #5, contract §2 note). The response is identical for every
# viewer POST (hidden, missing or real target) → no existence leak. The true
# non-member write-404 is pinned below with a GLOBAL ENGINEER after revocation.
assert_eq "AC-I8: Zara (GLOBAL viewer) POSTs a transition → the wrapper's uniform 403 fires first (documented layering; identical for hidden/missing targets — no leak)" \
  "403|forbidden|viewer role is read-only" "$STATUS|$(j "$BODY" '.error.code')|$(j "$BODY" '.error.message')"
AUTH_ARGS="$KWAME_AUTH"
http GET "/api/workflows/$BETA_WF_ID"
assert_eq "AC-I8: Kwame (Beta owner) reads the same workflow → 200, terminal state succeeded" \
  "200|$BETA_WF_ID|succeeded" "$STATUS|$(j "$BODY" '.data.workflow.id')|$(j "$BODY" '.data.workflow.state')"

# AC-I8b — the TRUE non-member write-404, proven with a global ENGINEER:
# operator plants an Alpha workflow, revokes Kwame's Alpha grant, and Kwame's
# transition is 404 Workflow not found BEFORE any state logic.
AUTH_ARGS="${EOS_AUTH:-}"
upload "/api/projects/$ALPHA_ID/artifacts" "$WORK/iso-beta-plan.svg" drawing "iso-alpha-plan.svg"
ALPHA_SVG_ID=$(j "$BODY" '.data.artifact.id')
assert_eq "AC-I8: fixture — operator registers a REAL drawing on Alpha (the workflow input carrier)" \
  "201|drawing" "$STATUS|$(j "$BODY" '.data.artifact.kind')"
jq -n --arg id "$ALPHA_SVG_ID" '{name: "Iso Alpha isolation report", definition: {steps: [
  {id: "report", operation: "build_report", inputs: {artifactIds: [$id]}, parameters: {title: "Iso Alpha isolation report"}, retry: {maxAttempts: 1, backoffMs: 0}, requiresApproval: false, skipOnError: false}
]}}' > "$WORK/wf-alpha.json"
jpost "/api/projects/$ALPHA_ID/workflows" "$WORK/wf-alpha.json"
ALPHA_WF_ID=$(j "$BODY" '.data.workflow.id')
assert_eq "AC-I8: fixture — operator creates a workflow on Alpha (201, draft — left unqueued on purpose)" \
  "201|draft" "$STATUS|$(j "$BODY" '.data.workflow.state')"
http GET "/api/projects/$ALPHA_ID/members"
KWAME_ALPHA_ROW=$(j "$BODY" "[.data.members[] | select(.email == \"kwame.demo@eos.local\")][0].id")
http DELETE "/api/projects/$ALPHA_ID/members/$KWAME_ALPHA_ROW"
assert_eq "AC-I8: operator revokes Kwame's Alpha grant (200 {removed:<row id>}) — Kwame becomes a non-member ENGINEER" \
  "200|$KWAME_ALPHA_ROW" "$STATUS|$(j "$BODY" '.data.removed')"
AUTH_ARGS="$KWAME_AUTH"
jpost "/api/workflows/$ALPHA_WF_ID/transition" "$WORK/t-ready.json"
assert_eq "AC-I8: Kwame (non-member ENGINEER) transitions the Alpha workflow → 404 Workflow not found BEFORE any state logic (the real non-member write-404 — hidden ≡ missing)" \
  "404|not_found|Workflow not found" "$STATUS|$(j "$BODY" '.error.code')|$(j "$BODY" '.error.message')"
http GET "/api/projects/$ALPHA_ID"
assert_eq "AC-I8: post-revoke, Kwame's Alpha READ is gone too (404 Project not found — the read gate agrees with the revoke)" \
  "404|not_found|Project not found" "$STATUS|$(j "$BODY" '.error.code')|$(j "$BODY" '.error.message')"

# ===========================================================================
# AC-I9 — audit trail (member.added linked + member.removed hadAccess)
# ===========================================================================
AUTH_ARGS="${EOS_AUTH:-}"
http GET "/api/events?projectId=$ALPHA_ID&limit=200"
assert_eq "AC-I9: Alpha's feed carries member.added with detail {linked:true, userId:Kwame} (detail is a stored JSON string — fromjson, contract §5)" \
  "true" "$(j "$BODY" "[.data.events[] | select(.action == \"member.added\" and .detail != null) | .detail | fromjson | select(.linked == true and .userId == \"$KWAME_ID\")] | length > 0")"
assert_eq "AC-I9: Alpha's feed carries member.removed with detail {hadAccess:true} (the revoked LINKED grant recorded honestly — pending rows would say false)" \
  "true" "$(j "$BODY" "[.data.events[] | select(.action == \"member.removed\" and .detail != null) | .detail | fromjson | select(.hadAccess == true)] | length > 0")"

# ===========================================================================
# AC-I10 — admin regression: the superuser still reaches every fixture route
# ===========================================================================
http GET "/api/projects/$GAMMA_ID"
I10_PROJECT_STATUS="$STATUS"
http GET "/api/events?projectId=$GAMMA_ID&limit=50"
assert_eq "AC-I10: regression — the operator reaches Gamma fully (GET project 200 + GET events?projectId 200; the five earlier suites rely on this bypass)" \
  "200|200" "$I10_PROJECT_STATUS|$STATUS"

# ===========================================================================
# AC-I11 — general signup core (Slice 14: POST /api/auth/signup, PUBLIC)
# ===========================================================================
# The operator plants a PENDING invitation on Alpha first (unknown email —
# the self-activation carrier for AC-I12).
AUTH_ARGS="${EOS_AUTH:-}"
cat > "$WORK/m-abi.json" <<'EOF'
{ "name": "Abi Okafor", "role": "editor", "email": "abi.signup@eos.test" }
EOF
jpost "/api/projects/$ALPHA_ID/members" "$WORK/m-abi.json"
ABI_ROW_ID=$(j "$BODY" '.data.member.id')
assert_status_in "AC-SU-01: pending invitation POST (Abi, unknown email) → 201/200 (display-only row — grants nothing YET)" 201 200

# PUBLIC signup — no session carried (AUTH_ARGS cleared for the call).
AUTH_ARGS=""
cat > "$WORK/signup-abi.json" <<'EOF'
{ "name": "Abi Okafor", "email": "abi.signup@eos.test", "password": "abi-pass-1234" }
EOF
jpost /api/auth/signup "$WORK/signup-abi.json"
ABI_ID=$(j "$BODY" '.data.user.id')
assert_eq "AC-SU-01: public signup → 201, engineer account, AND the pending Alpha invitation ACTIVATES in the same call (the §9 self-activation closure)" \
  "201|engineer|1|$ALPHA_ID|$ABI_ROW_ID|editor" \
  "$STATUS|$(j "$BODY" '.data.user.role')|$(j "$BODY" '.data.activatedInvites | length')|$(j "$BODY" '.data.activatedInvites[0].projectId')|$(j "$BODY" '.data.activatedInvites[0].memberId')|$(j "$BODY" '.data.activatedInvites[0].role')"

jpost /api/auth/signup "$WORK/signup-abi.json"
assert_eq "AC-SU-01: duplicate signup → 409 verbatim (honest state conflict, not a 422)" \
  "409|conflict|an account with this email already exists" "$STATUS|$(j "$BODY" '.error.code')|$(j "$BODY" '.error.message')"

cat > "$WORK/signup-short.json" <<'EOF'
{ "name": "Short Pw", "email": "short.pw@eos.test", "password": "short" }
EOF
jpost /api/auth/signup "$WORK/signup-short.json"
assert_eq "AC-SU-01: short password → 422 verbatim (field-prefixed zod message)" \
  "422|password: password must be at least 8 characters" "$STATUS|$(j "$BODY" '.error.message')"

cat > "$WORK/signup-badmail.json" <<'EOF'
{ "name": "Bad Mail", "email": "not-an-email", "password": "valid-pass-123" }
EOF
jpost /api/auth/signup "$WORK/signup-badmail.json"
assert_eq "AC-SU-01: invalid email → 422 verbatim" \
  "422|email: email must be a valid email address" "$STATUS|$(j "$BODY" '.error.message')"

_iso_signin "abi.signup@eos.test" "abi-pass-1234"
ABI_AUTH="-b $ISO_JAR -c $ISO_JAR"
assert_eq "AC-SU-01: the new account signs in through the REAL credentials flow — session role engineer (the schema-default global role)" \
  "engineer" "$ISO_ROLE"

# ===========================================================================
# AC-I12 — invitation self-activation END-TO-END (the new user's perspective)
# ===========================================================================
AUTH_ARGS="$ABI_AUTH"
http GET /api/projects
assert_eq "AC-SU-02: Abi's project list is EXACTLY {Alpha} (her one activated invitation — the canonical dataset and the other fixtures are invisible)" \
  "true" "$(j "$BODY" "([.data.projects[].id] | sort) == ([\"$ALPHA_ID\"] | sort)")"
http GET "/api/projects/$ALPHA_ID"
assert_eq "AC-SU-02: Abi READS Alpha → 200 (the activated invitation is a real editor grant, not a display row)" \
  "200|$ALPHA_ID" "$STATUS|$(j "$BODY" '.data.project.id')"
http GET "/api/projects/$BETA_ID"
assert_eq "AC-SU-02: Abi GETs Beta (never invited) → 404 Project not found — the no-leak envelope holds for a brand-new account" \
  "404|not_found|Project not found" "$STATUS|$(j "$BODY" '.error.code')|$(j "$BODY" '.error.message')"

AUTH_ARGS="${EOS_AUTH:-}"
http GET "/api/projects/$ALPHA_ID/members"
assert_eq "AC-SU-02: the roster row is now a REAL grant — userId == Abi's account id, role editor (activated at signup, owner never re-added her)" \
  "$ABI_ID|editor" "$(j "$BODY" "[.data.members[] | select(.email == \"abi.signup@eos.test\")][0] | \"\\(.userId)|\\(.role)\"")"
http GET "/api/events?projectId=$ALPHA_ID&limit=200"
assert_eq "AC-SU-02: Alpha's audit feed carries member.activated with detail {via:signup, userId:Abi} (actor = the self-activating user)" \
  "true" "$(j "$BODY" "[.data.events[] | select(.action == \"member.activated\" and .detail != null) | .detail | fromjson | select(.via == \"signup\" and .userId == \"$ABI_ID\")] | length > 0")"

# ===========================================================================
# AC-I13 — zero-invitation signup isolation floor
# ===========================================================================
AUTH_ARGS=""
cat > "$WORK/signup-kojo.json" <<'EOF'
{ "name": "Kojo Danquah", "email": "kojo.signup@eos.test", "password": "kojo-pass-1234" }
EOF
jpost /api/auth/signup "$WORK/signup-kojo.json"
KOJO_ID=$(j "$BODY" '.data.user.id')
assert_eq "AC-SU-03: a signup with ZERO pending invitations → 201, engineer, activatedInvites exactly [] (nothing granted by existing)" \
  "201|engineer|0" "$STATUS|$(j "$BODY" '.data.user.role')|$(j "$BODY" '.data.activatedInvites | length')"

_iso_signin "kojo.signup@eos.test" "kojo-pass-1234"
KOJO_AUTH="-b $ISO_JAR -c $ISO_JAR"
assert_eq "AC-SU-03: Kojo signs in through the REAL credentials flow — engineer" "engineer" "$ISO_ROLE"

AUTH_ARGS="$KOJO_AUTH"
http GET /api/projects
assert_eq "AC-SU-03: Kojo's project list is EXACTLY [] — a fresh account sees nothing (isolation bounds what a signup learns)" \
  "0" "$(j "$BODY" '.data.projects | length')"
http GET "/api/projects/$ALPHA_ID"
assert_eq "AC-SU-03: Kojo GETs Alpha → 404 Project not found (no-leak for an account with zero invitations)" \
  "404|not_found|Project not found" "$STATUS|$(j "$BODY" '.error.code')|$(j "$BODY" '.error.message')"

# ===========================================================================
# AC-I14 — member role PATCH (Slice 14: role change is ONE call, not
# revoke + re-grant). Gate order pinned per the members-route contract.
# ===========================================================================
# (a) member-but-not-manager: Kwame is a Gamma VIEWER (member read passes;
#     the manage gate fires — the ERR_MEMBER_MANAGEMENT envelope).
AUTH_ARGS="$KWAME_AUTH"
http GET "/api/projects/$GAMMA_ID/members"
KWAME_GAMMA_ROW=$(j "$BODY" "[.data.members[] | select(.userId == \"$KWAME_ID\")][0].id")
cat > "$WORK/role-editor.json" <<'EOF'
{ "role": "editor" }
EOF
http PATCH "/api/projects/$GAMMA_ID/members/$KWAME_GAMMA_ROW" -H 'Content-Type: application/json' --data-binary @"$WORK/role-editor.json"
assert_eq "AC-RP-01: Kwame (Gamma viewer — a member, NOT a manager) PATCHes a role → 403 member-management verbatim (isolation read passes; the manage gate fires)" \
  "403|forbidden|only the project owner or an admin can manage team members" "$STATUS|$(j "$BODY" '.error.code')|$(j "$BODY" '.error.message')"

# (b) non-member engineer: Kojo PATCHes an Alpha member → the PROJECT 404.
AUTH_ARGS="$KOJO_AUTH"
http PATCH "/api/projects/$ALPHA_ID/members/$ABI_ROW_ID" -H 'Content-Type: application/json' --data-binary @"$WORK/role-editor.json"
assert_eq "AC-RP-01: Kojo (non-member ENGINEER) PATCHes an Alpha member → 404 Project not found (no-leak — never a 403 that confirms it exists)" \
  "404|not_found|Project not found" "$STATUS|$(j "$BODY" '.error.code')|$(j "$BODY" '.error.message')"

# (c) global viewer: Zara PATCHes → the wrapper's uniform global-viewer 403
#     fires FIRST (documented layering, AC-I8's rule — identical for every
#     viewer POST/PATCH, hidden or not).
AUTH_ARGS="$ZARA_AUTH"
http PATCH "/api/projects/$ALPHA_ID/members/$ABI_ROW_ID" -H 'Content-Type: application/json' --data-binary @"$WORK/role-editor.json"
assert_eq "AC-RP-01: Zara (GLOBAL viewer) PATCHes a member role → the wrapper's uniform 403 (layering, AC-I8's rule)" \
  "403|forbidden|viewer role is read-only" "$STATUS|$(j "$BODY" '.error.code')|$(j "$BODY" '.error.message')"

# (d) manager path: the operator PATCHes Abi's Alpha role editor→viewer.
AUTH_ARGS="${EOS_AUTH:-}"
cat > "$WORK/role-viewer.json" <<'EOF'
{ "role": "viewer" }
EOF
http PATCH "/api/projects/$ALPHA_ID/members/$ABI_ROW_ID" -H 'Content-Type: application/json' --data-binary @"$WORK/role-viewer.json"
assert_eq "AC-RP-01: the operator (admin) PATCHes Abi's role editor→viewer → 200 with the updated member (one call — no revoke + re-grant)" \
  "200|viewer|$ABI_ROW_ID" "$STATUS|$(j "$BODY" '.data.member.role')|$(j "$BODY" '.data.member.id')"

http PATCH "/api/projects/$ALPHA_ID/members/$ABI_ROW_ID" -H 'Content-Type: application/json' --data-binary @"$WORK/role-editor.json"
assert_eq "AC-RP-01: and back viewer→editor → 200 (a second real change; the restore keeps the end state canonical)" \
  "200|editor" "$STATUS|$(j "$BODY" '.data.member.role')"

http PATCH "/api/projects/$ALPHA_ID/members/$ABI_ROW_ID" -H 'Content-Type: application/json' --data-binary @"$WORK/role-editor.json"
assert_eq "AC-RP-01: idempotent same-role PATCH (editor→editor) → 200 no-op (NOT an error — nothing changed)" \
  "200|editor" "$STATUS|$(j "$BODY" '.data.member.role')"

# (e) PROMOTION is a plain role change: Kwame's Gamma row viewer→editor.
http PATCH "/api/projects/$GAMMA_ID/members/$KWAME_GAMMA_ROW" -H 'Content-Type: application/json' --data-binary @"$WORK/role-editor.json"
assert_eq "AC-RP-01: PROMOTION works — the operator PATCHes Kwame's Gamma row viewer→editor → 200 (the last-owner guard only refuses DEMOTION of the last owner)" \
  "200|editor" "$STATUS|$(j "$BODY" '.data.member.role')"

# (f) last-owner demote guard: Beta's only LINKED owner row (Kwame's).
http PATCH "/api/projects/$BETA_ID/members/$BETA_OWNER_ROW_ID" -H 'Content-Type: application/json' --data-binary @"$WORK/role-editor.json"
assert_eq "AC-RP-01: demoting Beta's only LINKED owner → 409 verbatim (a project can never be stranded without an owner)" \
  "409|conflict|cannot demote the only owner of the project" "$STATUS|$(j "$BODY" '.error.code')|$(j "$BODY" '.error.message')"

# (g) unknown memberId → the SAME 404 as a foreign row (learns nothing).
http PATCH "/api/projects/$ALPHA_ID/members/mem_nonexistent_row" -H 'Content-Type: application/json' --data-binary @"$WORK/role-viewer.json"
assert_eq "AC-RP-01: unknown memberId → 404 Member not found (same envelope as a row of another project)" \
  "404|not_found|Member not found" "$STATUS|$(j "$BODY" '.error.code')|$(j "$BODY" '.error.message')"

# (h) invalid role value → 422 (stringEnum refusal).
cat > "$WORK/role-bogus.json" <<'EOF'
{ "role": "prime-minister" }
EOF
http PATCH "/api/projects/$ALPHA_ID/members/$ABI_ROW_ID" -H 'Content-Type: application/json' --data-binary @"$WORK/role-bogus.json"
assert_eq "AC-RP-01: invalid role value → 422 (the TEAM_ROLES vocabulary is closed — stringEnum refusal verbatim)" \
  "422|role: role must be one of: owner, editor, viewer" "$STATUS|$(j "$BODY" '.error.message')"

# ===========================================================================
# AC-I15 — the roleChanged audit detail carries {from, to}
# ===========================================================================
http GET "/api/events?projectId=$ALPHA_ID&limit=200"
assert_eq "AC-RP-02: Alpha's feed carries member.roleChanged with detail {from:editor, to:viewer, name:Abi} (fromjson — the append-only trail records CHANGES only)" \
  "true" "$(j "$BODY" "[.data.events[] | select(.action == \"member.roleChanged\" and .detail != null) | .detail | fromjson | select(.from == \"editor\" and .to == \"viewer\" and .name == \"Abi Okafor\")] | length > 0")"
http GET "/api/events?projectId=$GAMMA_ID&limit=200"
assert_eq "AC-RP-02: Gamma's feed carries the PROMOTION record {from:viewer, to:editor}" \
  "true" "$(j "$BODY" "[.data.events[] | select(.action == \"member.roleChanged\" and .detail != null) | .detail | fromjson | select(.from == \"viewer\" and .to == \"editor\")] | length > 0")"

# ===========================================================================
# Cleanup: remove the three fixture projects + the two Slice-14 signup
# fixture accounts (KEPT on failure for forensics). The user deletion
# cascades any remaining TeamMember rows; the projects go first so their
# event history (incl. the member.activated/roleChanged audit) goes with them.
# ===========================================================================
if [[ "$FAIL" -eq 0 ]]; then
  for PID in "$ALPHA_ID" "$BETA_ID" "$GAMMA_ID"; do
    (cd "$REPO" && bun scripts/dev-db-cleanup.ts --project "$PID" >/dev/null) \
      && printf 'fixture %s removed — dev DB is back to its pre-suite state\n' "$PID" \
      || printf 'WARNING: fixture removal FAILED for %s (dev-db-cleanup exited non-zero)\n' "$PID"
  done
  (cd "$REPO" && bun -e 'const {db} = await import("./src/lib/db"); const r = await db.user.deleteMany({where: {email: {in: ["abi.signup@eos.test", "kojo.signup@eos.test"]}}}); await db.$disconnect(); console.log(`signup fixtures removed: ${r.count}`);' >/dev/null) \
    && printf 'signup fixture accounts removed — dev DB user table is back to operator + demo personas\n' \
    || printf 'WARNING: signup fixture account removal FAILED (non-zero bun -e exit)\n'
fi

printf '\n== e2e-p6-isolation.sh: %d PASS / %d FAIL ==\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
