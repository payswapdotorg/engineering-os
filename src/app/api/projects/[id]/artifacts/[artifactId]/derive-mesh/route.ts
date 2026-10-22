import { jsonError, jsonOk, ERR } from "@/lib/api-utils"
import { BrokerRefusalError, BrokerRequestError, brokerDeriveMeshCore } from "@/engines/broker"

import { handler, requireProjectAccess } from "../../../../../_lib/route-helpers"

export const dynamic = "force-dynamic"

/**
 * POST /api/projects/[id]/artifacts/[artifactId]/derive-mesh — run the REAL
 * tessellation adapter on the latest revision file and store one
 * byte-deterministic eos-mesh/1 revision (Contract A: NO timestamps). The
 * ENTIRE flow lives in the broker core (ADR-0005 rule 1: the broker is the
 * only execution path); this route is a thin HTTP wrapper over
 * `brokerDeriveMeshCore` (src/engines/broker.ts). The mesh lands on its OWN
 * artifact of kind "mesh", linked `derived_from` this source: first derive
 * creates the artifact (rev 1); every later derive appends the NEXT
 * sequential revision to that same artifact. Detection is the canonical
 * multi-signal check (src/engines/adapters/derive-kind.ts). Failures surface
 * as honest 404/400 and 422 `unsupported`/`engine_unavailable` refusals,
 * never a fake mesh. Byte-stable contract: the pinned messages, the 201
 * response shape, the orphan-log line and the single `mesh.derived` audit
 * event come from the core unchanged (passing no workflow opts keeps the
 * `adapter:<engine>` audit actors exactly as before).
 */
export const POST = handler<{ id: string; artifactId: string }>(async (_req, ctx) => {
  const { id, artifactId } = await ctx.params

  // Slice 10: project isolation (contract §4)
  const access = await requireProjectAccess(id, "write")
  if (!access.ok) return access.response

  try {
    const core = await brokerDeriveMeshCore(id, artifactId)
    return jsonOk({ mesh: core.mesh }, { status: 201 })
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
