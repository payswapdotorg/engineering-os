import { jsonError, jsonOk, ERR } from "@/lib/api-utils"
import { BrokerRefusalError, BrokerRequestError, brokerDeriveQuantitiesCore } from "@/engines/broker"

import { handler } from "../../../../../_lib/route-helpers"
import { serializeQuantityRows } from "../../../../../_lib/ledger-rows"

export const dynamic = "force-dynamic"

/**
 * POST /api/projects/[id]/artifacts/[artifactId]/derive-quantities — run the
 * REAL engine adapter on the latest revision file and create one draft
 * model-derived QuantityRecord per DerivedQuantity. The ENTIRE flow lives in
 * the broker core (ADR-0005 rule 1: the broker is the only execution path);
 * this route is a thin HTTP wrapper over `brokerDeriveQuantitiesCore`
 * (src/engines/broker.ts) — detection is the canonical multi-signal check
 * (src/engines/adapters/derive-kind.ts), failures surface as honest 404/400
 * and 422 `unsupported`/`engine_unavailable` refusals, never a fake result.
 * Byte-stable contract: the pinned messages, response shapes and the single
 * `quantity.derived` audit event come from the core unchanged (passing no
 * workflow opts keeps the `adapter:<engine>` audit actors exactly as before).
 */
export const POST = handler<{ id: string; artifactId: string }>(async (_req, ctx) => {
  const { id, artifactId } = await ctx.params

  try {
    const core = await brokerDeriveQuantitiesCore(id, artifactId)
    return jsonOk({ quantities: await serializeQuantityRows(core.created) }, { status: 201 })
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
