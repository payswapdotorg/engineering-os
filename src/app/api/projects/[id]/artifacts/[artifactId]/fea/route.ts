import { jsonError, jsonOk, ERR } from "@/lib/api-utils"
import { BrokerRefusalError, BrokerRequestError, runBrokerOperation } from "@/engines/broker"
import { readRevisionFile } from "@/lib/artifact-store"
import { parseFeaModelJsonText } from "@/core/analysis-schemas"
import { db } from "@/lib/db"

import { handler, requireProjectAccess } from "../../../../../_lib/route-helpers"
import { DERIVE_SUMMARIES, buildDeriveResponse } from "../../../../../_lib/derive-outcome"

export const dynamic = "force-dynamic"

/**
 * POST /api/projects/[id]/artifacts/[artifactId]/fea — run the REAL
 * scikit-fem plane-stress solve over the artifact's stored eos-fea-model/1
 * JSON and store the eos-fea/1 result document (contract §14.3/§14.5).
 * Thin wrapper over `runBrokerOperation("solve_fea", …)` — every number in
 * the stored document is copied VERBATIM from the engine solve by the op
 * core, which also owns find-or-create of the kind-"analysis" artifact
 * (derived_from this source, DRAFT approval state) and the ONE `fea.solved`
 * audit event.
 *
 * Input validation happens HERE against the frozen §14.2 zod
 * (src/core/analysis-schemas.ts) before the op runs: the artifact's latest
 * revision content must parse as a valid FEA model, else 422 with the
 * verbatim joined message (`invalid FEA model: …`). Unknown project/artifact
 * and revision-less artifacts fall through to the op core's pinned 404/400
 * messages. Under-constrained models (free rigid-body modes) surface as
 * honest 422 refusals from the engine — never simulated results.
 * Route-path audit actor is the engine adapter (`adapter:scikit-fem`).
 */
export const POST = handler<{ id: string; artifactId: string }>(async (_req, ctx) => {
  const { id, artifactId } = await ctx.params

  // Slice 10: project isolation (contract §4)
  const access = await requireProjectAccess(id, "write")
  if (!access.ok) return access.response

  // Content pre-validation (the route's pinned §14.2 422s).
  const artifact = await db.artifact.findUnique({
    where: { id: artifactId },
    include: { latestRevision: true },
  })
  if (artifact && artifact.projectId === id && artifact.latestRevision) {
    const text = (await readRevisionFile(artifact.latestRevision.storageKey)).toString("utf8")
    const parsed = parseFeaModelJsonText(text)
    if (!parsed.ok) return ERR.invalid(parsed.error)
  }

  try {
    const outcome = await runBrokerOperation(
      "solve_fea",
      { projectId: id, actor: "adapter:scikit-fem" },
      { artifactId },
      {},
    )
    return jsonOk(
      {
        fea: await buildDeriveResponse({
          projectId: id,
          outcome,
          auditAction: "fea.solved",
          includeDocument: true,
          summarize: DERIVE_SUMMARIES.fea,
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
