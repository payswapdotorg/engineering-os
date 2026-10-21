/**
 * Engineering OS — core domain logic (Worker 3 lane).
 *
 * Pure TypeScript: no DB, no network, no filesystem (ADR-0002) → unit-testable
 * with `bun test` without engines, fixtures or a running server.
 * Normative semantics: docs/03-data/artifact-graph-schema.md
 * Keep exported signatures stable — src/app consumes this module (W1 contract).
 */

// ---------------------------------------------------------------------------
// Typed relations
// ---------------------------------------------------------------------------

export const RELATION_TYPES = [
  "derived_from",
  "analyzes",
  "quantifies",
  "validates",
  "supersedes",
  "depends_on",
  "scheduled_as",
  "approved_by",
] as const

export type RelationType = (typeof RELATION_TYPES)[number]

/** Relations where a change of the target makes the source stale. */
export const IMPACT_RELATIONS = new Set<RelationType>([
  "derived_from",
  "analyzes",
  "quantifies",
  "validates",
  "depends_on",
])

export function isRelationType(v: string): v is RelationType {
  return (RELATION_TYPES as readonly string[]).includes(v)
}

export interface GraphEdge {
  from: string
  to: string
  relation: RelationType
}

export interface ImpactResult {
  affected: string[]
  /** evidence path per affected node: [changed root, …, affected] */
  paths: Record<string, string[]>
}

/**
 * Change impact (Journey G): given changed nodes (roots), return all nodes
 * affected transitively via impact relations. Edge A→B reads "A {relation} B",
 * so a change in B affects A. `supersedes`, `scheduled_as` and `approved_by`
 * are excluded. Cycles are tolerated; evidence keeps the first (shortest,
 * BFS) path found per affected node. Roots themselves are never "affected".
 */
export function computeImpact(roots: string[], edges: GraphEdge[]): ImpactResult {
  const incoming = new Map<string, GraphEdge[]>()
  for (const e of edges) {
    const list = incoming.get(e.to)
    if (list) list.push(e)
    else incoming.set(e.to, [e])
  }

  const seen = new Set<string>(roots)
  const affected: string[] = []
  const paths: Record<string, string[]> = {}
  const queue: Array<{ node: string; path: string[] }> = roots.map((r) => ({ node: r, path: [r] }))

  while (queue.length > 0) {
    const cur = queue.shift()!
    const toHere = incoming.get(cur.node)
    if (!toHere) continue
    for (const e of toHere) {
      if (!IMPACT_RELATIONS.has(e.relation)) continue
      if (e.from === e.to || seen.has(e.from)) continue
      seen.add(e.from)
      const path = [...cur.path, e.from]
      affected.push(e.from)
      paths[e.from] = path
      queue.push({ node: e.from, path })
    }
  }
  return { affected, paths }
}

// ---------------------------------------------------------------------------
// Staleness state machine (per revision)
// ---------------------------------------------------------------------------

export const STALENESS_STATES = ["current", "stale", "recomputing"] as const
export type StalenessState = (typeof STALENESS_STATES)[number]
export type StalenessEvent =
  | "source-changed"
  | "recompute-started"
  | "recompute-succeeded"
  | "recompute-failed"

const STALENESS_TRANSITIONS: Record<StalenessState, Partial<Record<StalenessEvent, StalenessState>>> = {
  current: { "source-changed": "stale" },
  stale: { "source-changed": "stale", "recompute-started": "recomputing" },
  recomputing: { "recompute-succeeded": "current", "recompute-failed": "stale" },
}

export function nextStaleness(from: StalenessState, event: StalenessEvent): StalenessState | null {
  return STALENESS_TRANSITIONS[from][event] ?? null
}

// ---------------------------------------------------------------------------
// Approval state machine (per revision)
// ---------------------------------------------------------------------------

export const APPROVAL_STATES = ["draft", "in_review", "approved", "superseded"] as const
export type ApprovalState = (typeof APPROVAL_STATES)[number]
export type ApprovalAction = "submit" | "approve" | "reject" | "supersede"

const APPROVAL_TRANSITIONS: Record<ApprovalState, Partial<Record<ApprovalAction, ApprovalState>>> = {
  draft: { submit: "in_review", approve: "approved", supersede: "superseded" },
  in_review: { approve: "approved", reject: "draft", supersede: "superseded" },
  approved: { supersede: "superseded" },
  superseded: {},
}

/** Invalid transitions return null (the caller must reject the action). */
export function applyApproval(current: ApprovalState, action: ApprovalAction): ApprovalState | null {
  return APPROVAL_TRANSITIONS[current][action] ?? null
}

// ---------------------------------------------------------------------------
// Team roles & workflow states (Phase-1 data vocabulary)
// ---------------------------------------------------------------------------

export const TEAM_ROLES = ["owner", "editor", "viewer"] as const
export type TeamRole = (typeof TEAM_ROLES)[number]

export const WORKFLOW_STATES = [
  "draft",
  "ready",
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "awaiting_approval",
] as const
export type WorkflowState = (typeof WORKFLOW_STATES)[number]

export function isWorkflowState(v: string): v is WorkflowState {
  return (WORKFLOW_STATES as readonly string[]).includes(v)
}
