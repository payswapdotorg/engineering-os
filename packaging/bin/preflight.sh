#!/usr/bin/env bash
# /opt/engineering-os/bin/preflight.sh — ExecStartPre sanity gate for eos.service
#
# Phase-6 packaging (contract §2). Runs as the service user (eos) BEFORE
# /usr/bin/node server.js starts and fails fast with a clear stderr message
# (visible via `journalctl -u eos`). It performs NO DB mutation and NO
# service management — exactly three checks:
#   1. node present at /usr/bin/node with major version >= 18
#   2. data dir /var/lib/engineering-os writable by the service user
#   3. env file /etc/eos/eos.env readable by the service user
set -euo pipefail

fail() { echo "preflight: $*" >&2; exit 1; }

# 1) node runtime — the unit hardcodes /usr/bin/node (Depends: nodejs >= 18)
if [ ! -x /usr/bin/node ]; then
  fail "/usr/bin/node not found — install the nodejs package (sudo apt-get install nodejs; version >= 18 required)"
fi
NODE_VERSION="$(/usr/bin/node --version 2>/dev/null || true)"
NODE_MAJOR="$(printf '%s' "$NODE_VERSION" | sed -n 's/^v\([0-9][0-9]*\).*/\1/p')"
if [ -z "$NODE_MAJOR" ]; then
  fail "/usr/bin/node --version did not return a parseable version (got: '${NODE_VERSION:-<empty>}')"
fi
if [ "$NODE_MAJOR" -lt 18 ]; then
  fail "node $NODE_VERSION is too old — Engineering OS requires nodejs >= 18 (see docs/07-release/installation-ubuntu.md)"
fi

# 2) data dir writable by the service user (DB + artifact store live here)
if [ ! -d /var/lib/engineering-os ]; then
  fail "/var/lib/engineering-os does not exist — reinstall the package or create it owned by eos:eos"
fi
if [ ! -w /var/lib/engineering-os ]; then
  fail "/var/lib/engineering-os is not writable by $(id -un) — fix with: sudo chown eos:eos /var/lib/engineering-os"
fi

# 3) env file readable (systemd reads it as root, the service user must still
#    be able to read it for direct/manual runs — generated 0640 root:eos)
if [ ! -r /etc/eos/eos.env ]; then
  fail "/etc/eos/eos.env is not readable by $(id -un) — fix with: sudo chown root:eos /etc/eos/eos.env && sudo chmod 0640 /etc/eos/eos.env"
fi

echo "preflight: ok — node $NODE_VERSION, data dir writable, env file readable"
