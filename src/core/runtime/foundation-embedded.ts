/**
 * Engineering OS — the embedded workflow foundation (ADR-0010).
 *
 * Wraps the existing executor queue mechanics (src/core/runtime/executor.ts,
 * contract §8) as the default WorkflowExecutionFoundation: the 786-LOC
 * in-process serial queue — durable records, not durable execution; no
 * timers, no distributed workers, no parallelism — described honestly in
 * describe() exactly as the ADR-0011 audit characterized it. Claiming,
 * step dispatch, retry and orphan recovery delegate to the executor; the
 * platform-owned semantics (approval red line, revision publication, event
 * vocabulary, broker authorization) remain in the executor/routes and are
 * deliberately NOT part of this adapter.
 *
 * Importing this module has TWO effects, both intended:
 *   1. it registers the "embedded" foundation in the seam registry;
 *   2. it resolves the active foundation ONCE at module load — the
 *      .eos-engine-pin convention: a misconfigured EOS_WORKFLOW_RUNTIME
 *      (typo, or a foundation that is not registered on this host)
 *      surfaces at boot with the verbatim seam error, never as a silent
 *      fallback discovered on the first request.
 *
 * The successor lane (Temporal, ADR-0010 §Decision 2) ships as its own
 * adapter module registering through the same registerFoundation call;
 * this file does not change when it lands.
 */

import {
  getFoundation,
  registerFoundation,
  type WorkflowExecutionFoundation,
} from "@/core/runtime/foundation"
import { enqueueWorkflow, recoverOrphanedRuns } from "@/core/runtime/executor"

export const embeddedFoundation: WorkflowExecutionFoundation = {
  id: "embedded",
  enqueue: (workflowId) => enqueueWorkflow(workflowId),
  recoverOrphans: () => recoverOrphanedRuns(),
  describe: () => ({
    id: "embedded",
    kind: "embedded",
    durableExecution: false,
    parallelWorkers: false,
    timers: false,
  }),
}

registerFoundation("embedded", () => embeddedFoundation)

// Fail-fast boot resolution (see header): throws the verbatim seam error
// here if EOS_WORKFLOW_RUNTIME names anything unregistered.
export const activeFoundation = getFoundation()
