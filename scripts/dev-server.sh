#!/usr/bin/env bash
# scripts/dev-server.sh — dev-server launcher with the .env values exported at
# EXEC time. Rationale (Phase-6, recorded 2026-10-22): with Next 16 dev
# (Turbopack), values in .env reach Prisma (which loads .env itself) but do
# NOT reliably surface in the route-handler runtime `process.env` — the
# engine-detection probes and NextAuth need EOS_PYTHON / NEXTAUTH_* in the
# actual process environment, so this launcher exports them before exec.
# Production (the .deb) already works this way: systemd EnvironmentFile.
set -euo pipefail
cd "$(dirname "$0")/.."

# Export every KEY=VALUE line from .env with the value preserved VERBATIM
# (everything after the FIRST '=' — base64 secrets end in '=' and must not
# be truncated; comments/blank lines skipped; operator-controlled file).
if [[ -f .env ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" != *=* ]] && continue
    k="${line%%=*}"
    [[ "$k" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    export "${k}=${line#*=}"
  done < .env
fi

exec bun run dev
