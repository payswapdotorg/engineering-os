/**
 * Shared helpers for Engineering OS API routes (W1 lane).
 * Private folder: Next.js never maps `_*` folders to routes.
 */
import { z } from "zod"

import { ERR } from "@/lib/api-utils"

export interface RouteCtx<P extends Record<string, string>> {
  params: Promise<P>
}

/**
 * Wraps a route handler so unexpected errors log to dev.log and surface as a
 * clean `{error:{code:"internal"}}` envelope instead of an HTML error page.
 */
export function handler<P extends Record<string, string> = Record<string, string>>(
  fn: (req: Request, ctx: RouteCtx<P>) => Promise<Response>,
) {
  return async (req: Request, ctx: RouteCtx<P>): Promise<Response> => {
    try {
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
