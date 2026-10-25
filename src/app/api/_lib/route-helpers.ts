/**
 * Shared helpers for Engineering OS API routes (W1 lane).
 * Private folder: Next.js never maps `_*` folders to routes.
 *
 * Phase-6 session gates (contract §1.3): `handler(fn)` now REQUIRES a
 * signed-in session by default; opt out with `handler(fn, { auth: "public" })`
 * (only /api/auth/setup and /api/status do). Unauthenticated → 401 envelope;
 * viewer role on a mutating verb → 403 envelope (both verbatim, pinned by
 * e2e scripts). NextAuth's own /api/auth/* route is not wrapped at all.
 *
 * Slice-10 project isolation (contract §3): this file is also the ONLY seam
 * where project membership is resolved — `requireProjectAccess` / `requireEntityProject`
 * load the linked TeamMember grant, run the pure §2 core (`src/core/authz.ts`)
 * and map its decision to the pinned 404/403 envelopes below. Routes never
 * query TeamMember for access themselves (the members manage-gate in §5 is
 * the documented exception).
 */
import type { NextResponse } from "next/server"
import { z } from "zod"

import type { TeamRole } from "@/core"
import { resolveProjectAccess, type ProjectAccessNeed } from "@/core/authz"
import { ERR, jsonError } from "@/lib/api-utils"
import { getSessionUser, type SessionUser } from "@/lib/auth"
import { db } from "@/lib/db"

export interface RouteCtx<P extends Record<string, string>> {
  params: Promise<P>
}

/** Pinned verbatim 401 envelope (contract §1.3 / §1.6). */
export const ERR_SIGN_IN_REQUIRED = () => jsonError(401, "unauthorized", "sign in required")

/** Pinned verbatim 403 envelope for the viewer role (contract §1.3 / §1.6). */
export const ERR_VIEWER_READ_ONLY = () => jsonError(403, "forbidden", "viewer role is read-only")

/** Pinned verbatim 403 envelope for team-member management (contract §1.3). */
export const ERR_MEMBER_MANAGEMENT = () =>
  jsonError(403, "forbidden", "only the project owner or an admin can manage team members")

/** 403 verbatim — project-level read-only (distinct from the GLOBAL viewer envelope). */
export const ERR_PROJECT_VIEWER_READ_ONLY = () =>
  jsonError(403, "forbidden", "your role on this project is read-only")

/** 403 verbatim — project settings/identity management (owner or admin). */
export const ERR_PROJECT_MANAGE_ONLY = () =>
  jsonError(403, "forbidden", "only the project owner or an admin can manage this project")

/** 403 verbatim — platform-level storage administration. */
export const ERR_ADMIN_ONLY = () =>
  jsonError(403, "forbidden", "only an admin can manage platform storage")

/** 403 verbatim — platform-level account administration (Slice 17, limitation #19). */
export const ERR_ADMIN_USERS_ONLY = () =>
  jsonError(403, "forbidden", "only an admin can manage accounts")

/** `auth: "public"` opts — the ONLY opt-out from the session gate. */
export interface HandlerOptions {
  auth?: "public"
}

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"])

/**
 * Wraps a route handler:
 *  - default: session required (401 verbatim when missing) and the viewer
 *    role is read-only on mutating verbs (403 verbatim);
 *  - `{ auth: "public" }`: no gate (health checks + first-run setup only).
 * Unexpected errors still log to dev.log and surface as a clean
 * `{error:{code:"internal"}}` envelope instead of an HTML error page.
 */
export function handler<P extends Record<string, string> = Record<string, string>>(
  fn: (req: Request, ctx: RouteCtx<P>) => Promise<Response>,
  opts?: HandlerOptions,
) {
  return async (req: Request, ctx: RouteCtx<P>): Promise<Response> => {
    try {
      if (opts?.auth !== "public") {
        const session = await getSessionUser()
        if (!session) return ERR_SIGN_IN_REQUIRED()
        if (session.role === "viewer" && MUTATING_METHODS.has(req.method.toUpperCase())) {
          return ERR_VIEWER_READ_ONLY()
        }
      }
      return await fn(req, ctx)
    } catch (err) {
      console.error("[api] unexpected error:", err)
      return ERR.server()
    }
  }
}

/** Zod validator for closed string vocabularies (disciplines, roles, …). */
export function stringEnum(values: readonly string[], label: string) {
  return z
    .string()
    .refine((v) => values.includes(v), { message: `${label} must be one of: ${values.join(", ")}` })
}

/** URL-safe slug base (lowercase, dashed). */
export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
  return base.length > 0 ? base : "project"
}

/** Random suffix for unique slugs (4 lowercase alphanumeric chars). */
export function randomSuffix(): string {
  return Array.from({ length: 4 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("")
}

/** `true` when `err` is a Prisma unique-constraint violation (P2002). */
export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "P2002"
  )
}

// ---------------------------------------------------------------------------
// Slice-10 project access seam (contract §3 / ADR-0007)
// ---------------------------------------------------------------------------

export type ProjectAccessOk = {
  ok: true
  session: SessionUser // non-null (admin bypass may carry member = null)
  member: { id: string; userId: string; role: TeamRole } | null
}

/** Discriminated result: `{ ok: true; session; member } | { ok: false; response }` (contract §3). */
export type ProjectAccessResult = ProjectAccessOk | { ok: false; response: NextResponse }

/**
 * Membership check for a DIRECT projectId. Resolution order (contract §3):
 *  1. session = getSessionUser() → null ⇒ ERR_SIGN_IN_REQUIRED() (defensive; the wrapper already gates)
 *  2. member = db.teamMember.findFirst({ where: { projectId, userId: session.id } })
 *  3. decision = resolveProjectAccess({ sessionRole: session.role, memberRole: member?.role ?? null }, need)
 *  4. not_found ⇒ ERR.notFound("Project")  ·  forbidden ⇒
 *     need === "manage" ? ERR_PROJECT_MANAGE_ONLY() : ERR_PROJECT_VIEWER_READ_ONLY()
 */
export async function requireProjectAccess(projectId: string, need: ProjectAccessNeed): Promise<ProjectAccessResult> {
  // 1. Session (defensive — every wrapped route already 401s without one).
  const session = await getSessionUser()
  if (!session) return { ok: false, response: ERR_SIGN_IN_REQUIRED() }

  // 2. The linked membership grant: only rows with userId != null can match —
  //    display/pending roster rows (userId = null) grant nothing by design.
  const member = await db.teamMember.findFirst({
    where: { projectId, userId: session.id },
    select: { id: true, userId: true, role: true },
  })

  // 3. Pure §2 decision. The role string is boundary-guaranteed to be a
  //    TEAM_ROLES value (zod stringEnum(TEAM_ROLES) on member creation and
  //    the literal "owner" on the auto-owner row), so the cast is safe.
  const decision = resolveProjectAccess(
    { sessionRole: session.role, memberRole: (member?.role as TeamRole | undefined) ?? null },
    need,
  )

  // 4. Map the decision to the pinned envelopes — not_found reuses the SAME
  //    envelope as a missing project (404-no-leak, GitHub private-repo semantics).
  if (decision === "not_found") return { ok: false, response: ERR.notFound("Project") }
  if (decision === "forbidden") {
    return {
      ok: false,
      response: need === "manage" ? ERR_PROJECT_MANAGE_ONLY() : ERR_PROJECT_VIEWER_READ_ONLY(),
    }
  }

  // allow: a member carries their grant row (userId matched session.id, so it
  // is non-null); an admin bypass carries member = null.
  if (member) {
    return {
      ok: true,
      session,
      member: { id: member.id, userId: member.userId as string, role: member.role as TeamRole },
    }
  }
  return { ok: true, session, member: null }
}

/**
 * Entity-scoped variant: `entity` is the LOADED parent row carrying projectId
 * (or null ⇒ ERR.notFound(entityLabel) — same envelope as the missing-entity
 * path, so a hidden project and a missing entity are indistinguishable).
 * Delegates to requireProjectAccess(entity.projectId, need).
 */
export async function requireEntityProject(
  entity: { projectId: string } | null,
  entityLabel: string,
  need: ProjectAccessNeed,
): Promise<ProjectAccessResult> {
  if (!entity) return { ok: false, response: ERR.notFound(entityLabel) }
  const access = await requireProjectAccess(entity.projectId, need)
  // Slice 10 (contract §3): a hidden project and a missing entity are
  // indistinguishable — relabel the membership 404 to the entity envelope
  // (401/403 pass through unchanged).
  if (!access.ok && access.response.status === 404) {
    return { ok: false, response: ERR.notFound(entityLabel) }
  }
  return access
}
