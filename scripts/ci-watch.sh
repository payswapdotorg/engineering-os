#!/usr/bin/env bash
# scripts/ci-watch.sh — TL utility (Slice 10, local only): poll the CI runs for a SHA.
# NOT part of the product; a dev-host convenience during release verification.
set -euo pipefail
cd "$(dirname "$0")/.."
source /tmp/my-project/download/recovery/credentials.env
SHA="${1:-$(git rev-parse HEAD)}"
POLL="${2:-0}" # seconds between polls; 0 = single shot

while true; do
  OUT="$(curl -sS -m 30 -H "Authorization: Bearer ${GH_TOKEN}" \
    "https://api.github.com/repos/payswapdotorg/engineering-os/actions/runs?head_sha=${SHA}&per_page=20")"
  TOTAL="$(printf '%s' "$OUT" | /usr/bin/jq -r '.total_count')"
  echo "=== $(date -u +%H:%M:%S) runs for ${SHA:0:8}: ${TOTAL} ==="
  printf '%s' "$OUT" | /usr/bin/jq -r '.workflow_runs[] | "\(.id) \(.status) \(.conclusion // "-") \(.name)"'
  if [[ "$POLL" == "0" ]]; then break; fi
  # exit when no run is still queued/in_progress
  if [[ "$TOTAL" != "0" ]] && ! printf '%s' "$OUT" | /usr/bin/jq -e '[.workflow_runs[] | select(.status == "queued" or .status == "in_progress")] | length > 0' >/dev/null; then
    echo "=== all runs terminal ==="
    break
  fi
  sleep "$POLL"
done
