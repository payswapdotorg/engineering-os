import { recordEvent } from "@/lib/audit"
import { jsonOk, ERR } from "@/lib/api-utils"
import { db } from "@/lib/db"

import { handler, requireProjectAccess } from "../../../../_lib/route-helpers"

export const dynamic = "force-dynamic"

/**
 * DELETE /api/projects/[id]/markups/[markupId] — remove one markup.
 *
 * Gate order (the member-DELETE precedent, entity-seam contract §10):
 *  1. project-exists 404;
 *  2. isolation: requireProjectAccess "read" — a non-member gets the PROJECT
 *     404 before any state logic (hidden ≡ missing);
 *  3. write gate: requireProjectAccess "write" — a project-viewer gets the
 *     uniform read-only 403;
 *  4. the row must exist AND belong to this project ⇒ else 404 `Markup not
 *     found` (same envelope as a missing row — a foreign markup id learns
 *     nothing, the 10-e entity-seam rule);
 *  5. delete ⇒ 200 { removed } · audit markup.removed with detail
 *     { kind, page, quantityId, hadQuantityLink }.
 *
 * Honest scope note: deleting a markup NEVER touches the ledger row it
 * references — quantity rows are the ledger's own lifecycle (transition
 * route); markups are provenance geometry on top.
 */
export const DELETE = handler<{ id: string; markupId: string }>(async (_req, ctx) => {
  const { id, markupId } = await ctx.params

  const project = await db.project.findUnique({ where: { id }, select: { id: true } })
  if (!project) return ERR.notFound("Project")

  // Isolation + write gate in one seam call (route-helpers §3): a non-member
  // gets the PROJECT 404 (hidden ≡ missing) and a project-viewer gets the
  // uniform read-only 403 — both before any state logic.
  const access = await requireProjectAccess(id, "write")
  if (!access.ok) return access.response

  const row = await db.sheetMarkup.findFirst({ where: { id: markupId, projectId: id } })
  if (!row) return ERR.notFound("Markup")

  await db.sheetMarkup.delete({ where: { id: row.id } })

  await recordEvent({
    projectId: id,
    action: "markup.removed",
    entityType: "markup",
    entityId: row.id,
    detail: {
      kind: row.kind,
      page: row.page,
      revisionId: row.revisionId,
      quantityId: row.quantityId,
      hadQuantityLink: row.quantityId !== null,
    },
  })

  return jsonOk({ removed: row.id })
})
