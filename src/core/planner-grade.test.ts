/**
 * Slice 17 — planner-evidence grading rubric tests (the prompt-quality
 * iteration protocol's grading half; runner = scripts/grade-planner-ledger.ts,
 * rubric = src/core/planner-grade.ts). Pure only: no DB, no LLM (ADR-0002).
 *
 * Pins the three rubric dimensions from roadmap-gap-audit §7.2 with real
 * shapes on both sides of every rule:
 *  - definition validity: canonical plan shape + parseWorkflowDefinition
 *    re-parse (a stored definition that no longer parses is INVALID, e.g.
 *    serialization drift or a schema change the ledger did not follow)
 *  - refusal honesty: failed rows carry {stage: llm|validation, error, at}
 *    verbatim — a swallowed failure is a grading failure
 *  - evidence presence: non-fixture proposed rows carry evidence.rawResponse
 *    (the LLM's verbatim transcript); fixture rows ([e2e fixture] seam,
 *    contract §7.3) are exempt — the seam working as documented
 * Plus: status-vocabulary enforcement, the summary arithmetic, and the
 * exit-relevant verdict aggregation.
 */

/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test"

import { gradePlanLedger, gradePlanRow, type PlanRowForGrading } from "./planner-grade"

/** The canonical 1-step build_report definition (the e2e-precedent shape). */
const CANONICAL_DEFINITION = {
  steps: [
    {
      id: "report",
      operation: "build_report",
      inputs: { artifactIds: ["art_x"] },
      requiresApproval: true,
    },
  ],
}

function row(overrides: Partial<PlanRowForGrading> = {}): PlanRowForGrading {
  return {
    id: "plan_row1",
    intent: "Build a QA report from the model",
    status: "proposed",
    plan: JSON.stringify({
      rationale: "one step, gated on approval",
      assumptions: ["the model revision is the one to review"],
      definition: CANONICAL_DEFINITION,
    }),
    evidence: JSON.stringify({ rawResponse: "{\"rationale\": \"…\"}", durationMs: 1200, attempts: 1 }),
    failure: null,
    createdAt: "2026-10-25T12:00:00.000Z",
    ...overrides,
  }
}

describe("gradePlanRow — the three rubric dimensions", () => {
  test("a clean proposed row: canonical shape + valid definition + raw evidence", () => {
    const g = gradePlanRow(row())
    expect(g.verdict).toBe("clean")
    expect(g.issues).toEqual([])
    expect(g.checks).toEqual({
      statusVocabulary: true,
      planShape: true,
      definitionValid: true,
      failureHonesty: null,
      evidenceRawResponse: true,
    })
  })

  test("DEFINITION VALIDITY: a definition that no longer parses → invalid (drift caught)", () => {
    const g = gradePlanRow(
      row({
        plan: JSON.stringify({ rationale: "r", assumptions: [], definition: { steps: [{ id: "x", op: "not_an_op" }] } }),
      }),
    )
    expect(g.verdict).toBe("invalid")
    expect(g.checks.definitionValid).toBe(false)
    expect(g.issues.length).toBeGreaterThan(0)
  })

  test("plan-shape drift (missing assumptions key) → invalid with the named issue", () => {
    const g = gradePlanRow(
      row({ plan: JSON.stringify({ rationale: "r", definition: CANONICAL_DEFINITION }) }),
    )
    expect(g.verdict).toBe("invalid")
    expect(g.checks.planShape).toBe(false)
    expect(g.issues.some((issue) => issue.includes("canonical"))).toBe(true)
  })

  test("plan JSON that does not parse at all → invalid on both shape and definition", () => {
    const g = gradePlanRow(row({ plan: "{not-json" }))
    expect(g.verdict).toBe("invalid")
    expect(g.checks.planShape).toBe(false)
  })

  test("REFUSAL HONESTY: a failed row with verbatim {stage, error, at} grades clean on that dimension", () => {
    const g = gradePlanRow(
      row({
        status: "failed",
        plan: null,
        failure: JSON.stringify({ stage: "llm", error: "AI planner call failed: timeout", at: "2026-10-25T12:00:00.000Z" }),
      }),
    )
    expect(g.verdict).toBe("clean")
    expect(g.checks.failureHonesty).toBe(true)
    expect(g.checks.planShape).toBeNull()
    expect(g.checks.evidenceRawResponse).toBeNull()
  })

  test("REFUSAL HONESTY: a failed row with a swallowed (empty) error → invalid", () => {
    const g = gradePlanRow(
      row({
        status: "failed",
        plan: null,
        failure: JSON.stringify({ stage: "llm", error: "", at: "2026-10-25T12:00:00.000Z" }),
      }),
    )
    expect(g.verdict).toBe("invalid")
    expect(g.checks.failureHonesty).toBe(false)
  })

  test("REFUSAL HONESTY: a failed row with an out-of-vocabulary stage → invalid", () => {
    const g = gradePlanRow(
      row({
        status: "failed",
        plan: null,
        failure: JSON.stringify({ stage: "mystery", error: "something", at: "2026-10-25T12:00:00.000Z" }),
      }),
    )
    expect(g.verdict).toBe("invalid")
    expect(g.checks.failureHonesty).toBe(false)
  })

  test("a failed row with NO failure record at all → invalid (the honest refusal is missing)", () => {
    const g = gradePlanRow(row({ status: "failed", plan: null, failure: null }))
    expect(g.verdict).toBe("invalid")
    expect(g.checks.failureHonesty).toBe(false)
  })

  test("EVIDENCE PRESENCE: a non-fixture proposed row without rawResponse → invalid", () => {
    const g = gradePlanRow(row({ evidence: JSON.stringify({ durationMs: 800, attempts: 2 }) }))
    expect(g.verdict).toBe("invalid")
    expect(g.checks.evidenceRawResponse).toBe(false)
  })

  test("EVIDENCE PRESENCE: a whitespace-only rawResponse → invalid (never a blank success)", () => {
    const g = gradePlanRow(row({ evidence: JSON.stringify({ rawResponse: "   ", attempts: 1 }) }))
    expect(g.verdict).toBe("invalid")
    expect(g.checks.evidenceRawResponse).toBe(false)
  })

  test("the [e2e fixture] seam is exempt from the evidence rule — the documented contract §7.3 row", () => {
    const g = gradePlanRow(
      row({
        intent: "[e2e fixture] seeded proposed plan (Model QA pipeline)",
        evidence: null,
      }),
    )
    expect(g.isFixture).toBe(true)
    expect(g.verdict).toBe("clean")
    expect(g.checks.evidenceRawResponse).toBeNull()
  })

  test("status outside the vocabulary → invalid regardless of payload", () => {
    const g = gradePlanRow(row({ status: "maybe" }))
    expect(g.verdict).toBe("invalid")
    expect(g.checks.statusVocabulary).toBe(false)
  })

  test("an ACCEPTED row grades on definition validity too (the stored plan is the executed one)", () => {
    const g = gradePlanRow(row({ status: "accepted" }))
    expect(g.verdict).toBe("clean")
    expect(g.checks.definitionValid).toBe(true)
  })
})

describe("gradePlanLedger — the summary arithmetic", () => {
  test("empty ledger grades 0/0 clean", () => {
    const r = gradePlanLedger([])
    expect(r.summary).toEqual({ graded: 0, clean: 0, invalid: 0, fixtures: 0, byStatus: {} })
  })

  test("mixed ledger: clean/invalid/fixtures/byStatus all exact", () => {
    const r = gradePlanLedger([
      row({ id: "a", status: "proposed" }),
      row({ id: "b", status: "accepted" }),
      row({ id: "c", status: "failed", plan: null, failure: JSON.stringify({ stage: "validation", error: "invalid workflow definition: …", at: "2026-10-25T12:00:00.000Z" }) }),
      row({ id: "d", intent: "[e2e fixture] seeded", evidence: null }),
      row({ id: "e", status: "rejected" }),
      row({ id: "f", plan: "not-json" }),
    ])
    expect(r.summary.graded).toBe(6)
    expect(r.summary.clean).toBe(5)
    expect(r.summary.invalid).toBe(1)
    expect(r.summary.fixtures).toBe(1)
    expect(r.summary.byStatus).toEqual({ proposed: 3, accepted: 1, failed: 1, rejected: 1 })
  })
})
