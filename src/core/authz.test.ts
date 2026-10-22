/**
 * Slice 10 — project-access decision core tests (contract §2, ADR-0007).
 *
 * The FULL §2 matrix is pinned exhaustively — every (sessionRole, memberRole)
 * cell the core can express, each asserting all three needs (12 cells × 3
 * needs = 36 assertions): admin × every memberRole (incl. null), non-members
 * under both non-admin global roles, and every member role under both
 * non-admin global roles. Plus the two documented layerings (§2 notes / §7):
 * a global engineer who is a project viewer is read-only IN THAT PROJECT, and
 * a global viewer who is a project editor resolves the PROJECT need with the
 * core (the route wrapper's global-viewer 403 fires first — the core only
 * ever resolves the project half). Pure only: no DB, no engines (ADR-0002).
 */

/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test"

import { resolveProjectAccess } from "./authz"
import type { ProjectAccessDecision, ProjectAccessInput, ProjectAccessNeed } from "./authz"

const NEEDS: readonly ProjectAccessNeed[] = ["read", "write", "manage"]
const NON_ADMIN_SESSION_ROLES = ["engineer", "viewer"] as const
const MEMBER_ROLES = ["owner", "editor", "viewer"] as const

/** All three §2 decisions for one (session, member) cell — one readable object per test. */
function cell(sessionRole: ProjectAccessInput["sessionRole"], memberRole: ProjectAccessInput["memberRole"]) {
  const byNeed = {} as Record<ProjectAccessNeed, ProjectAccessDecision>
  for (const need of NEEDS) byNeed[need] = resolveProjectAccess({ sessionRole, memberRole }, need)
  return byNeed
}

// ---------------------------------------------------------------------------
// §2 row 1 — admin: superuser for ANY memberRole (incl. null)
// ---------------------------------------------------------------------------

describe("resolveProjectAccess — §2 row 1: admin allows every need for ANY memberRole (incl. null)", () => {
  for (const memberRole of [...MEMBER_ROLES, null]) {
    test(`admin × memberRole=${memberRole ?? "null"} → allow on read, write and manage`, () => {
      expect(cell("admin", memberRole)).toEqual({ read: "allow", write: "allow", manage: "allow" })
    })
  }
})

// ---------------------------------------------------------------------------
// §2 row 2 — non-members: not_found (never forbidden) on every need
// ---------------------------------------------------------------------------

describe("resolveProjectAccess — §2 row 2: non-members get not_found on every need (404-no-leak)", () => {
  for (const sessionRole of NON_ADMIN_SESSION_ROLES) {
    test(`${sessionRole} × memberRole=null → not_found on read, write and manage (admin already pinned above)`, () => {
      expect(cell(sessionRole, null)).toEqual({ read: "not_found", write: "not_found", manage: "not_found" })
    })
  }
})

// ---------------------------------------------------------------------------
// §2 rows 3–5 — member roles under both non-admin global roles
// ---------------------------------------------------------------------------

describe("resolveProjectAccess — §2 rows 3-5: member roles for engineer/viewer sessions", () => {
  for (const sessionRole of NON_ADMIN_SESSION_ROLES) {
    test(`${sessionRole} × owner → allow on every need`, () => {
      expect(cell(sessionRole, "owner")).toEqual({ read: "allow", write: "allow", manage: "allow" })
    })

    test(`${sessionRole} × editor → allow read/write, forbidden manage (settings/team are owner/admin)`, () => {
      expect(cell(sessionRole, "editor")).toEqual({ read: "allow", write: "allow", manage: "forbidden" })
    })

    test(`${sessionRole} × viewer → allow read, forbidden write/manage (in-project read-only)`, () => {
      expect(cell(sessionRole, "viewer")).toEqual({ read: "allow", write: "forbidden", manage: "forbidden" })
    })
  }
})

// ---------------------------------------------------------------------------
// Documented layerings (§2 notes / §7)
// ---------------------------------------------------------------------------

describe("resolveProjectAccess — documented layerings (§2 notes)", () => {
  test("global engineer + project-viewer: read allowed, write/manage forbidden — read-only IN THAT PROJECT", () => {
    // The first documented layering: a global engineer who was granted the
    // project-viewer role is read-only in that ONE project. The core decides
    // this cell directly (matrix row 5) — no wrapper involvement needed.
    expect(cell("engineer", "viewer")).toEqual({ read: "allow", write: "forbidden", manage: "forbidden" })
  })

  test("global viewer + project-editor: the core resolves the PROJECT need (read allow, write allow) — the route wrapper's global-viewer 403 fires FIRST, so the effective outcome is read-only", () => {
    // The second documented layering: for a GLOBAL viewer the wrapper's
    // ERR_VIEWER_READ_ONLY fires before any project logic, which is why the
    // effective route-level outcome for this cell is read allow / write
    // forbidden. This core never sees that global half — it must still
    // resolve the project need honestly (matrix row 4: editor ⇒ write allow
    // at the project level). Layered: wrapper global 403 + core project allow.
    expect(cell("viewer", "editor")).toEqual({ read: "allow", write: "allow", manage: "forbidden" })
  })
})

// ---------------------------------------------------------------------------
// Purity / determinism spot-check (same inputs ⇒ same decision)
// ---------------------------------------------------------------------------

describe("resolveProjectAccess — deterministic and total over its domain", () => {
  test("repeated resolution of the same cell is stable (pure function, no effects)", () => {
    const first = cell("engineer", "viewer")
    const second = cell("engineer", "viewer")
    expect(first).toEqual(second)
    // Every decision is one of the three §2 values — never undefined, never a stray string.
    for (const sessionRole of ["admin", ...NON_ADMIN_SESSION_ROLES] as const) {
      for (const memberRole of [...MEMBER_ROLES, null]) {
        for (const need of NEEDS) {
          const decision = resolveProjectAccess({ sessionRole, memberRole }, need)
          expect(["allow", "not_found", "forbidden"]).toContain(decision)
        }
      }
    }
  })
})
