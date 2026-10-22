import { z } from "zod"

import { TEAM_ROLES } from "@/core"
import { recordEvent } from "@/lib/audit"
import { jsonOk, ERR, parseBody } from "@/lib/api-utils"
import { db } from "@/lib/db"
import { newId } from "@/lib/ids"

import { handler, stringEnum, ERR_MEMBER_MANAGEMENT, requireProjectAccess } from "../../../_lib/route-helpers"
import { requireMemberManager } from "./manage-gate"

export const dynamic = "force-dynamic"

const memberSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(80, "name must be at most 80 characters"),
  role: stringEnum(TEAM_ROLES, "role").default("editor"),
  // Slice-10 (contract §5): an email matching a User account turns the row
  // into a real access GRANT (linked userId — the account identity wins over
  // any supplied display name); an unknown email creates an honest PENDING
  // invitation row (userId null — grants nothing until an account with that
  // email exists and an owner re-adds/links it, contract §9); no email keeps
  // today's display-only roster row (unchanged behavior).
  email: z.string().trim().toLowerCase().email("email must be a valid address").max(200).optional(),
})

/** GET /api/projects/[id]/members */
export const GET = handler<{ id: string }>(async (_req, ctx) => {
  const { id } = await ctx.params

  const project = await db.project.findUnique({ where: { id }, select: { id: true } })
  if (!project) return ERR.notFound("Project")

  // Slice 10 (contract §4): read = any member — non-members get the SAME 404
  // as a missing project (404-no-leak); project viewers may read the roster.
  const access = await requireProjectAccess(id, "read")
  if (!access.ok) return access.response

  const members = await db.teamMember.findMany({ where: { projectId: id }, orderBy: { addedAt: "asc" } })
  return jsonOk({ members })
})

/** POST /api/projects/[id]/members — roster rows AND real access grants.
 *
 * Phase-6 (contract §1.3): managing team members requires the caller to be
 * the project owner or a global admin — 403 verbatim otherwise. The
 * project-create route auto-creates the creator's owner row, so a fresh
 * project is never locked out.
 *
 * Slice-10 (contract §5) gate order:
 *  1. project-exists 404 (above)
 *  2. isolation: requireProjectAccess "read" — non-members 404 (no-leak)
 *  3. manage gate: admin bypass OR owner row (userId = session.id first; the
 *     legacy email/name fallback retained for pre-slice rows) — the pinned
 *     ERR_MEMBER_MANAGEMENT envelope, unchanged
 *  4. body parse (name / role / optional email)
 *  5. email present ⇒ account lookup: account found = GRANT (duplicate grant
 *     ⇒ 409 verbatim naming the ACCOUNT identity); no account = PENDING row
 *  6. duplicate-name 409 (existing message) — AFTER the grant-duplicate check
 *  7. create with addedBy = session.id · 201 · audit member.added with
 *     detail { name, role, email?, linked, userId? } */
export const POST = handler<{ id: string }>(async (req, ctx) => {
  const { id } = await ctx.params

  const project = await db.project.findUnique({ where: { id }, select: { id: true } })
  if (!project) return ERR.notFound("Project")

  // Slice-10 isolation: a non-member gets the same 404 as a missing project;
  // a member (or admin) may pass on to the manage gate below.
  const access = await requireProjectAccess(id, "read")
  if (!access.ok) return access.response
  const session = access.session

  // Manage gate (contract §5 step 2) — the documented TeamMember exception.
  if (!(await requireMemberManager(id, session))) return ERR_MEMBER_MANAGEMENT()

  const parsed = await parseBody(req, memberSchema)
  if (!parsed.ok) return parsed.response
  const { name: postedName, role } = parsed.data

  // Grant vs pending vs display-only row (contract §5 step 3).
  let userId: string | null = null
  let name = postedName
  let email: string | null = null
  let linked = false
  if (parsed.data.email !== undefined) {
    const account = await db.user.findUnique({
      where: { email: parsed.data.email },
      select: { id: true, name: true, email: true },
    })
    if (account) {
      // Real GRANT — one per user per project (@@unique([projectId, userId])).
      // The grant-duplicate check fires BEFORE the roster duplicate-name check
      // below: a same-name+same-email re-add surfaces the GRANT message.
      const existingGrant = await db.teamMember.findFirst({
        where: { projectId: id, userId: account.id },
        select: { id: true },
      })
      if (existingGrant) {
        return ERR.conflict(`"${account.name}" already has access to this project`)
      }
      userId = account.id
      // The account identity wins — a roster row can never spoof a display
      // name over a real user (ADR-0007 rule 6).
      name = account.name
      email = account.email
      linked = true
    } else {
      // PENDING invitation: userId stays null, name/email as supplied. The
      // row is display-only until an owner re-adds/links it (contract §9).
      email = parsed.data.email
    }
  }

  const duplicate = await db.teamMember.findFirst({ where: { projectId: id, name }, select: { id: true } })
  if (duplicate) {
    return ERR.conflict(`A member named "${name}" already exists in this project`)
  }

  const member = await db.teamMember.create({
    data: { id: newId("mem"), projectId: id, userId, name, email, role, addedBy: session.id },
  })

  await recordEvent({
    projectId: id,
    action: "member.added",
    entityType: "member",
    entityId: member.id,
    detail: {
      name,
      role,
      ...(email !== null ? { email } : {}),
      linked,
      ...(userId !== null ? { userId } : {}),
    },
  })

  return jsonOk({ member }, { status: 201 })
})
