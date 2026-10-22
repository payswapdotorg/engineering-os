/**
 * Engineering OS — CPM (Critical Path Method) platform core (W3-f, Phase 5).
 *
 * PURE TypeScript: no DB, no network, no filesystem, no engines (ADR-0002)
 * → unit-testable with `bun test` without a server or fixtures. This module is
 * the platform-core half of the `analyze_schedule` broker operation (contract
 * §4/§6): the broker core (W2-f) reads the schedule artifact, runs THIS
 * function and serializes the result as an `eos-cpm/1` document — the analysis
 * is honest platform math, never faked as an engine (engineKey stays absent).
 *
 * Frozen signature (docs/00-architecture/phase5-disciplines-contract.md §6) —
 * changes escalate to TL, they are never made in flight.
 *
 * Semantics:
 *  - forward pass:  es = max(ef of predecessors) (0 for roots), ef = es + duration
 *  - backward pass: lf = min(ls of successors) (project finish for terminals),
 *                   ls = lf − duration
 *  - totalFloat = ls − es; critical ⇔ totalFloat === 0
 *  - criticalPath = critical ids in topological order (deterministic: the
 *    Kahn-style sweep below prefers input array order on ties)
 *  - durationDays = project finish (max ef)
 *  - zero-duration activities are allowed (milestones)
 *  - output `activities` keep the INPUT array order; every output object is
 *    constructed in the pinned key order (id → name → durationDays → es → ef →
 *    ls → lf → totalFloat → critical) so downstream JSON serialization of this
 *    result is byte-deterministic by construction.
 *
 * Errors (§3.1 verbatim, ONE joinable ledger-style message):
 *  - duplicate ids        → `activity id "<id>" is used more than once`
 *  - unknown predecessor  → `activity "<id>" references unknown predecessor "<pid>"`
 *  - cycle                → `activity chain contains a cycle involving "<id>"`
 *    (the FIRST activity in input order that can reach itself through
 *    predecessor edges — an activity merely downstream of a cycle is never
 *    named; see cpm.test.ts "reports the activity ON the cycle, not downstream")
 *  Multiple problems join with "; " (structural guards first, then duplicates,
 *  then unknown predecessors; the cycle check needs a well-formed id set and
 *  runs only when the other checks pass).
 */

export interface CpmActivity {
  id: string
  name: string
  durationDays: number
  predecessorIds: string[]
}

export interface CpmActivityResult {
  activities: Array<{
    id: string
    name: string
    durationDays: number
    es: number
    ef: number
    ls: number
    lf: number
    totalFloat: number
    critical: boolean
  }>
  criticalPath: string[]
  durationDays: number
}

export type CpmResult = { ok: true; value: CpmActivityResult } | { ok: false; error: string }

/** Renders a value for an error message without inventing content. */
function describe(value: unknown): string {
  if (typeof value === "string") return `"${value}"`
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value)
  if (Array.isArray(value)) return "an array"
  if (typeof value === "object") return "an object"
  return typeof value
}

/**
 * Deterministic topological order: repeated array sweeps (input order wins on
 * ties). Cycles are impossible here — the caller excludes them first; the
 * `progressed` guard keeps the loop honest if that invariant ever breaks.
 */
function topologicalOrder(activities: CpmActivity[]): string[] {
  const done = new Set<string>()
  const order: string[] = []
  while (done.size < activities.length) {
    let progressed = false
    for (const activity of activities) {
      if (done.has(activity.id)) continue
      if (activity.predecessorIds.every((p) => done.has(p))) {
        order.push(activity.id)
        done.add(activity.id)
        progressed = true
      }
    }
    if (!progressed) break // unreachable: cycles are rejected before this runs
  }
  return order
}

/**
 * True when `id` can reach itself by walking predecessor edges (i.e. the
 * activity is ON a cycle). Visited-set per query → terminates on any graph.
 */
function onCycle(id: string, predecessors: Map<string, string[]>): boolean {
  const stack = [...(predecessors.get(id) ?? [])]
  const visited = new Set<string>()
  while (stack.length > 0) {
    const current = stack.pop()!
    if (current === id) return true
    if (visited.has(current)) continue
    visited.add(current)
    stack.push(...(predecessors.get(current) ?? []))
  }
  return false
}

/**
 * The Critical Path Method over an activity list. Every numeric result below
 * comes from the pinned arithmetic in the module header — no invented numbers
 * (ADR-0006 §2), no partial results on error (nothing is computed before every
 * guard passes).
 */
export function analyzeCpm(activities: CpmActivity[]): CpmResult {
  if (!Array.isArray(activities)) {
    return { ok: false, error: `activities must be an array of CpmActivity objects (got ${describe(activities)})` }
  }

  // Structural guards (runtime honesty: the zod layer is the real boundary,
  // the pure core defends its own invariants independently).
  const structural: string[] = []
  for (let i = 0; i < activities.length; i++) {
    const activity = activities[i] as unknown
    if (typeof activity !== "object" || activity === null) {
      structural.push(`activity at index ${i} must be an object (got ${describe(activity)})`)
      continue
    }
    const a = activity as CpmActivity
    if (typeof a.id !== "string" || a.id.length === 0) {
      structural.push(`activity at index ${i} must have a non-empty id`)
      continue
    }
    if (typeof a.name !== "string" || a.name.length === 0) {
      structural.push(`activity "${a.id}" name must be a non-empty string`)
      continue
    }
    if (
      typeof a.durationDays !== "number" ||
      !Number.isFinite(a.durationDays) ||
      a.durationDays < 0
    ) {
      structural.push(
        `activity "${a.id}" durationDays must be a finite number ≥ 0 (got ${describe(a.durationDays)})`,
      )
      continue
    }
    if (
      !Array.isArray(a.predecessorIds) ||
      a.predecessorIds.some((p) => typeof p !== "string")
    ) {
      structural.push(`activity "${a.id}" predecessorIds must be an array of activity ids`)
    }
  }
  if (structural.length > 0) return { ok: false, error: structural.join("; ") }

  // Duplicate ids (§3.1 verbatim; reported once per duplicated id).
  const errors: string[] = []
  const knownIds = new Set<string>()
  const reportedDup = new Set<string>()
  for (const activity of activities) {
    if (knownIds.has(activity.id)) {
      if (!reportedDup.has(activity.id)) {
        errors.push(`activity id "${activity.id}" is used more than once`)
        reportedDup.add(activity.id)
      }
    } else {
      knownIds.add(activity.id)
    }
  }

  // Unknown predecessors (§3.1 verbatim; array order, then predecessor order).
  for (const activity of activities) {
    for (const predecessor of activity.predecessorIds) {
      if (!knownIds.has(predecessor)) {
        errors.push(`activity "${activity.id}" references unknown predecessor "${predecessor}"`)
      }
    }
  }

  if (errors.length > 0) return { ok: false, error: errors.join("; ") }

  // Cycle check (§3.1 verbatim) — needs the well-formed id set above.
  const predecessors = new Map(activities.map((a) => [a.id, [...a.predecessorIds]]))
  for (const activity of activities) {
    if (onCycle(activity.id, predecessors)) {
      return { ok: false, error: `activity chain contains a cycle involving "${activity.id}"` }
    }
  }

  // Forward pass (topological order guarantees predecessors are computed first).
  const order = topologicalOrder(activities)
  const byId = new Map(activities.map((a) => [a.id, a]))
  const es = new Map<string, number>()
  const ef = new Map<string, number>()
  for (const id of order) {
    const activity = byId.get(id)!
    let start = 0
    for (const predecessor of activity.predecessorIds) {
      const predEf = ef.get(predecessor) ?? 0
      if (predEf > start) start = predEf
    }
    es.set(id, start)
    ef.set(id, start + activity.durationDays)
  }

  let finish = 0
  for (const id of order) {
    const candidate = ef.get(id) ?? 0
    if (candidate > finish) finish = candidate
  }

  // Backward pass (reverse topological order → successors are computed first).
  const successors = new Map<string, string[]>()
  for (const activity of activities) {
    for (const predecessor of activity.predecessorIds) {
      const list = successors.get(predecessor)
      if (list) list.push(activity.id)
      else successors.set(predecessor, [activity.id])
    }
  }
  const lf = new Map<string, number>()
  const ls = new Map<string, number>()
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i]
    const duration = byId.get(id)!.durationDays
    const succs = successors.get(id)
    let finishBy = finish
    if (succs) {
      for (const succ of succs) {
        const succLs = ls.get(succ) ?? finish
        if (succLs < finishBy) finishBy = succLs
      }
    }
    lf.set(id, finishBy)
    ls.set(id, finishBy - duration)
  }

  // Result: input array order, pinned key order, exact critical set.
  const critical = new Set<string>()
  for (const id of order) {
    if ((ls.get(id) ?? 0) - (es.get(id) ?? 0) === 0) critical.add(id)
  }
  return {
    ok: true,
    value: {
      activities: activities.map((activity) => {
        const aEs = es.get(activity.id) ?? 0
        const aEf = ef.get(activity.id) ?? 0
        const aLs = ls.get(activity.id) ?? 0
        const aLf = lf.get(activity.id) ?? 0
        return {
          id: activity.id,
          name: activity.name,
          durationDays: activity.durationDays,
          es: aEs,
          ef: aEf,
          ls: aLs,
          lf: aLf,
          totalFloat: aLs - aEs,
          critical: critical.has(activity.id),
        }
      }),
      criticalPath: order.filter((id) => critical.has(id)),
      durationDays: finish,
    },
  }
}
