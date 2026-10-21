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
 *
 * Hardened edge-case contract (pinned by src/core/graph.test.ts):
 *  - multiple roots are all seeded at BFS depth 0 (union of their impact sets)
 *  - duplicate roots are collapsed; root order decides evidence-path ties
 *  - a node affected via two paths appears once, keeping the first-found
 *    (shortest, BFS) evidence path
 *  - cycles are tolerated (each node is visited at most once) and self-loops
 *    are ignored outright
 *  - non-impact relations (`supersedes`, `scheduled_as`, `approved_by`) never
 *    propagate — neither as an entry into the impact set nor THROUGH an
 *    already-affected node
 *  - malformed edges (empty-string endpoints) are skipped instead of crashing
 */
export function computeImpact(roots: string[], edges: GraphEdge[]): ImpactResult {
  const { affected, paths } = walkImpact(roots, edges)
  return { affected, paths }
}

export interface ImpactDescription {
  affected: string[]
  /** evidence path per affected node: [changed root, …, affected] */
  paths: Record<string, string[]>
  /**
   * Relation type of the final edge that pulled each affected node into the
   * impact set — e.g. `{ ["rev_x"]: "derived_from" }` lets the UI badge read
   * "stale: derived_from rev_x". Keys are exactly the affected node ids;
   * values are `RelationType` (a string subtype, so this satisfies
   * `Record<string, string>` consumers as well).
   */
  via: Record<string, RelationType>
}

/**
 * Impact set + evidence for the UI staleness badge. Same traversal and
 * hardening contract as `computeImpact`, plus the `via` relation map.
 */
export function describeImpact(roots: string[], edges: GraphEdge[]): ImpactDescription {
  return walkImpact(roots, edges)
}

interface ImpactWalk {
  affected: string[]
  paths: Record<string, string[]>
  via: Record<string, RelationType>
}

/**
 * Shared BFS over incoming impact edges (internal). Edge A→B reads
 * "A {relation} B": a change in B makes A stale, then A's own dependents are
 * reached transitively — but only along `IMPACT_RELATIONS` edges.
 */
function walkImpact(roots: string[], edges: GraphEdge[]): ImpactWalk {
  // Index incoming edges per target node. Self-loops (e.from === e.to) and
  // malformed edges with empty endpoints are dropped here — they can never
  // propagate impact and would otherwise pollute the traversal.
  const incoming = new Map<string, GraphEdge[]>()
  for (const e of edges) {
    if (e.from === "" || e.to === "") continue
    if (e.from === e.to) continue
    const list = incoming.get(e.to)
    if (list) list.push(e)
    else incoming.set(e.to, [e])
  }

  // Seed the queue with the changed roots, de-duplicated in first-seen order.
  // `seen` starts with the roots, which is what guarantees roots never appear
  // in `affected` — a changed node is a cause, not a consequence.
  const seen = new Set<string>()
  const queue: Array<{ node: string; path: string[] }> = []
  for (const r of roots) {
    if (r === "" || seen.has(r)) continue
    seen.add(r)
    queue.push({ node: r, path: [r] })
  }

  const affected: string[] = []
  const paths: Record<string, string[]> = {}
  const via: Record<string, RelationType> = {}

  while (queue.length > 0) {
    const cur = queue.shift()!
    const toHere = incoming.get(cur.node)
    if (!toHere) continue
    for (const e of toHere) {
      if (!IMPACT_RELATIONS.has(e.relation)) continue
      if (seen.has(e.from)) continue
      seen.add(e.from)
      const path = [...cur.path, e.from]
      affected.push(e.from)
      paths[e.from] = path
      via[e.from] = e.relation
      queue.push({ node: e.from, path })
    }
  }
  return { affected, paths, via }
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

// ---------------------------------------------------------------------------
// Quantity ledger & estimating domain model
// ---------------------------------------------------------------------------
// Phase-3-ready domain types + zod validation + deterministic estimate math,
// per docs/03-data/quantity-ledger-schema.md. Re-exported here so consumers
// import the whole core domain from a single module; no name collisions with
// the graph/approval vocabulary above.
export * from "./ledger"
