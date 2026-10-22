/**
 * NextAuth v4 app-router route (contract §1.2): the directory name is
 * literally `[...nextauth]`; GET+POST are NextAuth's own handler and are NOT
 * wrapped by the api `handler()` gate (they are public by construction —
 * session bootstrap lives here).
 */
import NextAuth from "next-auth"

import { authOptions } from "@/lib/auth"

const h = NextAuth(authOptions)

export { h as GET, h as POST }
