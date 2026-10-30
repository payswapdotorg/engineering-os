import { jsonError, jsonOk, ERR } from "@/lib/api-utils"
import { BrokerRefusalError, BrokerRequestError, runBrokerOperation } from "@/engines/broker"
import { readRevisionFile } from "@/lib/artifact-store"
import { parseRtlModelJsonText } from "@/core/analysis-schemas"
import { db } from "@/lib/db"

import { handler, requireProjectAccess } from "../../../../../_lib/route-helpers"
import { DERIVE_SUMMARIES, buildDeriveResponse } from "../../../../../_lib/derive-outcome"

export const dynamic = "force-dynamic"

/**
 * POST /api/projects/[id]/artifacts/[artifactId]/rtl — run the REAL amaranth
 * + yowasp-yosys RTL synthesis over the artifact's stored eos-chip-rtl-model/1
 * JSON and store the eos-chip-netlist/1 result document (contract §17.3/§17.5,
 * Slice 30 — the chip lane the Slice-28 license-first probe opened). Thin
 * wrapper over `runBrokerOperation("synthesize_rtl", …)` — every number in
 * the stored document is copied VERBATIM from the engine elaboration and the
 * yosys synthesis by the op core, which also owns find-or-create of the
 * kind-"analysis" artifact (derived_from this source, DRAFT approval state)
 * and the ONE `rtl.synthesized` audit event (both engines attributed).
 *
 * Input validation happens HERE against the frozen §17.2 zod
 * (src/core/analysis-schemas.ts) before the op runs: the artifact's latest
 * revision content must parse as a valid RTL model, else 422 with the
 * verbatim joined message (`invalid rtl model: …`). Unknown project/artifact
 * and revision-less artifacts fall through to the op core's pinned 404/400
 * messages. The closed-form refusals (a netlist whose flip-flop count ≠ the
 * register width, or a trajectory that disagrees with the counter closed
 * form) surface as honest 422s from the engine — never a wrong netlist.
 * Route-path audit actor is the engine adapter (`adapter:amaranth`).
 */
export const POST = handler<{ id: string; artifactId: string }>(async (_req, ctx) => {
  const { id, artifactId } = await ctx.params

  // Slice 10: project isolation (contract §4)
  const access = await requireProjectAccess(id, "write")
  if (!access.ok) return access.response

  // Content pre-validation (the route's pinned §17.2 422s).
  const artifact = await db.artifact.findUnique({
    where: { id: artifactId },
    include: { latestRevision: true },
  })
  if (artifact && artifact.projectId === id && artifact.latestRevision) {
    const text = (await readRevisionFile(artifact.latestRevision.storageKey)).toString("utf8")
    const parsed = parseRtlModelJsonText(text)
    if (!parsed.ok) return ERR.invalid(parsed.error)
  }

  try {
    const outcome = await runBrokerOperation(
      "synthesize_rtl",
      { projectId: id, actor: "adapter:amaranth" },
      { artifactId },
      {},
    )
    return jsonOk(
      {
        rtl: await buildDeriveResponse({
          projectId: id,
          outcome,
          auditAction: "rtl.synthesized",
          includeDocument: true,
          summarize: DERIVE_SUMMARIES.rtl,
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
