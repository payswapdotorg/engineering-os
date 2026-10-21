import { z } from "zod"

import {
  LedgerError,
  QUANTITY_METHODS,
  QUANTITY_TYPES,
  makeQuantityRecord,
  type QuantityMethod,
  type QuantityRecord,
  type QuantityType,
} from "@/core"
import { recordEvent } from "@/lib/audit"
import { jsonOk, ERR, parseBody } from "@/lib/api-utils"
import { db } from "@/lib/db"
import { newId } from "@/lib/ids"

import { handler, stringEnum } from "../../../_lib/route-helpers"
import { serializeQuantity, serializeQuantityRows } from "../../../_lib/ledger-rows"

export const dynamic = "force-dynamic"

/** POST body = QuantityRecordInput minus id/projectId (worklog pinned contract). */
const createQuantitySchema = z.object({
  sourceArtifactRevisionId: z.string().min(1, "sourceArtifactRevisionId is required"),
  sheetRef: z.string().optional(),
  elementRef: z.string().optional(),
  quantityType: stringEnum(QUANTITY_TYPES, "quantityType"),
  value: z.number({ message: "value must be a number" }),
  unit: z.string().trim().min(1, "unit is required"),
  method: stringEnum(QUANTITY_METHODS, "method"),
  scale: z.string().optional(),
  quantityMethod: z.string().optional(),
  rulesetId: z.string().trim().min(1, "rulesetId is required"),
  rulesetVersion: z.string().trim().min(1, "rulesetVersion is required"),
  tradeAssemblyId: z.string().optional(),
  createdBy: z.string().trim().min(1, "createdBy is required"),
})

/** GET /api/projects/[id]/quantities — ledger rows + joined sourceArtifact. */
export const GET = handler<{ id: string }>(async (_req, ctx) => {
  const { id } = await ctx.params

  const project = await db.project.findUnique({ where: { id }, select: { id: true } })
  if (!project) return ERR.notFound("Project")

  const rows = await db.quantityRecord.findMany({
    where: { projectId: id },
    orderBy: { createdAt: "desc" },
  })

  return jsonOk({ quantities: await serializeQuantityRows(rows) })
})

/** POST /api/projects/[id]/quantities — record a ledger row via makeQuantityRecord. */
export const POST = handler<{ id: string }>(async (req, ctx) => {
  const { id } = await ctx.params

  const project = await db.project.findUnique({ where: { id }, select: { id: true } })
  if (!project) return ERR.notFound("Project")

  const parsed = await parseBody(req, createQuantitySchema)
  if (!parsed.ok) return parsed.response
  const input = parsed.data

  // The ledger row must point at a revision of THIS project (rows never point
  // at mutable artifacts; a foreign/unknown revision id is a body error).
  const revision = await db.artifactRevision.findUnique({
    where: { id: input.sourceArtifactRevisionId },
    select: {
      id: true,
      revNumber: true,
      artifact: { select: { id: true, name: true, kind: true, projectId: true } },
    },
  })
  if (!revision || revision.artifact.projectId !== id) {
    return ERR.invalid(
      `sourceArtifactRevisionId: must reference an artifact revision of this project (got ${
        input.sourceArtifactRevisionId
      })`,
    )
  }

  // Domain validation (sheetRef/elementRef rules, value > 0, …) via src/core.
  // stringEnum above narrows to the closed vocabularies at the boundary; the
  // casts only re-narrow the already-validated strings for makeQuantityRecord.
  let record: QuantityRecord
  try {
    record = makeQuantityRecord({
      ...input,
      quantityType: input.quantityType as QuantityType,
      method: input.method as QuantityMethod,
      id: newId("qty"),
      projectId: id,
    })
  } catch (err) {
    if (err instanceof LedgerError) return ERR.invalid(err.message)
    throw err
  }

  const created = await db.quantityRecord.create({
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
      provenance: JSON.stringify(record.provenance),
    },
  })

  await recordEvent({
    projectId: id,
    action: "quantity.created",
    entityType: "quantity",
    entityId: record.id,
    detail: {
      method: record.method,
      quantityType: record.quantityType,
      value: record.value,
      unit: record.unit,
      rulesetId: record.rulesetId,
      rulesetVersion: record.rulesetVersion,
      sheetRef: record.sheetRef ?? null,
      elementRef: record.elementRef ?? null,
      sourceArtifactRevisionId: record.sourceArtifactRevisionId,
    },
  })

  return jsonOk(
    {
      quantity: serializeQuantity(created, {
        id: revision.artifact.id,
        name: revision.artifact.name,
        kind: revision.artifact.kind,
        revNumber: revision.revNumber,
      }),
    },
    { status: 201 },
  )
})
