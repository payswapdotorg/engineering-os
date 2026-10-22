/**
 * Worker 3 lane — Phase-6 password helper tests (contract §1.2).
 *
 * Pure unit pins: round-trip, wrong-password refusal, malformed-stored
 * refusal (never throws), and salt uniqueness (same password → different
 * hashes, both still verifiable). The wire format is asserted byte-exactly
 * so the stored format stays stable across sessions.
 */

/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test"

import { hashPassword, verifyPassword } from "@/lib/password"

describe("hashPassword wire format", () => {
  test("produces the pinned scrypt:16384:8:1:<saltB64>:<hashB64> shape", () => {
    const stored = hashPassword("operator-demo-2026")
    const parts = stored.split(":")
    expect(parts.length).toBe(6)
    expect(parts[0]).toBe("scrypt")
    expect(parts[1]).toBe("16384")
    expect(parts[2]).toBe("8")
    expect(parts[3]).toBe("1")
    // 16-byte salt → 24 base64 chars; 64-byte key → 88 base64 chars
    expect(parts[4].length).toBe(24)
    expect(parts[5].length).toBe(88)
  })
})

describe("verifyPassword", () => {
  test("round-trip: the hashed password verifies", () => {
    const stored = hashPassword("correct horse battery staple")
    expect(verifyPassword("correct horse battery staple", stored)).toBe(true)
  })

  test("wrong password → false", () => {
    const stored = hashPassword("correct horse battery staple")
    expect(verifyPassword("wrong horse", stored)).toBe(false)
    expect(verifyPassword("", stored)).toBe(false)
  })

  test("malformed stored value → false (never throws)", () => {
    expect(verifyPassword("whatever", "")).toBe(false)
    expect(verifyPassword("whatever", "plaintext")).toBe(false)
    expect(verifyPassword("whatever", "bcrypt:10:aaa:bbb")).toBe(false)
    expect(verifyPassword("whatever", "scrypt:16384:8:1:only-one-piece")).toBe(false)
    expect(verifyPassword("whatever", "scrypt:notanumber:8:1:AAAA:BBBB")).toBe(false)
    expect(verifyPassword("whatever", "scrypt:16384:8:1::BBBB")).toBe(false) // empty salt
    expect(verifyPassword("whatever", "scrypt:16384:8:1:AAAA:")).toBe(false) // empty hash
  })

  test("salt uniqueness: same password hashes differently (per-hash 16-byte salt), both verify", () => {
    const a = hashPassword("same password")
    const b = hashPassword("same password")
    expect(a).not.toBe(b)
    expect(verifyPassword("same password", a)).toBe(true)
    expect(verifyPassword("same password", b)).toBe(true)
  })
})
