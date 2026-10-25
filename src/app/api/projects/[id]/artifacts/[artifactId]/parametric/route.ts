import { jsonError, jsonOk, ERR } from "@/lib/api-utils"
import {
  BrokerRefusalError,
  BrokerRequestError,
  brokerParametricSchemaCore,
  brokerRebuildParametricCore,
} from "@/engines/broker"

import { handler, requireProjectAccess } from "../../../../../_lib/route-helpers"

export const dynamic = "force-dynamic"

/**
 * GET  /api/projects/[id]/artifacts/[artifactId]/parametric — the parametric
 * model's declared PARAM_SCHEMA + authored DEFAULT_PARAMS (Slice 16, the
 * roadmap-gap-audit item-2 integration; the Design Studio parameter-form
 * source). A live adapter schema-mode run through the broker core (ADR-0005:
 * the broker is the only engine path — reads included); no persistence, no
 * audit event (the mesh GET precedent). Read access: viewers may open the
 * form; the REBUILD (POST) is the write-gated side.
 *
 * POST — `rebuild_parametric` (the eleventh broker op; this route is the thin
 * HTTP wrapper over the core — the derive-quantities/derive-mesh route
 * precedent, while the workflow executor reaches the same core through
 * runBrokerOperation): body `{values?: {param: number, …}}` (absent/empty =
 * the authored defaults). The core validates against the model's schema
 * (pinned 422s BEFORE any engine spawn), builds via cadquery, gate-checks the
 * volume against the model's analytic closed form, and persists the STEP on a
 * find-or-create kind-"model" artifact derived_from the script artifact —
 * sequential revisions per rebuild, downstream meshes go stale (the shared
 * cascade), ONE `parametric.rebuilt` audit event carrying the parameters
 * used. The adapter's verbatim refusals (range / unknown key / type /
 * geometry contradiction / ground-truth disagreement) surface as 422
 * engine_unavailable. Route-path audit actor is the requesting member (the
 * rebuild is a USER authoring decision, unlike engine-derived documents).
 */
export const GET = handler<{ id: string; artifactId: string }>(async (req, ctx) => {
  const { id, artifactId } = await ctx.params

  const access = await requireProjectAccess(id, "read")
  if (!access.ok) return access.response

  try {
    const schema = await brokerParametricSchemaCore(id, artifactId)
    return jsonOk(schema)
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

export const POST = handler<{ id: string; artifactId: string }>(async (req, ctx) => {
  const { id, artifactId } = await ctx.params

  const access = await requireProjectAccess(id, "write")
  if (!access.ok) return access.response

  // Optional body: absent/empty → {} (the authored defaults). Malformed JSON
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

  try {
    const core = await brokerRebuildParametricCore(id, artifactId, body, {
      actor: `user:${access.session.email}`,
    })
    return jsonOk(
      {
        model: core.model,
        engineKey: core.engineKey,
        engineVersion: core.engineVersion,
        adapterScript: core.adapterScript,
        adapterHash: core.adapterHash,
        durationMs: core.durationMs,
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
    throw err
  }
})
