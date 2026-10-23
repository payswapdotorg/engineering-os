/**
 * scripts/dev-seed-plan.ts — Slice-11 test-only fixture (agent-planning-
 * contract §7.3): inserts ONE proposed AgentPlan row directly through Prisma.
 *
 * WHY this seam exists (recorded honestly): a proposed plan can normally only
 * come from the REAL LLM round trip (POST /api/projects/[id]/plans), which is
 * exactly the point of the slice — no fake path to a proposal. The CONTRACT
 * surface of the plans API (decision flow, 409/422 envelopes, isolation,
 * accept→draft wiring) must however stay e2e-tested in environments WITHOUT
 * an LLM (the CI runners — engine-harness skip precedent). This script is the
 * deliberate, documented seam: it seeds a proposed row whose definition went
 * through the REAL parseWorkflowDefinition (canonical, defaults filled) and
 * wires the artifact id the caller passes, so every downstream API path runs
 * 100% real code. Part B of scripts/e2e-p7-planner.sh exercises the LIVE LLM
 * path and is skipped honestly where no LLM exists.
 *
 * The seeded intent is always prefixed "[e2e fixture]" so a seeded row can
 * never masquerade as a planner proposal in the UI, the ledger or forensics.
 *
 * Usage (from the repo root):
 *   bun scripts/dev-seed-plan.ts <projectId> <artifactId> [status] [shape]
 *     status defaults to "proposed"; only "proposed"|"failed" are accepted
 *       (accepted/rejected are HUMAN-decision outcomes — this script can never
 *       mint them, by design).
 *     shape defaults to "qa" (the canonical 3-step Model QA pipeline — the
 *       contract §2 worked example); "report" seeds the DETERMINISTIC single
 *       build_report step (gated on approval, no engine subprocess — the p6
 *       precedent) that the e2e accept-path drives to `succeeded`.
 *
 * Prints JSON { plan: { id, status, projectId, intent } } on success.
 */
import { parseWorkflowDefinition } from "../src/core/workflow"
import { db } from "../src/lib/db"
import { newId } from "../src/lib/ids"

const args = process.argv.slice(2)
if (args.length < 2) {
  console.error("usage: bun scripts/dev-seed-plan.ts <projectId> <artifactId> [status] [shape]")
  process.exit(2)
}
const projectId = args[0]
const artifactId = args[1]
const status = args[2] ?? "proposed"
const shape = args[3] ?? "qa"

if (status !== "proposed" && status !== "failed") {
  console.error(`dev-seed-plan: status must be "proposed" or "failed" (got "${status}")`)
  process.exit(2)
}
if (shape !== "qa" && shape !== "report") {
  console.error(`dev-seed-plan: shape must be "qa" or "report" (got "${shape}")`)
  process.exit(2)
}

const project = await db.project.findUnique({ where: { id: projectId }, select: { id: true, name: true } })
if (!project) {
  console.error(`dev-seed-plan: project ${projectId} not found`)
  process.exit(1)
}
const artifact = await db.artifact.findUnique({ where: { id: artifactId }, select: { id: true, name: true } })
if (!artifact || artifact.id === "") {
  console.error(`dev-seed-plan: artifact ${artifactId} not found`)
  process.exit(1)
}

// The canonical Model-QA-pipeline shape (contract §2 worked example), wired to
// the REAL artifact id and run through the REAL canonical parser — defaults
// filled, placeholders impossible. The "report" shape is the DETERMINISTIC
// single build_report step (gated on approval, no engine subprocess).
const qaSteps = [
  {
    id: "quantities",
    operation: "derive_quantities",
    inputs: { artifactId },
    parameters: {},
    retry: { maxAttempts: 2, backoffMs: 400 },
    requiresApproval: false,
    skipOnError: false,
  },
  {
    id: "mesh",
    operation: "derive_mesh",
    inputs: { artifactId },
    parameters: {},
    retry: { maxAttempts: 1, backoffMs: 0 },
    requiresApproval: false,
    skipOnError: false,
  },
  {
    id: "report",
    operation: "build_report",
    inputs: { artifactIds: [artifactId, artifactId] },
    parameters: { title: "Model QA report" },
    retry: { maxAttempts: 1, backoffMs: 0 },
    requiresApproval: true,
    skipOnError: false,
  },
]
const reportSteps = [
  {
    id: "report",
    operation: "build_report",
    inputs: { artifactIds: [artifactId] },
    parameters: { title: "Seeded report" },
    retry: { maxAttempts: 1, backoffMs: 0 },
    requiresApproval: true,
    skipOnError: false,
  },
]
const raw = { steps: shape === "report" ? reportSteps : qaSteps }

const parsed = parseWorkflowDefinition(raw)
if (!parsed.ok) {
  // Impossible by construction (the shape is pinned); honest exit if it ever
  // fires — a fixture that does not validate is never seeded.
  console.error(`dev-seed-plan: fixture definition failed validation: ${parsed.error}`)
  process.exit(1)
}

const intent = `[e2e fixture] Model QA pipeline on ${artifact.name} (seeded plan — not a real LLM proposal)`
const planColumn =
  status === "proposed"
    ? JSON.stringify({
        rationale: `Seeded fixture: run the ${shape === "report" ? "report build" : "Model QA pipeline (quantities + mesh, then a human-gated report)"} on '${artifact.name}'.`,
        assumptions: ["Seeded by dev-seed-plan.ts — replace by regenerating with the live planner"],
        definition: parsed.value,
      })
    : null

const plan = await db.agentPlan.create({
  data: {
    id: newId("pln"),
    projectId,
    intent,
    status,
    plan: planColumn,
    evidence:
      status === "proposed"
        ? JSON.stringify({ rawResponse: "seeded-fixture (no LLM ran)", durationMs: 0, attempts: 0 })
        : JSON.stringify({ rawResponse: "seeded-fixture (no LLM ran)", durationMs: 0, attempts: 1 }),
    failure:
      status === "failed"
        ? JSON.stringify({ stage: "llm", error: "seeded-fixture failure", at: new Date().toISOString() })
        : null,
  },
  select: { id: true, status: true, projectId: true, intent: true },
})

console.log(JSON.stringify({ plan }))
