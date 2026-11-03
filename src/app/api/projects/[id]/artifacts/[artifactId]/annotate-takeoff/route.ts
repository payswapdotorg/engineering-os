import { jsonError, jsonOk, ERR } from "@/lib/api-utils"
import { BrokerRefusalError, BrokerRequestError, runBrokerOperation } from "@/engines/broker"

import { handler, requireProjectAccess } from "../../../../../_lib/route-helpers"
import { buildDeriveResponse } from "../../../../../_lib/derive-outcome"

export const dynamic = "force-dynamic"

/**
 * POST /api/projects/[id]/artifacts/[artifactId]/annotate-takeoff — the
 * agent takeoff surface's annotate op (ADR-0011 Stage 4): a THIN wrapper
 * over `runBrokerOperation("annotate_takeoff", …)`. The adopted engine
 * writes the takeoff markups into the PDF as STANDARD annotations (opens in
 * Bluebeam Revu, Adobe Acrobat and the web app).
 *
 * Body (all fields pass through as broker parameters):
 *   { "markups"?: [ { "type": "length"|"area"|"count", "label"?: …,
 *                     "page": 1, "points": [[x, y], …] } ]
 *     "keepExisting"?: false }
 *
 * The DEFAULT (markups absent): the revision's OWN Sheet Measure rows — the
 * length/area/count markups a human already measured on this revision
 * become the annotations (the product loop: measure → annotate → export).
 * No rows and no explicit markups is the pinned verbatim 422. The output is
 * a kind-"pdf" artifact; the response serves META only (the PDF route
 * precedent — binary content is not inlined into JSON).
 */
export const POST = handler<{ id: string; artifactId: string }>(async (req, ctx) => {
  const { id, artifactId } = await ctx.params

  // Slice 10: project isolation (contract §4)
  const access = await requireProjectAccess(id, "write")
  if (!access.ok) return access.response

  // Optional JSON body → broker parameters (the vector-takeoff precedent)
  let parameters: Record<string, unknown> = {}
  const text = await req.text()
  if (text.trim().length > 0) {
    try {
      parameters = JSON.parse(text) as Record<string, unknown>
    } catch {
      return ERR.badRequest("body must be valid JSON")
    }
  }

  try {
    const outcome = await runBrokerOperation(
      "annotate_takeoff",
      { projectId: id, actor: "local-operator" },
      { artifactId },
      parameters,
    )
    return jsonOk(
      {
        annotate: await buildDeriveResponse({
          projectId: id,
          outcome,
          auditAction: "takeoff.pdfAnnotated",
          includeOutcomeSummary: true, // markupCount / kept — the binary output has no JSON document
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
