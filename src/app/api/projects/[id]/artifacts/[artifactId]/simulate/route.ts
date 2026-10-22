import { jsonError, jsonOk, ERR } from "@/lib/api-utils"
import { BrokerRefusalError, BrokerRequestError, runBrokerOperation } from "@/engines/broker"
import { readRevisionFile } from "@/lib/artifact-store"
import { parseDesScenarioJsonText } from "@/core/analysis-schemas"
import { db } from "@/lib/db"

import { handler } from "../../../../../_lib/route-helpers"
import { DERIVE_SUMMARIES, buildDeriveResponse } from "../../../../../_lib/derive-outcome"

export const dynamic = "force-dynamic"

/**
 * POST /api/projects/[id]/artifacts/[artifactId]/simulate — run the REAL SimPy
 * discrete-event simulation over the artifact's stored eos-des-scenario/1 JSON
 * (FIFO resources, fixed durations — deterministic by construction) and store
 * the eos-des/1 record (makespan, per-resource busy/utilization, per-job
 * start/end — contract §2/§8). Thin wrapper over `runBrokerOperation("run_des",
 * …)`: the op core owns the adapter run, find-or-create of the kind-"analysis"
 * artifact (derived_from this source, DRAFT approval state), and the ONE
 * `sim.completed` audit event.
 *
 * Input validation happens HERE against the frozen §3.3 zod
 * (src/core/analysis-schemas.ts) before the op runs — zero-duration tasks and
 * tasks referencing absent resources are schema-refused with the verbatim
 * joined message (`invalid DES scenario: …`), never an engine error. Unknown
 * project/artifact and revision-less artifacts fall through to the op core's
 * pinned 404/400 messages. Route-path audit actor is the engine adapter
 * (`adapter:simpy`).
 */
export const POST = handler<{ id: string; artifactId: string }>(async (_req, ctx) => {
  const { id, artifactId } = await ctx.params

  // Content pre-validation (the route's pinned §3.3 422s).
  const artifact = await db.artifact.findUnique({
    where: { id: artifactId },
    include: { latestRevision: true },
  })
  if (artifact && artifact.projectId === id && artifact.latestRevision) {
    const text = (await readRevisionFile(artifact.latestRevision.storageKey)).toString("utf8")
    const parsed = parseDesScenarioJsonText(text)
    if (!parsed.ok) return ERR.invalid(parsed.error)
  }

  try {
    const outcome = await runBrokerOperation(
      "run_des",
      { projectId: id, actor: "adapter:simpy" },
      { artifactId },
      {},
    )
    return jsonOk(
      {
        sim: await buildDeriveResponse({
          projectId: id,
          outcome,
          auditAction: "sim.completed",
          includeDocument: true,
          summarize: DERIVE_SUMMARIES.sim,
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
