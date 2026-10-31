/**
 * Engineering OS — OpenProject REST v3 wire (ADR-0012 Stage 3).
 *
 * SERVER-ONLY transport — the ONE module in the repository that talks to an
 * external OpenProject instance (the llm.ts precedent: one wire, transports
 * only). NO sync semantics live here: the pure core (src/core/
 * openproject-sync.ts) plans and folds; this module carries the plan's bytes
 * over HTTPS and returns per-item VALUES:
 *
 *  - apikey Basic-auth convention (Authorization: Basic base64("apikey:<token>"))
 *    on every request;
 *  - the lockVersion PATCH model: every update PATCH carries the mapping's
 *    lockVersion; a 409 refreshes it once (GET → retry) — a second conflict
 *    fails honestly, never a blind overwrite;
 *  - recreate-on-404: an update whose work package was deleted on the
 *    instance re-creates (or adopts) it — the fold records the new id;
 *  - adopt-or-create idempotency: a create first searches the target project
 *    for an existing work package with the EXACT subject — exactly one match
 *    is adopted (the crash window between a create and the mapping persist
 *    can never duplicate work packages), zero matches POSTs, more than one
 *    refuses honestly (never guesses);
 *  - follows+precedes duplicate healing: before creating a relation the
 *    successor's existing relations are fetched; an equivalent edge in
 *    EITHER form — follows(from=successor, to=predecessor) or
 *    precedes(from=predecessor, to=successor) — is reused, never duplicated
 *    (relation.rb at the pinned upstream v17.9.2: from = successor,
 *    to = predecessor; upstream auto-reverses precedes into follows);
 *  - collect-never-throw: every item's outcome is a value; a network error
 *    is an honest per-item failure string, never a thrown exception (only
 *    the target-project verification fails the whole phase — nothing was
 *    attempted then).
 *
 * Configuration (env, read per call — never cached across a config change):
 *   EOS_OPENPROJECT_URL      e.g. https://openproject.example.org (no trailing slash)
 *   EOS_OPENPROJECT_APIKEY   the instance apikey (Basic password; user "apikey")
 */

import { OPENPROJECT_TASK_TYPE_HREF } from "@/core/openproject-sync"
import type {
  RelationSyncPlan,
  WireCreateWorkPackage,
  WireCreateWorkPackagePayload,
  WireRelationResult,
  WireUpdateWorkPackage,
  WireWorkPackageResult,
  WorkPackageSyncPlan,
} from "@/core/openproject-sync"

/** Wire transport configuration (tests inject a fake-instance baseUrl). */
export interface OpenProjectWireConfig {
  baseUrl: string
  apiKey: string
  /** per-request ceiling (default 30s); injectable for the timeout pin */
  requestTimeoutMs?: number
}

/** The env-derived configuration, or null when the integration is unset. */
export function openProjectWireConfigFromEnv(): OpenProjectWireConfig | null {
  const baseUrl = process.env.EOS_OPENPROJECT_URL?.trim()
  const apiKey = process.env.EOS_OPENPROJECT_APIKEY?.trim()
  if (baseUrl === undefined || baseUrl.length === 0 || apiKey === undefined || apiKey.length === 0) {
    return null
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey }
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

export type WorkPackageWireOutcome =
  | { ok: true; results: WireWorkPackageResult[] }
  | { ok: false; error: string }

export type RelationWireOutcome =
  | { ok: true; results: WireRelationResult[] }
  | { ok: false; error: string }

// ---------------------------------------------------------------------------
// HTTP plumbing (one function, the whole transport surface)
// ---------------------------------------------------------------------------

interface V3Response {
  status: number
  json: unknown
}

/** One REST v3 request. Throws only on network/timeout errors (honest, caught per-item). */
async function v3Request(
  config: OpenProjectWireConfig,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
): Promise<V3Response> {
  const res = await fetch(`${config.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${btoa(`apikey:${config.apiKey}`)}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
  })
  let json: unknown = null
  const contentType = res.headers.get("content-type") ?? ""
  if (contentType.includes("json")) {
    json = await res.json().catch(() => null)
  }
  return { status: res.status, json }
}

/** The OpenProject error body's message field, when present (never invented). */
function apiErrorMessage(json: unknown): string {
  if (typeof json === "object" && json !== null && typeof (json as { message?: unknown }).message === "string") {
    return `: ${(json as { message: string }).message}`
  }
  return ""
}

function workPackageHref(id: number): string {
  return `/api/v3/work_packages/${id}`
}

interface WorkPackageJson {
  id: number
  lockVersion: number
}

function asWorkPackage(json: unknown): WorkPackageJson | null {
  if (typeof json === "object" && json !== null) {
    const candidate = json as { id?: unknown; lockVersion?: unknown }
    if (typeof candidate.id === "number" && typeof candidate.lockVersion === "number") {
      return { id: candidate.id, lockVersion: candidate.lockVersion }
    }
  }
  return null
}

/** The _embedded.elements of a HAL collection (never invented). */
function halElements(json: unknown): Array<Record<string, unknown>> {
  if (typeof json === "object" && json !== null) {
    const embedded = (json as { _embedded?: unknown })._embedded
    if (typeof embedded === "object" && embedded !== null && Array.isArray((embedded as { elements?: unknown }).elements)) {
      return (embedded as { elements: Array<Record<string, unknown>> }).elements
    }
  }
  return []
}

// ---------------------------------------------------------------------------
// Target verification (phase-entry gate — the only whole-phase failure)
// ---------------------------------------------------------------------------

async function verifyTargetProject(
  config: OpenProjectWireConfig,
  targetProjectId: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let response: V3Response
  try {
    response = await v3Request(config, "GET", `/api/v3/projects/${targetProjectId}`)
  } catch (err) {
    return {
      ok: false,
      error: `OpenProject instance unreachable at ${config.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (response.status === 200) return { ok: true }
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      error: `OpenProject rejected the apikey (HTTP ${response.status}) — check EOS_OPENPROJECT_APIKEY`,
    }
  }
  if (response.status === 404) {
    return {
      ok: false,
      error: `OpenProject target project ${targetProjectId} not found on the instance — check parameters.targetProjectId`,
    }
  }
  return {
    ok: false,
    error: `OpenProject instance error verifying target project ${targetProjectId}: HTTP ${response.status}${apiErrorMessage(response.json)}`,
  }
}

// ---------------------------------------------------------------------------
// Adopt-or-create (idempotent creates) — shared by create and recreate-on-404
// ---------------------------------------------------------------------------

async function adoptOrCreate(
  config: OpenProjectWireConfig,
  plan: WorkPackageSyncPlan,
  item: WireCreateWorkPackage | WireUpdateWorkPackage,
): Promise<
  | { ok: true; workPackageId: number; lockVersion: number; adopted: boolean }
  | { ok: false; error: string }
> {
  // 1) search the target project for an existing exact-subject work package
  const filters = JSON.stringify([{ subject: { operator: "=", values: [item.payload.subject] } }])
  const searchPath = `/api/v3/projects/${plan.targetProjectId}/work_packages?filters=${encodeURIComponent(filters)}`
  let search: V3Response
  try {
    search = await v3Request(config, "GET", searchPath)
  } catch (err) {
    return {
      ok: false,
      error: `OpenProject search failed for activity "${item.activityId}": ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (search.status !== 200) {
    return {
      ok: false,
      error: `OpenProject search failed for activity "${item.activityId}": HTTP ${search.status}${apiErrorMessage(search.json)}`,
    }
  }
  const matches = halElements(search.json)
    .map((element) => asWorkPackage(element))
    .filter((wp): wp is WorkPackageJson => wp !== null)
  if (matches.length === 1) {
    return { ok: true, workPackageId: matches[0].id, lockVersion: matches[0].lockVersion, adopted: true }
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error: `OpenProject create refused for activity "${item.activityId}": ${matches.length} existing work packages already match the subject "${item.payload.subject}" — refusing to guess; disambiguate on the instance`,
    }
  }

  // 2) zero matches → POST the exact core payload (recreate-on-404 rebuilds
  //    the create-only _links block — the update payload lacks it)
  let createPayload: WireCreateWorkPackagePayload
  if (item.kind === "create-work-package") {
    createPayload = item.payload
  } else {
    createPayload = {
      subject: item.payload.subject,
      startDate: item.payload.startDate,
      dueDate: item.payload.dueDate,
      _links: { type: { href: OPENPROJECT_TASK_TYPE_HREF } },
    }
  }
  let created: V3Response
  try {
    created = await v3Request(config, "POST", `/api/v3/projects/${plan.targetProjectId}/work_packages`, createPayload)
  } catch (err) {
    return {
      ok: false,
      error: `OpenProject create failed for activity "${item.activityId}": ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (created.status !== 201) {
    return {
      ok: false,
      error: `OpenProject create failed for activity "${item.activityId}": HTTP ${created.status}${apiErrorMessage(created.json)}`,
    }
  }
  const workPackage = asWorkPackage(created.json)
  if (workPackage === null) {
    return {
      ok: false,
      error: `OpenProject create for activity "${item.activityId}" returned a body without id/lockVersion`,
    }
  }
  return { ok: true, workPackageId: workPackage.id, lockVersion: workPackage.lockVersion, adopted: false }
}

// ---------------------------------------------------------------------------
// Phase 1 — the work-package plan
// ---------------------------------------------------------------------------

export async function executeWorkPackageWirePlan(
  config: OpenProjectWireConfig,
  plan: WorkPackageSyncPlan,
): Promise<WorkPackageWireOutcome> {
  const verified = await verifyTargetProject(config, plan.targetProjectId)
  if (!verified.ok) return { ok: false, error: verified.error }

  const results: WireWorkPackageResult[] = []
  for (const item of plan.items) {
    if (item.kind === "create-work-package") {
      const outcome = await adoptOrCreate(config, plan, item)
      results.push(
        outcome.ok
          ? {
              kind: item.kind,
              activityId: item.activityId,
              ok: true,
              workPackageId: outcome.workPackageId,
              lockVersion: outcome.lockVersion,
              adopted: outcome.adopted,
              recreated: false,
            }
          : { kind: item.kind, activityId: item.activityId, ok: false, error: outcome.error },
      )
      continue
    }

    // update-work-package: PATCH with lockVersion; 404 → recreate; 409 → one refresh + retry
    const patchBody = {
      lockVersion: item.lockVersion,
      subject: item.payload.subject,
      startDate: item.payload.startDate,
      dueDate: item.payload.dueDate,
    }
    let response: V3Response
    try {
      response = await v3Request(config, "PATCH", workPackageHref(item.workPackageId), patchBody)
    } catch (err) {
      results.push({
        kind: item.kind,
        activityId: item.activityId,
        ok: false,
        error: `OpenProject update failed for activity "${item.activityId}": ${err instanceof Error ? err.message : String(err)}`,
      })
      continue
    }

    if (response.status === 200) {
      const workPackage = asWorkPackage(response.json)
      results.push(
        workPackage === null
          ? {
              kind: item.kind,
              activityId: item.activityId,
              ok: false,
              error: `OpenProject update for activity "${item.activityId}" returned a body without id/lockVersion`,
            }
          : {
              kind: item.kind,
              activityId: item.activityId,
              ok: true,
              workPackageId: workPackage.id,
              lockVersion: workPackage.lockVersion,
              adopted: false,
              recreated: false,
            },
      )
      continue
    }

    if (response.status === 404) {
      // the work package was deleted on the instance — recreate (or adopt)
      const outcome = await adoptOrCreate(config, plan, item)
      results.push(
        outcome.ok
          ? {
              kind: item.kind,
              activityId: item.activityId,
              ok: true,
              workPackageId: outcome.workPackageId,
              lockVersion: outcome.lockVersion,
              adopted: outcome.adopted,
              recreated: true,
            }
          : { kind: item.kind, activityId: item.activityId, ok: false, error: outcome.error },
      )
      continue
    }

    if (response.status === 409) {
      // optimistic-concurrency conflict: refresh the lockVersion once, retry once
      let refreshed: V3Response
      try {
        refreshed = await v3Request(config, "GET", workPackageHref(item.workPackageId))
      } catch (err) {
        results.push({
          kind: item.kind,
          activityId: item.activityId,
          ok: false,
          error: `OpenProject update conflict refresh failed for activity "${item.activityId}": ${err instanceof Error ? err.message : String(err)}`,
        })
        continue
      }
      const fresh = refreshed.status === 200 ? asWorkPackage(refreshed.json) : null
      if (fresh === null) {
        results.push({
          kind: item.kind,
          activityId: item.activityId,
          ok: false,
          error: `OpenProject update conflict for work package ${item.workPackageId}: the lockVersion refresh returned HTTP ${refreshed.status} — review the instance`,
        })
        continue
      }
      let retried: V3Response
      try {
        retried = await v3Request(config, "PATCH", workPackageHref(item.workPackageId), {
          lockVersion: fresh.lockVersion,
          subject: item.payload.subject,
          startDate: item.payload.startDate,
          dueDate: item.payload.dueDate,
        })
      } catch (err) {
        results.push({
          kind: item.kind,
          activityId: item.activityId,
          ok: false,
          error: `OpenProject update retry failed for activity "${item.activityId}": ${err instanceof Error ? err.message : String(err)}`,
        })
        continue
      }
      if (retried.status === 200) {
        const workPackage = asWorkPackage(retried.json)
        results.push(
          workPackage === null
            ? {
                kind: item.kind,
                activityId: item.activityId,
                ok: false,
                error: `OpenProject update retry for activity "${item.activityId}" returned a body without id/lockVersion`,
              }
            : {
                kind: item.kind,
                activityId: item.activityId,
                ok: true,
                workPackageId: workPackage.id,
                lockVersion: workPackage.lockVersion,
                adopted: false,
                recreated: false,
              },
        )
      } else {
        results.push({
          kind: item.kind,
          activityId: item.activityId,
          ok: false,
          error: `OpenProject update conflict for work package ${item.workPackageId}: the mapping's lockVersion is stale even after a refresh (HTTP ${retried.status}) — review the instance`,
        })
      }
      continue
    }

    results.push({
      kind: item.kind,
      activityId: item.activityId,
      ok: false,
      error: `OpenProject update failed for activity "${item.activityId}": HTTP ${response.status}${apiErrorMessage(response.json)}`,
    })
  }

  return { ok: true, results }
}

// ---------------------------------------------------------------------------
// Phase 2 — the relation plan (follows + precedes duplicate healing)
// ---------------------------------------------------------------------------

interface ExistingRelation {
  id: number
  type: string
  fromHref: string
  toHref: string
}

function asExistingRelations(json: unknown): ExistingRelation[] {
  return halElements(json)
    .map((element): ExistingRelation | null => {
      const id = element.id
      const type = element.type
      const links = element._links
      if (typeof id !== "number" || typeof type !== "string" || typeof links !== "object" || links === null) return null
      const from = (links as { from?: { href?: unknown } }).from
      const to = (links as { to?: { href?: unknown } }).to
      if (typeof from !== "object" || from === null || typeof (from as { href?: unknown }).href !== "string") return null
      if (typeof to !== "object" || to === null || typeof (to as { href?: unknown }).href !== "string") return null
      return {
        id,
        type,
        fromHref: (from as { href: string }).href,
        toHref: (to as { href: string }).href,
      }
    })
    .filter((relation): relation is ExistingRelation => relation !== null)
}

export async function executeRelationWirePlan(
  config: OpenProjectWireConfig,
  plan: RelationSyncPlan,
): Promise<RelationWireOutcome> {
  const results: WireRelationResult[] = []
  for (const item of plan.items) {
    const successorHref = workPackageHref(item.successorWorkPackageId)
    const predecessorHref = workPackageHref(item.predecessorWorkPackageId)

    // 1) the successor's existing relations — an equivalent edge in EITHER
    //    form is reused (follows succ→pred, or precedes pred→succ)
    let existing: V3Response
    try {
      existing = await v3Request(config, "GET", `${successorHref}/relations`)
    } catch (err) {
      results.push({
        kind: "ensure-relation",
        successorActivityId: item.successorActivityId,
        predecessorActivityId: item.predecessorActivityId,
        ok: false,
        error: `OpenProject relation search failed for ${item.successorActivityId} → ${item.predecessorActivityId}: ${err instanceof Error ? err.message : String(err)}`,
      })
      continue
    }
    if (existing.status !== 200) {
      results.push({
        kind: "ensure-relation",
        successorActivityId: item.successorActivityId,
        predecessorActivityId: item.predecessorActivityId,
        ok: false,
        error: `OpenProject relation search failed for ${item.successorActivityId} → ${item.predecessorActivityId}: HTTP ${existing.status}${apiErrorMessage(existing.json)}`,
      })
      continue
    }
    const equivalent = asExistingRelations(existing.json).find(
      (relation) =>
        (relation.type === "follows" && relation.fromHref === successorHref && relation.toHref === predecessorHref) ||
        (relation.type === "precedes" && relation.fromHref === predecessorHref && relation.toHref === successorHref),
    )
    if (equivalent !== undefined) {
      results.push({
        kind: "ensure-relation",
        successorActivityId: item.successorActivityId,
        predecessorActivityId: item.predecessorActivityId,
        ok: true,
        relationId: equivalent.id,
        existedAlready: true,
      })
      continue
    }

    // 2) no equivalent edge → POST the follows relation (from = successor,
    //    to = predecessor — the relation.rb direction, never inverted)
    let created: V3Response
    try {
      created = await v3Request(config, "POST", `${successorHref}/relations`, {
        type: "follows",
        _links: { from: { href: successorHref }, to: { href: predecessorHref } },
      })
    } catch (err) {
      results.push({
        kind: "ensure-relation",
        successorActivityId: item.successorActivityId,
        predecessorActivityId: item.predecessorActivityId,
        ok: false,
        error: `OpenProject relation create failed for ${item.successorActivityId} → ${item.predecessorActivityId}: ${err instanceof Error ? err.message : String(err)}`,
      })
      continue
    }
    if (created.status !== 201) {
      results.push({
        kind: "ensure-relation",
        successorActivityId: item.successorActivityId,
        predecessorActivityId: item.predecessorActivityId,
        ok: false,
        error: `OpenProject relation create failed for ${item.successorActivityId} → ${item.predecessorActivityId}: HTTP ${created.status}${apiErrorMessage(created.json)}`,
      })
      continue
    }
    const relationId = typeof (created.json as { id?: unknown } | null)?.id === "number" ? (created.json as { id: number }).id : null
    if (relationId === null) {
      results.push({
        kind: "ensure-relation",
        successorActivityId: item.successorActivityId,
        predecessorActivityId: item.predecessorActivityId,
        ok: false,
        error: `OpenProject relation create for ${item.successorActivityId} → ${item.predecessorActivityId} returned a body without id`,
      })
      continue
    }
    results.push({
      kind: "ensure-relation",
      successorActivityId: item.successorActivityId,
      predecessorActivityId: item.predecessorActivityId,
      ok: true,
      relationId,
      existedAlready: false,
    })
  }

  return { ok: true, results }
}
