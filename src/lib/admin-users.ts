/**
 * Global-role administration core (Slice 17 — limitation #19's product half,
 * roadmap-gap-audit §7.2 item 1).
 *
 * Pure TypeScript: no DB, no network (ADR-0002 discipline — every rule here is
 * unit-testable without a server). The route layer owns the zod parse and the
 * Prisma reads; this module owns the DECISION: which role changes are allowed
 * on which users, and the exact refusal text for each honest "no".
 *
 * Rules (all verbatim-pinned by src/lib/admin-users.test.ts + e2e AC-AD-01…):
 *  1. Demo personas keep their provisioned role — their grants are the
 *     re-provisionable demo fixtures the release docs and e2e suites rely on
 *     (kwame=engineer, zara=viewer, ama=admin). On a real deployment every
 *     account has isDemo=false, so this refusal is invisible in production.
 *  2. The LAST admin can never be demoted — there must always remain at
 *     least one admin able to administer the deployment. The count is the
 *     number of OTHER REAL admins (id != target, isDemo false): demo
 *     personas never count (they are re-provisionable fixtures that can
 *     never themselves be demoted — a deployment's durable adminship must
 *     not hang on one), and the actor's own row counts when the actor is
 *     someone else. The demo-exclusion is enforced by the route's count
 *     query and pinned live by the e2e (AC-AD-10 — the 422 fires while a
 *     demo-admin persona exists, proving fixtures don't count).
 *  3. A no-op change is an explicit refusal, never a silent 200: the audit
 *     trail records real transitions only.
 */

/** The closed global-role vocabulary (contract §1.2 — mirrors src/lib/auth.ts). */
export const ADMIN_ROLES = ["admin", "engineer", "viewer"] as const
export type AdminRole = (typeof ADMIN_ROLES)[number]

export function isAdminRole(value: string): value is AdminRole {
  return ADMIN_ROLES.some((role) => role === value)
}

/** Verbatim refusals — pinned by unit tests AND e2e assertions. */
export const ROLE_CHANGE_DEMO_REFUSED =
  "demo personas keep their provisioned role (their grants are re-provisionable demo fixtures — clear the demo accounts and re-provision to change personas)"
export const LAST_ADMIN_REFUSED =
  "cannot demote the last remaining admin (promote another admin first)"
export const ROLE_CHANGE_NOOP_REFUSED = "user already has this role"

/** The admin-users route's decision shape. */
export type RoleChangeDecision =
  | { ok: true; from: AdminRole; to: AdminRole }
  | { ok: false; message: string }

export interface RoleChangeTarget {
  id: string
  role: string
  isDemo: boolean
}

/**
 * Decide one role-change request. Inputs are the target row (as the route
 * loaded it) and the count of OTHER admin rows. Order matters and is pinned:
 * demo refusal fires before the last-admin guard (a demo persona can never
 * be the last admin BECAUSE it can never be demoted — but an operator could
 * in principle be the only admin AND a demo... provisioning forbids that by
 * construction: the operator is never a demo persona. The order still keeps
 * the more specific refusal first).
 */
export function planRoleChange(
  target: RoleChangeTarget,
  to: AdminRole,
  otherAdmins: number,
): RoleChangeDecision {
  if (!isAdminRole(target.role)) {
    // Defensive: the DB column is a free string; an out-of-vocabulary row is
    // never silently "fixed" by a demotion — refuse with the honest state.
    return { ok: false, message: `user has an unknown role "${target.role}" (refusing to change it)` }
  }
  if (target.isDemo) return { ok: false, message: ROLE_CHANGE_DEMO_REFUSED }
  if (target.role === to) return { ok: false, message: ROLE_CHANGE_NOOP_REFUSED }
  if (target.role === "admin" && to !== "admin" && otherAdmins === 0) {
    return { ok: false, message: LAST_ADMIN_REFUSED }
  }
  return { ok: true, from: target.role, to }
}

/**
 * Deployment signup toggle (roadmap-gap-audit §7.2: "closed-signup deployment
 * toggle (env-gated at boot, surfaced honestly in the UI when off)").
 *
 * EOS_SIGNUP is read from the process environment: the dev-server launcher
 * and the systemd EnvironmentFile both export it at EXEC time, so the value
 * IS the boot value for the process lifetime. The public status route and
 * the signup route read it through here so there is exactly one vocabulary.
 */
export const SIGNUP_CLOSED_MESSAGE =
  "signups are closed on this deployment (EOS_SIGNUP=closed at boot — ask the operator to open registration, or have a project owner send an invitation to your email)"

export function signupOpen(): boolean {
  return process.env.EOS_SIGNUP !== "closed"
}
