import { z } from "zod"

import { ROUNDING_MODES } from "@/core"
import { recordEvent } from "@/lib/audit"
import { jsonOk, ERR, parseBody } from "@/lib/api-utils"
import { db } from "@/lib/db"
import { newId } from "@/lib/ids"

import { handler, stringEnum } from "../../../_lib/route-helpers"
import { serializeEstimate } from "../../../_lib/ledger-rows"

export const dynamic = "force-dynamic"

const pct = (label: string) =>
  z
    .number({ message: `${label} must be a number` })
    .refine((v) => Number.isFinite(v) && v >= 0, {
      message: `${label} must be a finite number ≥ 0`,
    })

/** POST body per contract; rounding defaults to half-up/2 (GHS-style 2dp). */
const estimateSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(120),
  currency: z
    .string()
    .trim()
    .min(1, "currency is required")
    .max(8, "currency must be at most 8 characters")
    .transform((v) => v.toUpperCase()),
  overheadPct: pct("overheadPct"),
  profitPct: pct("profitPct"),
  taxPct: pct("taxPct"),
  roundingMode: stringEnum(ROUNDING_MODES, "roundingMode").default("half-up"),
  roundingDecimals: z
    .number({ message: "roundingDecimals must be a number" })
    .int("roundingDecimals must be an integer")
    .min(0, "roundingDecimals must be ≥ 0")
    .max(15, "roundingDecimals must be ≤ 15")
    .default(2),
})

/** GET /api/projects/[id]/estimates — full rows with lines + recomputed totals. */
export const GET = handler<{ id: string }>(async (_req, ctx) => {
  const { id } = await ctx.params

  const project = await db.project.findUnique({ where: { id }, select: { id: true } })
  if (!project) return ERR.notFound("Project")

  const rows = await db.estimate.findMany({
    where: { projectId: id },
    include: { lines: true },
    orderBy: { createdAt: "desc" },
  })

  // totals are recomputed from stored lineTotals on EVERY read (never stored)
  return jsonOk({ estimates: rows.map((row) => serializeEstimate(row, row.lines)) })
})

/** POST /api/projects/[id]/estimates — draft estimate (no lines yet). */
export const POST = handler<{ id: string }>(async (req, ctx) => {
  const { id } = await ctx.params

  const project = await db.project.findUnique({ where: { id }, select: { id: true } })
  if (!project) return ERR.notFound("Project")

  const parsed = await parseBody(req, estimateSchema)
  if (!parsed.ok) return parsed.response
  const { name, currency, overheadPct, profitPct, taxPct, roundingMode, roundingDecimals } =
    parsed.data

  const estimate = await db.estimate.create({
    data: {
      id: newId("est"),
      projectId: id,
      name,
      currency,
      overheadPct,
      profitPct,
      taxPct,
      roundingMode,
      roundingDecimals,
      status: "draft",
      createdBy: "local-operator",
    },
    include: { lines: true },
  })

  await recordEvent({
    projectId: id,
    action: "estimate.created",
    entityType: "estimate",
    entityId: estimate.id,
    detail: { name, currency, overheadPct, profitPct, taxPct, roundingMode, roundingDecimals },
  })

  return jsonOk({ estimate: serializeEstimate(estimate, estimate.lines) }, { status: 201 })
})
