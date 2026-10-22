/**
 * First-run operator setup (contract §1.2) — PUBLIC route (pre-auth by
 * definition): GET reports whether bootstrap is still possible; POST creates
 * the FIRST user (role "admin") and is refused afterwards. This is the only
 * user-creation path in the product — honest limitation: it is first-run
 * only, so operator recovery is a DB operation, never an API loop.
 */
import { z } from "zod"

import { jsonOk, ERR, parseBody } from "@/lib/api-utils"
import { db } from "@/lib/db"
import { hashPassword } from "@/lib/password"

import { handler } from "../../_lib/route-helpers"

export const dynamic = "force-dynamic"

// Pinned verbatim 422 messages (the frontend mirrors these byte-exactly).
export const SETUP_ALREADY_DONE = "operator account already exists (setup is first-run only)"
export const SETUP_PASSWORD_TOO_SHORT = "password must be at least 8 characters"

const setupSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(120, "name must be at most 120 characters"),
  email: z
    .string()
    .trim()
    .min(1, "email is required")
    .email("email must be a valid email address"),
  password: z.string().min(8, SETUP_PASSWORD_TOO_SHORT).max(200, "password must be at most 200 characters"),
})

/** GET /api/auth/setup — {needed: true} while the User table is empty. */
export const GET = handler(
  async () => {
    const count = await db.user.count()
    return jsonOk({ needed: count === 0 })
  },
  { auth: "public" },
)

/** POST /api/auth/setup — create the first user (admin); 422 once one exists. */
export const POST = handler(
  async (req) => {
    const existing = await db.user.count()
    if (existing > 0) {
      return ERR.invalid(SETUP_ALREADY_DONE)
    }

    const parsed = await parseBody(req, setupSchema)
    if (!parsed.ok) return parsed.response
    const { name, email, password } = parsed.data

    const user = await db.user.create({
      data: {
        email: email.toLowerCase(),
        name,
        passwordHash: hashPassword(password),
        role: "admin",
      },
      select: { id: true, name: true, email: true, role: true },
    })

    return jsonOk({ user }, { status: 201 })
  },
  { auth: "public" },
)
