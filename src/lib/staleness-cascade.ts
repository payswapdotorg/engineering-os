/**
 * Engineering OS — the staleness cascade (docs/03-data/artifact-graph-schema.md §2),
 * shared by the artifact-revisions upload route (Phase 2) and the parametric
 * rebuild core (Slice 16): when an artifact gains a new revision, every
 * artifact with an IMPACT relation pointing at it is marked stale with path
 * evidence, one `artifact.staled` audit event per marked artifact.
 *
 * Extracted from the revisions route in Slice 16 so the broker's
 * `rebuild_parametric` core (which appends revisions to the derived model
 * artifact) rides the IDENTICAL semantics — no second implementation to drift.
 * Behavior is byte-identical to the inline route logic it replaced.
 */
import { db } from "@/lib/db"
import { recordEvent } from "@/lib/audit"
import { IMPACT_RELATIONS, nextStaleness, type StalenessState } from "@/core"

export interface StaleMarkedRow {
  artifactId: string
  name: string
  relation: string
  path: string[]
}

/**
 * Mark every downstream artifact (impact-relation edges pointing at
 * `revisedArtifactId`) stale. Returns the evidence rows for the caller's
 * response/audit detail. Idempotent per staleness state machine: an already
 * stale artifact stays stale (nextStaleness returns null → skipped).
 */
export async function markDownstreamStale(
  projectId: string,
  revisedArtifactId: string,
): Promise<StaleMarkedRow[]> {
  const impactLinks = await db.artifactLink.findMany({
    where: { toArtifactId: revisedArtifactId, relationType: { in: [...IMPACT_RELATIONS] } },
    include: { fromArtifact: { include: { latestRevision: true } } },
  })

  const staleMarked: StaleMarkedRow[] = []
  const seenSources = new Set<string>()

  for (const link of impactLinks) {
    const source = link.fromArtifact
    if (seenSources.has(source.id)) continue
    seenSources.add(source.id)

    const latest = source.latestRevision
    if (!latest) continue

    const next = nextStaleness(latest.staleness as StalenessState, "source-changed")
    if (next === null) continue

    await db.artifactRevision.update({ where: { id: latest.id }, data: { staleness: next } })

    await recordEvent({
      projectId: source.projectId,
      action: "artifact.staled",
      entityType: "artifact",
      entityId: source.id,
      detail: {
        staleArtifactId: source.id,
        because: revisedArtifactId,
        relation: link.relationType,
        path: [revisedArtifactId, source.id],
      },
    })

    staleMarked.push({
      artifactId: source.id,
      name: source.name,
      relation: link.relationType,
      path: [revisedArtifactId, source.id],
  })
  }

  void projectId // the audit rows carry each source's own project; the caller's project is context only
  return staleMarked
}
