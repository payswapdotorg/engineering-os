/**
 * scripts/dev-db-cleanup.ts — dev-DB housekeeping (Phase-3 acceptance record:
 * "worker smoke projects removed; demo dataset rebuilt through the real API").
 *
 * Deletes project rows AND their content-store directories. Everything hangs
 * off Project in prisma/schema.prisma (onDelete: Cascade): artifacts +
 * revisions + links, quantity ledger rows, trade assemblies, rates, estimates +
 * lines, workflows + step runs + events, project-scoped audit events. The
 * content-store layout is <root>/<projectId>/<artifactId>/<revisionId>/content
 * (src/lib/artifact-store.ts), so removing <root>/<projectId> removes every
 * stored byte of the project.
 *
 * EngineProbeResult rows are NEVER touched (engine discovery state is true
 * product state, not probe litter).
 *
 * User rows are NEVER touched either (Phase-6, contract §1.5): operator
 * accounts persist across cleanups — setup is first-run only, so deleting
 * users here would lock the product behind a bootstrap that can never run
 * again. Demo rebuild = the signed-in takeoff run.
 *
 * Usage (bun resolves ../src/lib/db and auto-loads .env from the cwd):
 *   bun scripts/dev-db-cleanup.ts                    # dry run: list what could be removed
 *   bun scripts/dev-db-cleanup.ts --all              # delete EVERY project row + storage dir,
 *                                                    #   then sweep leftover top-level store dirs
 *   bun scripts/dev-db-cleanup.ts --project <id>     # delete one project (by id)
 *   bun scripts/dev-db-cleanup.ts --name <substr>    # delete projects whose name contains <substr>
 *
 * Prints what it removed. Run from the repo root (bun loads .env → DATABASE_URL).
 */
import { existsSync, readdirSync, rmSync } from "node:fs"
import path from "node:path"

import { db } from "../src/lib/db"

/** Mirrors getStorageRoot() in src/lib/artifact-store.ts (no import: that module
 * pulls @/lib/hash, which only resolves under the Next alias). */
function storageRoot(): string {
  return process.env.EOS_STORAGE_ROOT ?? path.join(process.cwd(), "data", "artifacts")
}

interface ProjectRow {
  id: string
  name: string
}

function removeStorageDir(projectId: string): boolean {
  const dir = path.join(storageRoot(), projectId)
  if (!existsSync(dir)) return false
  rmSync(dir, { recursive: true, force: true })
  console.log(`  removed storage dir ${dir}`)
  return true
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const all = args.includes("--all")
  const projectIdx = args.indexOf("--project")
  const nameIdx = args.indexOf("--name")

  if (!all && projectIdx === -1 && nameIdx === -1) {
    const projects = (await db.project.findMany({
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true },
    })) as ProjectRow[]
    console.log(
      `dev-db-cleanup: dry run — ${projects.length} project(s) in the dev DB. ` +
        "Pass --all (everything), --project <id> or --name <substr> to delete.",
    )
    for (const p of projects) console.log(`  - ${p.id}  ${JSON.stringify(p.name)}`)
    return
  }

  let targets: ProjectRow[]
  if (all) {
    targets = (await db.project.findMany({
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true },
    })) as ProjectRow[]
  } else if (projectIdx !== -1) {
    const id = args[projectIdx + 1]
    if (!id) throw new Error("--project requires an id argument")
    const one = await db.project.findUnique({ where: { id }, select: { id: true, name: true } })
    if (!one) throw new Error(`no project with id ${id}`)
    targets = [one as ProjectRow]
  } else {
    const substr = args[nameIdx + 1]
    if (!substr) throw new Error("--name requires a substring argument")
    targets = (await db.project.findMany({
      where: { name: { contains: substr } },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true },
    })) as ProjectRow[]
  }

  console.log(`dev-db-cleanup: removing ${targets.length} project row(s) + storage dir(s):`)
  for (const target of targets) {
    removeStorageDir(target.id)
    await db.project.delete({ where: { id: target.id } }) // schema cascades clean up every dependent row
    console.log(`  removed project ${target.id} (${JSON.stringify(target.name)})`)
  }

  if (all) {
    // With --all no project rows remain, so any top-level store dir that is
    // still there belongs to an already-deleted project — sweep it so the
    // store ends up exactly consistent with the (empty) DB.
    const root = storageRoot()
    if (existsSync(root)) {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const dir = path.join(root, entry.name)
        rmSync(dir, { recursive: true, force: true })
        console.log(`  removed leftover storage dir ${dir} (no project row)`)
      }
    }
  }

  console.log(`dev-db-cleanup: done — removed ${targets.length} project row(s). EngineProbeResult untouched.`)
}

main().catch((err) => {
  console.error("dev-db-cleanup failed:", err)
  process.exit(1)
})
