import { NextResponse } from "next/server"
import type { ZodType } from "zod"

/** JSON envelopes: {data} on success, {error:{code,message}} on failure. */

export function jsonOk<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ data }, init)
}

export function jsonError(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status })
}

export const ERR = {
  notFound: (what: string) => jsonError(404, "not_found", `${what} not found`),
  badRequest: (msg: string) => jsonError(400, "bad_request", msg),
  tooLarge: (msg: string) => jsonError(413, "payload_too_large", msg),
  invalid: (issues: string) => jsonError(422, "validation_failed", issues),
  conflict: (msg: string) => jsonError(409, "conflict", msg),
  server: () => jsonError(500, "internal", "internal error"),
}

export type ParsedBody<T> = { ok: true; data: T } | { ok: false; response: NextResponse }

export async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<ParsedBody<T>> {
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return { ok: false, response: ERR.badRequest("body must be valid JSON") }
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ")
    return { ok: false, response: ERR.invalid(issues) }
  }
  return { ok: true, data: parsed.data }
}
