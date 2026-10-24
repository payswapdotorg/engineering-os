import { z } from "zod"

import { TEAM_ROLES } from "@/core"
import { recordEvent } from "@/lib/audit"
import { jsonOk, ERR, parseBody } from "@/lib/api-utils"
import { db } from "@/lib/db"

import { handler, stringEnum, ERR_MEMBER_MANAGEMENT, requireProjectAccess } from "../../../../_lib/route-helpers"
import { requireMemberManager } from "../manage-gate"

export const dynamic = "force-dynamic"

/** Pinned verbatim (Slice 14 — role PATCH, the Slice-10 §9 remainder). */
export const ERR_LAST_OWNER_DEMOTE = "cannot demote the only owner of the project"

const rolePatchSchema = z.object({
  role: stringEnum(TEAM_ROLES, "role"),
})

/** DELETE /api/projects/[id]/members/[memberId] — remove a roster row / revoke
 * a real access grant (contract §5).
 *
 * Gate order (same as the members POST):
 *  1. project-exists 404
 *  2. isolation: requireProjectAccess "read" — non-members 404 (no-leak)
 *  3. manage gate: admin bypass OR owner row (userId = session.id first;
 *     legacy email/name fallback retained) — the pinned ERR_MEMBER_MANAGEMENT
 *  4. row exists AND belongs to this project ⇒ else 404 `Member not found`
 *     (same envelope as a missing row, so a foreign row id learns nothing)
 *  5. last-owner guard: deleting the project's only LINKED owner row is
 *     refused with the 409 verbatim below. Legacy UNLINKED owner rows and
 *     non-owner rows are always deletable (a linked admin can re-grant, and
 *     legacy rows predate grants — contract §5 step 3).
 *  6. delete ⇒ 200 { removed } · audit member.removed with
 *     detail { name, role, email?, hadAccess } (hadAccess = linked grant). */
export const DELETE = handler<{ id: string; memberId: string }>(async (_req, ctx) => {
  const { id, memberId } = await ctx.params

  const project = await db.project.findUnique({ where: { id }, select: { id: true } })
  if (!project) return ERR.notFound("Project")

  // Slice-10 isolation: a non-member gets the same 404 as a missing project.
  const access = await requireProjectAccess(id, "read")
  if (!access.ok) return access.response
  const session = access.session

  // Manage gate (contract §5 step 2) — the documented TeamMember exception.
  if (!(await requireMemberManager(id, session))) return ERR_MEMBER_MANAGEMENT()

  const row = await db.teamMember.findFirst({ where: { id: memberId, projectId: id } })
  if (!row) return ERR.notFound("Member")

  if (row.role === "owner" && row.userId !== null) {
    const otherLinkedOwner = await db.teamMember.findFirst({
      where: { projectId: id, role: "owner", userId: { not: null }, id: { not: memberId } },
      select: { id: true },
    })
    if (!otherLinkedOwner) return ERR.conflict("cannot remove the only owner of the project")
  }

  await db.teamMember.delete({ where: { id: row.id } })

  await recordEvent({
    projectId: id,
    action: "member.removed",
    entityType: "member",
    entityId: row.id,
    detail: {
      name: row.name,
      role: row.role,
      ...(row.email !== null ? { email: row.email } : {}),
      hadAccess: row.userId !== null,
    },
  })

  return jsonOk({ removed: memberId })
})

/** PATCH /api/projects/[id]/members/[memberId] — change a member's ROLE
 * (Slice 14: the Slice-10 §9 "member role PATCH" remainder closed; until
 * now a role change was revoke + re-grant through POST + DELETE).
 *
 * Gate order (identical to DELETE above):
 *  1. project-exists 404
 *  2. isolation: requireProjectAccess "read" — non-members 404 (no-leak)
 *  3. manage gate: admin bypass OR owner row — ERR_MEMBER_MANAGEMENT
 *  4. row exists AND belongs to this project ⇒ else 404 `Member not found`
 *  5. body { role } ∈ TEAM_ROLES ⇒ else 422 (stringEnum)
 *  6. last-owner guard: demoting (owner → non-owner) the project's only
 *     LINKED owner row is refused with the 409 verbatim above — a project
 *     can never be stranded without an owner. PROMOTIONS to owner are
 *     allowed (that is how ownership transfers safely).
 *  7. same role ⇒ 200 { member } idempotent no-op (no audit event — nothing
 *     changed); changed ⇒ update + audit member.roleChanged
 *     detail { name, from, to, email?, hadAccess }.
 */
export const PATCH = handler<{ id: string; memberId: string }>(async (req, ctx) => {
  const { id, memberId } = await ctx.params

  const project = await db.project.findUnique({ where: { id }, select: { id: true } })
  if (!project) return ERR.notFound("Project")

  // Slice-10 isolation: a non-member gets the same 404 as a missing project.
  const access = await requireProjectAccess(id, "read")
  if (!access.ok) return access.response
  const session = access.session

  // Manage gate (contract §5 step 2) — the documented TeamMember exception.
  if (!(await requireMemberManager(id, session))) return ERR_MEMBER_MANAGEMENT()

  const row = await db.teamMember.findFirst({ where: { id: memberId, projectId: id } })
  if (!row) return ERR.notFound("Member")

  const parsed = await parseBody(req, rolePatchSchema)
  if (!parsed.ok) return parsed.response
  const { role } = parsed.data

  // Last-owner guard: demoting the only LINKED owner strands the project.
  if (row.role === "owner" && row.userId !== null && role !== "owner") {
    const otherLinkedOwner = await db.teamMember.findFirst({
      where: { projectId: id, role: "owner", userId: { not: null }, id: { not: memberId } },
      select: { id: true },
    })
    if (!otherLinkedOwner) return ERR.conflict(ERR_LAST_OWNER_DEMOTE)
  }

  // Idempotent no-op: the same role is not an error (nothing changes, no
  // audit event is written — the append-only trail records CHANGES only).
  if (row.role === role) {
    return jsonOk({ member: row })
  }

  const member = await db.teamMember.update({
    where: { id: row.id },
    data: { role },
  })

  await recordEvent({
    projectId: id,
    action: "member.roleChanged",
    entityType: "member",
    entityId: row.id,
    detail: {
      name: row.name,
      from: row.role,
      to: role,
      ...(row.email !== null ? { email: row.email } : {}),
      hadAccess: row.userId !== null,
    },
  })

  return jsonOk({ member })
})
