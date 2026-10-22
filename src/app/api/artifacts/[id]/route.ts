import { db } from "@/lib/db"
import { jsonOk, ERR } from "@/lib/api-utils"

import { handler, requireEntityProject } from "../../_lib/route-helpers"

export const dynamic = "force-dynamic"

/**
 * GET /api/artifacts/[id] — artifact with full revision history and both
 * link directions (names of the other side included).
 */
export const GET = handler<{ id: string }>(async (_req, ctx) => {
  const { id } = await ctx.params

  const artifact = await db.artifact.findUnique({
    where: { id },
    include: {
      latestRevision: true,
      revisions: { orderBy: { revNumber: "desc" } },
      linksFrom: {
        orderBy: { createdAt: "desc" },
        include: { toArtifact: { select: { id: true, name: true, kind: true } } },
      },
      linksTo: {
        orderBy: { createdAt: "desc" },
        include: { fromArtifact: { select: { id: true, name: true, kind: true } } },
      },
      _count: { select: { revisions: true } },
    },
  })
  if (!artifact) return ERR.notFound("Artifact")

  // Slice 10: project isolation (contract §4)
  const access = await requireEntityProject(artifact, "Artifact", "read")
  if (!access.ok) return access.response

  return jsonOk({ artifact })
})
