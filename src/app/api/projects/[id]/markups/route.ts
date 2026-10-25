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
 * Slice 13 — persistent sheet markups (limitation #5). Slice 16-B extends
 * the kind vocabulary with "text-hits" (accepted OCR word boxes) whose
 * transcript rides the new nullable `payload` column.
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
 *  - a `payload` is accepted ONLY for kind "text-hits" (the OCR transcript)
 *    and shape-validated: words[] with boxIndex < hit-pair count, conf ≥ 0,
 *    raw text always present, the engine envelope; every other kind
 *    carrying a payload is a 422 (never silently dropped);
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
  payload: z.unknown().optional(),
  createdBy: z.string().trim().min(1, "createdBy is required"),
})

/** The Slice 16-B text-hits transcript payload (shape-validated at the route;
 * the pure core keeps points/value semantics — the transcript is provenance). */
const transcriptWordSchema = z.object({
  text: z.string().min(1, "payload.words[].text must be a non-empty string"),
  conf: z.number({ message: "payload.words[].conf must be a number" }).min(0).max(100),
  boxIndex: z.number({ message: "payload.words[].boxIndex must be a number" }).int().min(0),
  normalized: z
    .object({
      raw: z.string().min(1),
      normalized: z.string().min(1),
      rule: z.literal("diameter-glyph"),
    })
    .optional(),
})

const transcriptPayloadSchema = z.object({
  words: z.array(transcriptWordSchema, { message: "payload.words must be an array" }).min(1),
  engine: z.string().min(1, "payload.engine is required (which engine read the words)"),
  engineVersion: z.string().min(1, "payload.engineVersion is required"),
  adapterScript: z.string().min(1, "payload.adapterScript is required"),
  adapterHash: z.string().min(1, "payload.adapterHash is required"),
})

/** Serializes a stored row: `points`/`payload` JSON parsed, everything else verbatim. */
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
  payload: string | null
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
  let payload: unknown = null
  if (row.payload !== null) {
    try {
      payload = JSON.parse(row.payload)
    } catch {
      payload = null // same never-crash rule
    }
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
    ...(payload !== null ? { payload } : {}),
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

  // Slice 16-B: the transcript payload is text-hits-ONLY, shape-validated,
  // with every word's boxIndex inside the markup's own hit-pair boxes — the
  // transcript and the geometry can never disagree in storage.
  let payloadJson: string | null = null
  if (input.payload !== undefined) {
    if (input.kind !== "text-hits") {
      return ERR.invalid(`payload: is only accepted for kind "text-hits" markups (kind ${input.kind} carries none)`,)
    }
    const payload = transcriptPayloadSchema.safeParse(input.payload)
    if (!payload.success) {
      const issues = payload.error.issues
        .map((issue) => {
          const at = issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""
          return `${at}${issue.message}`
        })
        .join("; ")
      return ERR.invalid(`payload: ${issues}`)
    }
    const pairCount = Math.floor(input.points.length / 2)
    for (const word of payload.data.words) {
      if (word.boxIndex >= pairCount) {
        return ERR.invalid(
          `payload.words[].boxIndex: ${word.boxIndex} is outside the markup's ${pairCount} word boxes — the transcript and the geometry disagree`,
        )
      }
    }
    payloadJson = JSON.stringify(payload.data)
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
      payload: payloadJson,
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
