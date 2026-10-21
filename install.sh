#!/usr/bin/env bash
# Engineering OS — Phase-1 developer install (Ubuntu 22.04 / 24.04)
#
# This performs the *developer* install documented in
# docs/07-release/installation-ubuntu.md. Distributable packaging
# (.deb/AppImage/service install) is a Phase-6 deliverable.
set -euo pipefail

cd "$(dirname "$0")"

echo "==> Checking prerequisites"
command -v bun >/dev/null 2>&1 || {
  echo "ERROR: Bun is not installed. Install it first:" >&2
  echo "  curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
}
command -v git >/dev/null 2>&1 || { echo "ERROR: git is required" >&2; exit 1; }

echo "==> Installing dependencies (bun)"
bun install --frozen-lockfile

echo "==> Generating Prisma client"
bunx prisma generate

if [ ! -f .env ]; then
  echo "==> Creating .env from .env.example"
  cp .env.example .env
fi

echo "==> Pushing database schema (SQLite dev backend)"
bunx prisma db push

echo
echo "Engineering OS installed (developer mode)."
echo "Start it with:   bun run dev"
echo "Then open:       http://localhost:3000"
