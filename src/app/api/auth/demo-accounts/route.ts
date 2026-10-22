/**
 * Demo accounts (post-Phase-6 slice; contract §1.8) — provisionable demo
 * personas with one-click quick sign-in from the auth surface.
 *
 *  GET     (public) — list the provisioned demo accounts (never returns
 *                    passwordHash; the shared password is a public constant
 *                    by design — see src/lib/demo-accounts.ts).
 *  POST    (public) — IDEMPOTENT ensure: creates the missing fixed roster
 *                    accounts (isDemo=true, shared public password). Accepts
 *                    no client-supplied fields, so provisioning can never
 *                    mint a privileged non-demo account. Never consumes the
 *                    first-run operator bootstrap (setup counts non-demo
 *                    users only — §1.2 extension, deviation recorded).
 *  DELETE          — admin session only (session gate is the default; viewer
 *                    gets the pinned read-only 403, engineer the pinned
 *                    admin-only 403). Removes ONLY isDemo accounts; the
 *                    signed-in user is never deleted (a demo admin removing
 *                    the roster cannot remove herself). Audit attribution
 *                    stays intact — events are append-only.
 *
 * Security posture (recorded honestly): provisioning is public so a fresh
 * install can demo itself before any operator exists; it writes exactly the
 * fixed roster and nothing else.
 */
import { jsonOk, jsonError } from "@/lib/api-utils"
import { recordEvent } from "@/lib/audit"
import { db } from "@/lib/db"
import { DEMO_ACCOUNTS, DEMO_ACCOUNT_PASSWORD } from "@/lib/demo-accounts"
import { getSessionUser } from "@/lib/auth"
import { hashPassword } from "@/lib/password"

import { handler, isUniqueViolation } from "../../_lib/route-helpers"

/** Pinned verbatim 403 for non-admin removal attempts (contract §1.8). */
export const ERR_DEMO_REMOVAL_ADMIN_ONLY = "only an admin can remove demo accounts"

const accountSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  title: true,
  createdAt: true,
} as const

/** GET — the provisioned demo accounts, oldest first, stable shape. */
export const GET = handler(
  async () => {
    const found = await db.user.findMany({
      where: { isDemo: true },
      orderBy: { createdAt: "asc" },
      select: accountSelect,
    })
    return jsonOk({ accounts: found })
  },
  { auth: "public" },
)

/**
 * POST — idempotent ensure of the fixed roster. Concurrent calls are safe:
 * an email-unique violation from a racing create is treated as
 * already-provisioned (skipped, not an error).
 */
export const POST = handler(
  async () => {
    const existing = await db.user.findMany({
      where: { isDemo: true },
      select: { email: true },
    })
    const have = new Set(existing.map((u) => u.email.toLowerCase()))
    const missing = DEMO_ACCOUNTS.filter((spec) => !have.has(spec.email.toLowerCase()))

    const created: { id: string; email: string; role: string }[] = []
    for (const spec of missing) {
      try {
        const user = await db.user.create({
          data: {
            name: spec.name,
            email: spec.email,
            title: spec.title,
            role: spec.role,
            isDemo: true,
            passwordHash: hashPassword(DEMO_ACCOUNT_PASSWORD),
          },
          select: accountSelect,
        })
        created.push({ id: user.id, email: user.email, role: user.role })
      } catch (err) {
        if (isUniqueViolation(err)) continue // racing provision — fine
        throw err
      }
    }

    if (created.length > 0) {
      // System actor by definition (public route, no session required) —
      // system events keep userName null per contract §1.4.
      await recordEvent({
        actorType: "system",
        actorId: "system:demo-provisioner",
        action: "user.demo.provisioned",
        entityType: "user",
        entityId: "demo-roster",
        detail: {
          created: created.map((u) => ({ id: u.id, email: u.email, role: u.role })),
        },
      })
    }

    const accounts = await db.user.findMany({
      where: { isDemo: true },
      orderBy: { createdAt: "asc" },
      select: accountSelect,
    })
    return jsonOk({ created: created.length, accounts }, { status: created.length > 0 ? 201 : 200 })
  },
  { auth: "public" },
)

/** DELETE — admin-only removal of the demo roster (never the caller). */
export const DELETE = handler(async () => {
  const session = await getSessionUser()
  if (!session || session.role !== "admin") {
    return jsonError(403, "forbidden", ERR_DEMO_REMOVAL_ADMIN_ONLY)
  }

  const demoUsers = await db.user.findMany({
    where: { isDemo: true },
    select: { id: true, email: true },
  })
  const removable = demoUsers.filter((u) => u.id !== session.id)

  const result = await db.user.deleteMany({
    where: { isDemo: true, id: { not: session.id } },
  })

  if (result.count > 0) {
    // Session attribution resolves automatically (contract §1.4): the admin
    // human performed this removal — actorType "user" + their id + name.
    await recordEvent({
      action: "user.demo.removed",
      entityType: "user",
      entityId: "demo-roster",
      detail: {
        removed: removable.slice(0, result.count).map((u) => ({ id: u.id, email: u.email })),
        skippedSelf: demoUsers.some((u) => u.id === session.id),
      },
    })
  }

  const remaining = await db.user.count({ where: { isDemo: true } })
  return jsonOk({ removed: result.count, remaining })
})
