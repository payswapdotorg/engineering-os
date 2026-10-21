import { db } from "@/lib/db"
import { newId } from "@/lib/ids"

/**
 * Append-only audit events (ADR-0006, security model). Every mutation in the
 * product writes exactly one event; events are never updated or deleted.
 */

export interface AuditInput {
  projectId?: string | null
  actorType?: "user" | "agent" | "system"
  actorId?: string
  action: string
  entityType: string
  entityId: string
  detail?: unknown
}

export async function recordEvent(input: AuditInput) {
  return db.auditEvent.create({
    data: {
      id: newId("evt"),
      projectId: input.projectId ?? null,
      actorType: input.actorType ?? "user",
      actorId: input.actorId ?? "local-operator",
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      detail: input.detail === undefined ? null : JSON.stringify(input.detail),
    },
  })
}
