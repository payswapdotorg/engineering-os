import { jsonError, jsonOk, ERR } from "@/lib/api-utils"
import { BrokerRefusalError, BrokerRequestError, runBrokerOperation } from "@/engines/broker"
import { readRevisionFile } from "@/lib/artifact-store"
import { parseRobotArmModelJsonText } from "@/core/analysis-schemas"
import { db } from "@/lib/db"

import { handler, requireProjectAccess } from "../../../../../_lib/route-helpers"
import { DERIVE_SUMMARIES, buildDeriveResponse } from "../../../../../_lib/derive-outcome"

export const dynamic = "force-dynamic"

/**
 * POST /api/projects/[id]/artifacts/[artifactId]/kinematics — run the REAL
 * Pinocchio (pip `pin`) kinematic analysis over the artifact's stored
 * eos-robot-arm-model/1 JSON and store the eos-robot-kinematics/1 result
 * document (contract §18.3/§18.5, Slice 32 — the robotics lane the Slice-28
 * license-first probe opened). Thin wrapper over
 * `runBrokerOperation("solve_kinematics", …)` — every number in the stored
 * document is copied VERBATIM from the engine's forward kinematics and
 * geometric Jacobian by the op core, which also owns find-or-create of the
 * kind-"analysis" artifact (derived_from this source, DRAFT approval state)
 * and the ONE `kinematics.solved` audit event.
 *
 * Input validation happens HERE against the frozen §18.2 zod
 * (src/core/analysis-schemas.ts) before the op runs: the artifact's latest
 * revision content must parse as a valid robot arm model, else 422 with the
 * verbatim joined message (`invalid robot model: …`). Unknown project/artifact
 * and revision-less artifacts fall through to the op core's pinned 404/400
 * messages. The closed-form refusals (FK or Jacobian disagreeing with the
 * planar closed forms beyond 1e-12) surface as honest 422s from the engine —
 * never a wrong kinematics result. Route-path audit actor is the engine
 * adapter (`adapter:pin`).
 */
export const POST = handler<{ id: string; artifactId: string }>(async (_req, ctx) => {
  const { id, artifactId } = await ctx.params

  // Slice 10: project isolation (contract §4)
  const access = await requireProjectAccess(id, "write")
  if (!access.ok) return access.response

  // Content pre-validation (the route's pinned §18.2 422s).
  const artifact = await db.artifact.findUnique({
    where: { id: artifactId },
    include: { latestRevision: true },
  })
  if (artifact && artifact.projectId === id && artifact.latestRevision) {
    const text = (await readRevisionFile(artifact.latestRevision.storageKey)).toString("utf8")
    const parsed = parseRobotArmModelJsonText(text)
    if (!parsed.ok) return ERR.invalid(parsed.error)
  }

  try {
    const outcome = await runBrokerOperation(
      "solve_kinematics",
      { projectId: id, actor: "adapter:pin" },
      { artifactId },
      {},
    )
    return jsonOk(
      {
        kinematics: await buildDeriveResponse({
          projectId: id,
          outcome,
          auditAction: "kinematics.solved",
          includeDocument: true,
          summarize: DERIVE_SUMMARIES.kinematics,
        }),
      },
      { status: 201 },
    )
  } catch (err) {
    if (err instanceof BrokerRequestError) {
      if (err.code === "not_found") return ERR.notFound(err.what ?? "Resource")
      if (err.code === "bad_request") return ERR.badRequest(err.message)
      return ERR.invalid(err.message)
    }
    if (err instanceof BrokerRefusalError) {
      return jsonError(422, err.code, err.message)
    }
    throw err // unexpected adapter failure → honest 500 via handler, logged
  }
})
