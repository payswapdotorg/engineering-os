import { z } from "zod"

import { DISCIPLINE_VALUES } from "@/lib/disciplines"
import { recordEvent } from "@/lib/audit"
import { jsonOk, ERR, parseBody } from "@/lib/api-utils"
import { getSessionUser } from "@/lib/auth"
import { db } from "@/lib/db"
import { newId } from "@/lib/ids"

import { handler, isUniqueViolation, randomSuffix, slugify, stringEnum } from "../_lib/route-helpers"

export const dynamic = "force-dynamic"

const createSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(120, "name must be at most 120 characters"),
  discipline: stringEnum(DISCIPLINE_VALUES, "discipline"),
  description: z.string().max(2000, "description must be at most 2000 characters").optional(),
})

/** GET /api/projects — list with counts + latest event date. */
export const GET = handler(async () => {
  const [projects, latestEvents] = await Promise.all([
    db.project.findMany({
      orderBy: { updatedAt: "desc" },
      include: { _count: { select: { artifacts: true, members: true } } },
    }),
    db.auditEvent.groupBy({
      by: ["projectId"],
      where: { projectId: { not: null } },
      _max: { createdAt: true },
    }),
  ])

  const lastEventByProject = new Map(
    latestEvents
      .filter((e) => e.projectId !== null)
      .map((e) => [e.projectId as string, e._max.createdAt as Date | null]),
  )

  return jsonOk({
    projects: projects.map((p) => ({
      id: p.id,
      slug: p.slug,
      name: p.name,
      discipline: p.discipline,
      description: p.description,
      status: p.status,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      _count: p._count,
      lastEventAt: lastEventByProject.get(p.id) ?? null,
    })),
  })
})

/** POST /api/projects — create project + owner member + audit event. */
export const POST = handler(async (req) => {
  const parsed = await parseBody(req, createSchema)
  if (!parsed.ok) return parsed.response
  const { name, discipline, description } = parsed.data

  // Unique slug: slugify(name) + 4 random chars, retried on (astronomically
  // unlikely) collisions.
  let slug = `${slugify(name)}-${randomSuffix()}`
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await db.project.findUnique({ where: { slug }, select: { id: true } })
    if (!existing) break
    slug = `${slugify(name)}-${randomSuffix()}`
  }

  const projectId = newId("prj")

  // Phase-6 (contract §1.3): the creating user becomes the project's owner
  // TeamMember row — stamped with their session identity (name + email) so
  // the team-member gate never locks out the creator. The session exists for
  // every signed-in POST; the "Local Operator" fallback covers background
  // contexts only (defensive — the gate makes those 401 before this point).
  const session = await getSessionUser()
  const ownerMember = {
    id: newId("mem"),
    name: session?.name ?? "Local Operator",
    email: session?.email ?? null,
    role: "owner",
  }

  try {
    const project = await db.project.create({
      data: {
        id: projectId,
        slug,
        name,
        discipline,
        description: description?.trim().length ? description.trim() : null,
        status: "active",
        members: {
          create: [ownerMember],
        },
      },
      include: { _count: { select: { artifacts: true, members: true } } },
    })

    await recordEvent({
      projectId,
      action: "project.created",
      entityType: "project",
      entityId: projectId,
      detail: { name, discipline, slug },
    })

    return jsonOk({ project: { ...project, lastEventAt: null } }, { status: 201 })
  } catch (err) {
    if (isUniqueViolation(err)) {
      return ERR.conflict("A project with this slug already exists — try a different name")
    }
    throw err
  }
})
