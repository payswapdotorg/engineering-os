#!/usr/bin/env bash
# scripts/build-deb.sh — build the Engineering OS Ubuntu package.
#
# Phase-6 packaging lane (contract docs/00-architecture/phase-6-hardening-contract.md §2).
# Output: dist/engineering-os_<version>_amd64.deb (version from package.json).
#
# Modes:
#   scripts/build-deb.sh                    # full build (CI / release host)
#   scripts/build-deb.sh --structure-only   # sandbox-safe validation, NO .deb
#
# FULL BUILD (default) — requires bun + dpkg-deb and runs the REAL production
# build (`bun run build`, standalone output per package.json) plus a clean
# `prisma db push` seed against a temp DATABASE_URL. Never run casually in
# dev sandboxes; the CI packaging job (ubuntu-latest) is the canonical runner.
#
# --STRUCTURE-ONLY — honest no-artifact mode for environments where the full
# build is not allowed or not possible (this sandbox's standing rule): it
# validates that every referenced input exists (standalone dir only if
# already built), parses every maintscript with `bash -n`, and checks the
# DEBIAN/control field set. It NEVER emits a .deb — the package artifact
# comes only from the real CI job.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

die()  { echo "build-deb: error: $*" >&2; exit 1; }
note() { echo "build-deb: $*"; }

# ---------------------------------------------------------------------------
# Version — package.json is the single source of truth (the snapshot in
# packaging/DEBIAN/control is rewritten from here at build time).
# ---------------------------------------------------------------------------
VERSION="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' package.json | head -n1)"
[ -n "$VERSION" ] || die "cannot read the \"version\" field from package.json"
DEB_NAME="engineering-os_${VERSION}_amd64.deb"

# ---------------------------------------------------------------------------
# Input inventory (shared by both modes — single source of truth)
# ---------------------------------------------------------------------------
MAINT_SCRIPTS="packaging/DEBIAN/postinst packaging/DEBIAN/prerm packaging/DEBIAN/postrm"
BIN_SCRIPTS="packaging/bin/preflight.sh packaging/bin/orphan-sweep.sh"
UNIT_FILES="packaging/systemd/eos.service packaging/systemd/eos-orphan-sweep.service packaging/systemd/eos-orphan-sweep.timer"
REQUIRED_INPUTS="
  packaging/DEBIAN/control
  $MAINT_SCRIPTS
  $BIN_SCRIPTS
  $UNIT_FILES
  packaging/desktop/eos.desktop
  packaging/eos.env.example
  packaging/README.md
  public/logo.svg
  prisma/schema.prisma
  scripts/setup-engine-libs.sh
  src/engines/adapters/step_quantities.py
  src/engines/adapters/ifc_quantities.py
  src/engines/adapters/step_mesh.py
  src/engines/adapters/ifc_mesh.py
  src/engines/adapters/step_femesh.py
  src/engines/adapters/powerflow.py
  src/engines/adapters/des.py
"

validate_structure() {
  note "mode: --structure-only (no .deb will be emitted)"

  local missing=0
  for f in $REQUIRED_INPUTS; do
    if [ -e "$f" ]; then
      note "ok: $f"
    else
      echo "build-deb: MISSING input: $f" >&2
      missing=1
    fi
  done
  [ "$missing" -eq 0 ] || die "referenced packaging inputs are missing (see above)"

  # every runtime python adapter (the bridges resolve *.py from this directory)
  local py_count
  py_count="$(find src/engines/adapters -maxdepth 1 -name '*.py' | wc -l)"
  [ "$py_count" -gt 0 ] || die "no python adapters found in src/engines/adapters/"
  note "ok: src/engines/adapters/*.py ($py_count scripts)"

  # bash -n: this script + all maintscripts + bundled bin scripts (0 findings expected)
  for f in "$0" $MAINT_SCRIPTS $BIN_SCRIPTS; do
    bash -n "$f" || die "bash -n failed on $f (syntax error)"
    note "ok: bash -n $f"
  done

  # DEBIAN/control field-set validation
  local c="packaging/DEBIAN/control"
  local field
  for field in Package Version Section Priority Architecture Depends Maintainer Description; do
    grep -Eq "^${field}:" "$c" || die "DEBIAN/control is missing the required field '${field}'"
  done
  grep -q "^Package: engineering-os$" "$c" || die "DEBIAN/control: Package must be 'engineering-os'"
  grep -q "^Section: science$" "$c" || die "DEBIAN/control: Section must be 'science'"
  grep -q "^Depends: nodejs (>= 18)$" "$c" || die "DEBIAN/control: Depends must declare 'nodejs (>= 18)'"
  grep -Eq "^Architecture: (amd64|all)$" "$c" || die "DEBIAN/control: Architecture must be amd64 or all"
  grep -q "^Version: $VERSION$" "$c" \
    || note "note: control Version snapshot differs from package.json ($VERSION) — rewritten at build time (ok)"
  note "ok: DEBIAN/control field set validated"

  # standalone output — only meaningful if a build already happened
  if [ -f .next/standalone/server.js ]; then
    note "ok: .next/standalone/server.js present (previous build — will be packaged verbatim)"
  else
    note "ok: no standalone build present (expected pre-build) — bun run build runs in the CI job"
  fi

  echo "structure validated (full build runs in CI)"
  note "structure-only mode: no .deb emitted (honest — no artifact without the real build)"
}

build_full() {
  command -v bun >/dev/null 2>&1 || die "bun is required for the full build (CI/release host)"
  command -v dpkg-deb >/dev/null 2>&1 || die "dpkg-deb is required for the full build"

  note "mode: full build → dist/${DEB_NAME}"
  note "version: $VERSION"

  # NOTE: WORK is deliberately NOT `local` — the EXIT trap below expands it
  # after the function returns (global scope at exit); a local would make the
  # trap hit `set -u`'s unbound-variable error. First full-run lesson from CI
  # (2026-10-22): never reference a local from a trap.
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT
  local SEED_DB="$WORK/engineering-os-seed.db"

  # -- 1) clean seed DB: schema-only SQLite from a temp DATABASE_URL -----------
  # (never touches the developer DB; the operator's live DB is likewise never
  #  touched at runtime — postinst copies this seed on FIRST INSTALL only)
  note "seeding clean SQLite schema (temp DATABASE_URL, schema only, no data)"
  bunx prisma generate >/dev/null
  DATABASE_URL="file:$SEED_DB" bun run db:push >/dev/null
  [ -f "$SEED_DB" ] || die "prisma db push did not produce the seed DB at $SEED_DB"

  # -- 2) the REAL production build (standalone per package.json) --------------
  # Build-time env: modules imported during `next build` read these at init
  # (NextAuth config, Prisma client). Build-time values are throwaway — the
  # packaged service reads the REAL values from /etc/eos/eos.env at runtime
  # (EnvironmentFile= in packaging/systemd/eos.service).
  note "running the real production build: bun run build"
  DATABASE_URL="file:$SEED_DB" \
  NEXTAUTH_URL="http://localhost:3000" \
  NEXTAUTH_SECRET="build-time-placeholder-replaced-at-runtime-by-postinst" \
    bun run build

  [ -f .next/standalone/server.js ] || die "bun run build did not produce .next/standalone/server.js"
  [ -d .next/standalone/.next/static ] || die "build output is missing .next/standalone/.next/static (package.json build script copies it)"
  [ -d .next/standalone/public ] || die "build output is missing .next/standalone/public (package.json build script copies it)"
  [ -d node_modules/.prisma/client ] || die "node_modules/.prisma/client is missing — run bunx prisma generate first"
  note "ok: standalone build verified (server.js + .next/static + public)"

  # -- 3) stage the package tree ------------------------------------------------
  local STAGE="$WORK/stage"
  local OPT="$STAGE/opt/engineering-os"
  mkdir -p "$OPT"

  note "staging /opt/engineering-os"
  cp -a .next/standalone/. "$OPT/"
  # Prisma generated client + native query engine: loaded via dynamic paths
  # that Next's output file tracing can miss — copied explicitly (standard
  # standalone-deploy practice; also the reason the package is Architecture:
  # amd64 — see packaging/README.md).
  mkdir -p "$OPT/node_modules/.prisma"
  rm -rf "$OPT/node_modules/.prisma/client"
  cp -a node_modules/.prisma/client "$OPT/node_modules/.prisma/client"
  mkdir -p "$OPT/prisma" "$OPT/src/engines/adapters" "$OPT/scripts" "$OPT/share" "$OPT/bin"
  cp prisma/schema.prisma "$OPT/prisma/"
  # repo-relative adapter layout preserved: the bridges resolve scripts via
  # process.cwd()/src/engines/adapters (unit WorkingDirectory=/opt/engineering-os)
  cp src/engines/adapters/*.py "$OPT/src/engines/adapters/"
  cp scripts/setup-engine-libs.sh "$OPT/scripts/"
  install -m 0755 packaging/bin/preflight.sh   "$OPT/bin/preflight.sh"
  install -m 0755 packaging/bin/orphan-sweep.sh "$OPT/bin/orphan-sweep.sh"
  cp packaging/eos.env.example "$OPT/eos.env.example"
  cp "$SEED_DB" "$OPT/share/engineering-os-seed.db"
  chmod 0755 "$OPT/server.js"

  note "staging DEBIAN/ control members (Version rewritten to $VERSION)"
  mkdir -p "$STAGE/DEBIAN"
  for f in control postinst prerm postrm; do
    cp "packaging/DEBIAN/$f" "$STAGE/DEBIAN/$f"
  done
  sed -i "s/^Version:.*/Version: $VERSION/" "$STAGE/DEBIAN/control"
  chmod 0755 "$STAGE/DEBIAN/postinst" "$STAGE/DEBIAN/prerm" "$STAGE/DEBIAN/postrm"

  note "staging systemd units + desktop entry + icon"
  mkdir -p "$STAGE/lib/systemd/system"
  cp $UNIT_FILES "$STAGE/lib/systemd/system/"
  mkdir -p "$STAGE/usr/share/applications" "$STAGE/usr/share/icons/hicolor/scalable/apps"
  cp packaging/desktop/eos.desktop "$STAGE/usr/share/applications/eos.desktop"
  cp public/logo.svg "$STAGE/usr/share/icons/hicolor/scalable/apps/eos.svg"

  # -- 4) dpkg-deb --build -------------------------------------------------------
  mkdir -p dist
  local OUT="dist/$DEB_NAME"
  rm -f "$OUT"
  note "building $OUT"
  # --root-owner-group: CI builds run as a non-root user; the package must
  # still record root:root ownership (dpkg-deb >= 1.19.3 — CI/sandbox have 1.22.x).
  dpkg-deb --root-owner-group --build "$STAGE" "$OUT"

  # -- 5) structural self-checks on the artifact ---------------------------------
  dpkg-deb --info "$OUT" | head -n 14
  note "artifact: $OUT ($(du -h "$OUT" | cut -f1))"
  dpkg-deb --info "$OUT" >/dev/null
  dpkg-deb --contents "$OUT" >/dev/null
  note "ok: dpkg-deb --info / --contents both parse"
  note "live install/removal verification runs in the CI packaging job (sudo dpkg -i / dpkg -r)"
}

case "${1:-}" in
  --structure-only)
    validate_structure
    ;;
  "")
    build_full
    ;;
  *)
    die "unknown argument '$1' (expected: --structure-only or no arguments)"
    ;;
esac
