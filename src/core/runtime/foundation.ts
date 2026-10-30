/**
 * Engineering OS — workflow execution foundation seam (ADR-0010, the
 * ADR-0011 Stage-2 spike).
 *
 * THE PORT any durable-execution foundation must satisfy — and, more
 * important, the list of what it may NEVER own. ADR-0011 decision #11
 * binding conditions, restated as architecture: the approval RED LINE
 * (approveWorkflow, human-only actor), revision publication, the closed
 * event vocabulary (contract §7, WORKFLOW_EVENT_KINDS) and broker
 * authorization (steps call the broker in-process, ADR-0005) are
 * PLATFORM-OWNED semantics — they stay in platform code on every
 * foundation, by construction: this port has no operation that could
 * express them. A foundation owns ONLY the execution mechanics: claiming
 * queued work, step dispatch, retry scheduling and orphan recovery.
 *
 * Selection is explicit and fail-fast: EOS_WORKFLOW_RUNTIME (unset or
 * empty → "embedded"). Unlike the tuning knobs (EOS_PYTHON,
 * EOS_RECOVERY_CUTOFF_MS — invalid values fall back to the default), a
 * foundation selector must NEVER fall back silently: an operator who
 * asks for a foundation that is not registered gets a hard error naming
 * the registered ones, because silently running `embedded` while the
 * operator believes they are running the successor is an honesty
 * violation of the first order (ADR-0010 §Decision 2).
 *
 * Pure module: no DB, no executor import (ADR-0002) — the embedded
 * adapter lives in foundation-embedded.ts and registers itself here at
 * module load; unit tests of the seam never need a database.
 */

/// <reference types="bun-types" />

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

/** Honest capability declaration — what a foundation DOES and DOES NOT do. */
export interface FoundationDescription {
  id: string
  /** "embedded" = in-process platform code; "external" = a server process. */
  kind: "embedded" | "external"
  /** True only if a crashed run RESUMES mid-workflow (not recovery-mark + explicit retry). */
  durableExecution: boolean
  /** True if more than one workflow can execute at the same time. */
  parallelWorkers: boolean
  /** True if scheduled/delayed steps are supported natively. */
  timers: boolean
}

/**
 * The execution-foundation contract. Deliberately minimal: enqueue (the
 * fire-and-forget claim+run of a queued workflow — never awaited by
 * routes, contract §8) and recoverOrphans (mark interrupted `running`
 * rows failed, returning the marked ids). Everything that makes an
 * Engineering OS workflow SAFER rather than FASTER is platform-owned and
 * absent from this interface on purpose.
 */
export interface WorkflowExecutionFoundation {
  readonly id: string
  enqueue(workflowId: string): void
  recoverOrphans(): Promise<string[]>
  describe(): FoundationDescription
}

// ---------------------------------------------------------------------------
// Registry + flag resolution
// ---------------------------------------------------------------------------

/** The one flag (read once per resolve; see ADR-0010). */
export const WORKFLOW_RUNTIME_FLAG = "EOS_WORKFLOW_RUNTIME" as const

const REGISTRY = new Map<string, () => WorkflowExecutionFoundation>()

/**
 * Register a foundation under its flag id. Ids are matched EXACTLY (no
 * case folding): "EMBEDDED" is an error, not a synonym. Today only
 * "embedded" registers (foundation-embedded.ts); the designated Temporal
 * successor lane (ADR-0010 §Decision 2) registers through this same call
 * when it lands — never by editing the seam.
 */
export function registerFoundation(id: string, factory: () => WorkflowExecutionFoundation): void {
  REGISTRY.set(id, factory)
}

/**
 * Resolve the foundation from an environment (pure: injectable for tests;
 * defaults to process.env — a Record<string, string | undefined> so both
 * the real index-signature env and literal test envs fit). Unset/
 * whitespace-only flag → the "embedded" default. Unknown value → hard
 * verbatim error listing the registered foundations. Empty registry →
 * hard verbatim error (the embedded adapter module was not imported).
 * Neither failure path guesses.
 */
export function resolveWorkflowFoundation(
  env: Record<string, string | undefined> = process.env,
): WorkflowExecutionFoundation {
  const raw = (env.EOS_WORKFLOW_RUNTIME ?? "").trim()
  const id = raw === "" ? "embedded" : raw
  const factory = REGISTRY.get(id)
  if (factory) return factory()
  if (REGISTRY.size === 0) {
    throw new Error(
      'no workflow foundation registered — import "@/core/runtime/foundation-embedded" before resolving (ADR-0010)',
    )
  }
  throw new Error(
    `unknown ${WORKFLOW_RUNTIME_FLAG} "${id}" (registered foundations: ${[...REGISTRY.keys()].join(", ")}) — ` +
      "refusing to fall back silently: a workflow foundation must be chosen explicitly (ADR-0010)",
  )
}

let resolved: WorkflowExecutionFoundation | null = null

/** Memoized resolution for route code (resolves once per process). */
export function getFoundation(): WorkflowExecutionFoundation {
  resolved ??= resolveWorkflowFoundation()
  return resolved
}
