/**
 * W3-f lane — CPM platform-core tests (Phase 5, contract §6).
 *
 * Every fixture below is HAND-DERIVED (derivation shown in comments) and pins
 * the exact expected ES/EF/LS/LF/totalFloat values, the critical path in
 * topological order, the project duration, the §3.1 verbatim error messages
 * and the deterministic behaviour (input-order independence, pinned output
 * key order). Pure only: no DB, no engines (ADR-0002).
 */

/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test"

import { analyzeCpm, type CpmActivity } from "./cpm"

/** Shorthand fixture builder: [id, duration, predecessors]. */
function act(id: string, durationDays: number, predecessorIds: string[] = []): CpmActivity {
  return { id, name: id.toUpperCase(), durationDays, predecessorIds }
}

// ---------------------------------------------------------------------------
// (a) The classic diamond graph with the D→F→E dependency
// ---------------------------------------------------------------------------

describe("analyzeCpm — classic diamond A→C→E / B→D→F→E (hand-derived)", () => {
  // Fixture (contract §6): A(3), B(2), C(4), D(5), E(3), F(1) with
  //   A→C, B→D, C→E, D→F, F→E  (E waits for BOTH C and F).
  //
  // Forward pass (es = max(ef of preds), ef = es + duration):
  //   A: es 0  ef 3          B: es 0  ef 2
  //   C: es 3  ef 7           D: es 2  ef 7
  //   F: es 7  ef 8           E: es max(ef C=7, ef F=8) = 8, ef 11
  //   project finish = 11
  // Backward pass (lf = min(ls of succs), terminal lf = 11; ls = lf − duration):
  //   E: lf 11 ls 8           F: lf 8 (ls E) ls 7
  //   C: lf 8 (ls E) ls 4     D: lf 7 (ls F) ls 2
  //   A: lf 4 (ls C) ls 1     B: lf 2 (ls D) ls 0
  // Total float = ls − es:  A 1 · B 0 · C 1 · D 0 · E 0 · F 0
  // Critical (float 0): B, D, F, E → path B→D→F→E = 2+5+1+3 = 11 ✓
  const diamond: CpmActivity[] = [
    act("a", 3),
    act("b", 2),
    act("c", 4, ["a"]),
    act("d", 5, ["b"]),
    act("e", 3, ["c", "f"]),
    act("f", 1, ["d"]),
  ]

  test("pins every ES/EF/LS/LF/totalFloat value and the critical flags", () => {
    const result = analyzeCpm(diamond)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.activities).toEqual([
      { id: "a", name: "A", durationDays: 3, es: 0, ef: 3, ls: 1, lf: 4, totalFloat: 1, critical: false },
      { id: "b", name: "B", durationDays: 2, es: 0, ef: 2, ls: 0, lf: 2, totalFloat: 0, critical: true },
      { id: "c", name: "C", durationDays: 4, es: 3, ef: 7, ls: 4, lf: 8, totalFloat: 1, critical: false },
      { id: "d", name: "D", durationDays: 5, es: 2, ef: 7, ls: 2, lf: 7, totalFloat: 0, critical: true },
      { id: "e", name: "E", durationDays: 3, es: 8, ef: 11, ls: 8, lf: 11, totalFloat: 0, critical: true },
      { id: "f", name: "F", durationDays: 1, es: 7, ef: 8, ls: 7, lf: 8, totalFloat: 0, critical: true },
    ])
  })

  test("criticalPath is the pinned topological order and durationDays is the finish", () => {
    const result = analyzeCpm(diamond)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.criticalPath).toEqual(["b", "d", "f", "e"])
    expect(result.value.durationDays).toBe(11)
  })

  test("keeps the INPUT array order for activities regardless of dependencies", () => {
    const scrambled: CpmActivity[] = [
      act("e", 3, ["c", "f"]),
      act("f", 1, ["d"]),
      act("a", 3),
      act("b", 2),
      act("c", 4, ["a"]),
      act("d", 5, ["b"]),
    ]
    const result = analyzeCpm(scrambled)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.activities.map((a) => a.id)).toEqual(["e", "f", "a", "b", "c", "d"])
    // Determinism: same math, same critical path, same duration.
    expect(result.value.criticalPath).toEqual(["b", "d", "f", "e"])
    expect(result.value.durationDays).toBe(11)
    const byId = new Map(result.value.activities.map((a) => [a.id, a]))
    expect(byId.get("e")).toMatchObject({ es: 8, ef: 11, ls: 8, lf: 11, totalFloat: 0 })
    expect(byId.get("a")).toMatchObject({ es: 0, ef: 3, ls: 1, lf: 4, totalFloat: 1 })
  })

  test("output objects are constructed in the pinned key order (byte-determinism support)", () => {
    const result = analyzeCpm(diamond)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(JSON.stringify(result.value.activities[0])).toBe(
      '{"id":"a","name":"A","durationDays":3,"es":0,"ef":3,"ls":1,"lf":4,"totalFloat":1,"critical":false}',
    )
  })
})

// ---------------------------------------------------------------------------
// (b) Zero-duration milestone on the critical path
// ---------------------------------------------------------------------------

describe("analyzeCpm — zero-duration milestone (hand-derived)", () => {
  // A(2) → M(0) → B(3), plus a slack branch X(1) → B:
  //   forward:  A 0→2 · M 2→2 · X 0→1 · B es max(2,1)=2 ef 5 · finish 5
  //   backward: B lf 5 ls 2 · M lf 2 (ls B) ls 2 · X lf 2 (ls B) ls 1
  //             A lf 2 (ls M) ls 0
  //   floats:   A 0 · M 0 · X 1 · B 0 → critical path A → M → B, duration 5
  const milestone: CpmActivity[] = [
    act("a", 2),
    act("m", 0, ["a"]),
    act("x", 1),
    act("b", 3, ["m", "x"]),
  ]

  test("a milestone can sit ON the critical path with es == ef == ls == lf", () => {
    const result = analyzeCpm(milestone)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const m = result.value.activities.find((a) => a.id === "m")
    expect(m).toMatchObject({
      durationDays: 0,
      es: 2,
      ef: 2,
      ls: 2,
      lf: 2,
      totalFloat: 0,
      critical: true,
    })
    expect(result.value.criticalPath).toEqual(["a", "m", "b"])
    expect(result.value.durationDays).toBe(5)
    const x = result.value.activities.find((a) => a.id === "x")
    expect(x).toMatchObject({ totalFloat: 1, critical: false })
  })
})

// ---------------------------------------------------------------------------
// (c) Cycle errors
// ---------------------------------------------------------------------------

describe("analyzeCpm — cycle errors (§3.1 verbatim)", () => {
  test("a two-activity cycle is refused naming the first array-order member", () => {
    const result = analyzeCpm([act("a", 1, ["b"]), act("b", 1, ["a"])])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('activity chain contains a cycle involving "a"')
  })

  test("reports the activity ON the cycle, never one merely downstream of it", () => {
    // a → b → a is the cycle; c merely depends on a and is NOT on it.
    const result = analyzeCpm([
      act("a", 1, ["b"]),
      act("b", 1, ["a"]),
      act("c", 1, ["a"]),
    ])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('activity chain contains a cycle involving "a"')
  })

  test("a self-referencing activity is a cycle involving itself", () => {
    const result = analyzeCpm([act("z", 1, ["z"])])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('activity chain contains a cycle involving "z"')
  })
})

// ---------------------------------------------------------------------------
// (d) Unknown-predecessor errors
// ---------------------------------------------------------------------------

describe("analyzeCpm — unknown predecessor (§3.1 verbatim)", () => {
  test("is refused with the pinned message naming activity and predecessor", () => {
    const result = analyzeCpm([act("a", 2, ["ghost"])])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('activity "a" references unknown predecessor "ghost"')
  })
})

// ---------------------------------------------------------------------------
// (e) Duplicate-id errors
// ---------------------------------------------------------------------------

describe("analyzeCpm — duplicate ids (§3.1 verbatim)", () => {
  test("is refused once per duplicated id", () => {
    const result = analyzeCpm([act("a", 2), act("a", 3), act("a", 1)])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('activity id "a" is used more than once')
  })
})

// ---------------------------------------------------------------------------
// Joined errors + structural guards
// ---------------------------------------------------------------------------

describe("analyzeCpm — joined errors and structural guards", () => {
  test("multiple problems join into ONE message with '; ' (duplicates before unknowns)", () => {
    const result = analyzeCpm([act("a", 2, ["ghost"]), act("a", 3)])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe(
      'activity id "a" is used more than once; activity "a" references unknown predecessor "ghost"',
    )
  })

  test("non-array input is refused honestly, never crashes", () => {
    const result = analyzeCpm("nope" as unknown as CpmActivity[])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain("activities must be an array")
  })

  test("a non-object entry, a bad id, a negative duration and bad predecessorIds are each refused", () => {
    const badEntry = analyzeCpm([null as unknown as CpmActivity])
    expect(badEntry.ok).toBe(false)
    if (!badEntry.ok) expect(badEntry.error).toContain("activity at index 0 must be an object")

    const badId = analyzeCpm([{ id: "", name: "X", durationDays: 1, predecessorIds: [] }])
    expect(badId.ok).toBe(false)
    if (!badId.ok) expect(badId.error).toContain("must have a non-empty id")

    const badDuration = analyzeCpm([act("a", -1)])
    expect(badDuration.ok).toBe(false)
    if (!badDuration.ok) {
      expect(badDuration.error).toContain('activity "a" durationDays must be a finite number ≥ 0')
    }

    const badPreds = analyzeCpm([
      { id: "a", name: "A", durationDays: 1, predecessorIds: "b" as unknown as string[] },
    ])
    expect(badPreds.ok).toBe(false)
    if (!badPreds.ok) {
      expect(badPreds.error).toContain('activity "a" predecessorIds must be an array of activity ids')
    }
  })
})

// ---------------------------------------------------------------------------
// (f) Single-activity graph + empty graph
// ---------------------------------------------------------------------------

describe("analyzeCpm — single activity and empty graph", () => {
  test("a lone activity is trivially critical", () => {
    // Z(5): es 0 ef 5 · lf 5 ls 0 · float 0 → critical path [z], duration 5.
    const result = analyzeCpm([act("z", 5)])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.activities).toEqual([
      { id: "z", name: "Z", durationDays: 5, es: 0, ef: 5, ls: 0, lf: 5, totalFloat: 0, critical: true },
    ])
    expect(result.value.criticalPath).toEqual(["z"])
    expect(result.value.durationDays).toBe(5)
  })

  test("an empty activity list is the trivial empty analysis (duration 0)", () => {
    const result = analyzeCpm([])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.activities).toEqual([])
    expect(result.value.criticalPath).toEqual([])
    expect(result.value.durationDays).toBe(0)
  })
})
