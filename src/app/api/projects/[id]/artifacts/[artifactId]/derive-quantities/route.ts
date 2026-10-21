import path from "node:path"

import { LedgerError, makeQuantityRecord, type QuantityRecord } from "@/core"
import { EngineUnavailableError, deriveFromFile } from "@/engines/adapters/quantities"
import { deriveKind } from "@/engines/adapters/derive-kind"
import { recordEvent } from "@/lib/audit"
import { jsonError, jsonOk, ERR } from "@/lib/api-utils"
import { getStorageRoot } from "@/lib/artifact-store"
import { db } from "@/lib/db"
import { newId } from "@/lib/ids"

import { handler } from "../../../../../_lib/route-helpers"
import { serializeQuantityRows } from "../../../../../_lib/ledger-rows"

export const dynamic = "force-dynamic"

/**
 * POST /api/projects/[id]/artifacts/[artifactId]/derive-quantities — run the
 * REAL engine adapter (W2 bridge) on the latest revision file and create one
 * draft model-derived QuantityRecord per DerivedQuantity. Detection is the
 * canonical multi-signal check (src/engines/adapters/derive-kind.ts): this
 * content store's storageKey never carries the original extension, so the
 * artifact name and stored MIME type are the usual signals. The bridge stub
 * honestly throws until W2-b ships; that surfaces as 422 `engine_unavailable`,
 * never a fake result.
 */
export const POST = handler<{ id: string; artifactId: string }>(async (_req, ctx) => {
  const { id, artifactId } = await ctx.params

  const project = await db.project.findUnique({ where: { id }, select: { id: true } })
  if (!project) return ERR.notFound("Project")

  const artifact = await db.artifact.findUnique({
    where: { id: artifactId },
    include: { latestRevision: true },
  })
  if (!artifact || artifact.projectId !== id) return ERR.notFound("Artifact")
  if (!artifact.latestRevision) {
    return ERR.badRequest("This artifact has no revisions to derive quantities from")
  }
  const revision = artifact.latestRevision

  const kind = deriveKind(revision.storageKey, artifact.name, revision.mimeType)
  if (!kind) {
    return jsonError(
      422,
      "unsupported",
      `artifact "${artifact.name}" (storage key ${revision.storageKey}) does not carry a derivable model extension (.step/.stp/.ifc)`,
    )
  }

  const absPath = path.join(getStorageRoot(), revision.storageKey, "content")

  const result = await (async () => {
    try {
      return await deriveFromFile(absPath, kind)
    } catch (err) {
      if (err instanceof EngineUnavailableError) {
        return { unavailable: err } as const
      }
      throw err // unexpected adapter failure → honest 500 via handler, logged
    }
  })()
  if ("unavailable" in result) {
    return jsonError(422, "engine_unavailable", result.unavailable.message)
  }

  // One draft ledger row per DerivedQuantity — all validated BEFORE anything is
  // written (no partial derive). Values come from the engine, identity from
  // the adapter: method model-derived, elementRef from the engine, quantity
  // method "<engine> <version> via <adapterScript>", ruleset pinned per kind.
  const rulesetId = kind === "step" ? "step-geometric" : "ifc-base-quantities"
  let records: QuantityRecord[]
  try {
    records = result.quantities.map((dq) =>
      makeQuantityRecord({
        id: newId("qty"),
        projectId: id,
        sourceArtifactRevisionId: revision.id,
        elementRef: dq.elementRef,
        quantityType: dq.quantityType,
        value: dq.value,
        unit: dq.unit,
        method: "model-derived",
        quantityMethod: `${result.engineKey} ${result.engineVersion} via ${result.adapterScript}`,
        rulesetId,
        rulesetVersion: "0.1",
        createdBy: `adapter:${result.engineKey}`,
      }),
    )
  } catch (err) {
    if (err instanceof LedgerError) return ERR.invalid(err.message)
    throw err
  }

  const created = await db.$transaction(
    records.map((record) =>
      db.quantityRecord.create({
        data: {
          id: record.id,
          projectId: record.projectId,
          sourceArtifactRevisionId: record.sourceArtifactRevisionId,
          sheetRef: record.sheetRef ?? null,
          elementRef: record.elementRef ?? null,
          quantityType: record.quantityType,
          value: record.value,
          unit: record.unit,
          method: record.method,
          scale: record.scale ?? null,
          quantityMethod: record.quantityMethod ?? null,
          rulesetId: record.rulesetId,
          rulesetVersion: record.rulesetVersion,
          status: record.status,
          tradeAssemblyId: record.tradeAssemblyId ?? null,
          verification: JSON.stringify(record.verification),
          reviewer: record.reviewer ?? null,
          approval: record.approval ? JSON.stringify(record.approval) : null,
          // provenance carries adapter evidence (adapterHash + engineVersion
          // next to recomputeHistory) so every derived row is re-traceable
          provenance: JSON.stringify({
            ...record.provenance,
            adapterScript: result.adapterScript,
            adapterHash: result.adapterHash,
            engineKey: result.engineKey,
            engineVersion: result.engineVersion,
            sourceArtifactRevisionId: revision.id,
          }),
        },
      }),
    ),
  )

  await recordEvent({
    projectId: id,
    actorType: "agent",
    actorId: `adapter:${result.engineKey}`,
    action: "quantity.derived",
    entityType: "artifact",
    entityId: artifactId,
    detail: {
      engineKey: result.engineKey,
      engineVersion: result.engineVersion,
      artifactId,
      count: created.length,
      quantityIds: created.map((row) => row.id),
      adapterHash: result.adapterHash,
    },
  })

  return jsonOk({ quantities: await serializeQuantityRows(created) }, { status: 201 })
})
