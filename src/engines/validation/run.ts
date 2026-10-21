/**
 * Engineering OS — engine validation harness CLI (Worker 2 lane, W2-c).
 *
 * Usage: bun run validate:engines   (package.json script: bun src/engines/validation/run.ts)
 *
 * Runs the REAL-bridge harness over the committed corpus manifest, writes the
 * machine report (tests/validation/report.json) and regenerates the human
 * evidence doc (docs/02-engines/validation-report.md), prints a per-case
 * summary to stdout, and exits:
 *   - exit 1 on ANY failed case,
 *   - exit 0 otherwise — including an all-skip run, which is honestly marked
 *     NOT RUN (a skipped case with its reason is evidence; a fake result is not).
 */

import { runHarness } from "./harness"
import { writeReports } from "./report"

async function main(): Promise<void> {
  let report
  try {
    report = await runHarness()
  } catch (err) {
    console.error(`validate:engines: harness could not run — ${(err as Error).message}`)
    process.exitCode = 1
    return
  }

  const { reportJsonPath, reportMarkdownPath } = writeReports(report)

  console.log(`engine validation harness — ${report.ranAt}`)
  console.log(`python: ${report.pythonBin}`)
  const versions = Object.entries(report.engineVersions)
    .map(([k, v]) => `${k} ${v ?? "(no successful run)"}`)
    .join(", ")
  console.log(`engines: ${versions}`)
  console.log("")
  for (const c of report.cases) {
    const head = `${c.status.toUpperCase().padEnd(4)} ${c.caseId} [${c.adapter}] ${c.fixture}`
    if (c.status === "skip") {
      console.log(`${head} — ${c.skipReason}`)
      continue
    }
    const parts: string[] = []
    if (c.expect === "success") {
      parts.push(`determinism=${c.determinism ? "true" : "FALSE"}`)
      parts.push(`quantities ${c.quantityCount}/${c.groundTruthCount}`)
      if (c.comparisons) {
        const rels = c.comparisons
          .filter((x) => x.observedRelError !== null)
          .map((x) => x.observedRelError as number)
        if (rels.length > 0) {
          parts.push(`max observed rel error ${Math.max(...rels).toExponential(3)}`)
        } else {
          parts.push("all comparisons bitwise-exact")
        }
      }
    } else if (c.status === "pass") {
      parts.push(`threw: ${c.errorObserved ?? ""}`)
    }
    console.log(`${head} — ${parts.join(" · ")}`)
    for (const p of c.problems) {
      console.log(`       problem: ${p}`)
    }
  }
  const s = report.summary
  console.log("")
  console.log(
    `summary: ${s.total} cases — ${s.pass} pass / ${s.fail} fail / ${s.skip} skip${s.note ? ` — ${s.note}` : ""}`,
  )
  console.log(`machine report: ${reportJsonPath}`)
  console.log(`evidence doc:   ${reportMarkdownPath}`)

  process.exitCode = s.fail > 0 ? 1 : 0
}

void main()
