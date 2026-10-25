/**
 * GET /api/admin/users — the global user directory (Slice 17, limitation #19:
 * "per-field admin tooling for global roles does not exist yet" closed).
 *
 * ADMIN-ONLY (the ERR_ADMIN_USERS_ONLY gate below — the dedicated
 * routes). Returns every account with its global role, demo flag and title so
 * the Administration surface can list them. No password material, no hashes
 * — the projection below is the entire response shape.
 */
import { jsonOk } from "@/lib/api-utils"
import { getSessionUser } from "@/lib/auth"
import { db } from "@/lib/db"

import { ERR_ADMIN_USERS_ONLY, ERR_SIGN_IN_REQUIRED, handler } from "../../_lib/route-helpers"

export const dynamic = "force-dynamic"

export const GET = handler(async () => {
  // Slice 10: admin-gated surface (contract §4 admin superuser).
  const session = await getSessionUser()
  if (!session) return ERR_SIGN_IN_REQUIRED()
  if (session.role !== "admin") return ERR_ADMIN_USERS_ONLY()

  const users = await db.user.findMany({
    orderBy: [{ isDemo: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      isDemo: true,
      title: true,
      createdAt: true,
    },
  })

  return jsonOk({ users })
})
