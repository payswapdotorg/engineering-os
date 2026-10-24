import { describe, expect, test } from "bun:test"

import { planInvitationActivation, type PendingInvitationRow } from "./signup"

const d = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n))

function row(over: Partial<PendingInvitationRow> & { id: string; projectId: string }): PendingInvitationRow {
  return { addedAt: d(0), role: "editor", ...over }
}

describe("planInvitationActivation (Slice 14 — invitation self-activation planner)", () => {
  test("no pending rows ⇒ nothing to activate", () => {
    expect(planInvitationActivation([])).toEqual([])
  })

  test("one row per project ⇒ all activate, ordered by projectId", () => {
    const plan = planInvitationActivation([
      row({ id: "mem-b", projectId: "pj-b", role: "viewer" }),
      row({ id: "mem-a", projectId: "pj-a", role: "editor" }),
    ])
    expect(plan).toEqual([
      { memberId: "mem-a", projectId: "pj-a", role: "editor" },
      { memberId: "mem-b", projectId: "pj-b", role: "viewer" },
    ])
  })

  test("two pending rows in the SAME project ⇒ only the EARLIEST activates (the @@unique([projectId, userId]) grant constraint)", () => {
    const plan = planInvitationActivation([
      row({ id: "mem-late", projectId: "pj-1", addedAt: d(90) }),
      row({ id: "mem-early", projectId: "pj-1", addedAt: d(10), role: "viewer" }),
    ])
    expect(plan).toEqual([{ memberId: "mem-early", projectId: "pj-1", role: "viewer" }])
  })

  test("same addedAt ties break by id (deterministic, no insertion-order dependence)", () => {
    const plan = planInvitationActivation([
      row({ id: "mem-zzz", projectId: "pj-1", addedAt: d(50) }),
      row({ id: "mem-aaa", projectId: "pj-1", addedAt: d(50), role: "owner" }),
    ])
    expect(plan).toEqual([{ memberId: "mem-aaa", projectId: "pj-1", role: "owner" }])
  })

  test("mixed: same-project duplicates collapse while other projects keep theirs", () => {
    const plan = planInvitationActivation([
      row({ id: "mem-1a", projectId: "pj-1", addedAt: d(30) }),
      row({ id: "mem-1b", projectId: "pj-1", addedAt: d(20) }),
      row({ id: "mem-1c", projectId: "pj-1", addedAt: d(10), role: "viewer" }),
      row({ id: "mem-2", projectId: "pj-2", addedAt: d(99), role: "owner" }),
    ])
    expect(plan).toEqual([
      { memberId: "mem-1c", projectId: "pj-1", role: "viewer" },
      { memberId: "mem-2", projectId: "pj-2", role: "owner" },
    ])
  })

  test("string addedAt (serialized JSON) is compared by time, not lexically", () => {
    const plan = planInvitationActivation([
      row({ id: "mem-str", projectId: "pj-1", addedAt: "2026-01-01T00:00:09.000Z" }),
      row({ id: "mem-iso", projectId: "pj-1", addedAt: "2026-01-01T00:00:02.000Z", role: "viewer" }),
    ])
    expect(plan).toEqual([{ memberId: "mem-iso", projectId: "pj-1", role: "viewer" }])
  })
})
