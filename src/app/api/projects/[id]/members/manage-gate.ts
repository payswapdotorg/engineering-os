import type { SessionUser } from "@/lib/auth"

import { db } from "@/lib/db"

/**
 * The members manage gate (contract §5 step 2) — the ONE documented exception
 * where a route queries TeamMember for an access decision: it keeps its pinned
 * ERR_MEMBER_MANAGEMENT envelope instead of the §3 seam envelopes.
 *
 * Admin bypass; otherwise the caller must hold the project's OWNER row:
 *  - linked grant first: `userId = session.id` (the Slice-10 exact match), or
 *  - the pre-slice legacy fallback for owner rows created before the userId
 *    link existed: `email === session.email OR name === session.name`
 *    (retained deliberately for pre-slice rows — ADR-0007).
 *
 * The boolean is an existence check over one OR'd lookup: a row matching the
 * userId grant OR either legacy column grants management either way, so one
 * query is exactly equivalent to trying the userId match first and falling
 * back to the legacy clause.
 */
export async function requireMemberManager(projectId: string, session: SessionUser): Promise<boolean> {
  if (session.role === "admin") return true
  const ownerRow = await db.teamMember.findFirst({
    where: {
      projectId,
      role: "owner",
      OR: [{ userId: session.id }, { email: session.email }, { name: session.name }],
    },
    select: { id: true },
  })
  return ownerRow !== null
}
