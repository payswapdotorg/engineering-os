/**
 * Slice 17 — global-role administration core tests (limitation #19, the
 * roadmap-gap-audit §7.2 admin lane). Pure only: no DB, no network (ADR-0002).
 *
 * Pins EXACTLY the decision matrix planRoleChange can express, with every
 * refusal text VERBATIM (the e2e AC-AD block asserts the same strings — if
 * either side drifts, the other fails):
 *   - role vocabulary round-trip (isAdminRole)
 *   - demo personas keep their provisioned role (any transition, any target)
 *   - no-op changes are refused, never silent 200s
 *   - the last-admin guard: demotion blocked ONLY when no other admin remains
 *     (both engineer- and viewer-bound demotions), allowed when one does
 *   - promotions are always allowed (an engineer/viewer target can never trip
 *     the guard — the admin count only matters for an admin target)
 *   - an out-of-vocabulary stored role is refused honestly, never "fixed"
 *   - the signup toggle vocabulary: default open, "closed" closes, the
 *     closed message is the one the API refuses with (verbatim)
 */

/// <reference types="bun-types" />
import { afterEach, describe, expect, test } from "bun:test"

import {
  ADMIN_ROLES,
  isAdminRole,
  LAST_ADMIN_REFUSED,
  planRoleChange,
  ROLE_CHANGE_DEMO_REFUSED,
  ROLE_CHANGE_NOOP_REFUSED,
  SIGNUP_CLOSED_MESSAGE,
  signupOpen,
  type AdminRole,
  type RoleChangeTarget,
} from "./admin-users"

function target(role: AdminRole, isDemo = false): RoleChangeTarget {
  return { id: "usr_test", role, isDemo }
}

describe("isAdminRole — the closed vocabulary", () => {
  for (const role of ADMIN_ROLES) {
    test(`accepts "${role}"`, () => {
      expect(isAdminRole(role)).toBe(true)
    })
  }
  test("rejects an out-of-vocabulary value", () => {
    expect(isAdminRole("superuser")).toBe(false)
  })
})

describe("planRoleChange — the full decision matrix", () => {
  // Every (from, to) pair the core can see, both as a real account and as a
  // demo persona, with and without a remaining admin — 3×2 order matters
  // where the guards differ; the matrix below pins the pairwise truth.
  for (const from of ADMIN_ROLES) {
    for (const to of ADMIN_ROLES) {
      const isDemotion = from === "admin" && to !== "admin"
      const isNoop = from === to
      test(`real user ${from} → ${to} (otherAdmins 0)`, () => {
        const d = planRoleChange(target(from), to, 0)
        if (isNoop) {
          expect(d).toEqual({ ok: false, message: ROLE_CHANGE_NOOP_REFUSED })
        } else if (isDemotion) {
          expect(d).toEqual({ ok: false, message: LAST_ADMIN_REFUSED })
        } else {
          expect(d).toEqual({ ok: true, from, to })
        }
      })
      test(`real user ${from} → ${to} (otherAdmins 2)`, () => {
        const d = planRoleChange(target(from), to, 2)
        if (isNoop) {
          expect(d).toEqual({ ok: false, message: ROLE_CHANGE_NOOP_REFUSED })
        } else {
          expect(d).toEqual({ ok: true, from, to })
        }
      })
      test(`demo persona ${from} → ${to} refuses first`, () => {
        const d = planRoleChange(target(from, true), to, 5)
        // Demo refusal outranks even the no-op and last-admin guards.
        expect(d).toEqual({ ok: false, message: ROLE_CHANGE_DEMO_REFUSED })
      })
    }
  }

  test("unknown stored role refuses honestly (never a silent fix)", () => {
    const d = planRoleChange({ id: "usr_x", role: "root", isDemo: false }, "engineer", 3)
    expect(d.ok).toBe(false)
    if (!d.ok) {
      expect(d.message).toBe('user has an unknown role "root" (refusing to change it)')
    }
  })

  test("last-admin guard is exact about the otherAdmins input", () => {
    // 0 others → blocked; 1 other → allowed. The count is OTHERS: the actor's
    // own row counts when (and only when) the actor is someone else.
    expect(planRoleChange(target("admin"), "viewer", 0)).toEqual({ ok: false, message: LAST_ADMIN_REFUSED })
    expect(planRoleChange(target("admin"), "viewer", 1)).toEqual({ ok: true, from: "admin", to: "viewer" })
  })

  test("the verbatim refusal strings the e2e pins", () => {
    expect(ROLE_CHANGE_DEMO_REFUSED).toBe(
      "demo personas keep their provisioned role (their grants are re-provisionable demo fixtures — clear the demo accounts and re-provision to change personas)",
    )
    expect(LAST_ADMIN_REFUSED).toBe("cannot demote the last remaining admin (promote another admin first)")
    expect(ROLE_CHANGE_NOOP_REFUSED).toBe("user already has this role")
  })
})

describe("signupOpen — the boot-time deployment toggle", () => {
  const KEY = "EOS_SIGNUP"
  afterEach(() => {
    delete process.env[KEY]
  })

  test("default is OPEN (unset = open — the Slice-14 behavior)", () => {
    delete process.env[KEY]
    expect(signupOpen()).toBe(true)
  })

  test('EOS_SIGNUP="closed" closes signups', () => {
    process.env[KEY] = "closed"
    expect(signupOpen()).toBe(false)
  })

  test('any other value stays open (open, OPEN, "" — one vocabulary, no surprises)', () => {
    for (const value of ["open", "OPEN", "true", ""]) {
      process.env[KEY] = value
      expect(signupOpen()).toBe(true)
    }
  })

  test("the closed message the API refuses with (verbatim, one vocabulary with the UI)", () => {
    expect(SIGNUP_CLOSED_MESSAGE).toBe(
      "signups are closed on this deployment (EOS_SIGNUP=closed at boot — ask the operator to open registration, or have a project owner send an invitation to your email)",
    )
  })
})
