import { jsonError, jsonOk, ERR } from "@/lib/api-utils"
import { BrokerRefusalError, BrokerRequestError, runBrokerOperation, type BrokerOperation } from "@/engines/broker"

import { db } from "@/lib/db"
import { handler, requireProjectAccess } from "../../../../../_lib/route-helpers"
import { DERIVE_SUMMARIES, buildDeriveResponse } from "../../../../../_lib/derive-outcome"

export const dynamic = "force-dynamic"

/**
 * POST /api/projects/[id]/artifacts/[artifactId]/vector-takeoff — extract REAL
 * vector geometry from the artifact's latest revision (Slice 15, roadmap-gap-
 * audit item 1):
 *
 *   PDF sheet  → the `takeoff_sheet` op (pdfplumber over the drawn path
 *                operators; curve control points flattened at the pinned N;
 *                scale = explicit parameters.scaleMmPerPt, else the
 *                revision's Sheet Measure calibration markup, else an honest
 *                422 telling the user to calibrate first)
 *   DXF drawing → the `takeoff_drawing` op (ezdxf; declared-mm units only;
 *                per-layer counts/lengths/areas with EXACT arc + circle math)
 *   DWG        → the pinned 422 naming the documented operator-side
 *                converters (no open CI-pinnable DWG path exists — 16-R1)
 *
 * The op persists a byte-deterministic eos-vector-takeoff/1 document on a
 * find-or-create kind-"calculation" artifact derived_from the source
 * revision (the femesh precedent) and writes the ONE
 * takeoff.vectorDerived/takeoff.dxfDerived audit event. Ledger rows stay
 * HUMAN-disposed: the extraction is evidence; recording quantities from it
 * goes through the existing quantities contract. The route is a thin HTTP
 * wrapper over `runBrokerOperation` (ADR-0005 rule 1) and reads an OPTIONAL
 * JSON body: {pageNo?, scaleMmPerPt?, flattenSegments?} for sheets,
 * {layerFilter?} for drawings. Route-path audit actor is the engine adapter
 * (`adapter:pdfplumber` / `adapter:ezdxf`).
 */
export const POST = handler<{ id: string; artifactId: string }>(async (req, ctx) => {
  const { id, artifactId } = await ctx.params

  // Slice 10: project isolation (contract §4)
  const access = await requireProjectAccess(id, "write")
  if (!access.ok) return access.response

  // Optional body: absent/empty → {} (the op defaults apply). Malformed JSON
  // is an honest 400 — never silently treated as empty.
  let body: Record<string, unknown> = {}
  try {
    const text = await req.text()
    if (text.length > 0) body = JSON.parse(text) as Record<string, unknown>
  } catch {
    return ERR.badRequest("request body must be a JSON object when provided")
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return ERR.badRequest("request body must be a JSON object when provided")
  }

  // Op selection by the latest revision's signals (the cores re-gate and own
  // the pinned refusals — this peek only routes).
  const artifact = await db.artifact.findUnique({
    where: { id: artifactId },
    include: { latestRevision: true },
  })
  if (!artifact || artifact.projectId !== id || !artifact.latestRevision) {
    return ERR.notFound("Artifact")
  }
  const name = artifact.name.toLowerCase()
  const mime = artifact.latestRevision.mimeType
  let operation: BrokerOperation
  if (
    name.endsWith(".dxf") ||
    mime === "image/vnd.dxf" ||
    mime === "application/dxf" ||
    name.endsWith(".dwg") ||
    mime === "image/vnd.dwg"
  ) {
    operation = "takeoff_drawing" // the core owns the honest DWG refusal
  } else {
    operation = "takeoff_sheet" // the core owns the honest non-PDF refusal
  }

  try {
    const outcome = await runBrokerOperation(
      operation,
      { projectId: id, actor: operation === "takeoff_sheet" ? "adapter:pdfplumber" : "adapter:ezdxf" },
      { artifactId },
      body,
    )
    return jsonOk(
      {
        takeoff: await buildDeriveResponse({
          projectId: id,
          outcome,
          auditAction: operation === "takeoff_sheet" ? "takeoff.vectorDerived" : "takeoff.dxfDerived",
          includeDocument: true,
          summarize:
            operation === "takeoff_sheet" ? DERIVE_SUMMARIES.takeoffSheet : DERIVE_SUMMARIES.takeoffDrawing,
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
