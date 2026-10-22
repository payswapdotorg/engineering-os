/**
 * NextAuth core (Phase-6 auth slice, contract §1.2).
 *
 * Credentials provider (email + password) against the User table, JWT
 * sessions, and a `getSessionUser()` helper for route handlers. NextAuth v4
 * in the app router: `getServerSession` is imported from "next-auth" and
 * reads cookies/headers via next/headers — outside a request scope it throws,
 * which `getSessionUser` converts to null (background/system context).
 */
import type { NextAuthOptions } from "next-auth"
import { getServerSession } from "next-auth"
import type { Session } from "next-auth"
import CredentialsProvider from "next-auth/providers/credentials"

import { db } from "@/lib/db"
import { verifyPassword } from "@/lib/password"

export type UserRole = "admin" | "engineer" | "viewer"

/** The signed-in human as seen by API routes (contract §1.2). */
export interface SessionUser {
  id: string
  name: string
  email: string
  role: UserRole
}

function asRole(role: string): UserRole {
  return role === "admin" || role === "viewer" ? role : "engineer"
}

export const authOptions: NextAuthOptions = {
  session: { strategy: "jwt" },
  pages: { signIn: "/signin" },
  providers: [
    CredentialsProvider({
      name: "Engineering OS",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const email = credentials?.email?.trim().toLowerCase()
        const password = credentials?.password
        if (!email || !password) return null

        const user = await db.user.findUnique({ where: { email } })
        if (!user) return null
        if (!verifyPassword(password, user.passwordHash)) return null

        return { id: user.id, name: user.name, email: user.email, role: asRole(user.role) }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id
        const withRole = user as unknown as { role?: unknown }
        token.role =
          typeof withRole.role === "string" && withRole.role.length > 0
            ? (asRole(withRole.role))
            : "engineer"
      }
      return token
    },
    async session({ session, token }) {
      if (session.user) {
        ;(session.user as Session["user"] & { id?: string; role?: UserRole }).id = token.id as string
        ;(session.user as Session["user"] & { id?: string; role?: UserRole }).role =
          token.role as UserRole
      }
      return session
    },
  },
}

/**
 * The current session user, or null when unauthenticated / outside a request
 * scope (background contexts, scripts, tests). Never throws.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  try {
    const session = await getServerSession(authOptions)
    const user = session?.user as (Session["user"] & { id?: string; role?: string }) | undefined
    if (!user?.id || !user.email) return null
    return {
      id: user.id,
      name: user.name ?? user.email,
      email: user.email,
      role: asRole(user.role ?? "engineer"),
    }
  } catch {
    // next/headers outside a request scope (background executor, scripts) —
    // honest null: there is no session there by definition.
    return null
  }
}
