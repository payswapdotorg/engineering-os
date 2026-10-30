"use client"

/**
 * Agents & Automations workspace (W1-e lane, Phase 4) — workflows, approvals
 * and execution history over the pinned Phase-4 API contracts
 * (docs/00-architecture/workflow-runtime-contract.md §6/§9).
 *
 * Honesty rules this workspace follows:
 *  - every state change goes through POST /api/workflows/[id]/transition; the
 *    client never computes the state machine — 409/422 messages surface VERBATIM
 *    in toasts (the takeoff-workspace idiom);
 *  - ZERO dead buttons: actions render only in states the machine allows
 *    (contract §3); terminal states get an honest note instead of buttons;
 *  - approve/reject are human-review actions: the UI states the approver is
 *    recorded as the local human operator, and agent-created workflows carry
 *    the ADR-0006 callout — an agent can never approve (no code path, the API
 *    accepts no actor for these actions);
 *  - stdout/stderr tails, failure errors and event payloads render verbatim —
 *    never paraphrased, wrapped by CSS only;
 *  - templates come from WORKFLOW_TEMPLATES in src/core/workflow.ts (the single
 *    source of truth — no duplicated definitions here);
 *  - active runs (queued/running/awaiting_approval) poll the list (and the
 *    open detail) every ~2.5s and stop when everything is terminal;
 *  - Slice 11 (agent-planning-contract §6): the AI planner panel — the LLM
 *    PROPOSES a workflow definition from a natural-language intent and a
 *    HUMAN decides (ADR-0008); Accept creates a draft workflow authored by
 *    agent:planner-v1 that still goes review → mark-ready → queue with
 *    human-only approval gates (ADR-0006); failed runs persist as honest
 *    `failed` rows rendered with their verbatim evidence, and the plan
 *    statuses/status machine come from api.ts's local wire pin (contract
 *    §5.4) — the UI never imports src/core/planner.ts.
 */
import { Bot, ChevronDown, ChevronRight, Info, Loader2, Plus, Server, User, Wand2 } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import {
  ApiError,
  createProjectPlan,
  createProjectWorkflow,
  decidePlan,
  transitionWorkflow,
  useApi,
  type ArtifactListItem,
  type PlanRow,
  type PlanStatus,
  type WorkflowDefinition,
  type WorkflowDetail,
  type WorkflowEventRow,
  type WorkflowFailure,
  type WorkflowRow,
  type WorkflowState,
  type WorkflowStepDefinition,
  type WorkflowStepRow,
  type WorkflowStepRunState,
  type WorkflowTransitionAction,
} from "@/components/product/api"
import { ActorBadge } from "@/components/product/badges"
import { formatDate, formatDuration, relTime, shortHash } from "@/components/product/format"
import { EmptyState, ErrorState, InfoNote } from "@/components/product/parts"
import { GuardedButton } from "@/components/product/guarded-button"
import { useSessionUser } from "@/components/product/session-user"
import type { ArtifactSourceState } from "@/components/product/takeoff-dialogs"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
// Template source of truth + actor semantics (contract §9, ADR-0006): W3-e
// ships src/core/workflow.ts — the UI imports templates (never duplicates them)
// and the agent-actor predicate from the pure core.
import { WORKFLOW_TEMPLATES, isAgentActor } from "@/core/workflow"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// Local display helpers + constants
// ---------------------------------------------------------------------------

/** States the executor (or a human reviewer) can still advance — polled live. */
const ACTIVE_STATES: readonly WorkflowState[] = ["queued", "running", "awaiting_approval"]

function isActiveState(state: WorkflowState): boolean {
  return ACTIVE_STATES.includes(state)
}

/**
 * Normalize the row's createdBy for display. The wire contract (§1) always
 * carries it (server default "local-operator"), but a dev server running a
 * stale Prisma client mid-flight (parallel lane just pushed the schema) can
 * serve rows without the newest columns — render "unknown", never a crash.
 */
function creatorOf(row: { createdBy?: string }): string {
  return typeof row.createdBy === "string" && row.createdBy.length > 0 ? row.createdBy : "unknown"
}

/** Mirrored from the contract's actor validation (keep in sync with src/core/workflow.ts). */
const AGENT_NAME_RE = /^[a-z0-9-]{1,32}$/
const MSG_AGENT_NAME =
  "agent name must match ^[a-z0-9-]{1,32}$ — lowercase letters, digits and hyphens, 1–32 chars"

function parseDefinition(definition: string | null | undefined): WorkflowDefinition | null {
  if (!definition) return null
  try {
    const parsed = JSON.parse(definition) as Partial<WorkflowDefinition> | null
    return parsed && Array.isArray(parsed.steps) ? (parsed as WorkflowDefinition) : null
  } catch {
    return null
  }
}

function parseWorkflowFailure(failure: string | null | undefined): WorkflowFailure | null {
  if (!failure) return null
  try {
    const parsed = JSON.parse(failure) as Partial<WorkflowFailure> | null
    return parsed && typeof parsed.stepId === "string" && typeof parsed.error === "string"
      ? (parsed as WorkflowFailure)
      : null
  } catch {
    return null
  }
}

/** Card summary: "3 steps · quantities, mesh, report" (+ approval-gate marker). */
function definitionSummary(def: WorkflowDefinition | null): string {
  if (!def || def.steps.length === 0) return "No steps in the stored definition"
  const parts: string[] = [`${def.steps.length} step${def.steps.length === 1 ? "" : "s"}`]
  parts.push(def.steps.map((s) => s.id).join(", "))
  if (def.steps.some((s) => s.requiresApproval)) parts.push("approval gate")
  return parts.join(" · ")
}

/** One-line event payload summary (scalar key=value pairs); verbatim fallback. */
function summarizePayload(payload: string | null): string | null {
  if (!payload) return null
  try {
    const parsed = JSON.parse(payload) as unknown
    if (parsed === null || typeof parsed !== "object") return String(parsed)
    const entries = Object.entries(parsed as Record<string, unknown>)
      .filter(([, v]) => v !== null && v !== undefined)
      .slice(0, 6)
    if (entries.length === 0) return null
    return entries
      .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
      .join(" · ")
  } catch {
    return payload
  }
}

/** Full pretty payload for the expandable detail — verbatim, JSON-aware. */
function prettyPayload(payload: string | null): string | null {
  if (!payload) return null
  try {
    return JSON.stringify(JSON.parse(payload), null, 2)
  } catch {
    return payload
  }
}

function parseStringArray(json: string | null | undefined): string[] {
  if (!json) return []
  try {
    const parsed = JSON.parse(json) as unknown
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []
  } catch {
    return []
  }
}

/**
 * Build the POSTed definition from a template: the picked source model id is
 * written into EVERY step input slot — the derive steps' inputs.artifactId and
 * the report step's inputs.artifactIds (the report cites the SOURCE artifact
 * once; its quantity rows and derived mesh are found via that artifact).
 * Retry/parameters/approval flags pass through untouched.
 */
function buildDefinition(
  steps: readonly WorkflowStepDefinition[],
  sourceArtifactId: string,
): WorkflowDefinition {
  return {
    steps: steps.map((step) => ({
      ...step,
      inputs:
        "artifactIds" in step.inputs && step.inputs.artifactIds !== undefined
          ? { artifactIds: [sourceArtifactId] }
          : "artifactId" in step.inputs
            ? { artifactId: sourceArtifactId }
            : { ...step.inputs },
    })),
  }
}

const TRANSITION_TOAST: Record<WorkflowTransitionAction, string> = {
  "mark-ready": "Workflow marked ready",
  queue: "Workflow queued — the executor claims it and runs the steps in order",
  cancel: "Workflow cancelled",
  retry: "Workflow re-queued — it resumes from the failed step",
  approve: "Approved as the local human operator — execution continues",
  reject: "Workflow rejected — cancelled; the draft output is kept for audit",
}

const ACTION_BUSY_LABEL: Record<WorkflowTransitionAction, string> = {
  "mark-ready": "Marking ready…",
  queue: "Queueing…",
  cancel: "Cancelling…",
  retry: "Retrying…",
  approve: "Approving…",
  reject: "Rejecting…",
}

// ---------------------------------------------------------------------------
// Badges (state machine vocabularies — colors follow the product conventions:
// amber = in flight, orange = human gate, emerald = success, destructive =
// failure, muted outline = inert; never blue/indigo)
// ---------------------------------------------------------------------------

function WorkflowStateBadge({ state }: { state: WorkflowState | WorkflowStepRunState }) {
  switch (state) {
    case "draft":
      return <Badge variant="secondary">Draft</Badge>
    case "ready":
      return <Badge variant="outline" className="border-foreground/25 text-foreground">Ready</Badge>
    case "queued":
      return (
        <Badge className="border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
          Queued
        </Badge>
      )
    case "running":
      return (
        <Badge className="animate-pulse border-transparent bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          <Loader2 className="animate-spin" aria-hidden /> Running
        </Badge>
      )
    case "awaiting_approval":
      return (
        <Badge className="border-orange-300 bg-orange-100 text-orange-800 dark:border-orange-700 dark:bg-orange-950 dark:text-orange-300">
          Awaiting approval
        </Badge>
      )
    case "succeeded":
      return (
        <Badge className="border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
          Succeeded
        </Badge>
      )
    case "failed":
      return <Badge variant="destructive">Failed</Badge>
    case "cancelled":
      return <Badge variant="outline" className="text-muted-foreground">Cancelled</Badge>
    case "pending":
      return <Badge variant="outline" className="text-muted-foreground">Pending</Badge>
    case "skipped":
      return <Badge variant="outline" className="text-muted-foreground">Skipped</Badge>
    default:
      return <Badge variant="outline" className="font-mono">{state}</Badge>
  }
}

/** Creator actor badge — human vs automation are visually distinct (teal Bot vs muted User). */
function CreatorBadge({ createdBy }: { createdBy: string }) {
  if (isAgentActor(createdBy)) {
    return (
      <Badge
        className="border-transparent bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-300"
        title={`Automation actor — ${createdBy}`}
      >
        <Bot aria-hidden /> {createdBy}
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="text-muted-foreground" title={`Human actor — ${createdBy}`}>
      <User aria-hidden /> {createdBy}
    </Badge>
  )
}

function EventActorIcon({ actorType }: { actorType: string }) {
  const cls = "mt-0.5 size-4 shrink-0 text-muted-foreground"
  if (actorType === "agent") return <Bot className={cls} aria-hidden />
  if (actorType === "system") return <Server className={cls} aria-hidden />
  return <User className={cls} aria-hidden />
}

// ---------------------------------------------------------------------------
// Workflow card (list row)
// ---------------------------------------------------------------------------

function WorkflowCard({
  workflow,
  selected,
  onSelect,
}: {
  workflow: WorkflowRow
  selected: boolean
  onSelect: () => void
}) {
  const definition = parseDefinition(workflow.definition)
  const createdBy = creatorOf(workflow)
  return (
    <Card
      className={cn(
        // min-w-0 (Slice-11 fix): this card is a GRID item (grid gap-4 sm:grid-
        // cols-2 …) — without it the grid-item min-width:auto + the w-full
        // flex chain below let a long nowrap workflow name (e.g. the planner's
        // “<intent…> (AI plan)” names) push the card past a 390 px viewport
        // instead of truncating (browser-verified defect).
        "min-w-0 transition-colors",
        selected ? "border-orange-300 bg-accent/40 dark:border-orange-700" : "hover:bg-accent/30",
      )}
    >
      <CardContent className="p-4">
        <button
          type="button"
          onClick={onSelect}
          aria-pressed={selected}
          aria-label={`Inspect workflow ${workflow.name} (${workflow.state})`}
          className="flex min-h-11 w-full min-w-0 flex-col items-start gap-2 text-left"
        >
          <span className="flex w-full min-w-0 items-start justify-between gap-2">
            <span className="min-w-0 truncate font-medium" title={workflow.id}>
              {workflow.name}
            </span>
            <WorkflowStateBadge state={workflow.state} />
          </span>
          <CreatorBadge createdBy={createdBy} />
          <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <span title={workflow.createdAt}>created {relTime(workflow.createdAt)}</span>
            {workflow.finishedAt ? (
              <span title={workflow.finishedAt}>· finished {relTime(workflow.finishedAt)}</span>
            ) : null}
          </span>
          <span className="text-xs text-muted-foreground">{definitionSummary(definition)}</span>
        </button>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Event stream row (newest first; payload summary + expandable verbatim detail)
// ---------------------------------------------------------------------------

function WorkflowEventItem({ event }: { event: WorkflowEventRow }) {
  const [open, setOpen] = useState(false)
  const summary = summarizePayload(event.payload)
  const detail = prettyPayload(event.payload)
  return (
    <div
      className={cn("flex items-start gap-3 rounded-md px-2 py-2", detail ? "cursor-pointer hover:bg-muted/60" : "")}
      role={detail ? "button" : undefined}
      tabIndex={detail ? 0 : undefined}
      aria-expanded={detail ? open : undefined}
      aria-label={detail ? `Toggle payload of event ${event.kind}` : undefined}
      onClick={detail ? () => setOpen((v) => !v) : undefined}
      onKeyDown={
        detail
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault()
                setOpen((v) => !v)
              }
            }
          : undefined
      }
    >
      <EventActorIcon actorType={event.actorType} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="font-mono text-sm font-medium">{event.kind}</span>
          <ActorBadge actorType={event.actorType} />
          <span className="max-w-[180px] truncate text-xs text-muted-foreground" title={event.actorId}>
            {event.actorId}
          </span>
          <span className="ml-auto shrink-0 text-xs text-muted-foreground" title={event.createdAt}>
            {relTime(event.createdAt)}
          </span>
        </div>
        {summary ? (
          <p className="mt-0.5 truncate text-xs text-muted-foreground" title={summary}>
            {summary}
          </p>
        ) : null}
        {open && detail ? (
          <pre className="eos-scroll mt-2 max-h-64 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
            {detail}
          </pre>
        ) : null}
      </div>
      {detail ? (
        <ChevronRight
          aria-hidden
          className={cn("mt-1 size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
        />
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step timeline row (seq order, expandable execution record + verbatim logs)
// ---------------------------------------------------------------------------

const STEP_RAIL_CLASS: Record<WorkflowStepRunState, string> = {
  pending: "border-border bg-background text-muted-foreground",
  running: "border-amber-300 bg-amber-100 text-amber-800 dark:border-amber-700 dark:bg-amber-900 dark:text-amber-300",
  succeeded:
    "border-emerald-300 bg-emerald-100 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-900 dark:text-emerald-300",
  failed: "border-destructive/60 bg-destructive/10 text-destructive",
  skipped: "border-border bg-muted text-muted-foreground",
  awaiting_approval:
    "border-orange-300 bg-orange-100 text-orange-800 dark:border-orange-700 dark:bg-orange-900 dark:text-orange-300",
}

function StepTimelineRow({
  step,
  isLast,
  failure,
}: {
  step: WorkflowStepRow
  isLast: boolean
  failure: WorkflowFailure | null
}) {
  const inputRevisionIds = parseStringArray(step.inputRevisionIds)
  const inputHashes = parseStringArray(step.inputHashes)
  const stepFailed = step.state === "failed"
  const errorText = stepFailed && failure && failure.stepId === step.stepId ? failure.error : null
  const hasRecord = step.startedAt !== null || step.stdoutTail !== null || step.stderrTail !== null
  const outputSummary = prettyPayload(step.outputSummary)

  return (
    <li className="relative flex gap-3 pb-5 last:pb-0">
      {/* Timeline rail: numbered marker per step, colored by run state */}
      <div className="flex flex-col items-center" aria-hidden>
        <span
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-full border font-mono text-[11px]",
            STEP_RAIL_CLASS[step.state],
          )}
        >
          {step.seq}
        </span>
        {isLast ? null : <span className="mt-1 w-px flex-1 bg-border" />}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium">{step.stepId}</span>
          <Badge variant="outline" className="font-mono text-[11px]">
            {step.operation}
          </Badge>
          {step.engineKey ? (
            <Badge variant="outline" className="font-mono text-[11px] uppercase" title={step.engineVersion ?? undefined}>
              {step.engineKey}
            </Badge>
          ) : null}
          <WorkflowStateBadge state={step.state} />
        </div>
        <p className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          <span className="font-mono tabular-nums">
            attempt {step.attempt}/{step.maxAttempts}
          </span>
          {step.durationMs !== null ? (
            <span className="font-mono tabular-nums" title={step.endedAt ?? undefined}>
              · took {formatDuration(step.durationMs)}
            </span>
          ) : step.startedAt ? (
            <span title={step.startedAt}>· started {relTime(step.startedAt)}</span>
          ) : (
            <span>· not started yet</span>
          )}
          {step.endedAt ? <span title={step.endedAt}>· ended {relTime(step.endedAt)}</span> : null}
        </p>

        {errorText ? (
          <p
            className="mt-2 whitespace-pre-wrap break-words rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 font-mono text-xs text-destructive"
            title={errorText}
          >
            {errorText}
          </p>
        ) : null}

        {hasRecord ? (
          <Collapsible>
            <CollapsibleTrigger className="mt-1.5 flex min-h-8 items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline">
              <ChevronDown className="size-3.5" aria-hidden />
              Execution record &amp; logs
            </CollapsibleTrigger>
            <CollapsibleContent>
              <dl className="mt-1 grid gap-x-4 gap-y-1.5 rounded-lg border bg-muted/30 p-3 text-xs sm:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground">Engine</dt>
                  <dd className="font-mono" title={`${step.engineKey ?? "unknown"} ${step.engineVersion ?? ""}`.trim()}>
                    {step.engineKey ? `${step.engineKey} ${step.engineVersion ?? ""}`.trim() : "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Adapter</dt>
                  <dd className="truncate font-mono" title={`${step.adapterScript ?? "unknown"} — sha256 ${step.adapterHash ?? "n/a"}`}>
                    {step.adapterScript ? `${step.adapterScript} (${shortHash(step.adapterHash)})` : "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Exit code</dt>
                  <dd className="font-mono">{step.exitCode !== null ? step.exitCode : "—"}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Inputs locked at queue time</dt>
                  <dd
                    className="font-mono"
                    title={inputRevisionIds.length > 0 ? `revisions: ${inputRevisionIds.join(", ")}` : undefined}
                  >
                    {inputRevisionIds.length > 0
                      ? `${inputRevisionIds.length} revision${inputRevisionIds.length === 1 ? "" : "s"} · ${inputHashes.map((h) => shortHash(h)).join(", ")}`
                      : "—"}
                  </dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-muted-foreground">Output revision</dt>
                  <dd className="break-all font-mono">
                    {step.outputArtifactRevisionId ? step.outputArtifactRevisionId : "— (ledger-only op or none yet)"}
                  </dd>
                </div>
                {outputSummary ? (
                  <div className="sm:col-span-2">
                    <dt className="text-muted-foreground">Output summary (structured)</dt>
                    <dd>
                      <pre className="eos-scroll mt-1 max-h-40 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-[11px] leading-relaxed">
                        {outputSummary}
                      </pre>
                    </dd>
                  </div>
                ) : null}
              </dl>
              {step.stdoutTail ? (
                <div>
                  <p className="mt-2 text-xs font-medium text-muted-foreground">stdout (tail, verbatim)</p>
                  <pre className="eos-scroll mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
                    {step.stdoutTail}
                  </pre>
                </div>
              ) : null}
              {step.stderrTail ? (
                <div>
                  <p className="mt-2 text-xs font-medium text-muted-foreground">stderr (tail, verbatim)</p>
                  <pre className="eos-scroll mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
                    {step.stderrTail}
                  </pre>
                </div>
              ) : null}
            </CollapsibleContent>
          </Collapsible>
        ) : null}
      </div>
    </li>
  )
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

const noop = () => {}

export function AgentsWorkspace({
  projectId,
  onMutated,
}: {
  projectId: string
  /** Parent-side cache nudge: workflow completions/approvals produce artifacts
   *  and publish state changes the project-level caches don't observe on
   *  their own (useApi is manual-refresh). Optional — no-op when absent. */
  onMutated?: () => void
}) {
  const workflows = useApi<{ workflows: WorkflowRow[] }>(`/api/projects/${projectId}/workflows`)
  const artifacts = useApi<{ artifacts: ArtifactListItem[] }>(`/api/projects/${projectId}/artifacts`)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [rejectOpen, setRejectOpen] = useState(false)
  // One transition in flight at a time — no optimistic updates anywhere.
  const [transitioning, setTransitioning] = useState<WorkflowTransitionAction | null>(null)

  const detail = useApi<WorkflowDetail>(selectedId ? `/api/workflows/${selectedId}` : null)

  const rows = useMemo(() => workflows.data?.workflows ?? [], [workflows.data])

  // Guard against useApi's stale data while the detail path flips between ids.
  const detailData =
    detail.data && detail.data.workflow.id === selectedId && !detail.error ? detail.data : null
  const selectedRow = rows.find((w) => w.id === selectedId) ?? null
  // The detail fetch is authoritative once loaded; the list row stands in while loading.
  const wf = detailData?.workflow ?? selectedRow

  const steps = detailData?.steps ?? []
  const events = useMemo(() => {
    const list = detailData?.events ?? []
    // Newest first (defensive: seq is per-workflow monotonic — order is content).
    return [...list].sort((a, b) => b.seq - a.seq)
  }, [detailData])
  const canApprove = detailData ? detailData.canApprove : true
  const failure = parseWorkflowFailure(wf?.failure ?? null)
  const definition = parseDefinition(wf?.definition ?? null)
  const creator = creatorOf(wf ?? { createdBy: "unknown" })

  // Live polling: while ANY listed workflow (or the open detail) is in an
  // active state, refresh every ~2.5s; stop when everything is terminal.
  const listHasActive = rows.some((w) => isActiveState(w.state))
  const detailActive = wf ? isActiveState(wf.state) : false
  const refreshList = workflows.refresh
  const refreshDetail = detail.refresh
  const notifyMutated = onMutated ?? noop
  useEffect(() => {
    if (!listHasActive && !detailActive) return
    const timer = setInterval(() => {
      void refreshList()
      if (selectedId !== null && detailActive) void refreshDetail()
    }, 2500)
    return () => clearInterval(timer)
  }, [listHasActive, detailActive, selectedId, refreshList, refreshDetail])
  // A run reaching a terminal state produced (or published) artifacts — the
  // project-level caches (Artifacts tab, Studio model list, activity feed)
  // only refresh on their own triggers, so nudge them exactly once at the
  // active→terminal boundary (never per poll tick).
  const prevActiveRef = useRef(listHasActive || detailActive)
  useEffect(() => {
    const wasActive = prevActiveRef.current
    const active = listHasActive || detailActive
    if (wasActive && !active) notifyMutated()
    prevActiveRef.current = active
  }, [listHasActive, detailActive, notifyMutated])
  // (Project switches reset this workspace via the `key` the registration in
  // project-workspace.tsx passes — remount, not a synchronous effect reset.)

  const artifactSource: ArtifactSourceState = {
    rows: artifacts.data?.artifacts ?? [],
    loading: artifacts.loading,
    error: artifacts.error,
    onRetry: () => void artifacts.refresh(),
  }

  const applyTransition = async (action: WorkflowTransitionAction, note?: string) => {
    if (transitioning !== null || selectedId === null) return
    setTransitioning(action)
    try {
      await transitionWorkflow(selectedId, action, note)
      toast.success(TRANSITION_TOAST[action])
      void workflows.refresh()
      void detail.refresh()
      // approve publishes a revision; reject/cancel leave draft outputs —
      // either way the parent caches should hear about it once, immediately.
      notifyMutated()
    } catch (err) {
      // 409 (state machine refuses) / 422 (validation) / 403 surface verbatim.
      toast.error(err instanceof Error ? err.message : "Transition failed")
    } finally {
      setTransitioning(null)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight">
          <Bot className="size-4 text-muted-foreground" aria-hidden /> Agents &amp; Automations
        </h2>
        <Alert>
          <Info aria-hidden />
          <AlertTitle>Durable, auditable execution</AlertTitle>
          <AlertDescription>
            Workflows run real engine adapters step by step — quantities, mesh, report — with retries,
            verbatim logs and input revisions locked at queue time. Approval gates are enforced per
            ADR-0006: an agent can create and run a workflow, but publishing its output always
            requires a human approver — there is no code path for an agent to approve.
          </AlertDescription>
        </Alert>
      </header>

      {/* ---------------- AI planner (Slice 11, contract §6) — FIRST
          section, above the workflow templates: the planner PROPOSES, a
          human disposes (ADR-0008). Viewers keep the read-only history;
          the intent form is an editor action. ---------------- */}
      <PlannerPanel
        projectId={projectId}
        refreshWorkflows={() => void workflows.refresh()}
        notifyMutated={notifyMutated}
      />

      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold tracking-tight">Workflows ({rows.length})</h3>
        {listHasActive ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
            <Loader2 className="size-3.5 animate-spin" aria-hidden /> live — refreshing every few seconds
          </span>
        ) : null}
        <GuardedButton className="ml-auto h-10" onClick={() => setCreateOpen(true)}>
          <Plus aria-hidden /> New workflow
        </GuardedButton>
      </div>

      {workflows.error ? (
        <ErrorState message={workflows.error} onRetry={() => void workflows.refresh()} />
      ) : workflows.loading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Loading workflows">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Bot}
          title="No workflows yet — create your first automation from a template"
          description="Pick a template and a source model, name the acting agent (or yourself), and the runtime executes the steps with the real geometry engines. Publishing steps pause for your human approval."
          actionLabel="New workflow"
          onAction={() => setCreateOpen(true)}
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {rows.map((w) => (
              <WorkflowCard
                key={w.id}
                workflow={w}
                selected={w.id === selectedId}
                onSelect={() => setSelectedId(w.id)}
              />
            ))}
          </div>

          {selectedId === null ? (
            <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
              Select a workflow to inspect its steps, events and actions.
            </p>
          ) : detail.error && detailData === null ? (
            <ErrorState message={detail.error} onRetry={() => void detail.refresh()} />
          ) : wf === null ? (
            <Skeleton className="h-96" />
          ) : (
            <Card>
              <CardContent className="flex flex-col gap-4 p-4 sm:p-6">
                {/* ---------- Header ---------- */}
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h4 className="flex flex-wrap items-center gap-2 text-sm font-semibold tracking-tight">
                      <span className="truncate" title={wf.id}>
                        {wf.name}
                      </span>
                      <WorkflowStateBadge state={wf.state} />
                    </h4>
                    <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                      <CreatorBadge createdBy={creator} />
                      <span title={wf.createdAt}>created {formatDate(wf.createdAt)}</span>
                      {wf.currentStateSince ? (
                        <span title={wf.currentStateSince}>· {wf.state} since {relTime(wf.currentStateSince)}</span>
                      ) : null}
                      {wf.finishedAt ? (
                        <span title={wf.finishedAt}>· finished {formatDate(wf.finishedAt)}</span>
                      ) : null}
                    </p>
                  </div>
                </div>

                {/* ---------- Failure (verbatim) ---------- */}
                {failure ? (
                  <Alert variant="destructive" role="alert">
                    <AlertTitle>
                      Failed at step &quot;{failure.stepId}&quot; (attempt {failure.attempt})
                    </AlertTitle>
                    <AlertDescription>
                      <span className="break-words font-mono text-xs">{failure.error}</span>
                    </AlertDescription>
                  </Alert>
                ) : null}

                {/* ---------- Approval-gate affordances (ADR-0006) ---------- */}
                {wf.state === "awaiting_approval" ? (
                  <div className="flex flex-col gap-2">
                    {isAgentActor(creator) ? (
                      <Alert className="border-orange-300 bg-orange-50 text-orange-900 dark:border-orange-700 dark:bg-orange-950 dark:text-orange-200">
                        <Bot aria-hidden />
                        <AlertTitle>
                          Created by automation — publishing requires human approval (ADR-0006)
                        </AlertTitle>
                        <AlertDescription className="text-orange-900/90 dark:text-orange-300/90">
                          This workflow was created by {creator}. Approving records you as
                          local-operator — a human identity distinct from the creating agent. An agent
                          can never approve: the API accepts no actor for approve/reject.
                        </AlertDescription>
                      </Alert>
                    ) : null}
                    <InfoNote>
                      Approve / reject are recorded as the local human operator (local-operator) —
                      the API accepts no actor for these actions, so an agent can never approve.
                      Approving publishes the step&apos;s draft output and resumes execution;
                      rejecting cancels the workflow and keeps the draft for audit.
                    </InfoNote>
                  </div>
                ) : null}

                {/* ---------- Actions: ONLY what the state machine allows (contract §3) ---------- */}
                <WorkflowActions
                  state={wf.state}
                  canApprove={canApprove}
                  transitioning={transitioning}
                  onAction={(action) => void applyTransition(action)}
                  onReject={() => setRejectOpen(true)}
                />

                {/* ---------- Definition (pre-queue) / step timeline (post-queue) ---------- */}
                {steps.length === 0 ? (
                  <section aria-label="Workflow definition" className="flex flex-col gap-2">
                    <h3 className="text-sm font-semibold tracking-tight">
                      Definition ({definition?.steps.length ?? 0} steps · not queued yet)
                    </h3>
                    {definition && definition.steps.length > 0 ? (
                      <ol className="flex flex-col gap-1.5 rounded-lg border bg-muted/30 p-3">
                        {definition.steps.map((step, i) => (
                          <li
                            key={step.id}
                            className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-muted-foreground"
                          >
                            <span className="font-mono">{i + 1}.</span>
                            <span className="font-medium text-foreground">{step.id}</span>
                            <span className="font-mono">{step.operation}</span>
                            {step.retry.maxAttempts > 1 ? (
                              <span title={`retry: ${step.retry.maxAttempts} attempts, ${step.retry.backoffMs} ms backoff`}>
                                · retry ×{step.retry.maxAttempts}
                              </span>
                            ) : null}
                            {step.requiresApproval ? (
                              <Badge
                                variant="outline"
                                className="border-orange-300 text-orange-800 dark:border-orange-700 dark:text-orange-300"
                              >
                                approval gate
                              </Badge>
                            ) : null}
                            {step.skipOnError ? <span>· skip on error</span> : null}
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <p className="rounded-lg border border-dashed px-4 py-6 text-center text-xs text-muted-foreground">
                        No parseable definition stored on this workflow.
                      </p>
                    )}
                    <InfoNote>
                      Step rows are created when the run is queued — a draft carries its definition
                      only. Mark ready, then queue, to execute it.
                    </InfoNote>
                  </section>
                ) : (
                  <section aria-label="Workflow step timeline" className="flex flex-col gap-2">
                    <h3 className="text-sm font-semibold tracking-tight">Steps ({steps.length})</h3>
                    <ol className="flex flex-col">
                      {steps.map((step, i) => (
                        <StepTimelineRow
                          key={step.id}
                          step={step}
                          isLast={i === steps.length - 1}
                          failure={failure}
                        />
                      ))}
                    </ol>
                  </section>
                )}

                {/* ---------- Event stream ---------- */}
                <section aria-label="Workflow event stream" className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <h3 className="text-sm font-semibold tracking-tight">Events ({events.length})</h3>
                    <span className="text-xs text-muted-foreground">append-only · newest first · max 200</span>
                  </div>
                  {events.length === 0 ? (
                    <p className="rounded-lg border border-dashed px-4 py-6 text-center text-xs text-muted-foreground">
                      No events yet — creating and transitioning this workflow appends to this stream.
                    </p>
                  ) : (
                    <ul className="eos-scroll max-h-96 divide-y overflow-y-auto rounded-lg border" role="list">
                      {events.map((event) => (
                        <li key={event.id} className="py-1">
                          <WorkflowEventItem event={event} />
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </CardContent>
            </Card>
          )}
        </>
      )}

      {/* ---------------- Dialogs ---------------- */}
      <NewWorkflowDialog
        projectId={projectId}
        artifacts={artifactSource}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(workflow) => {
          setSelectedId(workflow.id)
          void workflows.refresh()
        }}
      />
      <RejectWorkflowDialog
        workflow={wf}
        open={rejectOpen}
        onOpenChange={setRejectOpen}
        onConfirm={(note) => {
          setRejectOpen(false)
          void applyTransition("reject", note)
        }}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// State-appropriate actions — exactly the §3 transition map, ZERO dead buttons
// ---------------------------------------------------------------------------

const STATE_NOTE: Record<WorkflowState, string> = {
  draft:
    "Draft — mark ready to arm the definition for queueing. The definition itself is immutable; create a new workflow to change the steps.",
  ready: "Ready — queue the run and the executor claims the workflow, locks input revisions and runs the steps in order.",
  queued:
    "Queued — waiting for the executor to claim it (single-operator executor, one workflow at a time).",
  running:
    "Running — cancelling asks the executor to stop; a step already in flight may finish first. Succeeded step outputs are kept, never silently deleted.",
  awaiting_approval:
    "Execution is paused before publishing — the step output is written as a draft revision. Approve to publish and continue; reject cancels and keeps the draft.",
  failed:
    "Retry revalidates the inputs (the source artifact must still exist) and resumes from the failed step; earlier outputs are kept.",
  succeeded:
    "Succeeded — all steps are done and every output is a real stored artifact revision. This state is terminal.",
  cancelled:
    "Cancelled — terminal. The definition and any earlier step outputs are kept for audit; recovery is a new workflow.",
}

function WorkflowActions({
  state,
  canApprove,
  transitioning,
  onAction,
  onReject,
}: {
  state: WorkflowState
  canApprove: boolean
  transitioning: WorkflowTransitionAction | null
  onAction: (action: WorkflowTransitionAction) => void
  onReject: () => void
}) {
  const busy = transitioning !== null
  const button = (action: WorkflowTransitionAction, label: string, variant: "default" | "outline" | "ghost" = "default") => (
    <GuardedButton
      className={cn(
        "h-9",
        variant === "ghost" && "text-muted-foreground",
        action === "cancel" && "hover:text-destructive",
      )}
      variant={variant}
      disabled={busy}
      onClick={() => onAction(action)}
    >
      {transitioning === action ? <Loader2 className="animate-spin" aria-hidden /> : null}
      {transitioning === action ? ACTION_BUSY_LABEL[action] : label}
    </GuardedButton>
  )

  let actions: React.ReactNode = null
  switch (state) {
    case "draft":
      actions = (
        <>
          {button("mark-ready", "Mark ready")}
          {button("cancel", "Cancel", "ghost")}
        </>
      )
      break
    case "ready":
      actions = (
        <>
          {button("queue", "Queue run")}
          {button("cancel", "Cancel", "ghost")}
        </>
      )
      break
    case "queued":
      actions = button("cancel", "Cancel", "ghost")
      break
    case "running":
      // Cancel with the honest confirm note (rendered below): an in-flight
      // step may finish first — the button never promises an instant stop.
      actions = button("cancel", "Cancel", "ghost")
      break
    case "awaiting_approval":
      actions = canApprove ? (
        <>
          {button("approve", "Approve (human review)")}
          <GuardedButton variant="outline" className="h-9" disabled={busy} onClick={onReject}>
            {transitioning === "reject" ? ACTION_BUSY_LABEL.reject : "Reject…"}
          </GuardedButton>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          This workflow is paused for human approval — approval is not available in this session
          (the server records approvers as the local human operator).
        </p>
      )
      break
    case "failed":
      actions = (
        <>
          {button("retry", "Retry from failed step")}
          {button("cancel", "Cancel", "ghost")}
        </>
      )
      break
    case "succeeded":
    case "cancelled":
    default:
      actions = null // terminal — the note below replaces dead buttons
      break
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {actions}
      </div>
      {/* awaiting_approval is explained by the human-review affordance above —
          no duplicate note here */}
      {state === "awaiting_approval" ? null : <InfoNote>{STATE_NOTE[state]}</InfoNote>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// New workflow (create from template)
// ---------------------------------------------------------------------------

function NewWorkflowDialog({
  projectId,
  artifacts,
  open,
  onOpenChange,
  onCreated,
}: {
  projectId: string
  artifacts: ArtifactSourceState
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (workflow: WorkflowRow) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New workflow</DialogTitle>
          <DialogDescription>
            Create a multi-step automation from a template. The picked source model is written into
            every step input (both derive steps&apos; artifact id and the report&apos;s cited
            artifact) — the exact definition JSON is previewed before it is sent.
          </DialogDescription>
        </DialogHeader>
        {/* Radix unmounts DialogContent on close, so the form component below —
            and ALL of its state — dies with it: every open starts fresh, with
            no reset effects (react-hooks/set-state-in-effect compliant). */}
        <NewWorkflowForm
          projectId={projectId}
          artifacts={artifacts}
          close={() => onOpenChange(false)}
          onCreated={onCreated}
        />
      </DialogContent>
    </Dialog>
  )
}

function NewWorkflowForm({
  projectId,
  artifacts,
  close,
  onCreated,
}: {
  projectId: string
  artifacts: ArtifactSourceState
  close: () => void
  onCreated: (workflow: WorkflowRow) => void
}) {
  const templates = useMemo(
    () =>
      Object.entries(WORKFLOW_TEMPLATES).map(([key, t]) => ({
        key,
        name: t.name,
        steps: t.definition.steps,
      })),
    [],
  )

  const [name, setName] = useState(templates[0]?.name ?? "")
  const [templateKey, setTemplateKey] = useState(templates[0]?.key ?? "")
  const [artifactId, setArtifactId] = useState("")
  const [actorMode, setActorMode] = useState<"human" | "agent">("human")
  const [agentName, setAgentName] = useState("")
  const [submitting, setSubmitting] = useState(false)

  const template = templates.find((t) => t.key === templateKey) ?? null
  // Source models only — derive/report steps run on a model artifact with bytes.
  const modelArtifacts = artifacts.rows.filter((a) => a.kind === "model" && a.latestRevision !== null)

  const definition = useMemo(
    () => (template && artifactId !== "" ? buildDefinition(template.steps, artifactId) : null),
    [template, artifactId],
  )

  const onTemplateChange = (key: string) => {
    setTemplateKey(key)
    const t = templates.find((x) => x.key === key)
    if (t) setName(t.name)
  }

  const submit = async () => {
    if (submitting || !template) return
    if (name.trim() === "") {
      toast.error("Workflow name is required")
      return
    }
    if (artifactId === "") {
      toast.error("Pick a source model artifact — every step input is written from it")
      return
    }
    let createdBy = "local-operator"
    if (actorMode === "agent") {
      if (!AGENT_NAME_RE.test(agentName)) {
        toast.error(MSG_AGENT_NAME)
        return
      }
      createdBy = `agent:${agentName}`
    }

    setSubmitting(true)
    try {
      const data = await createProjectWorkflow(projectId, {
        name: name.trim(),
        definition: buildDefinition(template.steps, artifactId),
        createdBy,
      })
      toast.success(
        `Workflow "${data.workflow.name}" created as draft — mark it ready when you want to queue it`,
      )
      close()
      onCreated(data.workflow)
    } catch (err) {
      // Server 422 (definition validation, actor pattern) surfaces verbatim.
      toast.error(err instanceof Error ? err.message : "Could not create the workflow")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Template</legend>
        <RadioGroup
          value={templateKey}
          onValueChange={onTemplateChange}
          className="grid gap-2"
          aria-label="Workflow template"
        >
          {templates.map((t) => (
            <Label
              key={t.key}
              htmlFor={`wf-template-${t.key}`}
              className="flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 font-normal"
            >
              <RadioGroupItem id={`wf-template-${t.key}`} value={t.key} className="mt-0.5" />
              <span className="min-w-0">
                <span className="block text-sm font-medium">{t.name}</span>
                <span className="block text-xs text-muted-foreground">
                  {t.steps.map((s) => (s.requiresApproval ? `${s.id} (approval)` : s.id)).join(" → ")}
                </span>
              </span>
            </Label>
          ))}
        </RadioGroup>
      </fieldset>

      <div className="space-y-2">
        <Label htmlFor="wf-name">
          Workflow name <span aria-hidden className="text-destructive">*</span>
        </Label>
        <Input
          id="wf-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Model QA pipeline"
          maxLength={120}
          autoFocus
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="wf-source">Source model artifact</Label>
        {artifacts.error ? (
          <ErrorState message={artifacts.error} onRetry={artifacts.onRetry} />
        ) : artifacts.loading ? (
          <Skeleton className="h-10 w-full" />
        ) : (
          <Select value={artifactId} onValueChange={setArtifactId} disabled={modelArtifacts.length === 0}>
            <SelectTrigger id="wf-source" className="h-10 w-full" aria-label="Source model artifact">
              <SelectValue
                placeholder={
                  modelArtifacts.length === 0 ? "No model artifacts with revisions yet" : "Pick a model artifact…"
                }
              />
            </SelectTrigger>
            <SelectContent>
              {modelArtifacts.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name} (r{a.latestRevision?.revNumber} · {a.kind})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {modelArtifacts.length === 0 && !artifacts.loading && !artifacts.error ? (
          <p className="text-xs text-muted-foreground">
            Register a model artifact (with at least one revision) first — every derive step runs
            on the latest revision of the picked model.
          </p>
        ) : null}
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Creator actor</legend>
        <RadioGroup
          value={actorMode}
          onValueChange={(v) => setActorMode(v as "human" | "agent")}
          className="grid gap-2 sm:grid-cols-2"
          aria-label="Creator actor"
        >
          <Label
            htmlFor="wf-actor-human"
            className="flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 font-normal"
          >
            <RadioGroupItem id="wf-actor-human" value="human" className="mt-0.5" />
            <span className="min-w-0">
              <span className="block text-sm font-medium">Human (local-operator)</span>
              <span className="block text-xs text-muted-foreground">
                Created by you — the local engineer
              </span>
            </span>
          </Label>
          <Label
            htmlFor="wf-actor-agent"
            className="flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 font-normal"
          >
            <RadioGroupItem id="wf-actor-agent" value="agent" className="mt-0.5" />
            <span className="min-w-0">
              <span className="block text-sm font-medium">Automation agent</span>
              <span className="block text-xs text-muted-foreground">
                Named deterministic actor — its publishes still need your human approval
              </span>
            </span>
          </Label>
        </RadioGroup>
      </fieldset>

      {actorMode === "agent" ? (
        <div className="space-y-2">
          <Label htmlFor="wf-agent-name">
            Agent name <span aria-hidden className="text-destructive">*</span>
          </Label>
          <Input
            id="wf-agent-name"
            value={agentName}
            onChange={(e) => setAgentName(e.target.value)}
            placeholder="e.g. qa-bot"
            maxLength={32}
            aria-describedby="wf-agent-name-help"
          />
          <p id="wf-agent-name-help" className="text-xs text-muted-foreground">
            Recorded as <span className="font-mono">agent:&lt;name&gt;</span> — {MSG_AGENT_NAME}.
          </p>
        </div>
      ) : null}

      {definition ? (
        <div className="space-y-1.5">
          <p className="text-sm font-medium">
            Definition preview{" "}
            <span className="text-xs font-normal text-muted-foreground">
              (sent to the server exactly as shown)
            </span>
          </p>
          <pre className="eos-scroll max-h-64 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
            {JSON.stringify(definition, null, 2)}
          </pre>
        </div>
      ) : (
        <p className="rounded-lg border border-dashed px-4 py-6 text-center text-xs text-muted-foreground">
          Pick a source model artifact — the exact definition JSON sent to the server is previewed
          here before you submit.
        </p>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={close}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting ? "Creating…" : "Create workflow"}
        </Button>
      </DialogFooter>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Reject with optional note (human-review affordance; the workspace owns the
// transition call so verbatim 422/409 surfacing stays in one place)
// ---------------------------------------------------------------------------

function RejectWorkflowDialog({
  workflow,
  open,
  onOpenChange,
  onConfirm,
}: {
  workflow: WorkflowRow | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (note?: string) => void
}) {
  if (workflow === null) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reject workflow</DialogTitle>
          <DialogDescription>
            Rejecting &quot;{workflow.name}&quot; cancels it — the step output written so far stays as
            a draft revision, kept for audit. Rejection is recorded as the local human operator
            (local-operator).
            {isAgentActor(creatorOf(workflow))
              ? " This workflow was created by automation — your human review is the ADR-0006 approval gate."
              : ""}
          </DialogDescription>
        </DialogHeader>
        {/* Same remount-reset idiom as NewWorkflowDialog: Radix unmounts the
            content on close, so the note never leaks into the next open. */}
        <RejectWorkflowForm onConfirm={onConfirm} close={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

function RejectWorkflowForm({
  onConfirm,
  close,
}: {
  onConfirm: (note?: string) => void
  close: () => void
}) {
  const [note, setNote] = useState("")

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        onConfirm(note.trim().length > 0 ? note.trim() : undefined)
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="wf-reject-note">Note (optional)</Label>
        <Textarea
          id="wf-reject-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          maxLength={500}
          placeholder="e.g. report cites the wrong revision — regenerate after the model update"
        />
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={close}>
          Cancel
        </Button>
        <Button type="submit" variant="destructive">
          Reject workflow
        </Button>
      </DialogFooter>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Slice 11 — AI planner (agent-planning-contract §6 / ADR-0008)
// ---------------------------------------------------------------------------
// The planner PROPOSES, a human disposes. This panel is the ONLY client
// surface for plans and every action hits the real API (POST
// /api/projects/[id]/plans, POST /api/plans/[id]/decision): 409/422/403
// messages surface VERBATIM in toasts and the client never computes the plan
// status machine — it renders whatever row the server sent. Honesty rules:
//  - the LLM round trip is ONE synchronous request (60s ceiling worst case):
//    the submit button carries an honest busy label and stays disabled while
//    in flight; the row is persisted either way, so a failed run lands as an
//    honest `failed` row with verbatim evidence — never a silent spinner;
//  - ZERO dead buttons: Accept/Regenerate/Reject render ONLY on `proposed`
//    (Regenerate also on `failed`); terminal rows get honest notes instead
//    (contract §2.1 — every status is terminal per row, re-plan = NEW row);
//  - the plan statuses come from api.ts's local wire pin (contract §5.4) —
//    the UI does not import src/core/planner.ts; the wire is the boundary;
//  - typed revision guidance has NO wire field (contract §5.1 pins the body
//    to {intent, revisesPlanId}), so it travels INSIDE the intent as a
//    labeled line — the row's intent column stays the verbatim human request;
//  - the plans list is member-readable (§5.2): viewers see the history
//    read-only, but the intent form is an editor action (POST plans needs
//    member editor+, §5.1) and is not rendered for the viewer role.
// ---------------------------------------------------------------------------

/** Sentinel Select value for the "no revision — fresh plan" default (shadcn Select needs a non-empty value). */
const PLAN_NO_REVISION = "none"

/** Revision guidance composes INTO the intent (no wire field — see section note above). */
function composeIntentWithFeedback(base: string, feedback: string): string {
  const trimmed = feedback.trim()
  return trimmed === "" ? base : `${base}\n\nRevision feedback: ${trimmed}`
}

/** Single-line intent excerpt (history rows use 60 chars; Select labels are shorter). */
function planExcerpt(intent: string, max = 60): string {
  const oneLine = intent.replace(/\s+/g, " ").trim()
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`
}

/** Plan status badge (§2.1 vocabulary): proposed=amber (awaiting a human),
 *  accepted=emerald, rejected=muted outline, failed=destructive. Never blue/indigo. */
function PlanStatusBadge({ status }: { status: PlanStatus }) {
  switch (status) {
    case "proposed":
      return (
        <Badge className="border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
          Proposed
        </Badge>
      )
    case "accepted":
      return (
        <Badge className="border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
          Accepted
        </Badge>
      )
    case "rejected":
      return <Badge variant="outline" className="text-muted-foreground">Rejected</Badge>
    case "failed":
      return <Badge variant="destructive">Failed</Badge>
    default:
      return <Badge variant="outline" className="font-mono">{status}</Badge>
  }
}

// ---------------------------------------------------------------------------
// Plans history row (newest first; proposed rows reopen the review card,
// terminal rows expand to a compact summary — the WorkflowEventItem idiom)
// ---------------------------------------------------------------------------

function PlanHistoryRow({ plan, onReview }: { plan: PlanRow; onReview: (plan: PlanRow) => void }) {
  const [open, setOpen] = useState(false)
  const proposed = plan.status === "proposed"
  // failed → verbatim failure error; accepted/rejected → rationale first line.
  const summary = proposed
    ? null
    : plan.status === "failed"
      ? (plan.failure?.error ?? null)
      : plan.rationale !== null
        ? (plan.rationale.split("\n")[0].trim() || null)
        : null
  const clickable = proposed || summary !== null

  return (
    <li
      className={cn("flex items-start gap-3 rounded-md px-2 py-2", clickable && "cursor-pointer hover:bg-muted/60")}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-expanded={clickable && !proposed ? open : undefined}
      aria-label={
        clickable
          ? proposed
            ? `Open the review card for proposed plan #${shortHash(plan.id)}`
            : `Toggle the summary of plan #${shortHash(plan.id)}`
          : undefined
      }
      onClick={
        clickable
          ? () => {
              if (proposed) onReview(plan)
              else setOpen((v) => !v)
            }
          : undefined
      }
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault()
                if (proposed) onReview(plan)
                else setOpen((v) => !v)
              }
            }
          : undefined
      }
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <PlanStatusBadge status={plan.status} />
          <span className="min-w-0 flex-1 truncate text-sm" title={plan.intent}>
            {planExcerpt(plan.intent)}
          </span>
          {plan.revisesPlanId ? (
            <span className="font-mono text-xs text-muted-foreground" title={`revises plan ${plan.revisesPlanId}`}>
              revises #{shortHash(plan.revisesPlanId)}
            </span>
          ) : null}
          <span className="shrink-0 text-xs text-muted-foreground" title={plan.createdAt}>
            {relTime(plan.createdAt)}
          </span>
          {plan.decidedAt ? (
            <span className="shrink-0 text-xs text-muted-foreground" title={plan.decidedAt}>
              · decided {relTime(plan.decidedAt)}
            </span>
          ) : null}
        </div>
        {proposed ? (
          <p className="mt-0.5 text-xs text-muted-foreground">
            open the review card to accept, regenerate or reject
          </p>
        ) : open && summary !== null ? (
          plan.status === "failed" ? (
            <p className="mt-1 whitespace-pre-wrap break-words font-mono text-xs text-destructive" title={summary}>
              {summary}
            </p>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground" title={summary}>
              {summary}
            </p>
          )
        ) : null}
      </div>
      {clickable ? (
        <ChevronRight
          aria-hidden
          className={cn("mt-1 size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
        />
      ) : null}
    </li>
  )
}

// ---------------------------------------------------------------------------
// Review-card collapsibles (verbatim evidence — wrapped by CSS only)
// ---------------------------------------------------------------------------

function PlanDefinitionCollapsible({ definition }: { definition: NonNullable<PlanRow["definition"]> }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="flex min-h-8 items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline">
        <ChevronDown className="size-3.5" aria-hidden /> Raw definition JSON
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="eos-scroll mt-1 max-h-96 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
          {JSON.stringify(definition, null, 2)}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  )
}

function PlanEvidenceCollapsible({ evidence }: { evidence: NonNullable<PlanRow["evidence"]> }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="flex min-h-8 items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline">
        <ChevronDown className="size-3.5" aria-hidden /> Planner evidence (verbatim)
      </CollapsibleTrigger>
      <CollapsibleContent>
        {typeof evidence.rawResponse === "string" && evidence.rawResponse.length > 0 ? (
          <pre className="eos-scroll mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
            {evidence.rawResponse}
          </pre>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">
            No raw response was recorded — the LLM wire failed before any text came back (stage &quot;llm&quot;).
          </p>
        )}
        {evidence.durationMs !== undefined || evidence.attempts !== undefined ? (
          <p className="mt-1.5 text-xs text-muted-foreground">
            planner call: {formatDuration(evidence.durationMs)} · {evidence.attempts ?? "—"} attempt
            {evidence.attempts === 1 ? "" : "(s)"}
          </p>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  )
}

// ---------------------------------------------------------------------------
// Plan review card (request/response only — NEVER polled): renders whatever
// row it holds; actions appear ONLY in the statuses the machine allows
// ---------------------------------------------------------------------------

function PlanReviewCard({
  plan,
  deciding,
  regenerating,
  feedback,
  onFeedbackChange,
  onAccept,
  onReject,
  onRegenerate,
  onDismiss,
}: {
  plan: PlanRow
  deciding: "accept" | "reject" | null
  regenerating: boolean
  feedback: string
  onFeedbackChange: (value: string) => void
  onAccept: () => void
  onReject: () => void
  onRegenerate: () => void
  onDismiss: () => void
}) {
  const busy = deciding !== null || regenerating
  // Regenerate reads the feedback field below — offered where the machine
  // allows a re-plan: while proposed (not yet decided) or after a failure.
  const revisable = plan.status === "proposed" || plan.status === "failed"

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 p-4 sm:p-6">
        {/* ---------- Header ---------- */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold tracking-tight">
              <Wand2 className="size-4 text-muted-foreground" aria-hidden /> Planner proposal
              <PlanStatusBadge status={plan.status} />
              <span className="font-mono text-xs text-muted-foreground" title={plan.id}>
                #{shortHash(plan.id)}
              </span>
            </h3>
            <p className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
              <span title={plan.createdAt}>requested {relTime(plan.createdAt)}</span>
              {plan.revisesPlanId ? (
                <span title={`revises plan ${plan.revisesPlanId}`}>· revises #{shortHash(plan.revisesPlanId)}</span>
              ) : null}
              {plan.decidedAt ? <span title={plan.decidedAt}>· decided {relTime(plan.decidedAt)}</span> : null}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            className="h-8 text-muted-foreground"
            onClick={onDismiss}
            aria-label="Dismiss the planner review card"
          >
            Dismiss
          </Button>
        </div>

        {/* ---------- Intent echoed verbatim ---------- */}
        <p className="whitespace-pre-wrap break-words rounded-lg border bg-muted/30 p-3 text-sm" title={plan.intent}>
          {plan.intent}
        </p>

        {/* ---------- proposed: the full review payload ---------- */}
        {plan.status === "proposed" ? (
          <>
            {plan.rationale !== null && plan.rationale.trim() !== "" ? (
              <div className="flex flex-col gap-1">
                <h4 className="text-xs font-medium text-muted-foreground">Planner rationale</h4>
                <p className="whitespace-pre-wrap break-words text-sm">{plan.rationale}</p>
              </div>
            ) : null}
            {plan.assumptions !== null && plan.assumptions.length > 0 ? (
              <div className="flex flex-col gap-1">
                <h4 className="text-xs font-medium text-muted-foreground">Assumptions</h4>
                <ul className="flex flex-col gap-1.5">
                  {plan.assumptions.map((assumption, i) => (
                    <li key={i} className="text-sm">
                      <span className="font-medium">Assumption — verify before accepting:</span> {assumption}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {plan.stepSummary !== null && plan.stepSummary.length > 0 ? (
              <div className="flex flex-col gap-1">
                <h4 className="text-xs font-medium text-muted-foreground">Proposed steps (real artifact names)</h4>
                <ol className="flex flex-col gap-1.5 rounded-lg border bg-muted/30 p-3">
                  {plan.stepSummary.map((line, i) => (
                    <li key={i} className="flex flex-wrap items-baseline gap-x-2 text-sm">
                      <span className="font-mono text-xs text-muted-foreground">{i + 1}.</span>
                      <span className="min-w-0 flex-1">{line}</span>
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
            {plan.definition !== null ? <PlanDefinitionCollapsible definition={plan.definition} /> : null}
            {plan.evidence !== null ? <PlanEvidenceCollapsible evidence={plan.evidence} /> : null}
            <InfoNote>
              Accepting creates a DRAFT workflow authored by agent:planner-v1 — nothing runs yet. You still
              review it, mark it ready and queue it in the Workflows list, and every approval gate inside it
              stays human-only (ADR-0006).
            </InfoNote>
          </>
        ) : null}

        {/* ---------- failed: verbatim stage + error, evidence, re-plan ---------- */}
        {plan.status === "failed" ? (
          <>
            {plan.failure ? (
              <Alert variant="destructive" role="alert">
                <AlertTitle>Planner failed at the &quot;{plan.failure.stage}&quot; stage</AlertTitle>
                <AlertDescription>
                  <span className="break-words font-mono text-xs">{plan.failure.error}</span>
                </AlertDescription>
              </Alert>
            ) : (
              <Alert variant="destructive" role="alert">
                <AlertTitle>Planner run failed</AlertTitle>
                <AlertDescription>
                  This row is marked failed but the server sent no failure record — unexpected wire shape.
                </AlertDescription>
              </Alert>
            )}
            {plan.evidence !== null ? <PlanEvidenceCollapsible evidence={plan.evidence} /> : null}
            <InfoNote>
              A failed row is terminal (contract §2.1) — the evidence above is kept verbatim for audit.
              Regenerate asks for a NEW proposal that revises this one, feeding this failure back to the planner.
            </InfoNote>
          </>
        ) : null}

        {/* ---------- accepted / rejected: honest terminal notes ---------- */}
        {plan.status === "accepted" ? (
          <div className="flex flex-col gap-1.5">
            <p className="text-xs text-muted-foreground">
              Draft workflow created:{" "}
              <span className="break-all font-mono" title={plan.workflowId ?? undefined}>
                {plan.workflowId ?? "—"}
              </span>
            </p>
            <InfoNote>
              Accepted — the proposal landed as a DRAFT in the Workflows list below (createdBy agent:planner-v1).
              It still needs your review there: mark it ready, queue it, and approve every gate. The planner
              executed nothing and approval stays human-only (ADR-0006).
            </InfoNote>
          </div>
        ) : null}
        {plan.status === "rejected" ? (
          <InfoNote>
            Rejected — no workflow was created. The proposal stays in the planning history for audit; ask for a
            fresh plan (or a revision of any earlier one) whenever you want.
          </InfoNote>
        ) : null}

        {/* ---------- Revision guidance (Regenerate reads this field) ---------- */}
        {revisable ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="plan-regen-feedback">Revision feedback (optional)</Label>
            <Input
              id="plan-regen-feedback"
              value={feedback}
              onChange={(e) => onFeedbackChange(e.target.value)}
              maxLength={500}
              placeholder="e.g. drop the mesh step — quantities and report only"
              aria-label="Revision feedback sent with the regenerated plan"
              aria-describedby="plan-regen-feedback-help"
            />
            <p id="plan-regen-feedback-help" className="text-xs text-muted-foreground">
              Regenerate creates a NEW plan that revises this one. The wire carries the intent only (contract
              §5.1), so your feedback travels inside the new intent as a labeled line — leave it empty to
              re-plan the same request verbatim.
            </p>
          </div>
        ) : null}

        {/* ---------- Actions: ONLY what the status machine allows (§2.1) ---------- */}
        {plan.status === "proposed" ? (
          <div className="flex flex-wrap gap-2">
            <GuardedButton
              className="h-9"
              disabled={busy}
              onClick={onAccept}
              aria-label={`Accept plan #${shortHash(plan.id)} — creates a draft workflow`}
            >
              {deciding === "accept" ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {deciding === "accept" ? "Accepting…" : "Accept"}
            </GuardedButton>
            <GuardedButton
              variant="outline"
              className="h-9"
              disabled={busy}
              onClick={onRegenerate}
              aria-label={`Regenerate plan #${shortHash(plan.id)} — a new proposal revising this one`}
            >
              {regenerating ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {regenerating ? "Planning…" : "Regenerate"}
            </GuardedButton>
            <GuardedButton
              variant="outline"
              className="h-9"
              disabled={busy}
              onClick={onReject}
              aria-label={`Reject plan #${shortHash(plan.id)} — no workflow is created`}
            >
              {deciding === "reject" ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {deciding === "reject" ? "Rejecting…" : "Reject"}
            </GuardedButton>
          </div>
        ) : null}
        {plan.status === "failed" ? (
          <div className="flex flex-wrap gap-2">
            <GuardedButton
              className="h-9"
              disabled={busy}
              onClick={onRegenerate}
              aria-label={`Regenerate plan #${shortHash(plan.id)} — a new proposal revising this failure`}
            >
              {regenerating ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {regenerating ? "Planning…" : "Regenerate"}
            </GuardedButton>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Planner panel — the AI planner card (first workspace section) + the review
// card it spawns. Plans list via the same useApi convention as the workflows
// list; the review card is request/response and is NEVER polled.
// ---------------------------------------------------------------------------

function PlannerPanel({
  projectId,
  refreshWorkflows,
  notifyMutated,
}: {
  projectId: string
  /** The parent's exact post-create refresh (void workflows.refresh()) — accept creates a workflow row. */
  refreshWorkflows: () => void
  /** Parent cache nudge (onMutated): plan requests/decisions append audit events to the project feed. */
  notifyMutated: () => void
}) {
  const plansApi = useApi<{ plans: PlanRow[] }>(`/api/projects/${projectId}/plans`)
  const sessionUser = useSessionUser()

  // POST plans needs member editor+ (contract §5.1): the intent form is an
  // editor action and is NOT rendered for the viewer role — the history
  // below stays member-readable (§5.2). "loading"/null hides it too (honest
  // default while the session resolves; the shell gates unauthenticated use).
  const canPlan = sessionUser !== null && sessionUser !== "loading" && sessionUser.role !== "viewer"

  const plans = useMemo(() => {
    const list = plansApi.data?.plans ?? []
    // Newest first (defensive: the server pins the order — sorting is content).
    return [...list].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  }, [plansApi.data])

  // Review card: request/response only — NEVER polled (contract §6).
  const [reviewPlan, setReviewPlan] = useState<PlanRow | null>(null)
  const [reviewFeedback, setReviewFeedback] = useState("")
  // One decision (or one re-plan) in flight at a time — no optimistic updates.
  const [deciding, setDeciding] = useState<"accept" | "reject" | null>(null)
  const [regenerating, setRegenerating] = useState(false)

  // Intent form state (reset on a persisted request; kept on a refused one).
  const [intent, setIntent] = useState("")
  const [reviseTarget, setReviseTarget] = useState("")
  const [feedback, setFeedback] = useState("")
  const [submitting, setSubmitting] = useState(false)

  const openReview = (plan: PlanRow) => {
    setReviewPlan(plan)
    setReviewFeedback("")
  }

  const submitIntent = async () => {
    if (submitting) return
    const base = intent.trim()
    const composed = reviseTarget !== "" ? composeIntentWithFeedback(base, feedback) : base
    // Client mirrors the server's 10..2000 boundary (contract §5.1) so the
    // honest message lands locally instead of a round trip; a server 422
    // still surfaces verbatim below if the boundary disagrees.
    if (composed.length < 10) {
      toast.error(`Intent must be at least 10 characters — yours is ${composed.length}; say what the workflow should do`)
      return
    }
    if (composed.length > 2000) {
      toast.error(`Intent is ${composed.length} characters — keep it (with any revision feedback) within 2000; the server refuses longer`)
      return
    }
    setSubmitting(true)
    try {
      const data = await createProjectPlan(projectId, composed, reviseTarget === "" ? undefined : reviseTarget)
      setReviewPlan(data.plan)
      setReviewFeedback("")
      void plansApi.refresh()
      notifyMutated()
      // The row IS the outcome (§5.1): proposed or failed, both are honest
      // persisted results — the card renders either, verbatim.
      if (data.plan.status === "failed") {
        toast.error("Planning attempt recorded as failed — the verbatim error is on the review card")
      } else {
        toast.success("Proposal ready — review the rationale, assumptions and steps before accepting")
      }
      // The request is consumed: the next intent starts fresh.
      setIntent("")
      setFeedback("")
      setReviseTarget("")
    } catch (err) {
      // 422 (intent/revisesPlanId) / 403 (viewer) / 404 surface verbatim.
      toast.error(err instanceof Error ? err.message : "Planning request failed")
    } finally {
      setSubmitting(false)
    }
  }

  const applyDecision = async (action: "accept" | "reject") => {
    if (deciding !== null || regenerating || reviewPlan === null) return
    setDeciding(action)
    try {
      const data = await decidePlan(reviewPlan.id, action)
      // The card re-renders from the DECIDED row — terminal statuses show the
      // honest note, never dead action buttons (status machine, §2.1).
      setReviewPlan(data.plan)
      void plansApi.refresh()
      if (action === "accept") {
        // The exact post-createProjectWorkflow mechanism: the parent's
        // workflows list refetches (useApi is manual-refresh).
        refreshWorkflows()
        toast.success(
          data.workflow
            ? `Draft workflow "${data.workflow.name}" created — review, mark ready and queue it in the Workflows list`
            : "Plan accepted — a draft workflow was created (see the Workflows list)",
        )
      } else {
        toast.success("Plan rejected — no workflow was created; the proposal stays in the history for audit")
      }
      notifyMutated()
    } catch (err) {
      // 409 (already decided) / 422 (accept-time re-validation) verbatim.
      toast.error(err instanceof Error ? err.message : "Decision failed")
      if (err instanceof ApiError && err.status === 409) {
        // Decided elsewhere (e.g. another member) — resync the card + list to
        // the server's truth instead of leaving a stale proposed row open.
        const currentId = reviewPlan.id
        const fresh = await plansApi.refresh()
        const row = fresh?.plans.find((p) => p.id === currentId) ?? null
        if (row !== null) setReviewPlan(row)
      }
    } finally {
      setDeciding(null)
    }
  }

  const regenerate = async () => {
    if (regenerating || deciding !== null || reviewPlan === null) return
    const composed = composeIntentWithFeedback(reviewPlan.intent.trim(), reviewFeedback)
    if (composed.length < 10 || composed.length > 2000) {
      toast.error(
        `The new intent (prior request + revision feedback) must stay within 10–2000 characters — currently ${composed.length}`,
      )
      return
    }
    setRegenerating(true)
    try {
      const data = await createProjectPlan(projectId, composed, reviewPlan.id)
      setReviewPlan(data.plan) // the new row replaces the card
      setReviewFeedback("")
      void plansApi.refresh()
      notifyMutated()
      if (data.plan.status === "failed") {
        toast.error("Re-planning attempt recorded as failed — the verbatim error is on the review card")
      } else {
        toast.success("New proposal ready — it revises the plan you were reviewing")
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Re-planning request failed")
    } finally {
      setRegenerating(false)
    }
  }

  return (
    <>
      <Card>
        <CardContent className="flex flex-col gap-4 p-4 sm:p-6">
          <div className="flex flex-col gap-2">
            <h3 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
              <Wand2 className="size-4 text-muted-foreground" aria-hidden /> AI planner
            </h3>
            <p className="text-xs text-muted-foreground">
              Describe what you need in plain language — the planner (agent:planner-v1) proposes a workflow
              definition wired to this project&apos;s REAL artifacts. It never executes, never approves and
              never computes numbers: a human decides, and every failure is kept verbatim.
            </p>
          </div>

          {canPlan ? (
            <>
              <InfoNote>
                The planner PROPOSES only. Accepting creates a draft workflow authored by{" "}
                <span className="font-mono">agent:planner-v1</span> — you still review it, mark it ready and
                queue it, and approval gates stay human-only (ADR-0006).
              </InfoNote>
              <form
                className="flex flex-col gap-4"
                onSubmit={(e) => {
                  e.preventDefault()
                  void submitIntent()
                }}
              >
                <div className="flex flex-col gap-2">
                  <Label htmlFor="planner-intent">
                    What should the workflow do? <span aria-hidden className="text-destructive">*</span>
                  </Label>
                  <Textarea
                    id="planner-intent"
                    value={intent}
                    onChange={(e) => setIntent(e.target.value)}
                    rows={3}
                    maxLength={2000}
                    placeholder="e.g. Derive quantities from the Harbour Wall model, then build a QA report citing it"
                    aria-label="Planner intent — what the workflow should do (10 to 2000 characters)"
                    aria-describedby="planner-intent-help"
                  />
                  <p id="planner-intent-help" className="text-xs text-muted-foreground">
                    10–2000 characters, sent verbatim. The planner sees this project&apos;s artifacts (names and
                    kinds only — never geometry or numbers) and the request may take up to a minute.
                  </p>
                </div>

                <div className="flex flex-col gap-2">
                  <Label htmlFor="planner-revise">Revise an earlier plan (optional)</Label>
                  <Select
                    value={reviseTarget === "" ? PLAN_NO_REVISION : reviseTarget}
                    onValueChange={(v) => {
                      setReviseTarget(v === PLAN_NO_REVISION ? "" : v)
                      if (v === PLAN_NO_REVISION) setFeedback("")
                    }}
                    disabled={plans.length === 0}
                  >
                    <SelectTrigger id="planner-revise" className="h-10 w-full" aria-label="Revise an earlier plan">
                      <SelectValue placeholder={plans.length === 0 ? "No earlier plans yet" : "Pick an earlier plan to revise…"} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={PLAN_NO_REVISION}>No revision — fresh plan</SelectItem>
                      {plans.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          #{shortHash(p.id)} {p.status} — {planExcerpt(p.intent, 40)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Revising feeds the earlier plan (and, once accepted, its workflow&apos;s live state and
                    failure evidence) back to the planner — the new proposal is a NEW row chained to it.
                  </p>
                </div>

                {reviseTarget !== "" ? (
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="planner-feedback">Revision feedback (optional)</Label>
                    <Input
                      id="planner-feedback"
                      value={feedback}
                      onChange={(e) => setFeedback(e.target.value)}
                      maxLength={500}
                      placeholder="e.g. skip the mesh step — quantities and report only"
                      aria-label="Revision feedback — guidance sent with the revision request"
                      aria-describedby="planner-feedback-help"
                    />
                    <p id="planner-feedback-help" className="text-xs text-muted-foreground">
                      The wire carries the intent only (contract §5.1), so your feedback travels inside the new
                      plan&apos;s intent as a labeled line — verbatim and reviewable in the history.
                    </p>
                  </div>
                ) : null}

                <div className="flex flex-wrap items-center gap-2">
                  <Button type="submit" disabled={submitting} aria-label="Ask the planner for a workflow proposal">
                    {submitting ? <Loader2 className="animate-spin" aria-hidden /> : null}
                    {submitting ? "Planning…" : "Ask the planner"}
                  </Button>
                  {submitting ? (
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
                      one synchronous LLM round trip — up to 60 s worst case; the row is persisted either way
                    </span>
                  ) : null}
                </div>
              </form>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              {sessionUser === "loading"
                ? "Resolving your session role…"
                : "The AI planner is an editor action — the viewer role is read-only, so the intent form is not shown. The planning history below stays readable."}
            </p>
          )}

          {/* ---------- Planning history (member-readable, newest first) ---------- */}
          <Collapsible defaultOpen className="flex flex-col gap-2">
            <CollapsibleTrigger
              className="flex min-h-8 items-center gap-1 self-start text-sm font-semibold tracking-tight"
              aria-label="Toggle the planning history"
            >
              <ChevronDown className="size-4 text-muted-foreground" aria-hidden />
              Planning history ({plans.length})
            </CollapsibleTrigger>
            <CollapsibleContent className="flex flex-col gap-2">
              {plansApi.error ? (
                <ErrorState message={plansApi.error} onRetry={() => void plansApi.refresh()} />
              ) : plansApi.loading ? (
                <div className="flex flex-col gap-2" aria-label="Loading plans">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <Skeleton key={i} className="h-12" />
                  ))}
                </div>
              ) : plans.length === 0 ? (
                <EmptyState
                  icon={Wand2}
                  title="No planning history yet"
                  description="Members with editor access can ask the planner for a workflow proposal — every attempt, success or failure, is kept here as reviewable history with its verbatim evidence."
                />
              ) : (
                <ul role="list" className="eos-scroll max-h-80 divide-y overflow-y-auto rounded-lg border">
                  {plans.map((p) => (
                    <PlanHistoryRow key={p.id} plan={p} onReview={openReview} />
                  ))}
                </ul>
              )}
            </CollapsibleContent>
          </Collapsible>
        </CardContent>
      </Card>

      {reviewPlan !== null ? (
        <PlanReviewCard
          plan={reviewPlan}
          deciding={deciding}
          regenerating={regenerating}
          feedback={reviewFeedback}
          onFeedbackChange={setReviewFeedback}
          onAccept={() => void applyDecision("accept")}
          onReject={() => void applyDecision("reject")}
          onRegenerate={() => void regenerate()}
          onDismiss={() => setReviewPlan(null)}
        />
      ) : null}
    </>
  )
}
