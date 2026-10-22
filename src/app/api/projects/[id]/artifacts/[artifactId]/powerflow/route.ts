import { jsonError, jsonOk, ERR } from "@/lib/api-utils"
import { BrokerRefusalError, BrokerRequestError, runBrokerOperation } from "@/engines/broker"
import { readRevisionFile } from "@/lib/artifact-store"
import { parsePowerflowNetworkJsonText } from "@/core/analysis-schemas"
import { db } from "@/lib/db"

import { handler } from "../../../../../_lib/route-helpers"
import { DERIVE_SUMMARIES, buildDeriveResponse } from "../../../../../_lib/derive-outcome"

export const dynamic = "force-dynamic"

/**
 * POST /api/projects/[id]/artifacts/[artifactId]/powerflow — run the REAL
 * pandapower Newton-Raphson power flow over the artifact's stored
 * eos-powerflow-network/1 JSON and store the eos-powerflow/1 result document
 * (contract §2/§8). Thin wrapper over `runBrokerOperation("run_powerflow", …)`
 * — every number in the stored document is copied VERBATIM from the engine
 * result frames by the op core, which also owns find-or-create of the
 * kind-"analysis" artifact (derived_from this source, DRAFT approval state)
 * and the ONE `powerflow.derived` audit event.
 *
 * Input validation happens HERE against the frozen §3.2 zod
 * (src/core/analysis-schemas.ts) before the op runs: the artifact's latest
 * revision content must parse as a valid network, else 422 with the verbatim
 * joined message (`invalid power flow network: …`). Unknown project/artifact
 * and revision-less artifacts fall through to the op core's pinned 404/400
 * messages. Non-convergence and islanded networks surface as honest 422
 * refusals from the engine — never simulated results. Route-path audit actor
 * is the engine adapter (`adapter:pandapower`).
 */
export const POST = handler<{ id: string; artifactId: string }>(async (_req, ctx) => {
  const { id, artifactId } = await ctx.params

  // Content pre-validation (the route's pinned §3.2 422s).
  const artifact = await db.artifact.findUnique({
    where: { id: artifactId },
    include: { latestRevision: true },
  })
  if (artifact && artifact.projectId === id && artifact.latestRevision) {
    const text = (await readRevisionFile(artifact.latestRevision.storageKey)).toString("utf8")
    const parsed = parsePowerflowNetworkJsonText(text)
    if (!parsed.ok) return ERR.invalid(parsed.error)
  }

  try {
    const outcome = await runBrokerOperation(
      "run_powerflow",
      { projectId: id, actor: "adapter:pandapower" },
      { artifactId },
      {},
    )
    return jsonOk(
      {
        powerflow: await buildDeriveResponse({
          projectId: id,
          outcome,
          auditAction: "powerflow.derived",
          includeDocument: true,
          summarize: DERIVE_SUMMARIES.powerflow,
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
