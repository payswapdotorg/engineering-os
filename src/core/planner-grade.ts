/**
 * Planner-evidence grading core (Slice 17 — the roadmap-gap-audit §7.2
 * "planner prompt-quality iteration protocol": "pull the persisted AgentPlan
 * evidence ledger → grade a rubric over proposed/failed rows (definition
 * validity, artifact wiring correctness, refusal honesty) → iterate the
 * prompt → pin regressions in unit tests → re-run the live Part B").
 *
 * Pure TypeScript (ADR-0002): no DB, no network, no filesystem. The LEDGER
 * PULL lives in scripts/grade-planner-ledger.ts (the runner); the RUBRIC
 * lives here and is unit-pinned so the protocol's grading cannot silently
 * drift. The three rubric dimensions from the report, made exact:
 *
 *  1. DEFINITION VALIDITY — a proposed/accepted/rejected row's stored plan
 *     must be the canonical shape {rationale, assumptions, definition} and
 *     the definition must parse through the SAME parseWorkflowDefinition the
 *     route used when the row was accepted (the stored value is by
 *     construction the canonical post-validation definition — grading
 *     re-proves it, catching storage/serialization drift).
 *  2. REFUSAL HONESTY — a failed row's stored failure must carry
 *     {stage: "llm"|"validation", error, at} with a non-empty verbatim
 *     error (ADR-0008: nothing is ever swallowed — a failure row without
 *     its verbatim reason is a grading failure, not a shrug).
 *  3. EVIDENCE PRESENCE — a non-fixture proposed row must carry the LLM's
 *     raw response in evidence (the honesty-ledger contract §2). Fixture
 *     rows (intent prefixed "[e2e fixture]" — the documented seed seam,
 *     contract §7.3) are graded on validity but marked isFixture: their
 *     evidence absence is the SEAM working as documented, not a defect.
 */

import { PLAN_STATUSES, type PlanStatus } from "./planner"
import { parseWorkflowDefinition } from "./workflow"

/** One AgentPlan row as the grader sees it (the ledger pull projects this). */
export interface PlanRowForGrading {
  id: string
  intent: string
  status: string
  plan: string | null // JSON {rationale, assumptions, definition} — null when failed
  evidence: string | null // JSON {rawResponse?, durationMs?, attempts?}
  failure: string | null // JSON {stage, error, at} — verbatim reason when failed
  createdAt: string
}

/** The fixture-seam marker (contract §7.3 — dev-seed-plan.ts prefixes it). */
export const FIXTURE_INTENT_PREFIX = "[e2e fixture]"

export interface PlanGradeChecks {
  statusVocabulary: boolean
  /** null when not applicable (failed rows carry no plan). */
  planShape: boolean | null
  definitionValid: boolean | null
  /** null when not applicable (only failed rows are graded for refusal honesty). */
  failureHonesty: boolean | null
  /** null when not applicable (fixture rows are exempt — the documented seam). */
  evidenceRawResponse: boolean | null
}

export interface PlanGrade {
  rowId: string
  verdict: "clean" | "invalid"
  isFixture: boolean
  checks: PlanGradeChecks
  /** Human-readable issue lines, one per failed check (empty when clean). */
  issues: string[]
}

export interface PlanLedgerGrade {
  grades: PlanGrade[]
  summary: {
    graded: number
    clean: number
    invalid: number
    fixtures: number
    byStatus: Record<string, number>
  }
}

function parseJson(text: string | null): unknown {
  if (text === null) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** Grade ONE ledger row against the rubric (pure — mirrors no route state). */
export function gradePlanRow(row: PlanRowForGrading): PlanGrade {
  const isFixture = row.intent.trimStart().startsWith(FIXTURE_INTENT_PREFIX)
  const issues: string[] = []

  const statusVocabulary = PLAN_STATUSES.some((status) => status === row.status)
  if (!statusVocabulary) issues.push(`status "${row.status}" is outside the plan-status vocabulary`)

  let planShape: boolean | null = null
  let definitionValid: boolean | null = null
  let failureHonesty: boolean | null = null
  let evidenceRawResponse: boolean | null = null

  if (row.status === "failed") {
    // REFUSAL HONESTY: {stage, error, at}, verbatim error preserved.
    const failure = parseJson(row.failure)
    const shape =
      failure !== undefined &&
      typeof failure === "object" &&
      failure !== null &&
      "stage" in failure &&
      "error" in failure &&
      "at" in failure
    if (shape) {
      const f = failure as { stage: unknown; error: unknown; at: unknown }
      failureHonesty =
        (f.stage === "llm" || f.stage === "validation") &&
        typeof f.error === "string" &&
        f.error.length > 0 &&
        typeof f.at === "string"
    } else {
      failureHonesty = false
    }
    if (failureHonesty !== true) {
      issues.push("failed row without a verbatim {stage, error, at} refusal record (ADR-0008: never swallowed)")
    }
  } else {
    // DEFINITION VALIDITY: the canonical plan shape + the definition re-parse.
    const plan = parseJson(row.plan)
    const shape =
      plan !== undefined &&
      typeof plan === "object" &&
      plan !== null &&
      "rationale" in plan &&
      "assumptions" in plan &&
      "definition" in plan
    planShape = shape
    if (!shape) {
      issues.push("plan is not the canonical {rationale, assumptions, definition} shape")
      definitionValid = false
    } else {
      const p = plan as { definition: unknown }
      const parsed = parseWorkflowDefinition(p.definition)
      definitionValid = parsed.ok
      if (!parsed.ok) issues.push(parsed.error)
    }

    // EVIDENCE PRESENCE: the LLM's raw response rides along (honest evidence,
    // like stdout tails). Fixture rows are the documented seam — exempt.
    if (isFixture) {
      evidenceRawResponse = null
    } else {
      const evidence = parseJson(row.evidence)
      evidenceRawResponse =
        evidence !== undefined &&
        typeof evidence === "object" &&
        evidence !== null &&
        typeof (evidence as { rawResponse?: unknown }).rawResponse === "string" &&
        ((evidence as { rawResponse: string }).rawResponse.trim().length > 0)
      if (evidenceRawResponse !== true) {
        issues.push("proposed row without evidence.rawResponse (the verbatim LLM transcript is the honesty ledger)")
      }
    }
  }

  const failed =
    !statusVocabulary ||
    planShape === false ||
    definitionValid === false ||
    failureHonesty === false ||
    evidenceRawResponse === false

  return {
    rowId: row.id,
    verdict: failed ? "invalid" : "clean",
    isFixture,
    checks: { statusVocabulary, planShape, definitionValid, failureHonesty, evidenceRawResponse },
    issues,
  }
}

/** Grade a whole ledger pull — the protocol's one-pass rubric. */
export function gradePlanLedger(rows: readonly PlanRowForGrading[]): PlanLedgerGrade {
  const grades = rows.map((row) => gradePlanRow(row))
  const byStatus: Record<string, number> = {}
  for (const grade of grades) {
    const row = rows.find((r) => r.id === grade.rowId)
    const status = row?.status ?? "(missing)"
    byStatus[status] = (byStatus[status] ?? 0) + 1
  }
  return {
    grades,
    summary: {
      graded: grades.length,
      clean: grades.filter((g) => g.verdict === "clean").length,
      invalid: grades.filter((g) => g.verdict === "invalid").length,
      fixtures: grades.filter((g) => g.isFixture).length,
      byStatus,
    },
  }
}

export type { PlanStatus }
