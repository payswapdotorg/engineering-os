/**
 * First-run operator setup (contract §1.2) — PUBLIC route (pre-auth by
 * definition): GET reports whether bootstrap is still possible; POST creates
 * the FIRST user (role "admin") and is refused afterwards. Honest boundary:
 * this is the ADMIN bootstrap only — general signup (Slice 14,
 * /api/auth/signup) creates engineer accounts, and demo provisioning creates
 * clearly-labelled personas; operator recovery beyond first run is a DB
 * operation, never an API loop.
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

/** GET /api/auth/setup — {needed: true} while no OPERATOR (non-demo) user exists. */
export const GET = handler(
  async () => {
    // §1.2 extension (demo-accounts slice, recorded): counts NON-DEMO users
    // only — provisioning demo personas must never consume the first-run
    // operator bootstrap. Deviation from the frozen §1.2 wording recorded in
    // the worklog + contract §1.8.
    const count = await db.user.count({ where: { isDemo: false } })
    return jsonOk({ needed: count === 0 })
  },
  { auth: "public" },
)

/** POST /api/auth/setup — create the first OPERATOR (admin); 422 once one exists. */
export const POST = handler(
  async (req) => {
    // §1.2 extension: only non-demo users guard the bootstrap — demo personas
    // (isDemo=true, created by /api/auth/demo-accounts) never count here.
    const existing = await db.user.count({ where: { isDemo: false } })
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
