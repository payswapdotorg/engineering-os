/**
 * GET /api/admin/settings — deployment facts for the Administration surface
 * (Slice 17). ADMIN-ONLY. Carries the settings an operator can actually
 * change on this deployment — today exactly one: the signup toggle, whose
 * truth is the boot-time process environment (EOS_SIGNUP, read through the
 * one vocabulary in src/lib/admin-users.ts). The response never invents a
 * knob the platform does not have (no fake toggles, no dead switches): every
 * item names HOW it is changed, because the toggle is env-gated at boot by
 * design (roadmap-gap-audit §7.2).
 */
import { jsonOk } from "@/lib/api-utils"
import { signupOpen, SIGNUP_CLOSED_MESSAGE } from "@/lib/admin-users"
import { getSessionUser } from "@/lib/auth"

import { ERR_ADMIN_USERS_ONLY, ERR_SIGN_IN_REQUIRED, handler } from "../../_lib/route-helpers"

export const dynamic = "force-dynamic"

export const GET = handler(async () => {
  const session = await getSessionUser()
  if (!session) return ERR_SIGN_IN_REQUIRED()
  if (session.role !== "admin") return ERR_ADMIN_USERS_ONLY()

  return jsonOk({
    signup: {
      open: signupOpen(),
      howToChange: "set EOS_SIGNUP=open|closed in the deployment environment and restart (boot-time gate)",
      closedMessage: SIGNUP_CLOSED_MESSAGE,
    },
  })
})
