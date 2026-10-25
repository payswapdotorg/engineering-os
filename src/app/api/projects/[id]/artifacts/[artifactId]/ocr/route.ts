import { jsonError, jsonOk, ERR } from "@/lib/api-utils"
import { BrokerRefusalError, BrokerRequestError, brokerSheetOcrCore } from "@/engines/broker"

import { handler, requireProjectAccess } from "../../../../../_lib/route-helpers"

export const dynamic = "force-dynamic"

/**
 * POST /api/projects/[id]/artifacts/[artifactId]/ocr — sheet-text OCR region
 * read (Slice 16-B, roadmap-gap-audit item 3, the 16-R2 research):
 *
 * body { imageBase64: string, psm?: number } — the Sheet Measure client
 * renders the operator's picked region offscreen at a FIXED 4× page scale
 * (zoom-independent, the auto-count precedent) and POSTs the PNG as base64.
 * The core gates the source as a PDF sheet revision (the takeoff_sheet
 * signal), runs the REAL tesseract 5 bridge through the broker (ADR-0005: no
 * engine call ever bypasses it), and returns the words: raw transcript +
 * confidence + raster boxes + the documented Ø normalization (tesseract never
 * reads the Ø glyph — "@400" maps to "Ø400" with the raw ALWAYS preserved).
 *
 * A READ: no persistence, no audit event (the mesh-GET / schema-read
 * precedent) — the ACCEPT of a reviewed transcript goes through the existing
 * markups contract (kind "text-hits" + the payload column). Read access:
 * viewers can read text (the client-side auto-count scan precedent); nothing
 * is written by this route. 422s (non-PDF source, bad base64, non-PNG,
 * oversize region, engine unavailable) surface verbatim.
 */
export const POST = handler<{ id: string; artifactId: string }>(async (req, ctx) => {
  const { id, artifactId } = await ctx.params

  const access = await requireProjectAccess(id, "read")
  if (!access.ok) return access.response

  let body: Record<string, unknown>
  try {
    const text = await req.text()
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    return ERR.badRequest("request body must be a JSON object")
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return ERR.badRequest("request body must be a JSON object")
  }

  try {
    const result = await brokerSheetOcrCore(id, artifactId, body)
    return jsonOk(result)
  } catch (err) {
    if (err instanceof BrokerRequestError) {
      if (err.code === "not_found") return ERR.notFound(err.what ?? "Resource")
      if (err.code === "bad_request") return ERR.badRequest(err.message)
      return ERR.invalid(err.message)
    }
    if (err instanceof BrokerRefusalError) {
      return jsonError(422, err.code, err.message)
    }
    throw err
  }
})
