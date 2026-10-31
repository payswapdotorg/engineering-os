/**
 * Engineering OS — OpenProject sync core pins (ADR-0012 Stage 3).
 *
 * Every expected value here is hand-derived from the pinned arithmetic in
 * src/core/openproject-sync.ts's module header (the CPM projection, the
 * diff rules, the fold rules) — no value is ever copied from an adapter
 * run (ADR-0006 §2). Pure-core tests: no DB, no network, no filesystem.
 */

import { describe, expect, test } from "bun:test"

import { analyzeCpm, type CpmActivity, type CpmActivityResult } from "./cpm"
import {
  OPENPROJECT_TASK_TYPE_HREF,
  addUtcDays,
  foldRelationSync,
  foldWorkPackageSync,
  isValidIsoDate,
  mappingDocumentBytes,
  parseOpenProjectMappingDocument,
  parseOpenProjectSyncRequest,
  planRelationSync,
  planWorkPackageSync,
  projectWorkPackage,
  type OpenProjectMappingDocument,
  type WireRelationResult,
  type WireWorkPackageResult,
} from "./openproject-sync"

// ---------------------------------------------------------------------------
// Fixtures (hand-derived; the CPM numbers verified against analyzeCpm)
// ---------------------------------------------------------------------------

/** Two chains off a root: a(3d) → b(2d) → c(0d milestone); a → d(4d). */
const SCHEDULE: CpmActivity[] = [
  { id: "a", name: "Excavate", durationDays: 3, predecessorIds: [] },
  { id: "b", name: "Pour foundation", durationDays: 2, predecessorIds: ["a"] },
  { id: "c", name: "Cure complete", durationDays: 0, predecessorIds: ["b"] },
  { id: "d", name: "Backfill", durationDays: 4, predecessorIds: ["a"] },
]

const CPM = analyzeCpm(SCHEDULE)
if (!CPM.ok) throw new Error(`fixture schedule must analyze: ${CPM.error}`)
const CPM_VALUE: CpmActivityResult = CPM.value

// hand-checked: a es=0 ef=3; b es=3 ef=5; c es=5 ef=5 (milestone); d es=3 ef=7

const ANCHOR = "2026-11-02"

function priorMapping(overrides?: Partial<OpenProjectMappingDocument>): OpenProjectMappingDocument {
  return {
    format: "eos-openproject-sync/1",
    targetProjectId: 42,
    anchorDate: "2026-10-19",
    sourceScheduleArtifactId: "art_schedule_1",
    sourceRevisionId: "rev_1",
    workPackages: [
      {
        activityId: "a",
        subject: "Excavate",
        workPackageId: 101,
        lockVersion: 3,
        startDate: "2026-10-19",
        dueDate: "2026-10-21",
        status: "synced",
      },
    ],
    relations: [],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// The UTC calendar projection
// ---------------------------------------------------------------------------

describe("openproject-sync core — isValidIsoDate / addUtcDays (pure UTC math)", () => {
  test("isValidIsoDate accepts real calendar dates only", () => {
    expect(isValidIsoDate("2026-11-02")).toBe(true)
    expect(isValidIsoDate("2028-02-29")).toBe(true) // leap year
    expect(isValidIsoDate("2026-02-29")).toBe(false) // 2026 is not a leap year
    expect(isValidIsoDate("2026-02-30")).toBe(false) // no 30 February, ever
    expect(isValidIsoDate("2026-13-01")).toBe(false) // month 13
    expect(isValidIsoDate("2026-00-10")).toBe(false) // month 0
    expect(isValidIsoDate("2026-1-1")).toBe(false) // not zero-padded
    expect(isValidIsoDate("26-01-01")).toBe(false) // not 4-digit year
    expect(isValidIsoDate("")).toBe(false)
  })

  test("addUtcDays rolls months, years and leap days correctly", () => {
    expect(addUtcDays("2026-11-02", 0)).toBe("2026-11-02")
    expect(addUtcDays("2026-11-02", 5)).toBe("2026-11-07")
    expect(addUtcDays("2026-01-30", 3)).toBe("2026-02-02") // month rollover
    expect(addUtcDays("2026-12-31", 1)).toBe("2027-01-01") // year rollover
    expect(addUtcDays("2028-02-28", 1)).toBe("2028-02-29") // leap
    expect(addUtcDays("2027-02-28", 1)).toBe("2027-03-01") // non-leap
    expect(addUtcDays("2026-11-02", 30)).toBe("2026-12-02")
  })

  test("addUtcDays refuses a malformed date honestly", () => {
    expect(() => addUtcDays("2026-11-2", 1)).toThrow(/not a YYYY-MM-DD date/)
  })
})

describe("openproject-sync core — the UTC calendar projection", () => {
  test("a 3-day root activity occupies [anchor, anchor+2] (start=anchor+es, due=anchor+ef−1)", () => {
    const projected = projectWorkPackage(CPM_VALUE.activities[0], ANCHOR)
    expect(projected).toEqual({ subject: "Excavate", startDate: "2026-11-02", dueDate: "2026-11-04" })
  })

  test("a downstream activity projects from its es (anchor+3 / anchor+4)", () => {
    const b = projectWorkPackage(CPM_VALUE.activities[1], ANCHOR)
    expect(b).toEqual({ subject: "Pour foundation", startDate: "2026-11-05", dueDate: "2026-11-06" })
    const d = projectWorkPackage(CPM_VALUE.activities[3], ANCHOR)
    expect(d).toEqual({ subject: "Backfill", startDate: "2026-11-05", dueDate: "2026-11-08" })
  })

  test("a zero-duration milestone clamps dueDate to startDate (never an inverted range)", () => {
    const c = projectWorkPackage(CPM_VALUE.activities[2], ANCHOR)
    expect(c).toEqual({ subject: "Cure complete", startDate: "2026-11-07", dueDate: "2026-11-07" })
  })
})

// ---------------------------------------------------------------------------
// The request zod
// ---------------------------------------------------------------------------

describe("openproject-sync core — the request zod", () => {
  test("a valid request parses with both fields", () => {
    expect(parseOpenProjectSyncRequest({ anchorDate: ANCHOR, targetProjectId: 42 })).toEqual({
      ok: true,
      value: { anchorDate: ANCHOR, targetProjectId: 42 },
    })
  })

  test("anchorDate is required and must be a REAL calendar date", () => {
    expect(parseOpenProjectSyncRequest({ targetProjectId: 42 })).toMatchObject({ ok: false })
    const bad = parseOpenProjectSyncRequest({ anchorDate: "2026-02-30", targetProjectId: 42 })
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.error).toContain("anchorDate must be a real calendar date in YYYY-MM-DD form")
  })

  test("targetProjectId must be a positive integer", () => {
    expect(parseOpenProjectSyncRequest({ anchorDate: ANCHOR, targetProjectId: 0 })).toMatchObject({ ok: false })
    expect(parseOpenProjectSyncRequest({ anchorDate: ANCHOR, targetProjectId: -1 })).toMatchObject({ ok: false })
    expect(parseOpenProjectSyncRequest({ anchorDate: ANCHOR, targetProjectId: 1.5 })).toMatchObject({ ok: false })
    expect(parseOpenProjectSyncRequest({ anchorDate: ANCHOR, targetProjectId: "42" })).toMatchObject({ ok: false })
  })

  test("the request object is strict — unknown keys are refused, never ignored", () => {
    const parsed = parseOpenProjectSyncRequest({ anchorDate: ANCHOR, targetProjectId: 42, dryRun: true })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toContain("invalid openproject_sync request")
  })
})

// ---------------------------------------------------------------------------
// The mapping document gate
// ---------------------------------------------------------------------------

describe("openproject-sync core — the eos-openproject-sync/1 gate", () => {
  test("a well-formed mapping round-trips", () => {
    const parsed = parseOpenProjectMappingDocument(priorMapping())
    expect(parsed.ok).toBe(true)
  })

  test("the wrong format literal is refused honestly", () => {
    const parsed = parseOpenProjectMappingDocument({ ...priorMapping(), format: "eos-openproject-sync/2" })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toContain("invalid openproject mapping")
  })

  test("a bad entry status and a missing relations array are both refused", () => {
    const badStatus = parseOpenProjectMappingDocument({
      ...priorMapping(),
      workPackages: [{ ...priorMapping().workPackages[0], status: "deleted" }],
    })
    expect(badStatus.ok).toBe(false)
    const noRelations = parseOpenProjectMappingDocument({
      format: "eos-openproject-sync/1",
      targetProjectId: 42,
      anchorDate: ANCHOR,
      sourceScheduleArtifactId: "art_schedule_1",
      sourceRevisionId: "rev_1",
      workPackages: [],
    })
    expect(noRelations.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Plan pass 1 — the work-package diff
// ---------------------------------------------------------------------------

describe("openproject-sync core — planWorkPackageSync (update/create/never-delete)", () => {
  test("the first sync of a schedule plans exactly one create per activity, in schedule order, with the pinned payloads", () => {
    const plan = planWorkPackageSync(CPM_VALUE, { anchorDate: ANCHOR, targetProjectId: 42 }, null)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.value.targetProjectId).toBe(42)
    expect(plan.value.anchorDate).toBe(ANCHOR)
    expect(plan.value.orphans).toEqual([])
    expect(plan.value.items.map((item) => item.kind)).toEqual([
      "create-work-package",
      "create-work-package",
      "create-work-package",
      "create-work-package",
    ])
    // the exact pinned payload of activity a (key order pinned by construction)
    expect(plan.value.items[0]).toEqual({
      kind: "create-work-package",
      activityId: "a",
      payload: {
        subject: "Excavate",
        startDate: "2026-11-02",
        dueDate: "2026-11-04",
        _links: { type: { href: OPENPROJECT_TASK_TYPE_HREF } },
      },
    })
    // the milestone's clamped projection rides the payload
    expect(plan.value.items[2]).toMatchObject({
      activityId: "c",
      payload: { startDate: "2026-11-07", dueDate: "2026-11-07" },
    })
  })

  test("the first sync without targetProjectId and without a prior mapping refuses honestly", () => {
    const plan = planWorkPackageSync(CPM_VALUE, { anchorDate: ANCHOR }, null)
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.error).toBe(
      "openproject_sync requires parameters.targetProjectId (an OpenProject project id) on the first sync of a schedule — no prior mapping carries one",
    )
  })

  test("a later sync defaults the target to the prior mapping's target", () => {
    const plan = planWorkPackageSync(CPM_VALUE, { anchorDate: ANCHOR }, priorMapping())
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.value.targetProjectId).toBe(42)
  })

  test("the diff: mapped → update (lockVersion carried), unmapped → create, vanished → orphan, revived → update, failed-with-id → update, failed-null-id → create", () => {
    const prior: OpenProjectMappingDocument = {
      ...priorMapping(),
      workPackages: [
        priorMapping().workPackages[0], // a: synced, wp 101 — stays in schedule → UPDATE
        {
          activityId: "gone",
          subject: "Old work",
          workPackageId: 999,
          lockVersion: 1,
          startDate: "2026-10-19",
          dueDate: "2026-10-20",
          status: "synced",
        }, // vanished → ORPHAN
        {
          activityId: "d",
          subject: "Backfill (old label)",
          workPackageId: 104,
          lockVersion: 7,
          startDate: "2026-10-22",
          dueDate: "2026-10-25",
          status: "failed",
          lastError: "HTTP 500 during the prior run",
        }, // failed WITH id → UPDATE (retry)
      ],
    }
    const plan = planWorkPackageSync(CPM_VALUE, { anchorDate: ANCHOR }, prior)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    const byActivity = new Map(plan.value.items.map((item) => [item.activityId, item]))
    expect(byActivity.get("a")).toEqual({
      kind: "update-work-package",
      activityId: "a",
      workPackageId: 101,
      lockVersion: 3,
      payload: { subject: "Excavate", startDate: "2026-11-02", dueDate: "2026-11-04" },
    })
    expect(byActivity.get("b")?.kind).toBe("create-work-package")
    expect(byActivity.get("c")?.kind).toBe("create-work-package")
    expect(byActivity.get("d")).toMatchObject({
      kind: "update-work-package",
      workPackageId: 104,
      lockVersion: 7,
    })
    expect(plan.value.orphans).toEqual(["gone"])
    // NEVER-delete: no wire item exists for the orphan
    expect(plan.value.items.some((item) => item.activityId === "gone")).toBe(false)

    // a failed create (null id) retries as a create
    const priorFailedCreate: OpenProjectMappingDocument = {
      ...priorMapping(),
      workPackages: [
        {
          activityId: "a",
          subject: "Excavate",
          workPackageId: null,
          lockVersion: null,
          startDate: "2026-10-19",
          dueDate: "2026-10-21",
          status: "failed",
          lastError: "connection refused",
        },
      ],
    }
    const retry = planWorkPackageSync(CPM_VALUE, { anchorDate: ANCHOR }, priorFailedCreate)
    expect(retry.ok).toBe(true)
    if (!retry.ok) return
    expect(retry.value.items[0].kind).toBe("create-work-package")

    // an orphaned entry whose activity REAPPEARS is revived (an update)
    const priorOrphan: OpenProjectMappingDocument = {
      ...priorMapping(),
      workPackages: [
        {
          activityId: "b",
          subject: "Pour foundation",
          workPackageId: 102,
          lockVersion: 2,
          startDate: "2026-10-22",
          dueDate: "2026-10-23",
          status: "orphaned",
        },
      ],
    }
    const revived = planWorkPackageSync(CPM_VALUE, { anchorDate: ANCHOR }, priorOrphan)
    expect(revived.ok).toBe(true)
    if (!revived.ok) return
    const revivedB = revived.value.items.find((item) => item.activityId === "b")
    expect(revivedB).toMatchObject({ kind: "update-work-package", workPackageId: 102, lockVersion: 2 })
  })
})

// ---------------------------------------------------------------------------
// Plan pass 2 — the follows relations
// ---------------------------------------------------------------------------

describe("openproject-sync core — planRelationSync (the graph edges)", () => {
  test("one ensure-relation per (successor, predecessor) edge in schedule × predecessor order, skipping recorded pairs and unresolved endpoints", () => {
    const mapping: OpenProjectMappingDocument = {
      ...priorMapping(),
      workPackages: [
        { activityId: "a", subject: "Excavate", workPackageId: 101, lockVersion: 1, startDate: ANCHOR, dueDate: ANCHOR, status: "synced" },
        { activityId: "b", subject: "Pour foundation", workPackageId: 102, lockVersion: 1, startDate: ANCHOR, dueDate: ANCHOR, status: "synced" },
        { activityId: "c", subject: "Cure complete", workPackageId: 103, lockVersion: 1, startDate: ANCHOR, dueDate: ANCHOR, status: "synced" },
        { activityId: "d", subject: "Backfill", workPackageId: null, lockVersion: null, startDate: ANCHOR, dueDate: ANCHOR, status: "failed" }, // create failed this run
      ],
      relations: [
        { successorActivityId: "b", predecessorActivityId: "a", relationId: 55 }, // already recorded
      ],
    }
    const plan = planRelationSync(SCHEDULE, mapping)
    // edges: b→a (recorded, skipped), c→b (planned), d→a (endpoint failed, skipped)
    expect(plan.items).toEqual([
      {
        kind: "ensure-relation",
        successorActivityId: "c",
        predecessorActivityId: "b",
        successorWorkPackageId: 103,
        predecessorWorkPackageId: 102,
      },
    ])
  })
})

// ---------------------------------------------------------------------------
// Fold pass 1 — work-package results into the next mapping
// ---------------------------------------------------------------------------

describe("openproject-sync core — foldWorkPackageSync (the interrupted-partial fold)", () => {
  const context = {
    targetProjectId: 42,
    anchorDate: ANCHOR,
    sourceScheduleArtifactId: "art_schedule_1",
    sourceRevisionId: "rev_2",
  }

  test("all-success fold: every entry synced with the response ids/lockVersions, prior orphans carried, exact stats", () => {
    const plan = planWorkPackageSync(CPM_VALUE, { anchorDate: ANCHOR, targetProjectId: 42 }, priorMapping())
    if (!plan.ok) throw new Error("plan fixture failed")
    const results: WireWorkPackageResult[] = [
      { kind: "update-work-package", activityId: "a", ok: true, workPackageId: 101, lockVersion: 4, adopted: false, recreated: false },
      { kind: "create-work-package", activityId: "b", ok: true, workPackageId: 201, lockVersion: 0, adopted: false, recreated: false },
      { kind: "create-work-package", activityId: "c", ok: true, workPackageId: 202, lockVersion: 0, adopted: false, recreated: false },
      { kind: "create-work-package", activityId: "d", ok: true, workPackageId: 203, lockVersion: 0, adopted: true, recreated: false },
    ]
    const folded = foldWorkPackageSync(CPM_VALUE, plan.value, results, priorMapping(), context)
    expect(folded.stats).toEqual({ created: 2, adopted: 1, updated: 1, recreated: 0, failed: 0, orphans: 0 })
    expect(folded.failures).toEqual([])
    expect(folded.mapping.workPackages.map((e) => [e.activityId, e.status, e.workPackageId, e.lockVersion])).toEqual([
      ["a", "synced", 101, 4],
      ["b", "synced", 201, 0],
      ["c", "synced", 202, 0],
      ["d", "synced", 203, 0],
    ])
    expect(folded.mapping.relations).toEqual([]) // prior's carried verbatim
  })

  test("a failed update keeps its prior workPackageId and records the verbatim error — the next plan retries it as an update", () => {
    const plan = planWorkPackageSync(CPM_VALUE, { anchorDate: ANCHOR, targetProjectId: 42 }, priorMapping())
    if (!plan.ok) throw new Error("plan fixture failed")
    const results: WireWorkPackageResult[] = [
      { kind: "update-work-package", activityId: "a", ok: false, error: 'OpenProject update failed for activity "a": HTTP 500' },
      { kind: "create-work-package", activityId: "b", ok: true, workPackageId: 201, lockVersion: 0, adopted: false, recreated: false },
      { kind: "create-work-package", activityId: "c", ok: false, error: 'OpenProject create failed for activity "c": connection refused' },
      { kind: "create-work-package", activityId: "d", ok: true, workPackageId: 203, lockVersion: 0, adopted: false, recreated: false },
    ]
    const folded = foldWorkPackageSync(CPM_VALUE, plan.value, results, priorMapping(), context)
    expect(folded.stats.failed).toBe(2)
    expect(folded.failures).toEqual([
      'OpenProject update failed for activity "a": HTTP 500',
      'OpenProject create failed for activity "c": connection refused',
    ])
    const a = folded.mapping.workPackages.find((e) => e.activityId === "a")!
    expect(a).toMatchObject({ status: "failed", workPackageId: 101, lastError: 'OpenProject update failed for activity "a": HTTP 500' })
    const c = folded.mapping.workPackages.find((e) => e.activityId === "c")!
    expect(c).toMatchObject({ status: "failed", workPackageId: null })
    // the interrupted-partial fold: the NEXT plan retries a as an update, c as a create
    const next = planWorkPackageSync(CPM_VALUE, { anchorDate: ANCHOR }, folded.mapping)
    expect(next.ok).toBe(true)
    if (!next.ok) return
    const byActivity = new Map(next.value.items.map((item) => [item.activityId, item]))
    expect(byActivity.get("a")).toMatchObject({ kind: "update-work-package", workPackageId: 101 })
    expect(byActivity.get("c")).toMatchObject({ kind: "create-work-package" })
  })

  test("an orphan is folded as recorded-never-deleted, keeping its prior identity", () => {
    const priorWithOrphan: OpenProjectMappingDocument = {
      ...priorMapping(),
      workPackages: [
        priorMapping().workPackages[0],
        {
          activityId: "gone",
          subject: "Old work",
          workPackageId: 999,
          lockVersion: 2,
          startDate: "2026-10-19",
          dueDate: "2026-10-20",
          status: "synced",
        },
      ],
    }
    const plan = planWorkPackageSync(CPM_VALUE, { anchorDate: ANCHOR, targetProjectId: 42 }, priorWithOrphan)
    if (!plan.ok) throw new Error("plan fixture failed")
    expect(plan.value.orphans).toEqual(["gone"])
    const results: WireWorkPackageResult[] = [
      { kind: "update-work-package", activityId: "a", ok: true, workPackageId: 101, lockVersion: 4, adopted: false, recreated: false },
      { kind: "create-work-package", activityId: "b", ok: true, workPackageId: 201, lockVersion: 0, adopted: false, recreated: false },
      { kind: "create-work-package", activityId: "c", ok: true, workPackageId: 202, lockVersion: 0, adopted: false, recreated: false },
      { kind: "create-work-package", activityId: "d", ok: true, workPackageId: 203, lockVersion: 0, adopted: false, recreated: false },
    ]
    const folded = foldWorkPackageSync(CPM_VALUE, plan.value, results, priorWithOrphan, context)
    expect(folded.stats.orphans).toBe(1)
    const orphan = folded.mapping.workPackages.find((e) => e.activityId === "gone")!
    expect(orphan).toMatchObject({ status: "orphaned", workPackageId: 999, subject: "Old work" })
    // canonical order: schedule activities first, orphans after
    expect(folded.mapping.workPackages.map((e) => e.activityId)).toEqual(["a", "b", "c", "d", "gone"])
  })

  test("canonical bytes: the fold is byte-deterministic and the exact serialization is pinned", () => {
    const plan = planWorkPackageSync(CPM_VALUE, { anchorDate: ANCHOR, targetProjectId: 42 }, null)
    if (!plan.ok) throw new Error("plan fixture failed")
    const results: WireWorkPackageResult[] = [
      { kind: "create-work-package", activityId: "a", ok: true, workPackageId: 101, lockVersion: 0, adopted: false, recreated: false },
      { kind: "create-work-package", activityId: "b", ok: true, workPackageId: 102, lockVersion: 0, adopted: false, recreated: false },
      { kind: "create-work-package", activityId: "c", ok: true, workPackageId: 103, lockVersion: 0, adopted: false, recreated: false },
      { kind: "create-work-package", activityId: "d", ok: true, workPackageId: 104, lockVersion: 0, adopted: false, recreated: false },
    ]
    const first = foldWorkPackageSync(CPM_VALUE, plan.value, results, null, context)
    const second = foldWorkPackageSync(CPM_VALUE, plan.value, results, null, context)
    expect(mappingDocumentBytes(first.mapping)).toBe(mappingDocumentBytes(second.mapping))
    expect(mappingDocumentBytes(first.mapping)).toBe(
      '{"format":"eos-openproject-sync/1","targetProjectId":42,"anchorDate":"2026-11-02",' +
        '"sourceScheduleArtifactId":"art_schedule_1","sourceRevisionId":"rev_2","workPackages":[' +
        '{"activityId":"a","subject":"Excavate","workPackageId":101,"lockVersion":0,"startDate":"2026-11-02","dueDate":"2026-11-04","status":"synced"},' +
        '{"activityId":"b","subject":"Pour foundation","workPackageId":102,"lockVersion":0,"startDate":"2026-11-05","dueDate":"2026-11-06","status":"synced"},' +
        '{"activityId":"c","subject":"Cure complete","workPackageId":103,"lockVersion":0,"startDate":"2026-11-07","dueDate":"2026-11-07","status":"synced"},' +
        '{"activityId":"d","subject":"Backfill","workPackageId":104,"lockVersion":0,"startDate":"2026-11-05","dueDate":"2026-11-08","status":"synced"}],' +
        '"relations":[]}',
    )
  })
})

// ---------------------------------------------------------------------------
// Fold pass 2 — relation results
// ---------------------------------------------------------------------------

describe("openproject-sync core — foldRelationSync", () => {
  const baseMapping: OpenProjectMappingDocument = {
    format: "eos-openproject-sync/1",
    targetProjectId: 42,
    anchorDate: ANCHOR,
    sourceScheduleArtifactId: "art_schedule_1",
    sourceRevisionId: "rev_2",
    workPackages: [],
    relations: [{ successorActivityId: "b", predecessorActivityId: "a", relationId: 55 }],
  }

  test("ok results are recorded (ensured vs reused in the stats); failures are NOT recorded and surface verbatim", () => {
    const plan = {
      items: [
        {
          kind: "ensure-relation" as const,
          successorActivityId: "c",
          predecessorActivityId: "b",
          successorWorkPackageId: 103,
          predecessorWorkPackageId: 102,
        },
        {
          kind: "ensure-relation" as const,
          successorActivityId: "d",
          predecessorActivityId: "a",
          successorWorkPackageId: 104,
          predecessorWorkPackageId: 101,
        },
      ],
    }
    const results: WireRelationResult[] = [
      {
        kind: "ensure-relation",
        successorActivityId: "c",
        predecessorActivityId: "b",
        ok: true,
        relationId: 77,
        existedAlready: true,
      },
      {
        kind: "ensure-relation",
        successorActivityId: "d",
        predecessorActivityId: "a",
        ok: false,
        error: 'OpenProject relation create failed for d → a: HTTP 422',
      },
    ]
    const folded = foldRelationSync(baseMapping, plan, results)
    expect(folded.stats).toEqual({ ensured: 0, reused: 1, failed: 1 })
    expect(folded.failures).toEqual(['OpenProject relation create failed for d → a: HTTP 422'])
    expect(folded.mapping.relations).toEqual([
      { successorActivityId: "b", predecessorActivityId: "a", relationId: 55 }, // carried over
      { successorActivityId: "c", predecessorActivityId: "b", relationId: 77 }, // recorded
      // d→a NOT recorded — the next sync re-plans it (the healer keeps the instance clean)
    ])
  })

  test("the same edge is never recorded twice (idempotent fold)", () => {
    const plan = {
      items: [
        {
          kind: "ensure-relation" as const,
          successorActivityId: "b",
          predecessorActivityId: "a",
          successorWorkPackageId: 102,
          predecessorWorkPackageId: 101,
        },
      ],
    }
    const results: WireRelationResult[] = [
      {
        kind: "ensure-relation",
        successorActivityId: "b",
        predecessorActivityId: "a",
        ok: true,
        relationId: 55,
        existedAlready: true,
      },
    ]
    const folded = foldRelationSync(baseMapping, plan, results)
    expect(folded.mapping.relations).toEqual([{ successorActivityId: "b", predecessorActivityId: "a", relationId: 55 }])
  })
})
