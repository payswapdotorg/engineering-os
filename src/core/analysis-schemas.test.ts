/**
 * W3-f lane — discipline input-schema tests (Phase 5, contract §3).
 *
 * Pins the frozen §3.1/3.2/3.3 semantics: happy paths with defaults filled,
 * the THREE pinned schedule error messages verbatim, the sibling
 * cross-reference messages, ledger-style joining ("; ", root issues without a
 * path), bounds, strictness and the stored-content helpers. Pure only.
 */

/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test"

import {
  canonicalScheduleJson,
  parseDesScenario,
  parseDesScenarioJsonText,
  parsePowerflowNetwork,
  parsePowerflowNetworkJsonText,
  parseSchedule,
  parseScheduleJsonText,
} from "./analysis-schemas"

// ---------------------------------------------------------------------------
// §3.1 Schedule
// ---------------------------------------------------------------------------

describe("parseSchedule (eos-schedule/1)", () => {
  const valid = {
    format: "eos-schedule/1",
    name: "Harbour piling program",
    activities: [
      { id: "a", name: "A", durationDays: 3, predecessorIds: [] },
      { id: "c", name: "C", durationDays: 4, predecessorIds: ["a"] },
    ],
  }

  test("valid schedule parses with predecessorIds defaulted to [] when omitted", () => {
    const parsed = parseSchedule({
      format: "eos-schedule/1",
      name: "s",
      activities: [{ id: "a", name: "A", durationDays: 1 }],
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.activities[0].predecessorIds).toEqual([])
    expect(parsed.value.name).toBe("s")
  })

  test("wrong format is refused with the pinned literal message", () => {
    const parsed = parseSchedule({ ...valid, format: "eos-schedule/2" })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toBe('invalid schedule: format: format must be "eos-schedule/1"')
  })

  test("duplicate activity id is refused VERBATIM at the second occurrence", () => {
    const parsed = parseSchedule({
      ...valid,
      activities: [
        { id: "a", name: "A", durationDays: 1, predecessorIds: [] },
        { id: "a", name: "A2", durationDays: 2, predecessorIds: [] },
      ],
    })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toBe('invalid schedule: activities.1.id: activity id "a" is used more than once')
  })

  test("unknown predecessor is refused VERBATIM with the activity path", () => {
    const parsed = parseSchedule({
      ...valid,
      activities: [{ id: "a", name: "A", durationDays: 2, predecessorIds: ["ghost"] }],
    })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toBe(
      'invalid schedule: activities.0: activity "a" references unknown predecessor "ghost"',
    )
  })

  test("a cycle is refused VERBATIM at the root (graph-level property)", () => {
    const parsed = parseSchedule({
      ...valid,
      activities: [
        { id: "a", name: "A", durationDays: 1, predecessorIds: ["b"] },
        { id: "b", name: "B", durationDays: 1, predecessorIds: ["a"] },
      ],
    })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toBe('invalid schedule: activity chain contains a cycle involving "a"')
  })

  test("multiple problems join into ONE message with '; '", () => {
    const parsed = parseSchedule({
      ...valid,
      activities: [
        { id: "a", name: "A", durationDays: 1, predecessorIds: ["ghost"] },
        { id: "a", name: "A2", durationDays: 1, predecessorIds: [] },
      ],
    })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toBe(
      'invalid schedule: activities.1.id: activity id "a" is used more than once; activities.0: activity "a" references unknown predecessor "ghost"',
    )
  })

  test("activity-count bounds: 0 and 65 are refused", () => {
    const empty = parseSchedule({ ...valid, activities: [] })
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.error).toContain("at least one activity is required")

    const many = Array.from({ length: 65 }, (_, i) => ({
      id: `a-${i}`,
      name: `A${i}`,
      durationDays: 1,
      predecessorIds: [],
    }))
    const tooMany = parseSchedule({ ...valid, activities: many })
    expect(tooMany.ok).toBe(false)
    if (!tooMany.ok) expect(tooMany.error).toContain("at most 64 activities are allowed")
  })

  test("durationDays must be an integer within 0..10000 (one pinned message)", () => {
    for (const bad of [-1, 1.5, 10001]) {
      const parsed = parseSchedule({
        ...valid,
        activities: [{ id: "a", name: "A", durationDays: bad }],
      })
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) {
        expect(parsed.error).toContain("durationDays must be an integer between 0 and 10000")
      }
    }
    // 0 is legal (milestone).
    const zero = parseSchedule({
      ...valid,
      activities: [{ id: "m", name: "M", durationDays: 0 }],
    })
    expect(zero.ok).toBe(true)
  })

  test("activity ids must match the pattern; unknown keys are refused (strict)", () => {
    const badId = parseSchedule({
      ...valid,
      activities: [{ id: "A!", name: "A", durationDays: 1 }],
    })
    expect(badId.ok).toBe(false)
    if (!badId.ok) {
      expect(badId.error).toContain(
        "activity id must match ^[a-z0-9-]{1,32}$ (lowercase letters, digits, dashes)",
      )
    }

    const unknownKey = parseSchedule({
      ...valid,
      activities: [{ id: "a", name: "A", durationDays: 1, bogus: true } as unknown as never],
    })
    expect(unknownKey.ok).toBe(false)
    if (!unknownKey.ok) expect(unknownKey.error).toContain("Unrecognized key")
  })

  test("a non-object schedule is refused with the root message, never a crash", () => {
    const parsed = parseSchedule([1, 2, 3])
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toBe("invalid schedule: schedule must be a JSON object")
  })
})

describe("canonicalScheduleJson (byte-deterministic stored bytes)", () => {
  test("pinned key order, defaults materialized", () => {
    const parsed = parseSchedule({
      format: "eos-schedule/1",
      name: "s",
      activities: [{ id: "a", name: "A", durationDays: 2 }],
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(canonicalScheduleJson(parsed.value)).toBe(
      '{"format":"eos-schedule/1","name":"s","activities":[{"id":"a","name":"A","durationDays":2,"predecessorIds":[]}]}',
    )
  })

  test("sender key order and whitespace never change the stored bytes (array order IS content)", () => {
    const a = parseSchedule({
      format: "eos-schedule/1",
      name: "s",
      activities: [
        { id: "a", name: "A", durationDays: 3, predecessorIds: ["b"] },
        { id: "b", name: "B", durationDays: 1, predecessorIds: [] },
      ],
    })
    // Same activity ARRAY (order is content), scrambled keys at both levels.
    const b = parseSchedule({
      activities: [
        { predecessorIds: ["b"], durationDays: 3, name: "A", id: "a" },
        { predecessorIds: [], durationDays: 1, name: "B", id: "b" },
      ],
      name: "s",
      format: "eos-schedule/1",
    })
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(canonicalScheduleJson(a.value)).toBe(canonicalScheduleJson(b.value))
  })
})

describe("parseScheduleJsonText (stored content)", () => {
  test("valid JSON text parses; non-JSON bytes are an honest dead end", () => {
    const good = parseScheduleJsonText(
      '{"format":"eos-schedule/1","name":"s","activities":[{"id":"a","name":"A","durationDays":1}]}',
    )
    expect(good.ok).toBe(true)

    const bad = parseScheduleJsonText("IFC4; not json at all")
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.error).toBe("invalid schedule: content is not valid JSON")
  })
})

// ---------------------------------------------------------------------------
// §3.2 Power-flow network
// ---------------------------------------------------------------------------

describe("parsePowerflowNetwork (eos-powerflow-network/1)", () => {
  const valid = {
    format: "eos-powerflow-network/1",
    name: "site feeder",
    buses: [
      { id: "b1", nominalVk: 20 },
      { id: "b2", nominalVk: 20 },
    ],
    lines: [
      {
        id: "l1",
        fromBus: "b1",
        toBus: "b2",
        lengthKm: 10,
        rOhmPerKm: 0,
        xOhmPerKm: 0.1,
      },
    ],
    externalGrid: { busId: "b1", vmPu: 1 },
    loads: [{ id: "ld1", busId: "b2", pMw: 2, qMvar: 0 }],
  }

  test("valid network parses with baseMva/maxCurrentKa defaults filled", () => {
    const parsed = parsePowerflowNetwork(valid)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.baseMva).toBe(100)
    expect(parsed.value.lines[0].maxCurrentKa).toBe(1)
  })

  test("unknown fromBus/toBus are refused with the pinned cross-reference style", () => {
    const parsed = parsePowerflowNetwork({
      ...valid,
      lines: [{ ...valid.lines[0], fromBus: "b9" }],
    })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toBe(
      'invalid power flow network: lines.0: line "l1" references unknown fromBus "b9"',
    )

    const toBus = parsePowerflowNetwork({
      ...valid,
      lines: [{ ...valid.lines[0], toBus: "b9" }],
    })
    expect(toBus.ok).toBe(false)
    if (toBus.ok) return
    expect(toBus.error).toBe(
      'invalid power flow network: lines.0: line "l1" references unknown toBus "b9"',
    )
  })

  test("externalGrid must point at a known bus; loads likewise", () => {
    const grid = parsePowerflowNetwork({
      ...valid,
      externalGrid: { busId: "b9", vmPu: 1 },
    })
    expect(grid.ok).toBe(false)
    if (grid.ok) return
    expect(grid.error).toBe(
      'invalid power flow network: externalGrid: externalGrid references unknown busId "b9"',
    )

    const load = parsePowerflowNetwork({
      ...valid,
      loads: [{ ...valid.loads[0], busId: "b9" }],
    })
    expect(load.ok).toBe(false)
    if (load.ok) return
    expect(load.error).toBe(
      'invalid power flow network: loads.0: load "ld1" references unknown busId "b9"',
    )
  })

  test("duplicate bus ids use the shared 'is used more than once' form", () => {
    // b2 stays present so the line/load references remain valid and the dup
    // error is the ONLY issue in the joined message.
    const parsed = parsePowerflowNetwork({
      ...valid,
      buses: [
        { id: "b1", nominalVk: 20 },
        { id: "b1", nominalVk: 20 },
        { id: "b2", nominalVk: 20 },
      ],
    })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toBe('invalid power flow network: buses.1.id: bus id "b1" is used more than once')
  })

  test("xOhmPerKm must be > 0 while rOhmPerKm 0 is legal", () => {
    const bad = parsePowerflowNetwork({
      ...valid,
      lines: [{ ...valid.lines[0], xOhmPerKm: 0 }],
    })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toContain("xOhmPerKm must be a finite number > 0")
    expect(parsePowerflowNetwork(valid).ok).toBe(true)
  })

  test("bus bound is 1..16", () => {
    const parsed = parsePowerflowNetwork({
      ...valid,
      buses: Array.from({ length: 17 }, (_, i) => ({ id: `b${i}`, nominalVk: 20 })),
    })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain("at most 16 buses are allowed")
  })

  test("stored-content helper: non-JSON text is an honest dead end", () => {
    const bad = parsePowerflowNetworkJsonText("<xml/>")
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.error).toBe("invalid power flow network: content is not valid JSON")
  })
})

// ---------------------------------------------------------------------------
// §3.3 DES scenario
// ---------------------------------------------------------------------------

describe("parseDesScenario (eos-des-scenario/1)", () => {
  const valid = {
    format: "eos-des-scenario/1",
    name: "flow shop",
    resources: [
      { id: "m1" },
      { id: "m2", capacity: 2 },
    ],
    jobs: [
      {
        id: "j1",
        tasks: [
          { resourceId: "m1", duration: 2 },
          { resourceId: "m2", duration: 4 },
        ],
      },
    ],
  }

  test("valid scenario parses with timeUnit/capacity/arriveAt defaults filled", () => {
    const parsed = parseDesScenario(valid)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.timeUnit).toBe("day")
    expect(parsed.value.resources[0].capacity).toBe(1)
    expect(parsed.value.resources[1].capacity).toBe(2)
    expect(parsed.value.jobs[0].arriveAt).toBe(0)
  })

  test("zero-duration tasks are schema-refused (the adapter never sees them)", () => {
    const parsed = parseDesScenario({
      ...valid,
      jobs: [{ id: "j1", tasks: [{ resourceId: "m1", duration: 0 }] }],
    })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toBe(
      "invalid DES scenario: jobs.0.tasks.0.duration: duration must be a finite number > 0",
    )
  })

  test("tasks referencing an absent resource are refused (harness case 7 shape)", () => {
    const parsed = parseDesScenario({
      ...valid,
      jobs: [{ id: "j1", tasks: [{ resourceId: "r9", duration: 1 }] }],
    })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toBe(
      'invalid DES scenario: jobs.0: job "j1" references unknown resource "r9"',
    )
  })

  test("capacity is an integer within 1..8", () => {
    const bad = parseDesScenario({ ...valid, resources: [{ id: "m1", capacity: 9 }] })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toContain("capacity must be an integer between 1 and 8")

    const fractional = parseDesScenario({ ...valid, resources: [{ id: "m1", capacity: 1.5 }] })
    expect(fractional.ok).toBe(false)
    if (!fractional.ok) expect(fractional.error).toContain("capacity must be an integer between 1 and 8")
  })

  test("timeUnit must be one of the three units", () => {
    const parsed = parseDesScenario({ ...valid, timeUnit: "week" })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toBe("invalid DES scenario: timeUnit: timeUnit must be one of: hour, day, minute")
  })

  test("duplicate job ids are refused with the shared form", () => {
    const parsed = parseDesScenario({
      ...valid,
      jobs: [
        { id: "j1", tasks: [{ resourceId: "m1", duration: 1 }] },
        { id: "j1", tasks: [{ resourceId: "m2", duration: 1 }] },
      ],
    })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toBe('invalid DES scenario: jobs.1.id: job id "j1" is used more than once')
  })

  test("stored-content helper: non-JSON text is an honest dead end", () => {
    const bad = parseDesScenarioJsonText("not json")
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.error).toBe("invalid DES scenario: content is not valid JSON")
  })
})
