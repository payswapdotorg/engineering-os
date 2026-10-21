import { z } from "zod"

import { RATE_SOURCES } from "@/core"
import { recordEvent } from "@/lib/audit"
import { jsonOk, ERR, parseBody } from "@/lib/api-utils"
import { db } from "@/lib/db"
import { newId } from "@/lib/ids"

import { handler, stringEnum } from "../../../_lib/route-helpers"
import { serializeRate } from "../../../_lib/ledger-rows"

export const dynamic = "force-dynamic"

/**
 * POST body per contract: `{ componentId, currency, unitPrice, source,
 * effectiveFrom? }`. `createdBy` is NEVER accepted from the body — rates are
 * engineer-approved provenance (price-book|contract|quote), never agent
 * guesses; the server records "local-operator".
 */
const rateSchema = z.object({
  componentId: z.string().trim().min(1, "componentId is required").max(64),
  currency: z
    .string()
    .trim()
    .min(1, "currency is required")
    .max(8, "currency must be at most 8 characters")
    .transform((v) => v.toUpperCase()), // "ghs" and "GHS" are one currency
  unitPrice: z
    .number({ message: "unitPrice must be a number" })
    .refine((v) => Number.isFinite(v) && v >= 0, {
      message: "unitPrice must be a finite number ≥ 0",
    }),
  source: stringEnum(RATE_SOURCES, "source"),
  effectiveFrom: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), {
      message: "effectiveFrom must be an ISO-8601 date-time string",
    })
    .optional(),
})

/** GET /api/projects/[id]/rates — versioned unit rates (newest first). */
export const GET = handler<{ id: string }>(async (_req, ctx) => {
  const { id } = await ctx.params

  const project = await db.project.findUnique({ where: { id }, select: { id: true } })
  if (!project) return ERR.notFound("Project")

  const rows = await db.rate.findMany({
    where: { projectId: id },
    orderBy: { createdAt: "desc" },
  })

  return jsonOk({ rates: rows.map(serializeRate) })
})

/** POST /api/projects/[id]/rates — add an engineer-approved unit rate. */
export const POST = handler<{ id: string }>(async (req, ctx) => {
  const { id } = await ctx.params

  const project = await db.project.findUnique({ where: { id }, select: { id: true } })
  if (!project) return ERR.notFound("Project")

  const parsed = await parseBody(req, rateSchema)
  if (!parsed.ok) return parsed.response
  const { componentId, currency, unitPrice, source, effectiveFrom } = parsed.data

  const rate = await db.rate.create({
    data: {
      id: newId("rte"),
      projectId: id,
      componentId,
      currency,
      unitPrice,
      source,
      effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : null,
      createdBy: "local-operator",
    },
  })

  await recordEvent({
    projectId: id,
    action: "rate.created",
    entityType: "rate",
    entityId: rate.id,
    detail: { componentId, currency, unitPrice, source, effectiveFrom: effectiveFrom ?? null },
  })

  return jsonOk({ rate: serializeRate(rate) }, { status: 201 })
})
