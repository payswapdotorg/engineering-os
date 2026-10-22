import { jsonError, jsonOk, ERR } from "@/lib/api-utils"
import { BrokerRefusalError, BrokerRequestError, runBrokerOperation } from "@/engines/broker"

import { handler } from "../../../../../_lib/route-helpers"
import { DERIVE_SUMMARIES, buildDeriveResponse } from "../../../../../_lib/derive-outcome"

export const dynamic = "force-dynamic"

/**
 * POST /api/projects/[id]/artifacts/[artifactId]/fe-mesh — run the REAL gmsh
 * adapter over the latest revision file (STEP/IFC) and store the
 * byte-deterministic eos-femesh/1 summary (contract §2/§8). The ENTIRE flow
 * lives in the broker op (ADR-0005 rule 1: the broker is the only execution
 * path); this route is a thin HTTP wrapper over `runBrokerOperation("fe_mesh",
 * …)` — validation, adapter run, find-or-create of the kind-"fe-mesh" artifact
 * (derived_from this source, sequential revision append per run, DRAFT
 * approval state) and the ONE `femesh.derived` audit event all come from the
 * op core. Parameters default inside the op ({meshSizeMin 2.0, meshSizeMax
 * 4.0, elementOrder 1}); the route reads no body. Failures surface as honest
 * 404/400 and 422 `unsupported`/`engine_unavailable` refusals, never a fake
 * mesh. Route-path audit actor is the engine adapter (`adapter:gmsh`), the
 * Phase-4 derive-route convention.
 */
export const POST = handler<{ id: string; artifactId: string }>(async (_req, ctx) => {
  const { id, artifactId } = await ctx.params

  try {
    const outcome = await runBrokerOperation(
      "fe_mesh",
      { projectId: id, actor: "adapter:gmsh" },
      { artifactId },
      {},
    )
    return jsonOk(
      {
        femesh: await buildDeriveResponse({
          projectId: id,
          outcome,
          auditAction: "femesh.derived",
          includeDocument: true,
          summarize: DERIVE_SUMMARIES.femesh,
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
