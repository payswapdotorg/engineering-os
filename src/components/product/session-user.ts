"use client"

/**
 * useSessionUser — the product's single typed view of the signed-in operator
 * (Phase-6 contract §1.2 SessionUser).
 *
 * Maps next-auth's session to the contract shape { id, name, email, role }.
 * The JWT/session callbacks (W3-g's src/lib/auth.ts) carry user.id and
 * user.role; anything else on the wire is ignored rather than invented.
 *
 * Returns:
 *  - "loading"   — session still resolving (the shell gate shows skeletons)
 *  - null        — no session (the shell gate shows the auth surface)
 *  - SessionUser — the signed-in human, with a role from the closed vocabulary.
 *
 * Never fake data: a session whose user carries no id, or a role outside
 * "admin" | "engineer" | "viewer", is treated as unauthenticated.
 */
import { useSession } from "next-auth/react"

export type SessionRole = "admin" | "engineer" | "viewer"

/** Contract §1.2 — mirrors getSessionUser()'s SessionUser exactly. */
export interface SessionUser {
  id: string
  name: string
  email: string
  role: SessionRole
}

export type SessionUserState = SessionUser | null | "loading"

export function useSessionUser(): SessionUserState {
  const { data: session, status } = useSession()
  if (status === "loading") return "loading"
  const raw = session?.user as { id?: unknown; name?: unknown; email?: unknown; role?: unknown } | undefined
  if (
    !raw ||
    typeof raw.id !== "string" ||
    raw.role !== "admin" &&
    raw.role !== "engineer" &&
    raw.role !== "viewer"
  ) {
    return null
  }
  return {
    id: raw.id,
    name: typeof raw.name === "string" ? raw.name : "",
    email: typeof raw.email === "string" ? raw.email : "",
    role: raw.role,
  }
}
