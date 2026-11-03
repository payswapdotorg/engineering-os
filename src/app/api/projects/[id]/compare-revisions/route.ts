import { z } from "zod"

import { jsonError, jsonOk, ERR } from "@/lib/api-utils"
import { BrokerRefusalError, BrokerRequestError, runBrokerOperation } from "@/engines/broker"

import { handler, requireProjectAccess } from "../../../_lib/route-helpers"
import { DERIVE_SUMMARIES, buildDeriveResponse } from "../../../_lib/derive-outcome"

export const dynamic = "force-dynamic"

/**
 * POST /api/projects/[id]/compare-revisions — the agent takeoff surface's
 * revision compare (ADR-0011 Stage 4): a PROJECT-SCOPED thin wrapper over
 * `runBrokerOperation("compare_revisions", …)` — the pair takes TWO
 * artifacts, so the route lives at the project level (exactly the workflow
 * schema's shape), not under one artifact.
 *
 * Body:
 *   { "artifactIds": ["<old id>", "<new id>"] }   EXACTLY 2, DISTINCT
 *
 * The route zod refuses every other shape (1/3 ids, self-comparison,
 * non-strings) with the SAME messages the workflow schema pins; the broker
 * core independently re-validates and enforces that BOTH artifacts belong
 * to THIS project (defense in depth — the project scope is the isolation
 * boundary). The output is an eos-revision-compare/1 analysis artifact
 * derived from the NEW revision, linked to both inputs.
 */
const CompareRevisionsBodySchema = z.strictObject({
  artifactIds: z
    .array(z.string().min(1, "artifact ids must be non-empty strings"))
    .length(2, "artifactIds must be EXACTLY 2 artifact ids [old, new]"),
})

export const POST = handler<{ id: string }>(async (req, ctx) => {
  const { id } = await ctx.params

  // Slice 10: project isolation (contract §4)
  const access = await requireProjectAccess(id, "write")
  if (!access.ok) return access.response

  const text = await req.text()
  if (text.trim().length === 0) {
    return ERR.invalid("compare_revisions requires a body: { artifactIds: [oldId, newId] }")
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return ERR.badRequest("body must be valid JSON")
  }
  const parsed = CompareRevisionsBodySchema.safeParse(body)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => {
        const at = issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""
        return `${at}${issue.message}`
      })
      .join("; ")
    return ERR.invalid(issues)
  }
  const [oldId, newId] = parsed.data.artifactIds
  if (oldId === newId) {
    return ERR.invalid(
      "inputs.artifactIds for compare_revisions must be two DIFFERENT artifacts — a revision cannot be compared with itself",
    )
  }

  try {
    const outcome = await runBrokerOperation(
      "compare_revisions",
      { projectId: id, actor: "local-operator" },
      { artifactIds: [oldId, newId] },
      {},
    )
    return jsonOk(
      {
        compare: await buildDeriveResponse({
          projectId: id,
          outcome,
          auditAction: "takeoff.revisionsCompared",
          includeDocument: true,
          includeOutcomeSummary: true, // oldArtifactId / newArtifactId ride the outcome summary
          summarize: DERIVE_SUMMARIES.revisionCompare,
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
