import { z } from "zod"

import { recordEvent } from "@/lib/audit"
import { jsonOk, parseBody } from "@/lib/api-utils"
import { getSessionUser } from "@/lib/auth"
import { removeStorageOrphans } from "@/lib/storage-orphans"

import { ERR_ADMIN_ONLY, ERR_SIGN_IN_REQUIRED, handler } from "../../../_lib/route-helpers"

export const dynamic = "force-dynamic"

const confirmSchema = z.object({
  confirm: z.literal(true, {
    message: "confirm must be true to delete orphans (this permanently removes unreferenced content-store directories)",
  }),
})

/**
 * DELETE /api/admin/storage/orphans — {confirm: true} (contract §6).
 * Deletes EXACTLY the storage dirs listed by a FRESH server-side scan run
 * inside this request (client-listed keys are never trusted); each dir is
 * re-checked against the DB right before removal — anything that
 * re-appeared or vanished is KEPT. Response {removed, kept}; one
 * `storage.orphans-removed` audit event carries the removed keys in detail.
 */
export const DELETE = handler(async (req) => {
  // Slice 10: project isolation (contract §4)
  const session = await getSessionUser()
  if (!session) return ERR_SIGN_IN_REQUIRED()
  if (session.role !== "admin") return ERR_ADMIN_ONLY()

  const parsed = await parseBody(req, confirmSchema)
  if (!parsed.ok) return parsed.response

  const { removed, kept } = await removeStorageOrphans()

  await recordEvent({
    action: "storage.orphans-removed",
    entityType: "storage",
    entityId: "content-store",
    detail: {
      removed,
      kept,
      removedCount: removed.length,
      keptCount: kept.length,
    },
  })

  return jsonOk({ removed, kept })
})
