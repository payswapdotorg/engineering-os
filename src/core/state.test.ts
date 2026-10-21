/**
 * Worker 3 lane — state machine tests: staleness (per revision) and approval
 * (per revision), pinning the exact transition tables in src/core/index.ts.
 * `null` from a transition function means "invalid event in this state — the
 * caller must reject the action".
 */

/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test"
import {
  applyApproval,
  nextStaleness,
  STALENESS_STATES,
  type StalenessEvent,
  type StalenessState,
} from "./index"

describe("nextStaleness (staleness state machine)", () => {
  test("current + source-changed → stale", () => {
    expect(nextStaleness("current", "source-changed")).toBe("stale")
  })

  test("stale + source-changed → stale (stays stale, keeps evidence)", () => {
    expect(nextStaleness("stale", "source-changed")).toBe("stale")
  })

  test("stale + recompute-started → recomputing", () => {
    expect(nextStaleness("stale", "recompute-started")).toBe("recomputing")
  })

  test("recomputing + recompute-succeeded → current", () => {
    expect(nextStaleness("recomputing", "recompute-succeeded")).toBe("current")
  })

  test("recomputing + recompute-failed → stale", () => {
    expect(nextStaleness("recomputing", "recompute-failed")).toBe("stale")
  })

  test("current + recompute-started → null (recompute requires staleness first)", () => {
    expect(nextStaleness("current", "recompute-started")).toBeNull()
  })

  test("recomputing + source-changed → null (must restart recompute explicitly)", () => {
    expect(nextStaleness("recomputing", "source-changed")).toBeNull()
  })

  test("every other (state, event) pair is rejected with null", () => {
    const events: StalenessEvent[] = [
      "source-changed",
      "recompute-started",
      "recompute-succeeded",
      "recompute-failed",
    ]
    const allowed: Record<string, StalenessState> = {
      "current|source-changed": "stale",
      "stale|source-changed": "stale",
      "stale|recompute-started": "recomputing",
      "recomputing|recompute-succeeded": "current",
      "recomputing|recompute-failed": "stale",
    }
    for (const state of STALENESS_STATES) {
      for (const event of events) {
        const expected = allowed[`${state}|${event}`] ?? null
        expect(nextStaleness(state, event)).toBe(expected)
      }
    }
  })
})

describe("applyApproval (approval state machine)", () => {
  test("draft + submit → in_review", () => {
    expect(applyApproval("draft", "submit")).toBe("in_review")
  })

  test("in_review + approve → approved", () => {
    expect(applyApproval("in_review", "approve")).toBe("approved")
  })

  test("in_review + reject → draft", () => {
    expect(applyApproval("in_review", "reject")).toBe("draft")
  })

  test("draft + approve → approved (fast path, small teams)", () => {
    expect(applyApproval("draft", "approve")).toBe("approved")
  })

  test("approved → superseded only (supersede); all other actions on approved are null", () => {
    expect(applyApproval("approved", "supersede")).toBe("superseded")
    expect(applyApproval("approved", "submit")).toBeNull()
    expect(applyApproval("approved", "approve")).toBeNull()
    expect(applyApproval("approved", "reject")).toBeNull()
  })

  test("in_review + supersede → superseded", () => {
    expect(applyApproval("in_review", "supersede")).toBe("superseded")
  })

  test("draft + supersede → superseded (existing TL seed behavior, pinned)", () => {
    expect(applyApproval("draft", "supersede")).toBe("superseded")
  })

  test("superseded + anything → null (terminal state)", () => {
    for (const action of ["submit", "approve", "reject", "supersede"] as const) {
      expect(applyApproval("superseded", action)).toBeNull()
    }
  })

  test("draft + reject → null (nothing to reject before submission)", () => {
    expect(applyApproval("draft", "reject")).toBeNull()
  })

  test("full happy-path walk: draft → in_review → approved → superseded", () => {
    const submitted = applyApproval("draft", "submit")
    expect(submitted).toBe("in_review")
    const approved = applyApproval(submitted ?? "in_review", "approve")
    expect(approved).toBe("approved")
    const superseded = applyApproval(approved ?? "approved", "supersede")
    expect(superseded).toBe("superseded")
  })
})
