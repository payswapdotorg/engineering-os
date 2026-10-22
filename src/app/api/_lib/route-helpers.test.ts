/**
 * Worker 3 lane — Phase-6 API session/permission gate tests (contract §1.3).
 *
 * The pinned 401/403 envelopes are asserted byte-exactly (the five e2e
 * scripts and W1-g's frontend both pin these verbatims). The viewer-role
 * branch itself needs a live session cookie (there is no session-injection
 * seam by design — the gate reads the real NextAuth session), so it is
 * proven by the in-session curl probes + e2e runs; what IS unit-testable
 * here is the envelope construction and the no-session behavior of
 * `handler()` (outside a request scope getSessionUser() is honestly null,
 * which is exactly the unauthenticated path).
 */
/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test"

import { ERR_MEMBER_MANAGEMENT, ERR_SIGN_IN_REQUIRED, ERR_VIEWER_READ_ONLY, handler } from "./route-helpers"

function call(gate: ReturnType<typeof handler>, method = "GET") {
  return gate(new Request("http://localhost:3000/api/test", { method }), {
    params: Promise.resolve({} as Record<string, string>),
  })
}

describe("Phase-6 pinned gate envelopes (contract §1.3)", () => {
  test("ERR_SIGN_IN_REQUIRED → 401 {unauthorized, 'sign in required'} verbatim", async () => {
    const res = ERR_SIGN_IN_REQUIRED()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: { code: "unauthorized", message: "sign in required" } })
  })

  test("ERR_VIEWER_READ_ONLY → 403 {forbidden, 'viewer role is read-only'} verbatim", async () => {
    const res = ERR_VIEWER_READ_ONLY()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: { code: "forbidden", message: "viewer role is read-only" } })
  })

  test("ERR_MEMBER_MANAGEMENT → 403 {forbidden, owner-or-admin} verbatim", async () => {
    const res = ERR_MEMBER_MANAGEMENT()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({
      error: { code: "forbidden", message: "only the project owner or an admin can manage team members" },
    })
  })
})

describe("handler() session gate (no session in a test context = unauthenticated)", () => {
  test("default handler → 401 verbatim envelope, fn never runs", async () => {
    let ran = false
    const res = await call(handler(async () => {
      ran = true
      return new Response("ok")
    }) as ReturnType<typeof handler>)
    expect(ran).toBe(false)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: { code: "unauthorized", message: "sign in required" } })
  })

  test("handler(fn, { auth: 'public' }) → fn runs without a session", async () => {
    const res = await call(handler(async () => new Response("ok"), { auth: "public" }) as ReturnType<typeof handler>)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("ok")
  })

  test("unexpected errors still surface the clean internal envelope (pre-Phase-6 behavior intact)", async () => {
    const res = await call(
      handler(async () => {
        throw new Error("boom")
      }, { auth: "public" }) as ReturnType<typeof handler>,
    )
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: { code: "internal", message: "internal error" } })
  })
})
