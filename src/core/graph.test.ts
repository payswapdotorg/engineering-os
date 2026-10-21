/**
 * Worker 3 lane — graph semantics tests (Journey G: change impact).
 *
 * Pin the hardened contract of `computeImpact` and `describeImpact` from
 * src/core/index.ts. Node names are abstract (A, B, C, …) because the
 * functions are pure graph logic; relation semantics come from
 * docs/03-data/artifact-graph-schema.md.
 */

/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test"
import {
  computeImpact,
  describeImpact,
  type GraphEdge,
  type RelationType,
} from "./index"

const edge = (from: string, to: string, relation: RelationType): GraphEdge => ({
  from,
  to,
  relation,
})

describe("computeImpact", () => {
  test("(a) direct edge: A derived_from B, change [B] → affected [A] with path [B, A]", () => {
    const edges = [edge("A", "B", "derived_from")]
    const result = computeImpact(["B"], edges)
    expect(result.affected).toEqual(["A"])
    expect(result.paths["A"]).toEqual(["B", "A"])
  })

  test("(b) transitive chain: A←B←C, change [C] → affected [B, A], paths [C,B] and [C,B,A]", () => {
    const edges = [edge("A", "B", "derived_from"), edge("B", "C", "derived_from")]
    const result = computeImpact(["C"], edges)
    expect(result.affected).toEqual(["B", "A"])
    expect(result.paths["B"]).toEqual(["C", "B"])
    expect(result.paths["A"]).toEqual(["C", "B", "A"])
  })

  test("(c) diamond: B←D, C←D, A←B, A←C, change [D] → affected {B, C, A}, A appears once", () => {
    const edges = [
      edge("A", "B", "derived_from"),
      edge("A", "C", "derived_from"),
      edge("B", "D", "depends_on"),
      edge("C", "D", "depends_on"),
    ]
    const result = computeImpact(["D"], edges)
    expect(result.affected.length).toBe(3)
    expect([...result.affected].sort()).toEqual(["A", "B", "C"])
    // A was pulled in via the FIRST-found shortest path (B side, BFS order)
    expect(result.paths["A"]).toEqual(["D", "B", "A"])
    expect(result.paths["B"]).toEqual(["D", "B"])
    expect(result.paths["C"]).toEqual(["D", "C"])
  })

  test("(d) cycle: A depends_on B, B depends_on A — dead root affects nothing; root A affects [B] only", () => {
    const edges = [edge("A", "B", "depends_on"), edge("B", "A", "depends_on")]
    // C has no incoming impact edges at all
    expect(computeImpact(["C"], edges).affected).toEqual([])
    // A is the changed root: B is affected, the cycle back to A stops there
    const result = computeImpact(["A"], edges)
    expect(result.affected).toEqual(["B"])
    expect(result.paths["B"]).toEqual(["A", "B"])
    // symmetric direction
    expect(computeImpact(["B"], edges).affected).toEqual(["A"])
  })

  test("(d′) self-loops are ignored and never break the walk", () => {
    const edges = [
      edge("A", "A", "derived_from"), // self-loop on a downstream node
      edge("B", "A", "depends_on"),
      edge("B", "B", "quantifies"), // self-loop on the pulled-in node
      edge("X", "X", "supersedes"),
    ]
    const result = computeImpact(["A"], edges)
    expect(result.affected).toEqual(["B"])
    expect(result.paths["B"]).toEqual(["A", "B"])
  })

  test("(e) supersedes never propagates: A supersedes B, change [B] → affected []", () => {
    expect(computeImpact(["B"], [edge("A", "B", "supersedes")]).affected).toEqual([])
  })

  test("(e′) no propagation THROUGH a non-impact relation either", () => {
    // A is affected by the change of B, but X merely supersedes A — X stays out
    const edges = [edge("A", "B", "derived_from"), edge("X", "A", "supersedes")]
    const result = computeImpact(["B"], edges)
    expect(result.affected).toEqual(["A"])
    expect(result.paths).toEqual({ A: ["B", "A"] })
  })

  test("(f) approved_by and scheduled_as are excluded from impact", () => {
    const edges = [edge("A", "B", "approved_by"), edge("C", "B", "scheduled_as")]
    const result = computeImpact(["B"], edges)
    expect(result.affected).toEqual([])
    expect(result.paths).toEqual({})
  })

  test("(g) multiple roots: union of both impact sets, each with its own root evidence", () => {
    const edges = [
      edge("A", "B", "derived_from"),
      edge("C", "D", "depends_on"),
      edge("E", "B", "quantifies"),
    ]
    const result = computeImpact(["B", "D"], edges)
    expect([...result.affected].sort()).toEqual(["A", "C", "E"])
    expect(result.paths["A"]).toEqual(["B", "A"])
    expect(result.paths["C"]).toEqual(["D", "C"])
    expect(result.paths["E"]).toEqual(["B", "E"])
  })

  test("(g′) node reachable from two roots appears once, evidence from the first root", () => {
    const edges = [edge("A", "R1", "derived_from"), edge("A", "R2", "analyzes")]
    const result = computeImpact(["R1", "R2"], edges)
    expect(result.affected).toEqual(["A"])
    expect(result.paths["A"]).toEqual(["R1", "A"])
  })

  test("(g″) duplicate roots are collapsed", () => {
    const edges = [edge("A", "B", "derived_from")]
    const result = computeImpact(["B", "B", "B"], edges)
    expect(result.affected).toEqual(["A"])
    expect(result.paths["A"]).toEqual(["B", "A"])
  })

  test("(h) roots never appear in affected even when edges point at them", () => {
    // B and C both changed; A derived_from B would be affected, but A is also a
    // root here — and B→C points at a root. Neither may show up as affected.
    const edges = [edge("A", "B", "derived_from"), edge("B", "C", "derived_from")]
    const result = computeImpact(["B", "C"], edges)
    expect(result.affected).toEqual(["A"])
    expect(result.affected).not.toContain("B")
    expect(result.affected).not.toContain("C")
  })

  test("hardening: malformed edges (empty endpoints) are skipped, not fatal", () => {
    const edges = [
      edge("A", "B", "derived_from"),
      edge("", "B", "derived_from"), // no source node
      edge("C", "", "depends_on"), // no target node
    ]
    const result = computeImpact(["B"], edges)
    expect(result.affected).toEqual(["A"])
  })

  test("all five impact relations propagate; the three non-impact ones never do", () => {
    const impactRelations: RelationType[] = [
      "derived_from",
      "analyzes",
      "quantifies",
      "validates",
      "depends_on",
    ]
    for (const relation of impactRelations) {
      expect(computeImpact(["B"], [edge("A", "B", relation)]).affected).toEqual(["A"])
    }
    for (const relation of ["supersedes", "scheduled_as", "approved_by"] as RelationType[]) {
      expect(computeImpact(["B"], [edge("A", "B", relation)]).affected).toEqual([])
    }
  })
})

describe("describeImpact", () => {
  test("via records the relation of the final edge that pulled each node in", () => {
    const edges = [
      edge("A", "B", "derived_from"), // A pulled in while visiting B
      edge("A", "C", "analyzes"), // second, longer path to A — must not win
      edge("B", "D", "depends_on"),
      edge("C", "D", "validates"),
    ]
    const d = describeImpact(["D"], edges)
    expect(d.affected).toEqual(["B", "C", "A"])
    expect(d.via["B"]).toBe("depends_on") // B→D edge
    expect(d.via["C"]).toBe("validates") // C→D edge
    expect(d.via["A"]).toBe("derived_from") // A→B edge (first-found path)
    // the losing path's relation (analyzes, via C) must not appear
    expect(d.via["A"]).not.toBe("analyzes")
    expect(d.paths["A"]).toEqual(["D", "B", "A"])
  })

  test("via stays empty when nothing is affected and excludes non-impact edges", () => {
    const edges = [edge("A", "B", "supersedes"), edge("C", "B", "quantifies")]
    const d = describeImpact(["B"], edges)
    expect(d.affected).toEqual(["C"])
    expect(d.via).toEqual({ C: "quantifies" })
    expect(d.via["A"]).toBeUndefined()
  })

  test("via keys are exactly the affected nodes; roots and unaffected nodes absent", () => {
    const edges = [
      edge("A", "R1", "derived_from"),
      edge("B", "A", "depends_on"),
      edge("X", "R2", "approved_by"), // R2 root, but approved_by never propagates
    ]
    const d = describeImpact(["R1", "R2"], edges)
    expect(Object.keys(d.via).sort()).toEqual(["A", "B"])
    expect(d.via["A"]).toBe("derived_from")
    expect(d.via["B"]).toBe("depends_on")
  })

  test("describeImpact agrees with computeImpact on affected and paths", () => {
    const edges = [
      edge("A", "B", "derived_from"),
      edge("B", "C", "depends_on"),
      edge("X", "B", "supersedes"),
      edge("A", "Z", "validates"),
    ]
    const roots = ["C", "Z"]
    const plain = computeImpact(roots, edges)
    const described = describeImpact(roots, edges)
    expect(described.affected).toEqual(plain.affected)
    expect(described.paths).toEqual(plain.paths)
  })
})
