/**
 * General signup (Slice 14 — closes the Slice-10 §9 honest remainder:
 * "General account signup ⇒ pending rows cannot self-activate").
 *
 * A PUBLIC signup route creates a real User account (global role "engineer",
 * the schema default — a fresh signup can create their OWN projects and sees
 * nothing else: project isolation guarantees that) and ACTIVATES every
 * pending invitation row whose email matches: the row's userId links to the
 * new account, turning the display-only invitation into a real access grant
 * at the invited role. That is the self-activation the isolation contract
 * recorded as impossible before this slice.
 *
 * The activation PLANNER is pure (unit-tested): among a project's pending
 * rows for one email, only ONE can link — the earliest by addedAt (the
 * @@unique([projectId, userId]) grant constraint would otherwise fire on the
 * second row of the same project). At signup time no grant for this user can
 * exist yet (the account is being created now), so the planner's per-project
 * pick is the only constraint-relevant rule.
 */

export const SIGNUP_EMAIL_TAKEN = "an account with this email already exists"
export const SIGNUP_PASSWORD_TOO_SHORT = "password must be at least 8 characters"

/** A pending invitation row as the planner sees it (db row subset). */
export interface PendingInvitationRow {
  id: string
  projectId: string
  addedAt: Date | string
  role: string
}

/** The rows the signup should link, in deterministic order. */
export interface InvitationActivation {
  memberId: string
  projectId: string
  role: string
}

/**
 * Pick the invitation rows to activate: one per project — the EARLIEST row
 * by addedAt (ties broken by id for determinism). Later same-project rows
 * stay display-only (they are honest duplicates; an owner can remove them).
 */
export function planInvitationActivation(rows: readonly PendingInvitationRow[]): InvitationActivation[] {
  const byProject = new Map<string, PendingInvitationRow>()
  for (const row of rows) {
    const current = byProject.get(row.projectId)
    if (current === undefined) {
      byProject.set(row.projectId, row)
      continue
    }
    const t = (r: PendingInvitationRow) => new Date(r.addedAt).getTime()
    const earlier = t(row) < t(current) || (t(row) === t(current) && row.id < current.id)
    if (earlier) byProject.set(row.projectId, row)
  }
  return [...byProject.values()]
    .sort((a, b) => (a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0))
    .map((row) => ({ memberId: row.id, projectId: row.projectId, role: row.role }))
}
