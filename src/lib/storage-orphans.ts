import { readdir, rm, stat } from "node:fs/promises"
import path from "node:path"

import { getStorageRoot } from "@/lib/artifact-store"
import { db } from "@/lib/db"

/**
 * Content-store orphan scanning + exact-removal (Phase 4, contract §6).
 *
 * Store layout (src/lib/artifact-store.ts): <storageRoot>/<projectId>/
 * <artifactId>/<revisionId>/content — the DB row's storageKey is exactly
 * "<projectId>/<artifactId>/<revisionId>". An orphan is a revision dir whose
 * storageKey appears in NO ArtifactRevision row (e.g. bytes written before a
 * failed DB transaction — the upload route logs exactly that case).
 *
 * Honesty rules: the scan is read-only; removal deletes EXACTLY the still
 * -orphaned dirs from a FRESH server-side scan (client-listed keys are never
 * trusted) and anything uncertain — re-appeared in the DB, vanished, odd
 * path shape — is KEPT. Never a blind sweep.
 */

/** storageKey shape pinned by src/lib/artifact-store.ts (readRevisionFile). */
export const STORAGE_KEY_RE = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+){2}$/

export interface StorageOrphan {
  storageKey: string
  /** Absolute revision dir — server-side only; the API never returns paths. */
  dir: string
  sizeBytes: number
}

async function dirSizeBytes(dir: string): Promise<number> {
  let total = 0
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      total += await dirSizeBytes(full)
    } else {
      const info = await stat(full).catch(() => null)
      if (info) total += info.size
    }
  }
  return total
}

/**
 * Read-only orphan scan: every revision dir in the content store whose
 * storageKey appears in no ArtifactRevision row, with the dir's size in
 * bytes. The store root may not exist yet (fresh install) — then the scan
 * is honestly empty.
 */
export async function scanStorageOrphans(): Promise<StorageOrphan[]> {
  const root = getStorageRoot()
  const orphans: StorageOrphan[] = []

  let projectDirs
  try {
    projectDirs = await readdir(root, { withFileTypes: true })
  } catch {
    return [] // no store yet — nothing to scan
  }

  const referenced = new Set(
    (await db.artifactRevision.findMany({ select: { storageKey: true } })).map((r) => r.storageKey),
  )

  for (const projectDir of projectDirs) {
    if (!projectDir.isDirectory()) continue
    const artifactDirs = await readdir(path.join(root, projectDir.name), {
      withFileTypes: true,
    }).catch(() => [])
    for (const artifactDir of artifactDirs) {
      if (!artifactDir.isDirectory()) continue
      const revisionBase = path.join(root, projectDir.name, artifactDir.name)
      const revisionDirs = await readdir(revisionBase, { withFileTypes: true }).catch(() => [])
      for (const revisionDir of revisionDirs) {
        if (!revisionDir.isDirectory()) continue
        const storageKey = `${projectDir.name}/${artifactDir.name}/${revisionDir.name}`
        if (referenced.has(storageKey)) continue
        orphans.push({
          storageKey,
          dir: path.join(revisionBase, revisionDir.name),
          sizeBytes: await dirSizeBytes(path.join(revisionBase, revisionDir.name)),
        })
      }
    }
  }
  return orphans
}

/**
 * Remove EXACTLY the still-orphaned revision dirs found by a FRESH scan
 * (never client-listed keys). Each dir is re-checked against the DB right
 * before removal: anything that re-appeared in the DB, vanished from disk or
 * has an uncertain key shape is KEPT.
 */
export async function removeStorageOrphans(): Promise<{ removed: string[]; kept: string[] }> {
  const candidates = await scanStorageOrphans()
  const removed: string[] = []
  const kept: string[] = []
  for (const candidate of candidates) {
    if (!STORAGE_KEY_RE.test(candidate.storageKey)) {
      kept.push(candidate.storageKey) // uncertain shape — never a blind sweep
      continue
    }
    const stillOrphan =
      (await db.artifactRevision.findFirst({
        where: { storageKey: candidate.storageKey },
        select: { id: true },
      })) === null
    if (!stillOrphan) {
      kept.push(candidate.storageKey) // re-appeared in the DB since the scan
      continue
    }
    try {
      // force:false — a dir that vanished mid-operation throws ENOENT and is
      // KEPT; a removal only counts when bytes actually went away.
      await rm(candidate.dir, { recursive: true, force: false })
      removed.push(candidate.storageKey)
    } catch (err) {
      kept.push(candidate.storageKey)
      console.error("[storage] orphan removal failed, keeping:", candidate.storageKey, err)
    }
  }
  return { removed, kept }
}
