/**
 * Engineering OS — AgentPlan → PlanRow wire mapper (Slice 11,
 * agent-planning-contract §5.4).
 *
 * Server util shared by the three plans routes (Next.js forbids imports
 * across route files, so the mapper lives here — the frozen lane decision).
 * The routes load rows straight from Prisma; this module turns one row into
 * the §5.4 wire shape the frontend consumes (byte-faithful to PlanRow in
 * src/components/product/api.ts):
 *
 *  - the `plan` column ({rationale, assumptions, definition} canonical JSON)
 *    becomes the parsed rationale/assumptions/definition fields;
 *  - `stepSummary` is RECOMPUTED here via the core's `summarizePlanSteps` —
 *    REAL artifact names, never ids alone. Names come from the optional
 *    id→{name,kind} map; a missing id renders through the core's honest
 *    `'unknown artifact <id>'` fallback;
 *  - the `evidence` / `failure` columns parse to their JSON objects;
 *  - every JSON column parse is try/catch — corrupt text degrades to null
 *    with a console.error, NEVER a 500 on a read.
 *
 * The mapper is DB-only: it never re-validates a definition (validation ran
 * at creation and re-runs at accept) — it only shapes data for the wire.
 */

import type { AgentPlan } from "@prisma/client"

import { summarizePlanSteps, type PlannerArtifactContext } from "@/core/planner"
import type { WorkflowDefinition } from "@/core/workflow"
import { db } from "@/lib/db"

/** id → {name, kind}: the artifact metadata toPlanRow needs for stepSummary. */
export type ArtifactNameById = Map<string, { name: string; kind: string }>

/** PlanRow wire shape (contract §5.4, frozen; ISO strings for the dates). */
export interface PlanRow {
  id: string
  projectId: string
  /** the human's request, VERBATIM (10..2000 chars enforced at the boundary) */
  intent: string
  /** proposed|accepted|rejected|failed (§2.1; boundary-guaranteed by the writers) */
  status: "proposed" | "accepted" | "rejected" | "failed"
  /** prior plan this proposal revises; null = fresh */
  revisesPlanId: string | null
  /** planner's stated reasoning; null when failed */
  rationale: string | null
  /** planner's assumptions; null when failed */
  assumptions: string[] | null
  /** CANONICAL post-validation workflow definition; null when failed */
  definition: { steps: Array<Record<string, unknown>> } | null
  /** summarizePlanSteps lines (REAL artifact names); null when failed */
  stepSummary: string[] | null
  /** the LLM's raw text VERBATIM + call metadata (honest evidence) */
  evidence: { rawResponse?: string; durationMs?: number; attempts?: number } | null
  /** verbatim reason when status failed; null otherwise */
  failure: { stage: "llm" | "validation"; error: string; at: string } | null
  /** session user id of the human who asked (AuditEvent precedent — no FK) */
  createdById: string | null
  /** session user id of the acceptor/rejector + when (set on decision) */
  decidedById: string | null
  decidedAt: string | null
  /** draft workflow created on accept (SetNull — plans outlive workflows) */
  workflowId: string | null
  createdAt: string
}

/**
 * Loads the project's artifact id→{name,kind} map — the only artifact data a
 * read path needs (the metadata-only rule §1.2 holds here too: no content
 * columns are ever selected).
 */
export async function loadArtifactNameMap(projectId: string): Promise<ArtifactNameById> {
  const artifacts = await db.artifact.findMany({
    where: { projectId },
    select: { id: true, name: true, kind: true },
    orderBy: { createdAt: "asc" },
  })
  return new Map(artifacts.map((artifact) => [artifact.id, { name: artifact.name, kind: artifact.kind }]))
}

/** Parses a JSON column honestly: corrupt text → null + console.error, never a throw. */
function parseJsonColumn(row: AgentPlan, column: "plan" | "evidence" | "failure"): unknown {
  const text = row[column]
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch (err) {
    console.error(`[plan-row] corrupt "${column}" JSON on AgentPlan ${row.id}:`, err)
    return null
  }
}

/** Narrows a parsed column to a plain object; non-objects degrade to null (logged). */
function asRecord(value: unknown, row: AgentPlan, column: "evidence" | "failure"): Record<string, unknown> | null {
  if (value === null) return null
  if (typeof value !== "object" || Array.isArray(value)) {
    console.error(`[plan-row] "${column}" JSON on AgentPlan ${row.id} is not an object`)
    return null
  }
  return value as Record<string, unknown>
}

/** The expected `plan` column shape: {rationale, assumptions, definition}. */
interface PlanColumn {
  rationale: string
  assumptions: string[]
  definition: { steps: Array<Record<string, unknown>> }
}

/** Parses + shape-checks the plan column; anything else degrades to null (logged). */
function parsePlanColumn(row: AgentPlan): PlanColumn | null {
  const value = parseJsonColumn(row, "plan")
  if (value === null) return null
  if (typeof value !== "object" || Array.isArray(value)) {
    console.error(`[plan-row] "plan" JSON on AgentPlan ${row.id} is not an object`)
    return null
  }

  const { rationale, assumptions, definition } = value as Record<string, unknown>
  const steps = (definition as { steps?: unknown } | null)?.steps
  const shaped =
    typeof rationale === "string" &&
    Array.isArray(assumptions) &&
    assumptions.every((assumption) => typeof assumption === "string") &&
    typeof definition === "object" &&
    definition !== null &&
    Array.isArray(steps) &&
    steps.length > 0 &&
    steps.every((step) => typeof step === "object" && step !== null)

  if (!shaped) {
    console.error(`[plan-row] "plan" JSON on AgentPlan ${row.id} has an unexpected shape`)
    return null
  }

  return {
    rationale,
    assumptions,
    definition: definition as PlanColumn["definition"],
  }
}

/**
 * Maps one AgentPlan row to the §5.4 wire shape.
 *
 * `artifactNameById` (optional) carries the project's id→{name,kind} map for
 * stepSummary; when it is absent — or an id is missing from it — the summary
 * renders through the core's honest `'unknown artifact <id>'` fallback rather
 * than guessing. Failed rows have a null plan column, so their
 * rationale/assumptions/definition/stepSummary are all null.
 */
export function toPlanRow(row: AgentPlan, artifactNameById?: ArtifactNameById): PlanRow {
  const planColumn = parsePlanColumn(row)
  const evidence = asRecord(parseJsonColumn(row, "evidence"), row, "evidence")
  const failure = asRecord(parseJsonColumn(row, "failure"), row, "failure")

  let stepSummary: string[] | null = null
  if (planColumn !== null) {
    // Minimal contexts: summarizePlanSteps reads name/kind only (the
    // structural fields are placeholders the summary never renders).
    const summaryMap = new Map<string, PlannerArtifactContext>()
    for (const [id, meta] of artifactNameById ?? []) {
      summaryMap.set(id, {
        id,
        name: meta.name,
        kind: meta.kind,
        revisionCount: 0,
        latestApprovalState: "none",
        latestNote: null,
      })
    }
    try {
      // The column was stored CANONICAL (post-validation); the cast is the
      // trust boundary, and the catch keeps a hand-corrupted row from 500ing
      // a read — stepSummary degrades to null instead.
      stepSummary = summarizePlanSteps(planColumn.definition as unknown as WorkflowDefinition, summaryMap)
    } catch (err) {
      console.error(`[plan-row] stepSummary computation failed for AgentPlan ${row.id}:`, err)
      stepSummary = null
    }
  }

  return {
    id: row.id,
    projectId: row.projectId,
    intent: row.intent,
    status: row.status as PlanRow["status"],
    revisesPlanId: row.revisesPlanId,
    rationale: planColumn?.rationale ?? null,
    assumptions: planColumn?.assumptions ?? null,
    definition: planColumn?.definition ?? null,
    stepSummary,
    evidence: evidence as PlanRow["evidence"],
    failure: failure as PlanRow["failure"],
    createdById: row.createdById,
    decidedById: row.decidedById,
    decidedAt: row.decidedAt === null ? null : row.decidedAt.toISOString(),
    workflowId: row.workflowId,
    createdAt: row.createdAt.toISOString(),
  }
}
