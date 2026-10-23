import { z } from "zod"

import {
  makeSheetMarkup,
  MARKUP_KINDS,
  MarkupError,
  type MarkupKind,
  type MarkupPoint,
} from "@/core/markup"
import { recordEvent } from "@/lib/audit"
import { jsonOk, ERR, parseBody } from "@/lib/api-utils"
import { db } from "@/lib/db"
import { newId } from "@/lib/ids"

import { handler, requireProjectAccess, stringEnum } from "../../../_lib/route-helpers"

export const dynamic = "force-dynamic"

/**
 * Slice 13 — persistent sheet markups (limitation #5).
 *
 * GET  /api/projects/[id]/markups            → all markups of the project
 * GET  …/markups?revisionId=<rid>            → filtered to one revision
 * GET  …/markups?revisionId=<rid>&page=<n>   → …and one page (the overlay query)
 *
 * POST /api/projects/[id]/markups            → create one markup
 *
 * Honesty rules (the quantities-route precedent):
 *  - project-scoped behind the ADR-0007 wrapper: session required (401),
 *    non-members get the project 404 (hidden ≡ missing), viewers read but
 *    never write (403);
 *  - `revisionId` must reference an artifact revision of THIS project (a
 *    foreign/unknown id is a body 422 — same rule as ledger rows);
 *  - a `quantityId`, when given, must be a ledger row of THIS project (the
 *    markup is the geometry OF that row — a dangling link would be a lie);
 *  - domain semantics (kind vocabulary, per-kind point counts, the strict
 *    value/geometry consistency, unit mapping) are enforced ONCE in
 *    src/core/markup.ts — a MarkupError message returns verbatim as 422;
 *  - mutations emit audit events (markup.created), reads do not.
 */

const pointSchema = z.object({
  x: z.number({ message: "point.x must be a number" }),
  y: z.number({ message: "point.y must be a number" }),
})

const createMarkupSchema = z.object({
  revisionId: z.string().min(1, "revisionId is required"),
  page: z.number({ message: "page must be a number" }).int().min(1),
  kind: stringEnum(MARKUP_KINDS, "kind"),
  points: z.array(pointSchema, { message: "points must be an array of {x, y}" }).min(1),
  label: z.string().optional(),
  value: z.number({ message: "value must be a number" }),
  unit: z.string().trim().min(1, "unit is required"),
  scale: z.string().optional(),
  quantityId: z.string().optional(),
  createdBy: z.string().trim().min(1, "createdBy is required"),
})

/** Serializes a stored row: `points` JSON parsed, everything else verbatim. */
function serializeMarkup(row: {
  id: string
  revisionId: string
  page: number
  kind: string
  points: string
  label: string | null
  value: number
  unit: string
  scale: string | null
  quantityId: string | null
  createdBy: string
  createdAt: Date
}) {
  let points: MarkupPoint[]
  try {
    const parsed: unknown = JSON.parse(row.points)
    if (!Array.isArray(parsed)) throw new Error("not an array")
    points = parsed as MarkupPoint[]
  } catch {
    // Stored JSON is written only through makeSheetMarkup-validated rows —
    // but a read must never crash the route on corrupt bytes either.
    points = []
  }
  return {
    id: row.id,
    revisionId: row.revisionId,
    page: row.page,
    kind: row.kind,
    points,
    label: row.label,
    value: row.value,
    unit: row.unit,
    scale: row.scale,
    quantityId: row.quantityId,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  }
}

/** GET — list markups (read role: viewers CAN read; write gate only on POST). */
export const GET = handler<{ id: string }>(async (req, ctx) => {
  const { id } = await ctx.params

  const project = await db.project.findUnique({ where: { id }, select: { id: true } })
  if (!project) return ERR.notFound("Project")

  const access = await requireProjectAccess(id, "read")
  if (!access.ok) return access.response

  // Optional filters (validated shapes; unknown revision ids simply match
  // zero rows — the list endpoint leaks nothing a 404 wouldn't).
  const url = new URL(req.url)
  const revisionId = url.searchParams.get("revisionId")
  const pageRaw = url.searchParams.get("page")
  let page: number | undefined
  if (pageRaw !== null) {
    page = Number(pageRaw)
    if (!Number.isInteger(page) || page < 1) {
      return ERR.invalid(`page: must be a whole number >= 1 (got ${pageRaw})`)
    }
  }

  const rows = await db.sheetMarkup.findMany({
    where: {
      projectId: id,
      ...(revisionId !== null ? { revisionId } : {}),
      ...(page !== undefined ? { page } : {}),
    },
    orderBy: { createdAt: "asc" },
  })

  return jsonOk({ markups: rows.map(serializeMarkup) })
})

/** POST — create one markup (write role required; viewers get the 403). */
export const POST = handler<{ id: string }>(async (req, ctx) => {
  const { id } = await ctx.params

  const project = await db.project.findUnique({ where: { id }, select: { id: true } })
  if (!project) return ERR.notFound("Project")

  const access = await requireProjectAccess(id, "write")
  if (!access.ok) return access.response

  const parsed = await parseBody(req, createMarkupSchema)
  if (!parsed.ok) return parsed.response
  const input = parsed.data

  // The markup must live on a revision of THIS project (ledger-row rule).
  const revision = await db.artifactRevision.findUnique({
    where: { id: input.revisionId },
    select: {
      id: true,
      revNumber: true,
      artifact: { select: { id: true, name: true, kind: true, projectId: true } },
    },
  })
  if (!revision || revision.artifact.projectId !== id) {
    return ERR.invalid(
      `revisionId: must reference an artifact revision of this project (got ${input.revisionId})`,
    )
  }

  // An optional quantityId must be a ledger row of THIS project — the markup
  // claims to be the geometry OF that row, so a dangling/foreign link is a
  // body error, never a silently accepted lie.
  if (input.quantityId !== undefined && input.quantityId.trim() !== "") {
    const quantity = await db.quantityRecord.findFirst({
      where: { id: input.quantityId, projectId: id },
      select: { id: true },
    })
    if (!quantity) {
      return ERR.invalid(
        `quantityId: must reference a quantity record of this project (got ${input.quantityId})`,
      )
    }
  }

  let record
  try {
    record = makeSheetMarkup({
      id: newId("mkp"),
      projectId: id,
      revisionId: input.revisionId,
      page: input.page,
      kind: input.kind as MarkupKind,
      points: input.points as MarkupPoint[],
      label: input.label,
      value: input.value,
      unit: input.unit,
      scale: input.scale,
      quantityId: input.quantityId,
      createdBy: input.createdBy,
    })
  } catch (err) {
    if (err instanceof MarkupError) return ERR.invalid(err.message)
    throw err
  }

  const created = await db.sheetMarkup.create({
    data: {
      id: record.id,
      projectId: record.projectId,
      revisionId: record.revisionId,
      page: record.page,
      kind: record.kind,
      points: JSON.stringify(record.points),
      label: record.label,
      value: record.value,
      unit: record.unit,
      scale: record.scale,
      quantityId: record.quantityId,
      createdBy: record.createdBy,
    },
  })

  await recordEvent({
    projectId: id,
    action: "markup.created",
    entityType: "markup",
    entityId: record.id,
    detail: {
      kind: record.kind,
      page: record.page,
      revisionId: record.revisionId,
      quantityId: record.quantityId,
      value: record.value,
      unit: record.unit,
      label: record.label,
    },
  })

  return jsonOk(
    {
      markup: serializeMarkup({
        ...created,
        createdAt: created.createdAt,
      }),
    },
    { status: 201 },
  )
})
