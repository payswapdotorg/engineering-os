import { jsonError, jsonOk, ERR } from "@/lib/api-utils"
import { BrokerRefusalError, BrokerRequestError, runBrokerOperation } from "@/engines/broker"
import { readRevisionFile } from "@/lib/artifact-store"
import { parseScheduleJsonText } from "@/core/analysis-schemas"
import { db } from "@/lib/db"

import { handler } from "../../../../../_lib/route-helpers"
import { DERIVE_SUMMARIES, buildDeriveResponse } from "../../../../../_lib/derive-outcome"

export const dynamic = "force-dynamic"

/**
 * POST /api/projects/[id]/artifacts/[artifactId]/analyze-schedule — run the
 * PLATFORM CPM core (src/core/cpm.ts — pure, no engine) over the artifact's
 * stored eos-schedule/1 JSON and store the byte-deterministic eos-cpm/1
 * analysis document (contract §2/§6/§8). Thin wrapper over
 * `runBrokerOperation("analyze_schedule", …)`: the op core reads the stored
 * schedule, runs the pure core, serializes the pinned-key-order document,
 * find-or-creates the kind-"analysis" artifact (derived_from the schedule) and
 * writes the ONE `schedule.analyzed` audit event.
 *
 * This op is a PLATFORM CORE, not an engine: engineKey/engineVersion/
 * adapterScript/adapterHash are honestly ABSENT in the outcome and therefore
 * null in the 201 response and the workflow execution records — the analysis is
 * never faked as an engine (AC-P5-05). The route-path audit actor is the
 * requesting human operator ("local-operator").
 *
 * Input validation happens HERE against the frozen §3.1 zod
 * (src/core/analysis-schemas.ts) before the op runs — the pinned verbatim 422s
 * for duplicate ids, unknown predecessors and cycles (`invalid schedule: …`).
 * Unknown project/artifact and revision-less artifacts fall through to the op
 * core's pinned 404/400 messages.
 */
export const POST = handler<{ id: string; artifactId: string }>(async (_req, ctx) => {
  const { id, artifactId } = await ctx.params

  // Content pre-validation (the route's pinned §3.1 422s).
  const artifact = await db.artifact.findUnique({
    where: { id: artifactId },
    include: { latestRevision: true },
  })
  if (artifact && artifact.projectId === id && artifact.latestRevision) {
    const text = (await readRevisionFile(artifact.latestRevision.storageKey)).toString("utf8")
    const parsed = parseScheduleJsonText(text)
    if (!parsed.ok) return ERR.invalid(parsed.error)
  }

  try {
    const outcome = await runBrokerOperation(
      "analyze_schedule",
      { projectId: id, actor: "local-operator" },
      { artifactId },
      {},
    )
    return jsonOk(
      {
        analysis: await buildDeriveResponse({
          projectId: id,
          outcome,
          auditAction: "schedule.analyzed",
          includeDocument: true,
          summarize: DERIVE_SUMMARIES.analysis,
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
    throw err // unexpected core failure → honest 500 via handler, logged
  }
})
