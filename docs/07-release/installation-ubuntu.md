# Ubuntu Installation

Status: Phase-1 **developer install** (verified). Distributable packaging (deb/AppImage/system service) is Phase 6.

## Requirements

- Ubuntu 22.04 LTS or 24.04 LTS (any modern Linux with Bun should work; verified on the sandbox's Linux)
- Bun ≥ 1.1 (`curl -fsSL https://bun.sh/install | bash`)
- Git
- ~600 MB free (dependencies)
- Optional: engineering engines (FreeCAD, LibreCAD, Blender, Bonsai…) — **not bundled**; the product detects what is installed (see [ADR-0004](../adr/0004-license-and-copyleft-boundary.md))

## Install & run

```bash
git clone https://github.com/payswapdotorg/engineering-os.git
cd engineering-os
bash install.sh        # bun install + prisma generate + dev db push + .env
bun run dev            # dev server on http://localhost:3000
```

What `install.sh` does (idempotent):
1. `bun install --frozen-lockfile` — dependencies
2. `bunx prisma generate` — typed database client
3. `cp .env.example .env` (if missing) — SQLite dev backend (`file:../db/custom.db`)
4. `bunx prisma db push` — create schema in the dev database

## Data locations (dev)

| Data | Location |
|---|---|
| Structured data (SQLite dev) | `db/custom.db` |
| Artifact content store | `data/artifacts/<projectId>/<artifactId>/<revisionId>/content` |
| Logs | stdout of `bun run dev` (dev.log when backgrounded) |

## Troubleshooting

| Symptom | Fix |
|---|---|
| `DATABASE_URL` missing | copy `.env.example` → `.env` |
| Prisma client errors after schema change | `bunx prisma generate` |
| Port 3000 busy | `EADDRINUSE`: stop the other process or set `--port` |
| First page compile is slow | normal for `next dev` cold start; subsequent loads are fast |

## Production target (not yet verified end-to-end)

PostgreSQL via `DATABASE_URL=postgresql://…` + `prisma db push` (ADR-0003); service deployment + reverse proxy + packaging land in Phase 6.
