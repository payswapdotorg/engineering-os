import { readRevisionFile } from "@/lib/artifact-store"
import { ERR } from "@/lib/api-utils"
import { db } from "@/lib/db"

import { handler, slugify } from "@/app/api/_lib/route-helpers"

export const dynamic = "force-dynamic"

/**
 * GET /api/revisions/[id]/download — serve the stored bytes of one artifact
 * revision with integrity headers (Slice-8 contract §1). This restores the
 * link the artifact dialog has carried since Phase 1
 * (src/components/product/artifact-dialogs.tsx) after the route file was
 * lost from git history.
 *
 * Session required (default `handler()` wrap; 401 envelope verbatim) — GET is
 * non-mutating, so the viewer role CAN download. No audit event: reads are
 * not mutations, the upload/derive routes own the event vocabulary.
 */

/**
 * MIME→ext map for the derived download filename (contract §1), keyed by the
 * MIME subtype after stripping parameters and structured suffixes
 * (`image/svg+xml` → `svg`). `plain` is included because `text/plain` carries
 * the `txt` extension the contract names. Everything else → `bin`.
 */
const EXT_BY_SUBTYPE: Record<string, string> = {
  pdf: "pdf",
  svg: "svg",
  step: "step",
  stp: "step",
  stl: "stl",
  json: "json",
  txt: "txt",
  plain: "txt",
  png: "png",
  jpeg: "jpg",
  zip: "zip",
}

function extForMime(mimeType: string | null): string {
  if (!mimeType) return "bin"
  const subtype = mimeType.split(";")[0].split("/")[1]?.split("+")[0].trim().toLowerCase()
  return subtype ? EXT_BY_SUBTYPE[subtype] ?? "bin" : "bin"
}

/** ASCII fallback for the `filename` form: printable ASCII only. */
function asciiFilename(name: string): string {
  return name.replace(/[^\x20-\x7E]/g, "")
}

/** RFC 5987 `ext-value` encoding: UTF-8 bytes, attr-chars stay literal. */
function rfc5987(value: string): string {
  const ATTR_CHAR = /[A-Za-z0-9!#$&+\-.^_`|~]/
  return Array.from(new TextEncoder().encode(value))
    .map((byte) => {
      const ch = String.fromCharCode(byte)
      return ATTR_CHAR.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
    })
    .join("")
}

export const GET = handler<{ id: string }>(async (_req, ctx) => {
  const { id } = await ctx.params

  const revision = await db.artifactRevision.findUnique({
    where: { id },
    include: { artifact: { select: { id: true, name: true, kind: true, projectId: true } } },
  })
  if (!revision) return ERR.notFound("Revision")

  // The regex-guarded reader — never construct store paths by hand.
  const bytes = await readRevisionFile(revision.storageKey)

  const filename = `rev-r${revision.revNumber}-${slugify(revision.artifact.name)}.${extForMime(revision.mimeType)}`
  const ascii = asciiFilename(filename)

  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": revision.mimeType ?? "application/octet-stream",
      "Content-Length": String(bytes.byteLength),
      "X-Eos-Sha256": revision.contentHash,
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${rfc5987(filename)}`,
    },
  })
})
