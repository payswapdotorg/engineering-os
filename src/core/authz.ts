/**
 * Slice 10 — project-access decision core (contract §2, ADR-0007).
 *
 * PURE module — no DB, no server-only imports (ADR-0002): the §2 matrix is an
 * exhaustive, unit-pinned decision table. The server seam
 * (src/app/api/_lib/route-helpers.ts) is the ONLY place membership is
 * resolved; it feeds this function { sessionRole, memberRole } and maps the
 * decision to the pinned envelopes:
 *
 *   "allow"     → proceed (an admin bypass may carry member = null)
 *   "not_found" → 404 `Project not found` — non-members cannot learn the
 *                 project exists (same envelope as a missing project;
 *                 GitHub private-repo semantics)
 *   "forbidden" → 403 — need "manage" ⇒ ERR_PROJECT_MANAGE_ONLY, otherwise
 *                 ERR_PROJECT_VIEWER_READ_ONLY (project-level, distinct from
 *                 the wrapper's GLOBAL viewer envelope)
 *
 * Matrix (sessionRole × memberRole × need):
 *   admin            × any memberRole (incl. null) → allow on every need
 *   engineer/viewer  × null (non-member)           → not_found on every need
 *   engineer/viewer  × owner                       → allow on every need
 *   engineer/viewer  × editor                      → allow read/write, forbidden manage
 *   engineer/viewer  × viewer                      → allow read, forbidden write/manage
 *
 * Layering note (§2): a GLOBAL viewer is read-only everywhere via the route
 * wrapper's ERR_VIEWER_READ_ONLY, which fires BEFORE any project logic — this
 * core never sees wrapper-level concerns and only resolves the PROJECT need
 * (so a global viewer who is a project editor resolves write = "allow" HERE;
 * the wrapper still refuses the mutation at the route layer).
 */
import type { TeamRole } from "@/core"

export type ProjectAccessNeed = "read" | "write" | "manage"

export interface ProjectAccessInput {
  /** The signed-in user's global role. */
  sessionRole: "admin" | "engineer" | "viewer"
  /** Linked TeamMember row role ("owner" | "editor" | "viewer"); null = not a member. */
  memberRole: TeamRole | null
}

export type ProjectAccessDecision = "allow" | "not_found" | "forbidden"

/** The member half of the §2 matrix, transcribed verbatim (row × need → decision). */
const MEMBER_MATRIX: Record<TeamRole, Record<ProjectAccessNeed, ProjectAccessDecision>> = {
  owner: { read: "allow", write: "allow", manage: "allow" },
  editor: { read: "allow", write: "allow", manage: "forbidden" },
  viewer: { read: "allow", write: "forbidden", manage: "forbidden" },
}

/**
 * Resolve the §2 matrix. Pure: same inputs ⇒ same decision, no effects, no
 * I/O — unit-testable like every src/core module.
 */
export function resolveProjectAccess(input: ProjectAccessInput, need: ProjectAccessNeed): ProjectAccessDecision {
  // Global admin = superuser (single-space product reality, ADR-0007 §3):
  // allow every need regardless of membership — even memberRole null.
  if (input.sessionRole === "admin") return "allow"

  // Non-member (no linked grant row): not_found, NEVER forbidden — a hidden
  // project and a missing project are indistinguishable to outsiders.
  if (input.memberRole === null) return "not_found"

  // Members: the per-role row of the matrix decides the need.
  return MEMBER_MATRIX[input.memberRole][need]
}
