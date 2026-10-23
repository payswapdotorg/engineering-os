#!/usr/bin/env bash
# scripts/postgres-runtime-drill.sh — the PostgreSQL product-RUNTIME drill
# (Slice 12, closes known-limitation #2's open half; ADR-0003).
#
# The db-portability CI job proves the SCHEMA path (regenerate → validate →
# init SQL → db push in-sync → upgrade-diff no DDL). This script proves the
# other half: the product RUNTIME — dev server sessions, NextAuth, the real
# engines, and ALL SEVEN e2e acceptance suites — running against a REAL
# PostgreSQL deployment, end to end.
#
# Modes (all reproducible locally WITHOUT root, and in CI against a service):
#   scripts/postgres-runtime-drill.sh                  # bootstrap local cluster + init + switch + battery
#   scripts/postgres-runtime-drill.sh --url URL        # use an EXISTING postgres (CI service container)
#   scripts/postgres-runtime-drill.sh --restore-sqlite # regen sqlite client + restore the .env backup + db:push
#   scripts/postgres-runtime-drill.sh --stop-postgres  # stop the local unprivileged cluster
#   scripts/postgres-runtime-drill.sh --status         # local cluster + server provider report
#
# Local bootstrap uses the setup-engine-libs.sh precedent: apt-get download
# the Debian postgres debs (no root needed), dpkg -x into a user-local dir,
# initdb a cluster under $HOME, start on 127.0.0.1:5432 with the socket in
# /tmp. Postgres 17 locally vs postgres:16 in CI is the honest variance —
# the production target is "real PostgreSQL", and the drill proves the
# runtime against a live server of the same major family both places.
#
# Env notes (recorded 2026-10-23, the hard way):
#  - Process-env DATABASE_URL beats bun's .env auto-load, so every bun
#    invocation in this script EXPORTS the drill URL explicitly.
#  - The dev-server launcher (scripts/dev-server.sh) exports .env at exec
#    time, so the SERVER follows the .env DATABASE_URL line this script
#    switches. The preflight gate below refuses to run the battery unless
#    /api/status honestly reports dbProvider "postgresql" — a sqlite-backed
#    server can never produce false drill PASSes.
set -euo pipefail
cd "$(dirname "$0")/.."

PGROOT="${EOS_PG_ROOT:-$HOME/.local/lib/eos-postgres}"
PGDATA="${EOS_PG_DATA:-$HOME/.local/lib/eos-pgdata}"
PGURL_DEFAULT="postgresql://eos:eos@127.0.0.1:5432/eos_dev"
PGURL="${PGURL_DEFAULT}"
SKIP_BOOTSTRAP=0
START_SERVER=0
RUNTIME_ONLY=0

say()  { printf '\n==> %s\n' "$*"; }
die()  { printf 'drill: FATAL — %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- arg parse --
while [ $# -gt 0 ]; do
  case "$1" in
    --url)          PGURL="$2"; SKIP_BOOTSTRAP=1; shift 2 ;;
    --start-server) START_SERVER=1; shift ;;
    --runtime-only) RUNTIME_ONLY=1; shift ;;   # skip init (DB already in sync) — rerun battery only
    --restore-sqlite) RESTORE=1; shift ;;
    --stop-postgres) STOP=1; shift ;;
    --status)        STATUS=1; shift ;;
    *) die "unknown flag: $1" ;;
  esac
done

pgbin() { echo "$PGROOT/usr/lib/postgresql/17/bin"; }
pg_is_up() { "$(pgbin)/pg_isready" -h 127.0.0.1 -p 5432 >/dev/null 2>&1; }

# ------------------------------------------------- local-cluster lifecycle --
if [ "${STOP:-0}" = 1 ]; then
  if pg_is_up; then "$(pgbin)/pg_ctl" -D "$PGDATA" stop -m fast && echo "local cluster stopped";
  else echo "local cluster not running"; fi
  exit 0
fi

if [ "${STATUS:-0}" = 1 ]; then
  echo "local cluster: $(pg_is_up && echo UP || echo down)  ($PGDATA)"
  CODE=$(curl -s -m 10 -o /tmp/drill-status.json -w '%{http_code}' http://localhost:3000/api/status || true)
  if [ "$CODE" = 200 ]; then
    python3 -c 'import json; d=json.load(open("/tmp/drill-status.json"))["data"]; print("server: dbProvider=%s engines=%d/%d counts=%s" % (d["dbProvider"], d["engines"]["installed"], d["engines"]["total"], d["counts"]))'
  else
    echo "server: not reachable (status $CODE)"
  fi
  exit 0
fi

# ------------------------------------------------------- restore to sqlite --
if [ "${RESTORE:-0}" = 1 ]; then
  say "restore the canonical SQLite dev runtime"
  [ -f .env.drill-sqlite-backup ] || die "no .env.drill-sqlite-backup found (was the switch ever run?)"
  mv .env.drill-sqlite-backup .env
  bunx prisma generate
  bunx prisma db push --skip-generate
  echo "restored: .env DATABASE_URL back to the sqlite file URL; sqlite client regenerated; db push in sync."
  echo "NOTE: restart the dev server (scripts/dev-server.sh) so it picks up the restored .env,"
  echo "      then rebuild the canonical demo dataset: bun scripts/dev-db-cleanup.ts --all && bash scripts/e2e-takeoff.sh"
  exit 0
fi

# ----------------------------------------------------------- 1) bootstrap --
if [ "$SKIP_BOOTSTRAP" = 0 ]; then
  if ! pg_is_up; then
    say "bootstrap the unprivileged local PostgreSQL 17 cluster (no root; setup-engine-libs.sh precedent)"
    if [ ! -x "$(pgbin)/initdb" ]; then
      WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
      ( cd "$WORK" && apt-get download postgresql-17 postgresql-client-17 libpq5 >/dev/null \
        || die "apt-get download postgresql-17 failed (offline?)" )
      mkdir -p "$PGROOT"
      for deb in "$WORK"/*.deb; do dpkg -x "$deb" "$PGROOT"; done
      echo "extracted: $(pgbin)/initdb"
    fi
    if [ ! -s "$PGDATA/PG_VERSION" ]; then
      "$(pgbin)/initdb" -D "$PGDATA" -U eos --auth=trust --no-locale -E UTF8 >/dev/null \
        || die "initdb failed"
    fi
    "$(pgbin)/pg_ctl" -D "$PGDATA" -o "-p 5432 -k /tmp -h 127.0.0.1" -l "$PGDATA/postgres.log" start \
      || die "pg_ctl start failed (see $PGDATA/postgres.log)"
    for i in $(seq 1 20); do pg_is_up && break; sleep 1; done
    pg_is_up || die "cluster did not come up"
    "$(pgbin)/psql" -h 127.0.0.1 -p 5432 -U eos -d postgres -c "ALTER ROLE eos PASSWORD 'eos';" \
      -c "CREATE DATABASE eos_dev OWNER eos;" >/dev/null 2>&1 || true
    echo "local cluster UP: $PGURL_DEFAULT"
  else
    echo "local cluster already UP ($PGDATA)"
  fi
else
  echo "using provided postgres: $PGURL"
fi

# --------------------------------------------- 2) production init path only --
if [ "$RUNTIME_ONLY" = 0 ]; then
  say "drift check: regenerate the postgres schema variant from the single source of truth"
  node scripts/gen-postgres-schema.mjs
  git diff --exit-code prisma/schema.postgres.prisma \
    || die "schema.postgres.prisma drifted from schema.prisma — commit the regenerated variant first"

  say "validate the postgres schema + run the production init path (db-portability job sequence)"
  export DATABASE_URL="$PGURL"
  bunx prisma validate --schema prisma/schema.postgres.prisma >/dev/null
  # Idempotence guard (local re-runs; CI always gets a fresh empty service):
  # if the live DB already has the Project table, the init path was proven —
  # the sync checks below still run, and --runtime-only skips this block whole.
  PGHOSTPORT_PARSED=$(printf '%s' "$PGURL" | sed -E 's|^postgres(ql)?://([^@]+)@||; s|/.*$||')
  if "$(pgbin)/psql" -h "${PGHOSTPORT_PARSED%%:*}" -p "${PGHOSTPORT_PARSED##*:}" -U "$(printf '%s' "$PGURL" | sed -E 's|^postgres(ql)?://([^:]+):.*|\2|')" -d "$(printf '%s' "$PGURL" | sed -E 's|.*/([^/?]+)$|\1|')" -tAc "SELECT to_regclass('public.\"Project\"')" 2>/dev/null | grep -q Project; then
    echo "live DB already initialized — skipping the init SQL (fresh deployments run it; see db-portability CI)"
  else
    bunx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.postgres.prisma --script > /tmp/drill-init.sql
    test -s /tmp/drill-init.sql || die "migrate diff from empty produced no SQL"
    grep -q 'CREATE TABLE "Project"' /tmp/drill-init.sql || die "init SQL lacks the Project table"
    echo "init.sql tables: $(grep -c 'CREATE TABLE' /tmp/drill-init.sql)"
    bunx prisma db execute --file /tmp/drill-init.sql --url "$PGURL"
  fi
  bunx prisma db push --skip-generate --schema prisma/schema.postgres.prisma 2>&1 | tail -1
  bunx prisma migrate diff --from-schema-datasource prisma/schema.postgres.prisma \
    --to-schema-datamodel prisma/schema.postgres.prisma --script > /tmp/drill-upgrade.sql
  if grep -E 'CREATE TABLE|ALTER TABLE|DROP TABLE|CREATE *(UNIQUE )*INDEX|DROP *(UNIQUE )*INDEX' /tmp/drill-upgrade.sql; then
    die "unexpected DDL in the live-vs-model upgrade diff"
  fi
  echo "live PostgreSQL matches the model — no DDL in upgrade diff"

  say "switch the product runtime: regenerate the client from the postgres schema + flip .env"
  bunx prisma generate --schema prisma/schema.postgres.prisma >/dev/null \
    || die "prisma generate (postgres variant) failed"
  CURRENT_URL=$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2- || true)
  if [ -n "$CURRENT_URL" ] && [ "${CURRENT_URL#file:}" != "$CURRENT_URL" ]; then
    cp .env .env.drill-sqlite-backup
    echo "backed up the sqlite .env to .env.drill-sqlite-backup"
  fi
  sed -i -E "s|^DATABASE_URL=.*|DATABASE_URL=$PGURL|" .env
  grep -q "^DATABASE_URL=$PGURL" .env || die "failed to switch the .env DATABASE_URL"
  echo ".env DATABASE_URL -> $PGURL"
fi

# ------------------------------------------------------ 3) dev server gate --
say "dev-server preflight: the runtime must HONESTLY be on postgresql"
CODE=$(curl -s -m 10 -o /tmp/drill-status.json -w '%{http_code}' http://localhost:3000/api/status || true)
if [ "$CODE" != 200 ]; then
  if [ "$START_SERVER" = 1 ]; then
    echo "starting the dev server (scripts/dev-server.sh exports .env at exec time)"
    nohup bash scripts/dev-server.sh > dev.log 2>&1 &
    for i in $(seq 1 60); do
      sleep 3
      CODE=$(curl -s -m 10 -o /tmp/drill-status.json -w '%{http_code}' http://localhost:3000/api/status || true)
      [ "$CODE" = 200 ] && break
    done
  fi
fi
[ "$CODE" = 200 ] || die "dev server not reachable (status $CODE) — start it, or pass --start-server"
PROVIDER=$(python3 -c 'import json; print(json.load(open("/tmp/drill-status.json"))["data"]["dbProvider"])')
[ "$PROVIDER" = "postgresql" ] \
  || die "/api/status reports dbProvider '$PROVIDER' — refusing to drill against a non-postgres runtime (restart the server against the switched .env first)"

# ------------------------------------------------------------- 4) battery --
say "the runtime battery: pre-clean + ALL SEVEN e2e suites (CI order + keep-name discipline)"
export DATABASE_URL="$PGURL"   # process env beats bun's .env auto-load for the cleanup tool

run_suite() { # name script preclean-keep-name(1|0)
  local name="$1" script="$2" keep="$3"
  printf '\n==> suite %s\n' "$name"
  if [ "$keep" = 1 ]; then
    bun scripts/dev-db-cleanup.ts --all --keep-name "Harbour View Extension" > /dev/null
  else
    bun scripts/dev-db-cleanup.ts --all > /dev/null
  fi
  bash "scripts/$script" 2>&1 | tee "/tmp/drill-$name.log" | tail -2
  # one line per suite in the machine-greppable summary (CI asserts on these)
  TOTALS="${TOTALS}$(printf '%s=%s' "$name" "$(grep -oE '[0-9]+ PASS / [0-9]+ FAIL' "/tmp/drill-$name.log" | tail -1)")
"
}

TOTALS=""
run_suite takeoff e2e-takeoff.sh 0
run_suite p2 e2e-p2-modelviewer.sh 1
run_suite p3 e2e-p3-hardening.sh 1
run_suite p4 e2e-p4-workflows.sh 1
run_suite p5 e2e-p5-disciplines.sh 1
run_suite p6 e2e-p6-isolation.sh 1
run_suite p7 e2e-p7-planner.sh 1

say "DRILL SUMMARY (runtime on real postgresql, dbProvider gate passed)"
printf '%s' "$TOTALS"
echo "$TOTALS" | grep -E '=[0-9]+ PASS / [1-9][0-9]* FAIL' && die "a suite recorded FAILs"
echo "ALL SUITES GREEN — the product runtime is verified on real PostgreSQL."
echo "(restore the canonical sqlite dev runtime with: scripts/postgres-runtime-drill.sh --restore-sqlite)"
