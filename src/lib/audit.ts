import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"
import { newId } from "@/lib/ids"

/**
 * Append-only audit events (ADR-0006, security model). Every mutation in the
 * product writes exactly one event; events are never updated or deleted.
 *
 * Phase-6 session attribution (contract §1.4): when `actorType` is NOT
 * explicitly set, the signed-in session user resolves automatically —
 * {actorType:"user", actorId:<user.id>, userName:<user.name>}. With no
 * session (background/system contexts: recovery scan, scripts, tests) the
 * existing defaults {actorType:"user", actorId:"local-operator", userName:null}
 * keep every prior call site and test intact. Explicit `actorType` inputs
 * ("system" engine probes, "agent" adapter runs) are passed through
 * unchanged — agent/system events keep userName null.
 */
export interface AuditInput {
  projectId?: string | null
  actorType?: "user" | "agent" | "system"
  actorId?: string
  /** Display name for a human actor (session stamping); null for agent/system. */
  userName?: string | null
  action: string
  entityType: string
  entityId: string
  detail?: unknown
}

export async function recordEvent(input: AuditInput) {
  let actorType: "user" | "agent" | "system"
  let actorId: string
  let userName: string | null = input.userName ?? null

  if (input.actorType !== undefined) {
    // Explicit actor (system/agent events, or a route that stamps its own
    // human actor) — behavior unchanged.
    actorType = input.actorType
    actorId = input.actorId ?? "local-operator"
  } else {
    const session = await getSessionUser()
    if (session) {
      actorType = "user"
      actorId = session.id
      userName = session.name
    } else {
      // Background/system context — the Phase-1..5 defaults.
      actorType = "user"
      actorId = input.actorId ?? "local-operator"
    }
  }

  return db.auditEvent.create({
    data: {
      id: newId("evt"),
      projectId: input.projectId ?? null,
      actorType,
      actorId,
      userName,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      detail: input.detail === undefined ? null : JSON.stringify(input.detail),
    },
  })
}
