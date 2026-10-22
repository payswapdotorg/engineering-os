"use client"

/**
 * Session plumbing for the Phase-6 auth slice (W1-g lane).
 *
 * next-auth/react's SessionProvider mounted exactly ONCE around the shell
 * (contract §1.6) — this client wrapper is the single mount point so the root
 * layout stays a one-line edit and no product component re-mounts the provider
 * (nested providers are a next-auth foot-gun; the type does not allow children
 * on a second mount anyway).
 */
import { SessionProvider as NextAuthSessionProvider } from "next-auth/react"

export function SessionProvider({ children }: { children: React.ReactNode }) {
  return <NextAuthSessionProvider>{children}</NextAuthSessionProvider>
}
