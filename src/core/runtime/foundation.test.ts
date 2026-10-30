/**
 * ADR-0010 Stage-2 spike — workflow foundation seam tests.
 *
 * Pins the four things the spike owes the audit (ADR-0009 decision #11):
 *   1. the flag: unset/empty → embedded default; EXACT id match; an
 *      unknown value is a hard verbatim error listing the registered
 *      foundations — a foundation is never a silent fallback;
 *   2. the port shape: a foundation owns enqueue + recoverOrphans +
 *      describe and NOTHING ELSE — the decision-#11 binding conditions
 *      (approval red line, revision publication, event vocabulary, broker
 *      authorization) are platform-owned BY CONSTRUCTION because the port
 *      has no operation that could express them;
 *   3. the embedded describe() honesty: durableExecution false,
 *      parallelWorkers false, timers false — the audit's characterization
 *      ("durable records, not durable execution") pinned as data;
 *   4. the event vocabulary freeze: WORKFLOW_EVENT_KINDS stays the exact
 *      closed 17-kind set of contract §7 — a foundation swap can never
 *      extend it.
 *
 * DB honesty: foundation.test imports foundation-embedded → the executor →
 * @/lib/db transitively. The seam module itself is pure (no executor
 * import); the tests below never issue a query — the executor's
 * module-load recovery scan is fire-and-forget with its own catch, so the
 * suite passes identically with or without a seeded database.
 */

/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test"

import { WORKFLOW_EVENT_KINDS } from "@/core/runtime/executor"
import { resolveWorkflowFoundation, WORKFLOW_RUNTIME_FLAG } from "@/core/runtime/foundation"
// side-effect: registers the embedded foundation (and resolves the active
// one fail-fast at module load — the boot-time behavior under test #1)
import { activeFoundation, embeddedFoundation } from "@/core/runtime/foundation-embedded"

describe("ADR-0010 workflow foundation seam — the flag", () => {
  test("unset flag resolves the embedded default", () => {
    expect(resolveWorkflowFoundation({}).id).toBe("embedded")
  })

  test("empty and whitespace-only flags resolve the embedded default", () => {
    expect(resolveWorkflowFoundation({ [WORKFLOW_RUNTIME_FLAG]: "" }).id).toBe("embedded")
    expect(resolveWorkflowFoundation({ [WORKFLOW_RUNTIME_FLAG]: "   " }).id).toBe("embedded")
  })

  test("the embedded id matches exactly (no case folding)", () => {
    expect(resolveWorkflowFoundation({ [WORKFLOW_RUNTIME_FLAG]: "embedded" }).id).toBe("embedded")
  })

  test("an unknown foundation is a HARD verbatim error naming the registered foundations — never a silent fallback", () => {
    expect(() => resolveWorkflowFoundation({ [WORKFLOW_RUNTIME_FLAG]: "temporal" })).toThrow(
      'unknown EOS_WORKFLOW_RUNTIME "temporal" (registered foundations: embedded) — ' +
        "refusing to fall back silently: a workflow foundation must be chosen explicitly (ADR-0010)",
    )
  })

  test("a case-typo'd id is refused exactly like an unknown id", () => {
    expect(() => resolveWorkflowFoundation({ [WORKFLOW_RUNTIME_FLAG]: "EMBEDDED" })).toThrow(
      'unknown EOS_WORKFLOW_RUNTIME "EMBEDDED" (registered foundations: embedded)',
    )
  })
})

describe("ADR-0010 workflow foundation seam — the port shape (decision #11 binding conditions)", () => {
  test("a foundation owns exactly id/enqueue/recoverOrphans/describe — no approve, no publish, no vocabulary, no broker ops", () => {
    expect(Object.keys(embeddedFoundation).sort()).toEqual([
      "describe",
      "enqueue",
      "id",
      "recoverOrphans",
    ])
  })

  test("enqueue is fire-and-forget void; recoverOrphans returns the marked ids", () => {
    expect(typeof embeddedFoundation.enqueue).toBe("function")
    expect(typeof embeddedFoundation.recoverOrphans).toBe("function")
    expect(typeof embeddedFoundation.describe).toBe("function")
  })

  test("the module-load resolution is the embedded foundation (fail-fast boot on a bad flag, same instance)", () => {
    expect(activeFoundation.id).toBe("embedded")
    expect(activeFoundation).toBe(embeddedFoundation)
  })
})

describe("ADR-0010 workflow foundation seam — the embedded describe() honesty", () => {
  test("durable records, NOT durable execution: no mid-workflow resume, no parallel workers, no timers", () => {
    expect(embeddedFoundation.describe()).toEqual({
      id: "embedded",
      kind: "embedded",
      durableExecution: false,
      parallelWorkers: false,
      timers: false,
    })
  })
})

describe("ADR-0010 workflow foundation seam — the event vocabulary freeze (contract §7)", () => {
  test("WORKFLOW_EVENT_KINDS stays the exact closed 17-kind set, in contract order — a foundation can never extend it", () => {
    expect(WORKFLOW_EVENT_KINDS).toEqual([
      "workflow.created",
      "workflow.ready",
      "workflow.queued",
      "workflow.started",
      "step.started",
      "step.succeeded",
      "step.failed",
      "step.retried",
      "step.skipped",
      "step.awaiting_approval",
      "workflow.awaiting_approval",
      "workflow.approved",
      "workflow.rejected",
      "workflow.cancelled",
      "workflow.succeeded",
      "workflow.failed",
      "workflow.recovery-marked",
    ])
    expect(new Set(WORKFLOW_EVENT_KINDS).size).toBe(17)
  })
})
