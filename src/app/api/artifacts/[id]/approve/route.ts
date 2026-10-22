import { z } from "zod"

import { applyApproval, type ApprovalState } from "@/core"
import { recordEvent } from "@/lib/audit"
import { jsonOk, ERR, parseBody } from "@/lib/api-utils"
import { db } from "@/lib/db"

import { handler, requireEntityProject } from "../../../_lib/route-helpers"

export const dynamic = "force-dynamic"

const approveSchema = z.object({
  note: z.string().max(500, "note must be at most 500 characters").optional(),
})

/** POST /api/artifacts/[id]/approve — approve latest revision; supersede prior. */
export const POST = handler<{ id: string }>(async (req, ctx) => {
  const { id } = await ctx.params

  const artifact = await db.artifact.findUnique({
    where: { id },
    include: { latestRevision: true },
  })
  if (!artifact) return ERR.notFound("Artifact")

  // Slice 10: project isolation (contract §4)
  const access = await requireEntityProject(artifact, "Artifact", "write")
  if (!access.ok) return access.response

  if (!artifact.latestRevision) {
    return ERR.badRequest("This artifact has no revisions to approve")
  }

  const parsed = await parseBody(req, approveSchema)
  if (!parsed.ok) return parsed.response

  const latest = artifact.latestRevision
  const next = applyApproval(latest.approvalState as ApprovalState, "approve")
  if (next === null) {
    const reason =
      latest.approvalState === "approved"
        ? "The latest revision is already approved — supersede it by uploading and approving a newer revision"
        : `The latest revision is ${latest.approvalState} and cannot be approved`
    return ERR.badRequest(reason)
  }

  // Prior approved revision of the same artifact gets superseded (state machine).
  const priorApproved = await db.artifactRevision.findFirst({
    where: { artifactId: id, approvalState: "approved", id: { not: latest.id } },
    orderBy: { revNumber: "desc" },
  })
  let supersededRev: number | null = null
  if (priorApproved && applyApproval("approved", "supersede") === "superseded") {
    await db.artifactRevision.update({
      where: { id: priorApproved.id },
      data: { approvalState: "superseded" },
    })
    supersededRev = priorApproved.revNumber
  }

  await db.artifactRevision.update({
    where: { id: latest.id },
    data: { approvalState: "approved" },
  })

  await recordEvent({
    projectId: artifact.projectId,
    action: "artifact.approved",
    entityType: "artifact",
    entityId: id,
    detail: {
      artifactName: artifact.name,
      revNumber: latest.revNumber,
      supersededRev,
      note: parsed.data.note ?? null,
    },
  })

  return jsonOk({ approved: true, revNumber: latest.revNumber, supersededRev })
})
