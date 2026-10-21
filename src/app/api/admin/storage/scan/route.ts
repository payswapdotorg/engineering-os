import { recordEvent } from "@/lib/audit"
import { jsonOk } from "@/lib/api-utils"
import { scanStorageOrphans } from "@/lib/storage-orphans"

import { handler } from "../../../_lib/route-helpers"

export const dynamic = "force-dynamic"

/**
 * POST /api/admin/storage/scan — READ-ONLY orphan listing (contract §6):
 * content-store revision dirs whose storageKey appears in no ArtifactRevision
 * row. Response: {orphans:[{storageKey, sizeBytes, detectedAt}]} — paths are
 * never exposed, only storage keys. One `storage.scanned` audit event
 * (entityType "storage", projectId null — storage is not workflow-scoped,
 * so NO WorkflowEvent is written here).
 */
export const POST = handler(async () => {
  const orphans = await scanStorageOrphans()
  const detectedAt = new Date().toISOString()

  await recordEvent({
    action: "storage.scanned",
    entityType: "storage",
    entityId: "content-store",
    detail: {
      orphanCount: orphans.length,
      totalBytes: orphans.reduce((sum, orphan) => sum + orphan.sizeBytes, 0),
    },
  })

  return jsonOk({
    orphans: orphans.map((orphan) => ({
      storageKey: orphan.storageKey,
      sizeBytes: orphan.sizeBytes,
      detectedAt,
    })),
  })
})
