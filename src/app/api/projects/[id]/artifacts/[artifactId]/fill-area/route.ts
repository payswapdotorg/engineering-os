import { jsonError, jsonOk, ERR } from "@/lib/api-utils"
import { BrokerRefusalError, BrokerRequestError, runBrokerOperation } from "@/engines/broker"

import { handler, requireProjectAccess } from "../../../../../_lib/route-helpers"
import { DERIVE_SUMMARIES, buildDeriveResponse } from "../../../../../_lib/derive-outcome"

export const dynamic = "force-dynamic"

/**
 * POST /api/projects/[id]/artifacts/[artifactId]/fill-area — the agent
 * takeoff surface's room fill (ADR-0011 Stage 4): a THIN wrapper over
 * `runBrokerOperation("fill_area", …)`. The adopted engine's Magic Fill
 * measures the room containing the click point; the output is an
 * eos-room-fill/1 EVIDENCE artifact for human review.
 *
 * Body (all fields pass through as broker parameters):
 *   { "at": [x, y]              REQUIRED — a finite point INSIDE the room, PDF points
 *     "pageNo"?: 1              positive integer
 *     "label"?: "Room 101"      1..120 chars
 *     "scaleMmPerPt"?: 35.27…   the calibration red line: EITHER this explicit
 *                               parameter OR the revision's Sheet Measure
 *                               calibration markup — NEITHER is the verbatim
 *                               422 (an uncalibrated takeoff number is a
 *                               fabricated number, never returned). }
 *
 * The route adds NO semantics of its own: every validation message is the
 * broker core's pinned verbatim refusal (the e2e pins them byte-for-byte).
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
      "fill_area",
      { projectId: id, actor: "local-operator" },
      { artifactId },
      parameters,
    )
    return jsonOk(
      {
        fill: await buildDeriveResponse({
          projectId: id,
          outcome,
          auditAction: "takeoff.roomFilled",
          includeDocument: true,
          summarize: DERIVE_SUMMARIES.roomFill,
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
