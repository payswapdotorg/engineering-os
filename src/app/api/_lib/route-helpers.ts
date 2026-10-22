/**
 * Shared helpers for Engineering OS API routes (W1 lane).
 * Private folder: Next.js never maps `_*` folders to routes.
 *
 * Phase-6 session gates (contract §1.3): `handler(fn)` now REQUIRES a
 * signed-in session by default; opt out with `handler(fn, { auth: "public" })`
 * (only /api/auth/setup and /api/status do). Unauthenticated → 401 envelope;
 * viewer role on a mutating verb → 403 envelope (both verbatim, pinned by
 * e2e scripts). NextAuth's own /api/auth/* route is not wrapped at all.
 */
import { z } from "zod"

import { ERR, jsonError } from "@/lib/api-utils"
import { getSessionUser } from "@/lib/auth"

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
