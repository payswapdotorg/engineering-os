import { jsonError, jsonOk, ERR } from "@/lib/api-utils"
import { BrokerRefusalError, BrokerRequestError, runBrokerOperation } from "@/engines/broker"

import { handler, requireProjectAccess } from "../../../../../_lib/route-helpers"
import { buildDeriveResponse } from "../../../../../_lib/derive-outcome"

export const dynamic = "force-dynamic"

/**
 * POST /api/projects/[id]/artifacts/[artifactId]/export-boq — the agent
 * takeoff surface's BOQ export (ADR-0011 Stage 4): a THIN wrapper over
 * `runBrokerOperation("export_boq_xlsx", …)`. Reads a PDF's pdf2takeoff
 * annotations back out as a bill-of-quantities table.
 *
 * Body (all fields pass through as broker parameters):
 *   { "format"?: "xlsx" | "csv"   XLSX is the DEFAULT; CSV only EXPLICIT
 *     "unit"?: "m"|"mm"|"cm"|"ft"|"in"   default m
 *     "scaleMmPerPt"?: …           the calibration red line (fill-area precedent) }
 *
 * Honesty pin: rowCount is 0 for XLSX — the binary workbook's rows are not
 * re-parsed (the CSV twin carries the row pins); the response reports the
 * honest zero, never a guessed count. The output is a kind-"document"
 * artifact (xlsx/csv bytes); the response serves META only.
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
      "export_boq_xlsx",
      { projectId: id, actor: "local-operator" },
      { artifactId },
      parameters,
    )
    return jsonOk(
      {
        export: await buildDeriveResponse({
          projectId: id,
          outcome,
          auditAction: "takeoff.boqExported",
          includeOutcomeSummary: true, // formatRequested / rowCount / scaleRatio — binary output, no JSON document
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
