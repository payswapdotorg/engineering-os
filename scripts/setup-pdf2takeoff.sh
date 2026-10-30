#!/usr/bin/env bash
# setup-pdf2takeoff.sh — Stage-1 ADR-0011: pin the pdf2takeoff engine checkout.
#
# Clones ajflow/pdf2takeoff (Apache-2.0, machine-verified during Audit v1) at
# the EXACT pinned commit into a user-local engine dir, installs its
# dependencies, builds dist-node (best effort — the bin shim falls back to
# Node's native type stripping when no build exists), and writes
# .eos-engine-pin so the bridge (src/engines/adapters/pdf2takeoff.ts) can
# verify the pin at every spawn — the ADR-0005 arm's-length contract: the
# engine runs in its own subprocess at a source-verified, license-verified,
# COMMIT-verified upstream state, never vendored into this repository.
#
# Idempotent: a checkout already at the pinned commit with node_modules is
# left untouched. Offline-safe failure: prints the honest remediation and
# exits non-zero (never silently pretends the engine is usable).
set -euo pipefail

PINNED_COMMIT="f5a1c08b1308628755867df3b921e96ac2018969"
PINNED_REPO="https://github.com/ajflow/pdf2takeoff"
DEST="${EOS_PDF2TAKEOFF_DIR:-$HOME/.local/share/eos-engines/pdf2takeoff}"

pin_ok() { [ -f "$DEST/.eos-engine-pin" ] && [ "$(cat "$DEST/.eos-engine-pin")" = "$PINNED_COMMIT" ]; }
node_modules_ok() { [ -d "$DEST/node_modules/pdfjs-dist" ]; }

if pin_ok && node_modules_ok; then
  echo "ok: pdf2takeoff already pinned at $PINNED_COMMIT with dependencies in $DEST"
  exit 0
fi

echo "fetch: $PINNED_REPO @ $PINNED_COMMIT -> $DEST"
mkdir -p "$(dirname "$DEST")"
if [ -d "$DEST/.git" ]; then
  git -C "$DEST" fetch --all --tags >/dev/null 2>&1 || { echo "error: git fetch in $DEST failed (offline?)" >&2; exit 1; }
else
  git clone "$PINNED_REPO" "$DEST" >/dev/null 2>&1 || { echo "error: git clone $PINNED_REPO failed (offline?)" >&2; exit 1; }
fi
git -C "$DEST" checkout --force "$PINNED_COMMIT" >/dev/null 2>&1 || {
  echo "error: could not check out the pinned commit $PINNED_COMMIT" >&2; exit 1; }

echo "install: npm install (engine dependencies)"
( cd "$DEST" && npm install --no-audit --no-fund >/dev/null 2>&1 ) || {
  echo "error: npm install failed in $DEST — the engine cannot run" >&2; exit 1; }

# dist-node build (best effort): the bin shim falls back to
# `node --experimental-strip-types` on the TypeScript sources, so a failed
# build is not fatal — but a successful build is the faster path.
if ! [ -d "$DEST/dist-node/headless" ]; then
  ( cd "$DEST" && npm run build:node >/dev/null 2>&1 ) \
    && echo "note: dist-node built" \
    || echo "note: dist-node build unavailable — the bin shim will run the TypeScript sources via --experimental-strip-types"
fi

printf '%s\n' "$PINNED_COMMIT" > "$DEST/.eos-engine-pin"

# verify the engine actually runs on this host (honest, not assumed)
if ! node "$DEST/bin/pdf2takeoff.js" help >/dev/null 2>&1; then
  echo "error: the pinned pdf2takeoff checkout does not run (node >= 22.13 required)" >&2
  exit 1
fi

echo "engine ready: pdf2takeoff @ $PINNED_COMMIT in $DEST (EOS_PDF2TAKEOFF_DIR can override)"
