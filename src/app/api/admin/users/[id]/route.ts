/**
 * PATCH /api/admin/users/[id] — global role management (Slice 17, limitation
 * #19's product half, roadmap-gap-audit §7.2: "global-role PATCH (admin-gated,
 * audited, last-admin guard)").
 *
 * ADMIN-ONLY. Body: {role: "admin"|"engineer"|"viewer"}. The decision rules
 * live in the pure core (src/lib/admin-users.ts — planRoleChange): demo
 * personas keep their provisioned role; the last admin can never be demoted;
 * a no-op change is refused, not silently 200'd. Every accepted change writes
 * one global `user.roleChanged` audit event (projectId null, actor = the
 * administering admin, detail {from, to, targetEmail, targetName, by}) — the
 * global feed already renders null-projectId events, so role changes are
 * attributable after the fact.
 *
 * Honest boundary (recorded in implementation-status #19): the session is a
 * JWT — a changed role takes effect for that user at the NEXT sign-in. The
 * e2e pins this rather than pretending instant effect.
 */
import { z } from "zod"

import { recordEvent } from "@/lib/audit"
import { jsonOk, ERR, parseBody } from "@/lib/api-utils"
import { planRoleChange, type AdminRole } from "@/lib/admin-users"
import { getSessionUser } from "@/lib/auth"
import { db } from "@/lib/db"

import { ERR_ADMIN_USERS_ONLY, ERR_SIGN_IN_REQUIRED, handler } from "../../../_lib/route-helpers"

export const dynamic = "force-dynamic"

const roleSchema = z.object({
  role: z.enum(["admin", "engineer", "viewer"], {
    message: "role must be one of admin, engineer, viewer",
  }),
})

export const PATCH = handler<{ id: string }>(async (req, ctx) => {
  const { id } = await ctx.params

  // Slice 10: admin-gated surface (contract §4 admin superuser). The wrapper's
  // default gate already demands a session and blocks viewer-role writes;
  // this route is narrower still: admins only.
  const session = await getSessionUser()
  if (!session) return ERR_SIGN_IN_REQUIRED()
  if (session.role !== "admin") return ERR_ADMIN_USERS_ONLY()

  const parsed = await parseBody(req, roleSchema)
  if (!parsed.ok) return parsed.response

  const target = await db.user.findUnique({
    where: { id },
    select: { id: true, name: true, email: true, role: true, isDemo: true },
  })
  if (!target) return ERR.notFound("User")

  // The count of OTHER REAL admins — the pure core's last-admin input.
  // Demo personas are excluded BY DESIGN (they can never be demoted, so a
  // fixture must not hold a deployment's durable adminship hostage); the
  // e2e pins this live: the 422 fires while the demo-admin persona exists.
  const otherAdmins = await db.user.count({
    where: { role: "admin", id: { not: target.id }, isDemo: false },
  })

  const decision = planRoleChange(target, parsed.data.role as AdminRole, otherAdmins)
  if (!decision.ok) return ERR.invalid(decision.message)

  const updated = await db.user.update({
    where: { id: target.id },
    data: { role: decision.to },
    select: { id: true, name: true, email: true, role: true, isDemo: true },
  })

  await recordEvent({
    projectId: null,
    actorType: "user",
    actorId: session.id,
    userName: session.name,
    action: "user.roleChanged",
    entityType: "user",
    entityId: updated.id,
    detail: {
      from: decision.from,
      to: decision.to,
      targetEmail: updated.email,
      targetName: updated.name,
      by: session.email,
    },
  })

  return jsonOk({ user: updated })
})
