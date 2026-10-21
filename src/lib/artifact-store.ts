import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

import { sha256Hex } from "@/lib/hash"

/**
 * Content-addressed artifact store (ADR-0003).
 * Layout: <root>/<projectId>/<artifactId>/<revisionId>/content
 * The DB row (storageKey) points here; bytes are stored verbatim (native formats
 * preserved) and verified by hash on write.
 */

export function getStorageRoot(): string {
  return process.env.EOS_STORAGE_ROOT ?? path.join(process.cwd(), "data", "artifacts")
}

export interface StoredRevision {
  storageKey: string
  sha256: string
  sizeBytes: number
}

export async function saveRevisionFile(
  projectId: string,
  artifactId: string,
  revisionId: string,
  data: Buffer,
): Promise<StoredRevision> {
  const dir = path.join(getStorageRoot(), projectId, artifactId, revisionId)
  await mkdir(dir, { recursive: true })
  const contentPath = path.join(dir, "content")
  await writeFile(contentPath, data)

  const sha256 = sha256Hex(data)
  const written = await readFile(contentPath)
  if (sha256Hex(written) !== sha256) {
    throw new Error(`storage integrity check failed after write (${revisionId})`)
  }
  return {
    storageKey: `${projectId}/${artifactId}/${revisionId}`,
    sha256,
    sizeBytes: data.byteLength,
  }
}

export async function readRevisionFile(storageKey: string): Promise<Buffer> {
  if (!/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+){2}$/.test(storageKey)) {
    throw new Error("invalid storage key")
  }
  return readFile(path.join(getStorageRoot(), storageKey, "content"))
}
