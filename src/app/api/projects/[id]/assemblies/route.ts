import { z } from "zod"

import { ESTIMATE_COMPONENT_KINDS } from "@/core"
import { recordEvent } from "@/lib/audit"
import { jsonOk, ERR, parseBody } from "@/lib/api-utils"
import { db } from "@/lib/db"
import { newId } from "@/lib/ids"

import { handler, stringEnum } from "../../../_lib/route-helpers"
import { serializeAssembly } from "../../../_lib/ledger-rows"

export const dynamic = "force-dynamic"

const finitePositive = (label: string) =>
  z
    .number({ message: `${label} must be a number` })
    .refine((v) => Number.isFinite(v) && v > 0, { message: `${label} must be a finite number > 0` })

const finiteNonNegative = (label: string) =>
  z
    .number({ message: `${label} must be a number` })
    .refine((v) => Number.isFinite(v) && v >= 0, { message: `${label} must be a finite number ≥ 0` })

/** Component shape mirrors src/core EstimateComponent (rates are keyed by id). */
const componentSchema = z.object({
  id: z.string().trim().min(1, "component id is required").max(64),
  kind: stringEnum(ESTIMATE_COMPONENT_KINDS, "component kind"),
  name: z.string().trim().min(1, "component name is required").max(120),
  quantityPerUnit: finitePositive("quantityPerUnit"),
  unit: z.string().trim().min(1, "component unit is required").max(32),
  wastePct: finiteNonNegative("wastePct").optional(),
  productivityFactor: finitePositive("productivityFactor").optional(),
})

const assemblySchema = z
  .object({
    name: z.string().trim().min(1, "name is required").max(120),
    trade: z.string().trim().min(1, "trade is required").max(120),
    components: z
      .array(componentSchema)
      .min(1, "an assembly needs at least one component")
      .max(64, "an assembly supports at most 64 components"),
  })
  .superRefine((assembly, ctx) => {
    // Rate resolution is per component id — duplicates would double-resolve.
    const seen = new Set<string>()
    for (const component of assembly.components) {
      if (seen.has(component.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["components"],
          message: `duplicate component id "${component.id}" — component ids must be unique within an assembly (rates are keyed by them)`,
        })
        return
      }
      seen.add(component.id)
    }
  })

/** GET /api/projects/[id]/assemblies — trade assemblies with components. */
export const GET = handler<{ id: string }>(async (_req, ctx) => {
  const { id } = await ctx.params

  const project = await db.project.findUnique({ where: { id }, select: { id: true } })
  if (!project) return ERR.notFound("Project")

  const rows = await db.tradeAssembly.findMany({
    where: { projectId: id },
    orderBy: { createdAt: "desc" },
  })

  return jsonOk({ assemblies: rows.map(serializeAssembly) })
})

/** POST /api/projects/[id]/assemblies — material+labor recipe for a trade. */
export const POST = handler<{ id: string }>(async (req, ctx) => {
  const { id } = await ctx.params

  const project = await db.project.findUnique({ where: { id }, select: { id: true } })
  if (!project) return ERR.notFound("Project")

  const parsed = await parseBody(req, assemblySchema)
  if (!parsed.ok) return parsed.response
  const { name, trade, components } = parsed.data

  const assembly = await db.tradeAssembly.create({
    data: {
      id: newId("asm"),
      projectId: id,
      name,
      trade,
      components: JSON.stringify(components),
    },
  })

  await recordEvent({
    projectId: id,
    action: "assembly.created",
    entityType: "assembly",
    entityId: assembly.id,
    detail: {
      name,
      trade,
      componentCount: components.length,
      componentIds: components.map((c) => c.id),
    },
  })

  return jsonOk({ assembly: serializeAssembly(assembly) }, { status: 201 })
})
