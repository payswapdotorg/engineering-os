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
 *   bun scripts/dev-db-cleanup.ts --all --keep-name "Harbour View Extension"
 *                                                    # --all EXCEPT projects whose name contains a
 *                                                    #   keep-substring (repeatable) — the CI e2e
 *                                                    #   steps keep the canonical demo dataset alive
 *                                                    #   between suites with this flag (Slice-10 CI
 *                                                    #   fix: the plain --all pre-clean had silently
 *                                                    #   destroyed the dataset three suites' regression
 *                                                    #   markers assert against)
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

  // --keep-name <substr> (repeatable): projects whose name contains any of
  // these are EXCLUDED from --all and --name sweeps. Without a destructive
  // mode it has no effect.
  const keepNames: string[] = []
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "--keep-name" && args[i + 1]) keepNames.push(args[i + 1])
  }

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

  const kept = (p: ProjectRow) => keepNames.some((k) => p.name.includes(k))

  let targets: ProjectRow[]
  let keptIds: string[] = []
  if (all) {
    const every = (await db.project.findMany({
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true },
    })) as ProjectRow[]
    keptIds = every.filter((p) => kept(p)).map((p) => p.id)
    targets = every.filter((p) => !kept(p))
  } else if (projectIdx !== -1) {
    const id = args[projectIdx + 1]
    if (!id) throw new Error("--project requires an id argument")
    const one = await db.project.findUnique({ where: { id }, select: { id: true, name: true } })
    if (!one) throw new Error(`no project with id ${id}`)
    targets = [one as ProjectRow]
  } else {
    const substr = args[nameIdx + 1]
    if (!substr) throw new Error("--name requires a substring argument")
    const matching = (await db.project.findMany({
      where: { name: { contains: substr } },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true },
    })) as ProjectRow[]
    targets = matching.filter((p) => !kept(p))
  }

  if (keepNames.length > 0) {
    console.log(`dev-db-cleanup: keeping projects matching ${JSON.stringify(keepNames)} (${keptIds.length} row(s) kept)`)
  }

  console.log(`dev-db-cleanup: removing ${targets.length} project row(s) + storage dir(s):`)
  for (const target of targets) {
    removeStorageDir(target.id)
    await db.project.delete({ where: { id: target.id } }) // schema cascades clean up every dependent row
    console.log(`  removed project ${target.id} (${JSON.stringify(target.name)})`)
  }

  if (all) {
    // With --all (+keeps) the only surviving project rows are the kept ones,
    // so a top-level store dir that is still there belongs EITHER to an
    // already-deleted project (sweep it — the store must match the DB) OR to a
    // kept project (leave it — its row survives --keep-name by design).
    const root = storageRoot()
    if (existsSync(root)) {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        if (keptIds.includes(entry.name)) continue
        const dir = path.join(root, entry.name)
        rmSync(dir, { recursive: true, force: true })
        console.log(`  removed leftover storage dir ${dir} (no surviving project row)`)
      }
    }
  }

  console.log(`dev-db-cleanup: done — removed ${targets.length} project row(s). EngineProbeResult untouched.`)
}

main().catch((err) => {
  console.error("dev-db-cleanup failed:", err)
  process.exit(1)
})
