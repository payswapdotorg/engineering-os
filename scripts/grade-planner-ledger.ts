/**
 * scripts/grade-planner-ledger.ts — the runner half of the planner
 * prompt-quality iteration protocol (Slice 17, roadmap-gap-audit §7.2:
 * "pull the persisted AgentPlan evidence ledger → grade a rubric …" — the
 * RUBRIC lives in the pure core src/core/planner-grade.ts, unit-pinned).
 *
 * Pulls EVERY AgentPlan row (the persistent planning ledger: every planner
 * attempt — proposed, accepted, rejected or failed), projects it to the
 * grader's row shape, runs the rubric, and prints:
 *   - one verdict line per row (CLEAN <id> <status> | INVALID <id> <status> + issues)
 *   - the by-status summary + the fixture count (the [e2e fixture] seam rows)
 *   - the PROTOCOL VERDICT line: "planner-ledger: N clean / M invalid"
 * Exit code: 0 when every row is clean, 1 when any row is invalid (so CI or
 * a session loop can gate on it).
 *
 * Usage (repo root): bun scripts/grade-planner-ledger.ts [--json]
 */

import { db } from "../src/lib/db"
import { gradePlanLedger, type PlanRowForGrading } from "../src/core/planner-grade"

async function main() {
  const rows = await db.agentPlan.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      intent: true,
      status: true,
      plan: true,
      evidence: true,
      failure: true,
      createdAt: true,
    },
  })

  const forGrading: PlanRowForGrading[] = rows.map((row) => ({
    id: row.id,
    intent: row.intent,
    status: row.status,
    plan: row.plan,
    evidence: row.evidence,
    failure: row.failure,
    createdAt: row.createdAt.toISOString(),
  }))

  const result = gradePlanLedger(forGrading)

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    for (const grade of result.grades) {
      const row = rows.find((r) => r.id === grade.rowId)
      const head = `${grade.verdict === "clean" ? "CLEAN " : "INVALID"} ${grade.rowId} [${row?.status ?? "?"}]${grade.isFixture ? " (fixture)" : ""}`
      if (grade.verdict === "clean") {
        console.log(head)
      } else {
        console.log(head)
        for (const issue of grade.issues) console.log(`    - ${issue}`)
      }
    }
    const s = result.summary
    console.log("")
    console.log(
      `planner-ledger: ${s.graded} rows graded — ${s.clean} clean / ${s.invalid} invalid ` +
        `(${s.fixtures} fixture-seam rows; by status: ${Object.entries(s.byStatus)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")})`,
    )
  }

  await db.$disconnect()
  process.exit(result.summary.invalid === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error("grade-planner-ledger failed:", err)
  process.exit(1)
})
