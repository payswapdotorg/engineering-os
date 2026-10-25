# First systemd-host runbook — Engineering OS `.deb` deployment

Owner: Phase-6 packaging lane (Slice 16-C; roadmap-gap-audit §6.4's committed
half) · Status: **UNEXECUTED BY DESIGN** — CI runners and the dev sandbox have
no systemd (PID 1 is not systemd, `/run/systemd/system` does not exist), so
this runbook is the committed, step-by-step procedure for the FIRST real
systemd host. Every claim below that could be verified without a systemd host
already IS verified in CI (the `e2e` job: `dpkg-deb --build` structural
checks, `eos.service` syntax, maintscript `bash -n`, the full e2e battery) or
by the **process-level recovery drill** (`scripts/e2e-recovery-drill.sh`, 16
PASS pinned in CI — the SIGKILL/restart/recovery-marking/retry semantics that
`Restart=on-failure` relies on, proven at the process level without systemd).

What this runbook adds when executed: the systemd supervision layer itself —
unit activation, `Restart` behavior, the `EnvironmentFile` wiring, the sweep
timer, and journal capture. **Everything below is to be run as root on the
target host unless prefixed with `$` (operator shell).**

## 0. Host prerequisites (record these before starting)

| Item | Expected | Capture |
|---|---|---|
| OS | Ubuntu 24.04 LTS (noble) x86-64 — the CI runner matrix | `lsb_release -ds` |
| systemd | PID 1 = systemd, `/run/systemd/system` exists | `ps -p 1 -o comm=` and `test -d /run/systemd/system && echo yes` |
| node (in-package) | the `.deb` bundles the standalone server; `node` only needs to exist for the preflight | `node --version` (≥ 18 per `packaging/bin/preflight.sh`) |
| Engine host extras (OPTIONAL — only if the host will run engines) | `tesseract-ocr` (OCR), LibreOffice (document conversion); the python engine venv per `tests/validation/engines-requirements.txt` (cadquery, ifcopenshell, gmsh, pandapower, simpy, pdfplumber, ezdxf); `scripts/setup-engine-libs.sh` for libGLU (gmsh) | each engine's `--version` / import check |
| Package | `dist/engineering-os_<version>_amd64.deb` built by CI (`scripts/build-deb.sh`) | sha256 of the `.deb` |

## 1. Install

```bash
apt-get install -y ./dist/engineering-os_<version>_amd64.deb
```

What must happen (postinst, already CI-verified):
- `eos` user/group created; `/var/lib/engineering-os/` created with the
  schema-only SQLite seed `custom.db` (first install only);
  `/etc/eos/eos.env` generated with a FRESH `NEXTAUTH_SECRET`
  (`openssl rand -base64 32`) and `DATABASE_URL=file:/var/lib/engineering-os/custom.db`;
- units installed to `/lib/systemd/system/`, `daemon-reload` run, `eos.service`
  ENABLED and STARTED, `eos-orphan-sweep.timer` enabled.

Capture: `dpkg -L engineering-os | head -50`, `systemctl status eos.service`.

## 2. Service gate (what passes)

```bash
systemctl is-active eos.service            # → active
journalctl -u eos.service -n 50 --no-pager # preflight passed, server listening
curl -fsS http://localhost:3000/api/status # → 200 with the version envelope
```

**PASS =** `/api/status` returns `200` with `dbProvider` matching the
configured database and the `counts` envelope. Any 5xx here: read
`journalctl -u eos.service` FIRST — the most likely cause is
`/etc/eos/eos.env` value quoting (the launcher and postinst both use dotenv
semantics: ONE outer quote pair is stripped; see
`scripts/dev-server.sh`'s header — the class was found live by the recovery
drill on a quoted sandbox `.env`).

## 3. First-run setup + smoke (operator shell, `$`)

Through the real UI (or API): create the first operator account at `/` —
the first-run setup flow is the ONLY path that creates the admin user.

```bash
# authenticated smoke (after sign-in, jar from the browser or a curl login):
curl -fsS -b <jar> http://localhost:3000/api/projects
```

**PASS =** the projects list returns `200` with an empty array (fresh host).

## 4. Restart recovery drill ON SYSTEMD (the reason this runbook exists)

This is the systemd-host execution of the semantics the CI drill already
proves at the process level. On the target host:

1. Create a probe project, upload a STEP model, create a 3-step
   `derive_quantities` workflow, mark-ready, queue (the
   `e2e-recovery-drill.sh` phases A–C against `http://localhost:3000`).
2. While the run is `running`, hard-kill the SERVICE tree the way systemd
   sees a crash — `systemctl kill -s SIGKILL eos.service` (or kill the node
   pid directly).
3. WAIT. What must happen: systemd's `Restart=on-failure` brings the server
   back (RestartSec=5); on boot the executor's recovery scan marks the
   orphaned `running` row `failed` with the pinned verbatim error
   `interrupted: server restarted or executor died (recovery-marked)`, one
   `workflow.recovery-marked` audit event by `system:recovery`, and the
   interrupted-step records stay intact.
   - NOTE: the production default orphan cutoff is 5 minutes
     (`RECOVERY_CUTOFF_MS` in `src/core/runtime/executor.ts`). The dev/CI
     drill shortens it via `EOS_RECOVERY_CUTOFF_MS=2000`; on this host either
     wait ≥5 min before the restart check, or set
     `EOS_RECOVERY_CUTOFF_MS=2000` in `/etc/eos/eos.env` for the drill
     (remove it afterwards).
4. `retry` the workflow (UI or `POST /api/workflows/<id>/transition` with
   `{"action":"retry"}`) → it resumes from the first unfinished step and
   reaches `succeeded`.
5. Clean up the probe project.

**PASS =** all four behaviors above observed on the systemd host, captured in
`journalctl -u eos.service` + the workflow's events trail. This closes the
roadmap-gap-audit §6.4 open half (`packaging/README.md`'s recorded boundary:
runners have no systemd — the process-level drill shipped; the systemd-host
execution stayed open until THIS runbook is run).

## 5. Sweep timer gate

```bash
systemctl list-timers eos-orphan-sweep.timer   # → scheduled
journalctl -u eos-orphan-sweep.service -n 20   # → exit 0
```

The sweep is inert-by-design until the sweep account is configured (skip +
exit 0). **PASS =** the timer fires, the service exits 0, journal shows the
honest skip line.

## 6. Remove / upgrade gate

```bash
dpkg -r engineering-os && systemctl is-active eos.service   # → inactive (unit file remains: our choice)
apt-get install -y ./dist/engineering-os_<new>_amd64.deb      # upgrade path: data + /etc/eos/eos.env preserved
```

**PASS =** removal stops the service without touching
`/var/lib/engineering-os/` data; upgrade preserves both the database and the
operator's `eos.env` (postinst only regenerates what's missing).

## 7. What to capture back into the repo

File the execution record under `docs/07-release/implementation-status.md`
(known-limitation #6's systemd-host half) with: host OS/version, the `.deb`
sha256, the four §4 drill observations, journal excerpts, and any deviation
from this runbook. Unit hardening (`ProtectSystem=strict`,
`ReadWritePaths=…`) is the recorded follow-up AFTER this first run —
`packaging/README.md`'s "wrong ReadWritePaths would brick the first real
install" reasoning stands.
