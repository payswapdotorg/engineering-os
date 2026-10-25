/**
 * General account signup (Slice 14 — the Slice-10 §9 honest remainder
 * closed). PUBLIC route, the third user-creation path alongside first-run
 * setup (the operator) and demo provisioning (clearly-labelled personas):
 *
 *  - creates a real User account (global role "engineer" — the least
 *    privileged role that can still create its OWN projects; project
 *    isolation keeps everything else invisible until an invitation lands);
 *  - ACTIVATES every pending invitation row whose email matches the signup:
 *    userId links to the new account, so the display-only invitation becomes
 *    a real access grant at the invited role (the contract §9 line "pending
 *    rows cannot self-activate" is closed);
 *  - audits one member.activated event per linked row (actor = the new user,
 *    self-activating) + one global user.signedUp event.
 *
 * No email verification exists (single-space self-hosted reality, recorded
 * honestly in the docs) — an invitation activates only for the email it was
 * issued to, and project isolation bounds what a fresh account can see.
 *
 * Slice 17: the closed-signup deployment toggle (roadmap-gap-audit §7.2 —
 * env-gated at boot, surfaced honestly in the UI when off). The guard fires
 * BEFORE any DB read, so a closed deployment answers signup probes without
 * revealing whether an email exists (the 409 duplicate-email check stays
 * reachable only when signups are open).
 */
import { z } from "zod"

import { recordEvent } from "@/lib/audit"
import { jsonOk, ERR, parseBody } from "@/lib/api-utils"
import { signupOpen, SIGNUP_CLOSED_MESSAGE } from "@/lib/admin-users"
import { db } from "@/lib/db"
import { hashPassword } from "@/lib/password"
import { planInvitationActivation, SIGNUP_EMAIL_TAKEN } from "@/lib/signup"

import { handler } from "../../_lib/route-helpers"

export const dynamic = "force-dynamic"

const signupSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(120, "name must be at most 120 characters"),
  email: z.string().trim().min(1, "email is required").email("email must be a valid email address").max(254),
  password: z.string().min(8, "password must be at least 8 characters").max(200, "password must be at most 200 characters"),
})

/** POST /api/auth/signup — public account creation + invitation self-activation. */
export const POST = handler(
  async (req) => {
    // Slice 17: boot-time deployment gate — one vocabulary with the status
    // route and the Administration surface (src/lib/admin-users.ts).
    if (!signupOpen()) return ERR.invalid(SIGNUP_CLOSED_MESSAGE)

    const parsed = await parseBody(req, signupSchema)
    if (!parsed.ok) return parsed.response
    const { name, password } = parsed.data
    const email = parsed.data.email.toLowerCase()

    const existing = await db.user.findUnique({ where: { email }, select: { id: true } })
    if (existing) return ERR.conflict(SIGNUP_EMAIL_TAKEN)

    // Pending invitations issued to this email (userId null = display-only
    // row by contract §1 rule 2). Linked rows never match this query — a
    // user account exists for those by definition, and the 409 above fired.
    const pending = await db.teamMember.findMany({
      where: { email, userId: null },
      orderBy: { addedAt: "asc" },
      select: { id: true, projectId: true, addedAt: true, role: true, name: true },
    })
    const activation = planInvitationActivation(pending)

    const user = await db.user.create({
      data: { email, name, passwordHash: hashPassword(password), role: "engineer" },
      select: { id: true, name: true, email: true, role: true },
    })

    // Link the planned invitations — one per project (the pure planner's
    // @@unique([projectId, userId]) guarantee; a grant for this brand-new
    // account cannot pre-exist, so each planned update is safe).
    const activatedInvites: Array<{ projectId: string; memberId: string; role: string }> = []
    for (const invite of activation) {
      const linked = await db.teamMember.update({
        where: { id: invite.memberId },
        data: { userId: user.id },
        select: { id: true, projectId: true, role: true },
      })
      activatedInvites.push({ projectId: linked.projectId, memberId: linked.id, role: linked.role })
      await recordEvent({
        projectId: linked.projectId,
        actorType: "user",
        actorId: user.id,
        userName: user.name,
        action: "member.activated",
        entityType: "member",
        entityId: linked.id,
        detail: {
          name: pending.find((p) => p.id === linked.id)?.name ?? null,
          role: linked.role,
          email,
          userId: user.id,
          via: "signup",
        },
      })
    }

    await recordEvent({
      projectId: null,
      actorType: "user",
      actorId: user.id,
      userName: user.name,
      action: "user.signedUp",
      entityType: "user",
      entityId: user.id,
      detail: { name: user.name, email, activatedInvites: activatedInvites.length },
    })

    return jsonOk({ user, activatedInvites }, { status: 201 })
  },
  { auth: "public" },
)
