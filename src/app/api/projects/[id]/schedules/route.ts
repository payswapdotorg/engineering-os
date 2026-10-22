import { recordEvent } from "@/lib/audit"
import { jsonOk, ERR } from "@/lib/api-utils"
import { db } from "@/lib/db"
import { newId } from "@/lib/ids"
import { saveRevisionFile } from "@/lib/artifact-store"
import { canonicalScheduleJson, parseSchedule } from "@/core/analysis-schemas"

import { handler, requireProjectAccess } from "../../../_lib/route-helpers"

export const dynamic = "force-dynamic"

/**
 * POST /api/projects/[id]/schedules — create a schedule artifact (contract §8).
 *
 * Body = the §3.1 eos-schedule/1 JSON (raw JSON body, zod-validated with
 * verbatim 422s). The CANONICAL bytes (pinned key order, defaults filled —
 * byte-deterministic by construction, so the same schedule always hashes the
 * same) are stored as revision 1 of a NEW artifact of kind "schedule" and the
 * artifact is registered with `name` from the body. Schedules are NEVER
 * upload-detected (a `.json` upload stays `dataset`); this route is the only
 * creation path. Persistence mirrors the artifact-register route exactly
 * (artifact → revision 1 → latestRevisionId relink, one transaction) and the
 * response is the same `{artifact}` shape (latestRevision + _count included).
 * Exactly ONE `schedule.created` audit event.
 */
export const POST = handler<{ id: string }>(async (req, ctx) => {
  const { id } = await ctx.params

  const project = await db.project.findUnique({ where: { id }, select: { id: true } })
  if (!project) return ERR.notFound("Project")

  // Slice 10: project isolation (contract §4)
  const access = await requireProjectAccess(id, "write")
  if (!access.ok) return access.response

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return ERR.badRequest("body must be valid JSON")
  }
  const parsed = parseSchedule(raw)
  if (!parsed.ok) return ERR.invalid(parsed.error)
  const schedule = parsed.value

  const bytes = Buffer.from(canonicalScheduleJson(schedule), "utf8")
  const artifactId = newId("art")
  const revisionId = newId("rev")
  const stored = await saveRevisionFile(id, artifactId, revisionId, bytes)

  try {
    // The FK (latestRevisionId) lives on Artifact itself, so Prisma cannot
    // nested-create the revision — write artifact, revision, then link them
    // in one transaction (the artifact-register route's exact pattern).
    const artifact = await db.$transaction(async (tx) => {
      const created = await tx.artifact.create({
        data: { id: artifactId, projectId: id, kind: "schedule", name: schedule.name },
      })
      await tx.artifactRevision.create({
        data: {
          id: revisionId,
          artifactId: created.id,
          revNumber: 1,
          contentHash: stored.sha256,
          sizeBytes: stored.sizeBytes,
          storageKey: stored.storageKey,
          mimeType: "application/json",
          uploadedBy: "local-operator",
        },
      })
      return tx.artifact.update({
        where: { id: created.id },
        data: { latestRevisionId: revisionId },
        include: { latestRevision: true, _count: { select: { revisions: true } } },
      })
    })

    await recordEvent({
      projectId: id,
      action: "schedule.created",
      entityType: "artifact",
      entityId: artifactId,
      detail: {
        name: schedule.name,
        kind: "schedule",
        sha256: stored.sha256,
        sizeBytes: stored.sizeBytes,
        revNumber: 1,
        activityCount: schedule.activities.length,
      },
    })

    return jsonOk({ artifact }, { status: 201 })
  } catch (err) {
    console.error("[api] schedule registration failed after file write — orphaned bytes remain in store:", err)
    throw err
  }
})
