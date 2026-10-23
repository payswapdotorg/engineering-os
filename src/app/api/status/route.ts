import { readFile } from "node:fs/promises"
import path from "node:path"

import { engineRegistry } from "@/engines"
import { getStorageRoot } from "@/lib/artifact-store"
import { jsonOk } from "@/lib/api-utils"
import { db } from "@/lib/db"

import { handler } from "../_lib/route-helpers"

export const dynamic = "force-dynamic"

// PUBLIC (contract §1.3): the health endpoint stays reachable without a
// session — watchdogs, CI and the first-run frontend poll it.

/** Live datasource provider, derived from the DATABASE_URL Prisma itself
 * resolves (the dev-server launcher exports .env at exec time — Phase-6
 * rationale). The footer shows this string, so it must report the backend
 * the queries are ACTUALLY hitting, never a hardcoded claim. */
function liveDbProvider(): string {
  const url = process.env.DATABASE_URL ?? ""
  if (url.startsWith("file:")) return "sqlite (dev)"
  if (/^postgres(ql)?:\/\//.test(url)) return "postgresql"
  return url ? "unknown" : "unset"
}

/** Version from package.json (fs read) with an honest fallback. */
async function readVersion(): Promise<string> {
  try {
    const raw = await readFile(path.join(process.cwd(), "package.json"), "utf-8")
    const parsed = JSON.parse(raw) as { version?: string }
    return typeof parsed.version === "string" && parsed.version.length > 0 ? parsed.version : "0.1.0"
  } catch {
    return "0.1.0"
  }
}

export const GET = handler(
  async () => {
    const [version, projects, artifacts, revisions, installed] = await Promise.all([
      readVersion(),
      db.project.count(),
      db.artifact.count(),
      db.artifactRevision.count(),
      db.engineProbeResult.count({ where: { state: "installed" } }),
    ])

    return jsonOk({
      version,
      storageMode: "local content-addressed store",
      storageRoot: getStorageRoot(),
      dbProvider: liveDbProvider(),
      engines: { total: engineRegistry.length, installed },
      counts: { projects, artifacts, revisions },
    })
  },
  { auth: "public" },
)
