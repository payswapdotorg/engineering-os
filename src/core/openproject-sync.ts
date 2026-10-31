/**
 * Engineering OS — OpenProject arm's-length project-graph sync (pure core).
 *
 * ADR-0012 (Stage 3 of the ADR-0011 migration plan): OpenProject (GPL-3.0)
 * is INTEGRATED at arm's length ONLY — REST v3 over HTTPS, never embedded,
 * no code reuse (the ADR-0004 license boundary). This module owns every
 * sync SEMANTIC in pure TypeScript (no DB, no network, no filesystem —
 * ADR-0002); the ONE wire module (src/lib/openproject-wire.ts, the llm.ts
 * precedent) transports the plan's bytes over REST v3 and nothing else.
 *
 * The frozen platform core computes every date: `cpm.ts` runs the CPM passes
 * and THIS module projects the results onto the UTC calendar
 * (start = anchor + es, due = anchor + ef − 1 — an activity occupies the
 * inclusive day range [es, ef−1]; a zero-duration milestone clamps due to
 * start, the pinned v1 convention). OpenProject never computes a platform
 * date and the platform never imports one back (one-way v1).
 *
 * The sync is DIFF-BASED against the prior `eos-openproject-sync/1` mapping
 * artifact: mapped activities become UPDATEs (lockVersion carried), unmapped
 * ones CREATEs, removed ones become recorded ORPHANS — NEVER deleted
 * (deletion is a human act on the instance, never automated). Failed items
 * keep their identity (a failed create retries as a create, a failed update
 * keeps its workPackageId and retries as an update) — the
 * interrupted-partial fold: collect-never-throw wire results fold into the
 * next mapping so a later sync resumes exactly where the prior one stopped.
 *
 * REST v3 semantics (source-verified against the tagged upstream
 * opf/openproject v17.9.2 tree — app/models/relation.rb; re-verified
 * first-hand on the v17.9.2 tag during this re-ship):
 *  - `follows` direction: from = successor, to = predecessor
 *    (relation.rb scopes: of_predecessor → where(to:), of_successor →
 *    where(from:) — the trap that would have inverted the graph);
 *  - `precedes` is auto-reversed by upstream into `follows`
 *    (before_validation :reverse_if_needed) — hence the wire's
 *    follows+precedes duplicate healing;
 *  - PATCH carries lockVersion (optimistic concurrency; the mapping records
 *    the lockVersion of every response);
 *  - apikey Basic-auth convention (the wire's transport concern).
 *
 * Canonical bytes: the mapping document is constructed in pinned key orders
 * with NO timestamps (creation time lives in the DB revision row — §5.4
 * lesson), so JSON.stringify of the folded document is byte-deterministic
 * by construction.
 */

import { z } from "zod"

import type { CpmActivity, CpmActivityResult } from "./cpm"

// ---------------------------------------------------------------------------
// UTC calendar projection (pure, deterministic)
// ---------------------------------------------------------------------------

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** True for a REAL calendar date in YYYY-MM-DD form (round-trip verified). */
export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)!
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  const utc = Date.UTC(year, month - 1, day)
  const roundTrip = new Date(utc)
  return roundTrip.getUTCFullYear() === year && roundTrip.getUTCMonth() === month - 1 && roundTrip.getUTCDate() === day
}

/**
 * Add whole UTC days to a YYYY-MM-DD date (pure Date.UTC arithmetic — no
 * timezone ever enters the projection).
 */
export function addUtcDays(isoDate: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate)
  if (match === null) {
    throw new Error(`addUtcDays: not a YYYY-MM-DD date: ${JSON.stringify(isoDate)}`)
  }
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) + days * 86_400_000
  return new Date(ms).toISOString().slice(0, 10)
}

/** The v1 work-package type: the default OpenProject Task type (ADR-0012). */
export const OPENPROJECT_TASK_TYPE_HREF = "/api/v3/types/1"

/** The projected work-package payload of one CPM activity (pinned key order). */
export interface ProjectedWorkPackage {
  subject: string
  startDate: string
  dueDate: string
}

/**
 * The UTC calendar projection (§ ADR-0012): start = anchor + es,
 * due = anchor + ef − 1 (the activity occupies the inclusive day range
 * [es, ef−1]). A zero-duration milestone (es === ef) clamps due to start —
 * an inverted range is never sent (the pinned v1 convention).
 */
export function projectWorkPackage(
  activity: Pick<CpmActivityResult["activities"][number], "id" | "name" | "es" | "ef">,
  anchorDate: string,
): ProjectedWorkPackage {
  const startDate = addUtcDays(anchorDate, activity.es)
  const dueOffset = Math.max(activity.ef - 1, activity.es)
  return { subject: activity.name, startDate, dueDate: addUtcDays(anchorDate, dueOffset) }
}

// ---------------------------------------------------------------------------
// The sync request (op parameters → zod)
// ---------------------------------------------------------------------------

export const OpenProjectSyncRequestSchema = z.strictObject({
  /** The UTC calendar anchor: day 0 of the CPM projection (required). */
  anchorDate: z
    .string()
    .refine(isValidIsoDate, "anchorDate must be a real calendar date in YYYY-MM-DD form (the UTC projection anchor)"),
  /**
   * The OpenProject project id. Required on the FIRST sync of a schedule; a
   * later sync defaults to the prior mapping's target (recorded there).
   */
  targetProjectId: z.number().int().positive(),
})

export type OpenProjectSyncRequest = z.infer<typeof OpenProjectSyncRequestSchema>

export type ParseOpenProjectSyncRequestResult =
  | { ok: true; value: OpenProjectSyncRequest }
  | { ok: false; error: string }

export function parseOpenProjectSyncRequest(parameters: unknown): ParseOpenProjectSyncRequestResult {
  const parsed = OpenProjectSyncRequestSchema.safeParse(parameters ?? {})
  if (parsed.success) return { ok: true, value: parsed.data }
  const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
  return { ok: false, error: `invalid openproject_sync request: ${issues}` }
}

// ---------------------------------------------------------------------------
// The eos-openproject-sync/1 mapping document
// ---------------------------------------------------------------------------

export const OPENPROJECT_MAPPING_FORMAT = "eos-openproject-sync/1"

const mappingEntrySchema = z.object({
  activityId: z.string().min(1),
  subject: z.string().min(1),
  workPackageId: z.number().int().positive().nullable(),
  lockVersion: z.number().int().min(0).nullable(),
  startDate: z.string().regex(ISO_DATE_RE, "startDate must be a YYYY-MM-DD date"),
  dueDate: z.string().regex(ISO_DATE_RE, "dueDate must be a YYYY-MM-DD date"),
  status: z.enum(["synced", "orphaned", "failed"]),
  lastError: z.string().optional(),
})

const mappingRelationSchema = z.object({
  successorActivityId: z.string().min(1),
  predecessorActivityId: z.string().min(1),
  relationId: z.number().int().positive(),
})

export const OpenProjectMappingDocumentSchema = z.object({
  format: z.literal(OPENPROJECT_MAPPING_FORMAT),
  targetProjectId: z.number().int().positive(),
  anchorDate: z.string().regex(ISO_DATE_RE, "anchorDate must be a YYYY-MM-DD date"),
  sourceScheduleArtifactId: z.string().min(1),
  sourceRevisionId: z.string().min(1),
  workPackages: z.array(mappingEntrySchema),
  relations: z.array(mappingRelationSchema),
})

export interface OpenProjectMappingEntry {
  activityId: string
  subject: string
  workPackageId: number | null
  lockVersion: number | null
  startDate: string
  dueDate: string
  status: "synced" | "orphaned" | "failed"
  lastError?: string
}

export interface OpenProjectMappingRelation {
  successorActivityId: string
  predecessorActivityId: string
  relationId: number
}

export interface OpenProjectMappingDocument {
  format: typeof OPENPROJECT_MAPPING_FORMAT
  targetProjectId: number
  anchorDate: string
  sourceScheduleArtifactId: string
  sourceRevisionId: string
  workPackages: OpenProjectMappingEntry[]
  relations: OpenProjectMappingRelation[]
}

export type ParseOpenProjectMappingResult =
  | { ok: true; value: OpenProjectMappingDocument }
  | { ok: false; error: string }

/** Honest gate for a prior mapping read from an artifact (never silent). */
export function parseOpenProjectMappingDocument(json: unknown): ParseOpenProjectMappingResult {
  const parsed = OpenProjectMappingDocumentSchema.safeParse(json)
  if (parsed.success) return { ok: true, value: parsed.data }
  const issues = parsed.error.issues
    .map((issue) => {
      const at = issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""
      return `${at}${issue.message}`
    })
    .join("; ")
  return { ok: false, error: `invalid openproject mapping: ${issues}` }
}

// ---------------------------------------------------------------------------
// The wire plan (what the ONE wire module transports)
// ---------------------------------------------------------------------------

/** The exact create payload (pinned key order; the type href is v1 Task). */
export interface WireCreateWorkPackagePayload {
  subject: string
  startDate: string
  dueDate: string
  _links: { type: { href: string } }
}

/** The exact update payload (pinned key order; lockVersion rides alongside). */
export interface WireUpdateWorkPackagePayload {
  subject: string
  startDate: string
  dueDate: string
}

export interface WireCreateWorkPackage {
  kind: "create-work-package"
  activityId: string
  payload: WireCreateWorkPackagePayload
}

export interface WireUpdateWorkPackage {
  kind: "update-work-package"
  activityId: string
  workPackageId: number
  lockVersion: number
  payload: WireUpdateWorkPackagePayload
}

export interface WireEnsureRelation {
  kind: "ensure-relation"
  successorActivityId: string
  predecessorActivityId: string
  successorWorkPackageId: number
  predecessorWorkPackageId: number
}

export type WirePlanItem = WireCreateWorkPackage | WireUpdateWorkPackage | WireEnsureRelation

export interface WorkPackageSyncPlan {
  targetProjectId: number
  anchorDate: string
  items: Array<WireCreateWorkPackage | WireUpdateWorkPackage>
  orphans: string[]
}

export interface RelationSyncPlan {
  items: WireEnsureRelation[]
}

// ---------------------------------------------------------------------------
// Wire results (the wire returns values — collect-never-throw per item)
// ---------------------------------------------------------------------------

export interface WireWorkPackageOk {
  kind: "create-work-package" | "update-work-package"
  activityId: string
  ok: true
  workPackageId: number
  lockVersion: number
  /** true when the wire adopted an existing same-subject work package instead of POSTing */
  adopted: boolean
  /** true when an update met 404 and the wire re-created the work package */
  recreated: boolean
}

export interface WireWorkPackageErr {
  kind: "create-work-package" | "update-work-package"
  activityId: string
  ok: false
  error: string
}

export interface WireRelationOk {
  kind: "ensure-relation"
  successorActivityId: string
  predecessorActivityId: string
  ok: true
  relationId: number
  /** true when an equivalent follows/precedes edge already existed (the healer) */
  existedAlready: boolean
}

export interface WireRelationErr {
  kind: "ensure-relation"
  successorActivityId: string
  predecessorActivityId: string
  ok: false
  error: string
}

export type WireWorkPackageResult = WireWorkPackageOk | WireWorkPackageErr
export type WireRelationResult = WireRelationOk | WireRelationErr

// ---------------------------------------------------------------------------
// Plan pass 1 — the work packages (update/create/never-delete + orphans)
// ---------------------------------------------------------------------------

export type PlanWorkPackageSyncResult =
  | { ok: true; value: WorkPackageSyncPlan }
  | { ok: false; error: string }

/**
 * Diff the schedule against the prior mapping:
 *  - a prior entry WITH a workPackageId (synced, orphaned-revived, or failed
 *    with a resolved id) → UPDATE (the mapping's lockVersion carried);
 *  - no prior entry (or a prior failed create with no id) → CREATE;
 *  - a prior entry whose activity vanished from the schedule → ORPHAN
 *    (recorded, NEVER deleted; NO wire item);
 *  - an orphaned entry whose activity REAPPEARS → revived (update/create as
 *    above — the mapping status returns to synced on success).
 */
export function planWorkPackageSync(
  cpm: CpmActivityResult,
  request: { anchorDate: string; targetProjectId?: number },
  prior: OpenProjectMappingDocument | null,
): PlanWorkPackageSyncResult {
  const targetProjectId = request.targetProjectId ?? prior?.targetProjectId
  if (targetProjectId === undefined) {
    return {
      ok: false,
      error:
        "openproject_sync requires parameters.targetProjectId (an OpenProject project id) on the first sync of a schedule — no prior mapping carries one",
    }
  }

  const priorByActivity = new Map((prior?.workPackages ?? []).map((entry) => [entry.activityId, entry]))
  const items: Array<WireCreateWorkPackage | WireUpdateWorkPackage> = []
  const orphans: string[] = []

  for (const activity of cpm.activities) {
    const projected = projectWorkPackage(activity, request.anchorDate)
    const priorEntry = priorByActivity.get(activity.id)
    if (priorEntry !== undefined && priorEntry.workPackageId !== null) {
      items.push({
        kind: "update-work-package",
        activityId: activity.id,
        workPackageId: priorEntry.workPackageId,
        lockVersion: priorEntry.lockVersion ?? 0,
        payload: { subject: projected.subject, startDate: projected.startDate, dueDate: projected.dueDate },
      })
    } else {
      items.push({
        kind: "create-work-package",
        activityId: activity.id,
        payload: {
          subject: projected.subject,
          startDate: projected.startDate,
          dueDate: projected.dueDate,
          _links: { type: { href: OPENPROJECT_TASK_TYPE_HREF } },
        },
      })
    }
  }

  for (const entry of prior?.workPackages ?? []) {
    if (!cpm.activities.some((activity) => activity.id === entry.activityId)) {
      orphans.push(entry.activityId)
    }
  }

  return { ok: true, value: { targetProjectId, anchorDate: request.anchorDate, items, orphans } }
}

// ---------------------------------------------------------------------------
// Plan pass 2 — the follows relations (after the work-package fold)
// ---------------------------------------------------------------------------

/**
 * Plan one `ensure-relation` per (successor, predecessor) edge that is not
 * yet recorded in the mapping — in schedule order × predecessor order, only
 * for pairs whose BOTH endpoints carry a resolved workPackageId (an edge
 * whose endpoint create failed this run is simply not planned; the next
 * sync re-plans it — the interrupted-partial fold). The wire's
 * follows+precedes healer deduplicates against the instance itself.
 */
export function planRelationSync(
  activities: CpmActivity[],
  mapping: OpenProjectMappingDocument,
): RelationSyncPlan {
  const byActivity = new Map(mapping.workPackages.map((entry) => [entry.activityId, entry]))
  const recorded = new Set(mapping.relations.map((r) => `${r.successorActivityId}\u0000${r.predecessorActivityId}`))
  const items: WireEnsureRelation[] = []
  for (const activity of activities) {
    const successor = byActivity.get(activity.id)
    if (successor === undefined || successor.workPackageId === null) continue
    for (const predecessorId of activity.predecessorIds) {
      const predecessor = byActivity.get(predecessorId)
      if (predecessor === undefined || predecessor.workPackageId === null) continue
      const key = `${activity.id}\u0000${predecessorId}`
      if (recorded.has(key)) continue
      items.push({
        kind: "ensure-relation",
        successorActivityId: activity.id,
        predecessorActivityId: predecessorId,
        successorWorkPackageId: successor.workPackageId,
        predecessorWorkPackageId: predecessor.workPackageId,
      })
    }
  }
  return { items }
}

// ---------------------------------------------------------------------------
// Fold pass 1 — work-package results into the next mapping
// ---------------------------------------------------------------------------

export interface FoldContext {
  targetProjectId: number
  anchorDate: string
  sourceScheduleArtifactId: string
  sourceRevisionId: string
}

export interface WorkPackageFoldResult {
  mapping: OpenProjectMappingDocument
  stats: { created: number; adopted: number; updated: number; recreated: number; failed: number; orphans: number }
  failures: string[]
}

/**
 * Fold the wire's work-package results into the NEXT mapping document:
 *  - ok create/update → status "synced" with the response's workPackageId +
 *    lockVersion (an adopted or recreated id replaces the prior one);
 *  - failed → status "failed" + the verbatim lastError, KEEPING any prior
 *    workPackageId (the next plan retries it as an update, not a create);
 *  - orphans (prior entries absent from the schedule) → status "orphaned",
 *    recorded, NEVER deleted;
 *  - prior relations carry over verbatim (the relation fold extends them).
 *
 * Canonical order: schedule activities in schedule order first, then orphans
 * in prior-mapping order; pinned key orders throughout — the serialized
 * document is byte-deterministic.
 */
export function foldWorkPackageSync(
  cpm: CpmActivityResult,
  plan: WorkPackageSyncPlan,
  results: WireWorkPackageResult[],
  prior: OpenProjectMappingDocument | null,
  context: FoldContext,
): WorkPackageFoldResult {
  const resultByActivity = new Map(results.map((result) => [result.activityId, result]))
  const priorByActivity = new Map((prior?.workPackages ?? []).map((entry) => [entry.activityId, entry]))
  const scheduleIds = new Set(cpm.activities.map((activity) => activity.id))

  const stats = { created: 0, adopted: 0, updated: 0, recreated: 0, failed: 0, orphans: 0 }
  const failures: string[] = []
  const entries: OpenProjectMappingEntry[] = []

  const projectedOf = (activityId: string): ProjectedWorkPackage | null => {
    const activity = cpm.activities.find((a) => a.id === activityId)
    return activity === undefined ? null : projectWorkPackage(activity, plan.anchorDate)
  }

  for (const activity of cpm.activities) {
    const projected = projectWorkPackage(activity, plan.anchorDate)
    const result = resultByActivity.get(activity.id)
    const priorEntry = priorByActivity.get(activity.id)
    if (result !== undefined && result.ok) {
      if (result.kind === "create-work-package") {
        if (result.adopted) stats.adopted += 1
        else stats.created += 1
      } else {
        stats.updated += 1
        if (result.recreated) stats.recreated += 1
      }
      entries.push({
        activityId: activity.id,
        subject: projected.subject,
        workPackageId: result.workPackageId,
        lockVersion: result.lockVersion,
        startDate: projected.startDate,
        dueDate: projected.dueDate,
        status: "synced",
      })
    } else if (result !== undefined && !result.ok) {
      stats.failed += 1
      failures.push(result.error)
      entries.push({
        activityId: activity.id,
        subject: projected.subject,
        workPackageId: priorEntry?.workPackageId ?? null,
        lockVersion: priorEntry?.lockVersion ?? null,
        startDate: projected.startDate,
        dueDate: projected.dueDate,
        status: "failed",
        lastError: result.error,
      })
    } else {
      // No wire item was planned for a schedule activity only when the plan
      // itself failed upstream — defensive honest entry (never reached via
      // the broker path: the plan covers every schedule activity).
      const priorSubject = priorEntry?.subject ?? projected.subject
      entries.push({
        activityId: activity.id,
        subject: priorSubject,
        workPackageId: priorEntry?.workPackageId ?? null,
        lockVersion: priorEntry?.lockVersion ?? null,
        startDate: projected.startDate,
        dueDate: projected.dueDate,
        status: "failed",
        lastError: "no wire operation was planned for this activity",
      })
      stats.failed += 1
      failures.push(`no wire operation was planned for activity "${activity.id}"`)
    }
  }

  for (const activityId of plan.orphans) {
    const priorEntry = priorByActivity.get(activityId)
    const projected = projectedOf(activityId) // null: absent from the schedule
    if (priorEntry === undefined) continue
    stats.orphans += 1
    entries.push({
      activityId: priorEntry.activityId,
      subject: priorEntry.subject,
      workPackageId: priorEntry.workPackageId,
      lockVersion: priorEntry.lockVersion,
      startDate: priorEntry.startDate,
      dueDate: priorEntry.dueDate,
      status: "orphaned",
      ...(priorEntry.status === "failed" && priorEntry.lastError !== undefined
        ? { lastError: priorEntry.lastError }
        : {}),
    })
    void projected
  }

  const mapping: OpenProjectMappingDocument = {
    format: OPENPROJECT_MAPPING_FORMAT,
    targetProjectId: context.targetProjectId,
    anchorDate: context.anchorDate,
    sourceScheduleArtifactId: context.sourceScheduleArtifactId,
    sourceRevisionId: context.sourceRevisionId,
    workPackages: entries,
    relations: prior?.relations ?? [],
  }
  return { mapping, stats, failures }
}

// ---------------------------------------------------------------------------
// Fold pass 2 — relation results into the mapping
// ---------------------------------------------------------------------------

export interface RelationFoldResult {
  mapping: OpenProjectMappingDocument
  stats: { ensured: number; reused: number; failed: number }
  failures: string[]
}

/**
 * Fold the wire's relation results: ok → recorded (relationId, reused flag
 * kept only in stats — the mapping records the edge idempotently); failed →
 * NOT recorded (the next sync re-plans the edge; the wire healer keeps the
 * instance free of duplicates). Canonical order: plan order appended after
 * the carried-over prior relations, deduplicated by (successor, predecessor).
 */
export function foldRelationSync(
  mapping: OpenProjectMappingDocument,
  plan: RelationSyncPlan,
  results: WireRelationResult[],
): RelationFoldResult {
  const resultByEdge = new Map(
    results.map((result) => [`${result.successorActivityId}\u0000${result.predecessorActivityId}`, result]),
  )
  const stats = { ensured: 0, reused: 0, failed: 0 }
  const failures: string[] = []
  const relations: OpenProjectMappingRelation[] = [...mapping.relations]
  const recorded = new Set(relations.map((r) => `${r.successorActivityId}\u0000${r.predecessorActivityId}`))

  for (const item of plan.items) {
    const key = `${item.successorActivityId}\u0000${item.predecessorActivityId}`
    const result = resultByEdge.get(key)
    if (result === undefined || !result.ok) {
      stats.failed += 1
      failures.push(result !== undefined ? result.error : `no wire result for relation ${item.successorActivityId} → ${item.predecessorActivityId}`)
      continue
    }
    if (result.existedAlready) stats.reused += 1
    else stats.ensured += 1
    if (!recorded.has(key)) {
      relations.push({
        successorActivityId: item.successorActivityId,
        predecessorActivityId: item.predecessorActivityId,
        relationId: result.relationId,
      })
      recorded.add(key)
    }
  }

  return {
    mapping: { ...mapping, relations },
    stats,
    failures,
  }
}

// ---------------------------------------------------------------------------
// Canonical bytes
// ---------------------------------------------------------------------------

/**
 * The canonical serialization of a mapping document: JSON.stringify of the
 * pinned-key-order construction above (no whitespace, no timestamps) —
 * byte-deterministic by construction, the artifact's stored bytes.
 */
export function mappingDocumentBytes(mapping: OpenProjectMappingDocument): string {
  return JSON.stringify(mapping)
}
