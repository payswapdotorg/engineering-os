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

# Export every KEY=VALUE line from .env, stripping ONE pair of matching
# surrounding quotes (dotenv semantics — a .env written by provisioning tools
# commonly quotes its values, and a verbatim export would push the literal
# quote characters into the environment: Prisma then rejects
# DATABASE_URL='"file:…"' with "the URL must start with the protocol file:"
# — found live by the Slice-16-C recovery drill on a quoted sandbox .env,
# 2026-10-25). Everything after the FIRST '=' is the value; base64 secrets
# ending in '=' are preserved (only the OUTERMOST quote pair is stripped);
# comments/blank lines skipped; operator-controlled file.
if [[ -f .env ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" != *=* ]] && continue
    k="${line%%=*}"
    [[ "$k" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    v="${line#*=}"
    if [[ "$v" == \"*\" && "${#v}" -ge 2 ]]; then v="${v:1:${#v}-2}"
    elif [[ "$v" == \'*\' && "${#v}" -ge 2 ]]; then v="${v:1:${#v}-2}"; fi
    export "${k}=${v}"
  done < .env
fi

exec bun run dev
