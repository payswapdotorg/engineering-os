# Ubuntu Installation

Two supported paths:

1. **Packaged install (.deb)** — production-style single-host deployment with
   a systemd service, a desktop entry, and a daily orphan-sweep timer
   (Phase-6 packaging; verified in CI on `ubuntu-latest`).
2. **Developer install** — clone + `install.sh` + `bun run dev`, for working on
   the codebase (kept at the bottom).

Packaging sources: `packaging/**` + `scripts/build-deb.sh` (repo path → package
path mapping in [packaging/README.md](../../packaging/README.md)).

## System requirements (packaged install)

- **Ubuntu 22.04 LTS / 24.04 LTS** (any systemd-based Linux should work; the
  CI packaging job runs on `ubuntu-latest` = 24.04).
- **Node.js ≥ 18** — the package declares `Depends: nodejs (>= 18)`, and the
  service runs `/usr/bin/node /opt/engineering-os/server.js` (the Next.js
  standalone server; Node is a dependency, never bundled).
  - Ubuntu 24.04: stock `nodejs` (18.x) satisfies it.
  - Ubuntu 22.04: the stock `nodejs` (12.x) is **too old** — install
    Node 18+ first (e.g. NodeSource), otherwise `dpkg -i` leaves the package
    unconfigured until a satisfying `nodejs` is installed:
    ```bash
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
    ```
- **systemd** — runs `eos.service` and the `eos-orphan-sweep.timer`.
  Containers/hosts without systemd still install cleanly (the maintscripts
  detect that and skip service management); start manually with
  `sudo -u eos /usr/bin/node /opt/engineering-os/server.js`.
- **python3** — *optional*. Only needed to operate the real engineering engine
  adapters (cadquery, IfcOpenShell, gmsh, pandapower, simpy, …). Engines are
  **not bundled** — the product probes and reports what is actually installed
  (ADR-0005). Without them, engine detection works and every engine is
  honestly reported `not_installed`.
- ~700 MB free for the installed tree.

## Getting the package

The `.deb` is built by the `packaging` CI job
([.github/workflows/ci.yml](../../.github/workflows/ci.yml)) on every push —
download it from the run's **artifacts** (`engineering-os-deb`), or build it
yourself from source (any Linux host with bun + dpkg-deb):

```bash
git clone https://github.com/payswapdotorg/engineering-os.git
cd engineering-os
bash install.sh          # bun install + prisma client + dev db (build prerequisites)
scripts/build-deb.sh      # → dist/engineering-os_<version>_amd64.deb
```

## Install

```bash
sudo dpkg -i engineering-os_<version>_amd64.deb
# (or, to let apt resolve dependencies from your configured repos:)
# sudo apt-get install ./engineering-os_<version>_amd64.deb

systemctl status eos          # should be active (running)
```

What the package does at install (`postinst`):

- creates the system user/group **`eos`** (`--system`, home
  `/var/lib/engineering-os`, shell `/usr/sbin/nologin`);
- creates `/var/lib/engineering-os/` owned by `eos` and seeds
  `/var/lib/engineering-os/custom.db` from the bundled schema-only SQLite DB —
  **first install only; upgrades never touch it**;
- generates `/etc/eos/eos.env` (only if absent) with
  `DATABASE_URL`, a **randomized `NEXTAUTH_SECRET`** (openssl),
  `NEXTAUTH_URL=http://localhost:3000`, `EOS_PYTHON=python3`,
  `EOS_STORAGE_ROOT=/var/lib/engineering-os/artifacts`;
- registers + enables + starts `eos.service` and `eos-orphan-sweep.timer`
  (skipped automatically where systemd isn't running).

### First run

Open **http://localhost:3000**. On a fresh database the app shows the
**first-run setup screen** — create the initial admin account there (name /
email / password). Setup is available only while no user exists; afterwards
everyone signs in through the sign-in form. This account is yours, local to
your server, and unrelated to any demo credentials.

Verify:

```bash
systemctl status eos
curl -s http://localhost:3000/api/status
```

## The orphan-sweep timer (and its service account)

`eos-orphan-sweep.timer` fires **daily** (`OnCalendar=daily`,
`Persistent=true`, catches up after downtime) and runs
`/opt/engineering-os/bin/orphan-sweep.sh` as `eos`. The sweep is the **real**
one through the product's HTTP API — never a filesystem sweep:

1. `GET /api/status` — skip gracefully if the app is down (exit 0);
2. `POST /api/admin/storage/scan` — server-side read-only orphan scan;
3. `DELETE /api/admin/storage/orphans` with `{"confirm":true}` — the server
   re-runs a **fresh scan inside that request** and re-checks every directory
   against the DB right before removal (anything that re-appeared or vanished
   in between is kept — client input is never trusted).

**The admin routes require a signed-in session and the product has no
API-token system**, so the sweep signs in through the real NextAuth
credentials flow using an operator-provided **admin-role service account**:

```bash
# 1) in the product UI (signed in as admin): create a dedicated user,
#    e.g. sweep@eos.local, with the admin role — viewer is read-only and
#    engineer cannot call admin routes (this is the documented, accepted
#    pattern: a scheduled sweep needs an admin service account)
# 2) put its credentials in /etc/eos/eos.env (uncomment + set):
#    EOS_SWEEP_EMAIL=sweep@eos.local
#    EOS_SWEEP_PASSWORD=...
sudo systemctl restart eos eos-orphan-sweep.timer
# 3) run it once to verify:
sudo systemctl start eos-orphan-sweep.service
journalctl -u eos-orphan-sweep.service -n 5
```

Until the credentials are configured the sweep logs one honest skip line and
exits 0 — it performs **no** admin call. Opt out entirely with
`sudo systemctl disable --now eos-orphan-sweep.timer`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Service won't start | `systemctl status eos` then `journalctl -u eos -n 50`. The `ExecStartPre` preflight gate prints a clear `preflight:` line for its three failure modes (see below). |
| `preflight: /usr/bin/node not found` | Node is missing: `sudo apt-get install nodejs` (≥ 18; on 22.04 use NodeSource — see requirements). |
| `preflight: node v12… too old` | Upgrade Node to ≥ 18 (see requirements). |
| `preflight: /var/lib/engineering-os not writable by eos` | `sudo chown -R eos:eos /var/lib/engineering-os` |
| `preflight: /etc/eos/eos.env not readable` | `sudo chown root:eos /etc/eos/eos.env && sudo chmod 0640 /etc/eos/eos.env` |
| Port 3000 already in use | `EADDRINUSE`: stop the other listener or edit `/etc/eos/eos.env` + the unit (`ExecStart`/port env) and `systemctl daemon-reload && systemctl restart eos`. |
| Changed `/etc/eos/eos.env`, no effect | `sudo systemctl restart eos` (the env file is read at service start). |
| Engine derivations report engines missing | Expected without engine libs: install python3 + the engines (cadquery/IfcOpenShell/…) into a venv and point `EOS_PYTHON` at its interpreter. Optional helper: `sudo -u eos /opt/engineering-os/scripts/setup-engine-libs.sh` (user-local libGLU/libOpenGL bootstrap). |
| Package unconfigured after `dpkg -i` (`nodejs (>= 18)` unsatisfied) | Install Node ≥ 18 (see requirements), then `sudo dpkg --configure engineering-os`. |

## Upgrade path

```bash
sudo dpkg -i engineering-os_<new-version>_amd64.deb
```

`prerm` stops the service first; `postinst` re-enables and restarts it with the
new files. **Operator data is never touched**: `/var/lib/engineering-os`
(database + artifact store) and `/etc/eos/eos.env` are kept as-is on upgrade.

**Honest limitation — schema drift is manual today.** The package does not run
database migrations on upgrade. If a release notes schema changes and your
service errors on startup or in API responses, apply the schema manually with
the packaged `prisma/schema.prisma` (requires bun/prisma available to you):

```bash
# backup first — prisma db push is not additive-only:
sudo -u eos cp /var/lib/engineering-os/custom.db /var/lib/engineering-os/custom.db.bak
DATABASE_URL="file:/var/lib/engineering-os/custom.db" bunx prisma db push \
  --schema /opt/engineering-os/prisma/schema.prisma
sudo systemctl restart eos
```

Automated migrations are future work (recorded, not silently promised).

## Data retention & removal

| Path | Contents | On `dpkg -r` | On `dpkg --purge` |
|---|---|---|---|
| `/opt/engineering-os` | application | removed | removed |
| `/var/lib/engineering-os` | SQLite DB + artifact store (**all project data**) | **kept** | **kept** |
| `/etc/eos/eos.env` | runtime env incl. `NEXTAUTH_SECRET` | **kept** | **kept** |

The package **never auto-deletes** project data — remove is not purge, and even
purge keeps the data dirs (deliberate: an engineering tool's data outlives the
package). Full manual cleanup:

```bash
sudo dpkg --purge engineering-os
sudo rm -rf /var/lib/engineering-os /etc/eos
sudo userdel eos
```

## Database note

The packaged deployment uses SQLite (as generated) — perfectly fine for a
single-host team. The production target is PostgreSQL via the same Prisma
schema (ADR-0003): point `DATABASE_URL` in `/etc/eos/eos.env` at your postgres
DSN, run `prisma db push` once, and `systemctl restart eos`. PostgreSQL
verification remains environment-blocked upstream (no server in the sandbox) —
recorded honestly as planned, not done.

---

## Developer install (unchanged from earlier phases)

```bash
git clone https://github.com/payswapdotorg/engineering-os.git
cd engineering-os
bash install.sh        # bun install + prisma generate + dev db push + .env
bun run dev            # dev server on http://localhost:3000
```

What `install.sh` does (idempotent): `bun install --frozen-lockfile` →
`bunx prisma generate` → copy `.env.example` to `.env` (SQLite dev backend) →
`bunx prisma db push`.

Dev-mode data locations:

| Data | Location |
|---|---|
| Structured data (SQLite dev) | `db/custom.db` |
| Artifact content store | `data/artifacts/<projectId>/<artifactId>/<revisionId>/content` |
| Logs | stdout of `bun run dev` (dev.log when backgrounded) |

Dev troubleshooting: `DATABASE_URL` missing → copy `.env.example` → `.env`;
Prisma client errors after schema change → `bunx prisma generate`; port 3000
busy → stop the other process or `--port`; slow first page compile → normal
cold start.
