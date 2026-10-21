import { createHash } from "node:crypto"

/** SHA-256 of the exact bytes (hex, lowercase). */
export function sha256Hex(data: Buffer | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex")
}
