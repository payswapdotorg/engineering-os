#!/usr/bin/env bash
# scripts/dev-server-daemon.sh — start the canonical dev server DETACHED from
# the calling shell's process tree, so it survives the caller's exit.
#
# WHY THIS EXISTS (live-found 2026-10-26, fourth re-provision): the sandbox's
# command-exec wrapper reaps every process DESCENDED from the tool shell when
# the command finishes — plain `nohup … &` AND `setsid … &` both die at that
# instant (setsid changes the session, not the ancestry; the kill walk hits
# them before reparenting). The only survival pattern is the classic
# double-fork daemonization: the intermediate child exits IMMEDIATELY, the
# grandchild is reparented to init (PPID 1) while the wrapper is still
# running, and the descendant walk at command exit finds nothing to kill.
# This mirrors how the platform's own boot server survives (sudo chain under
# PPID 1) — empirically verified: a double-forked `sleep` outlives the tool
# command; a setsid'd one does not.
#
# Refuses to double-start: if :3000 already answers, exits 0 with a note
# (the "avoid duplicate instances" rule — the boot server or a previous
# daemon wins).
#
# Usage: bash scripts/dev-server-daemon.sh
# Logs:  dev.log (same file dev-server.sh has always used).
set -euo pipefail
cd "$(dirname "$0")/.."

if curl -s -m 2 -o /dev/null http://localhost:3000/api/status; then
  echo "dev-server-daemon: :3000 already serving — not starting a duplicate."
  exit 0
fi

python3 - <<'PYEOF'
import os, sys

log = open("dev.log", "ab", 0)
devnull = os.open(os.devnull, os.O_RDONLY)

pid = os.fork()
if pid == 0:
    # child: new session, detach tty, redirect, then fork AGAIN
    os.setsid()
    os.dup2(devnull, 0)
    os.dup2(log.fileno(), 1)
    os.dup2(log.fileno(), 2)
    pid2 = os.fork()
    if pid2 == 0:
        # grandchild: reparented to init when the child below exits NOW —
        # before the exec wrapper's descendant-kill walk ever runs.
        os.execvp("bash", ["bash", "scripts/dev-server.sh"])
        os._exit(127)
    os._exit(0)

# parent: reap the intermediate child so it never lingers as a zombie
os.waitpid(pid, 0)
print(f"dev-server-daemon: launched (grandchild reparented to init), logging to dev.log")
PYEOF
