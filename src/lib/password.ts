/**
 * Password hashing for the Phase-6 auth slice (contract §1.2).
 *
 * node:crypto scrypt, N=16384, r=8, p=1, keylen=64, 16-byte random salt.
 * Wire format: `scrypt:16384:8:1:<saltB64>:<hashB64>` (B64 = standard base64).
 * Verification parses the stored value and compares with timingSafeEqual;
 * a malformed stored value returns false — it never throws.
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto"

/** Pinned scrypt parameters (contract §1.2 — do not change silently). */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, saltBytes: 16 } as const

const WIRE_PREFIX = `scrypt:${SCRYPT.N}:${SCRYPT.r}:${SCRYPT.p}`

/** Hash a plaintext password → `scrypt:16384:8:1:<saltB64>:<hashB64>`. */
export function hashPassword(pw: string): string {
  const salt = randomBytes(SCRYPT.saltBytes)
  const hash = scryptSync(pw, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p })
  return `${WIRE_PREFIX}:${salt.toString("base64")}:${hash.toString("base64")}`
}

/**
 * Verify a plaintext password against a stored wire-format hash.
 * Malformed stored value → false (never throws, never locks the API up).
 */
export function verifyPassword(pw: string, stored: string): boolean {
  const parts = stored.split(":")
  if (parts.length !== 6) return false
  if (parts[0] !== "scrypt") return false

  const n = Number.parseInt(parts[1], 10)
  const r = Number.parseInt(parts[2], 10)
  const p = Number.parseInt(parts[3], 10)
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p) || n <= 0 || r <= 0 || p <= 0) {
    return false
  }

  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(parts[4], "base64")
    expected = Buffer.from(parts[5], "base64")
  } catch {
    return false
  }
  if (salt.length === 0 || expected.length === 0) return false

  const actual = scryptSync(pw, salt, expected.length, { N: n, r, p })
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
