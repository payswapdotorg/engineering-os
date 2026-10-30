"use client"

/**
 * Project Controls workspace (W1-f lane, Phase 5) — schedules, critical-path
 * analysis and the estimate-recompute flow over the pinned Phase-5 API
 * contracts (docs/00-architecture/phase5-disciplines-contract.md §3.1/§8/§9/§11).
 *
 * Honesty rules this workspace follows:
 *  - schedules are canonical eos-schedule/1 artifacts created through
 *    POST /api/projects/[id]/schedules. The dialog's validation IS the pure
 *    core (parseSchedule / canonicalScheduleJson from src/core/analysis-schemas.ts
 *    — the agents-workspace "import the core, never duplicate it" convention):
 *    the exact verbatim messages the server enforces surface in the form
 *    BEFORE submit, and a server 422 would surface verbatim anyway;
 *  - "Analyze" runs the platform core through the broker route (POST
 *    …/analyze-schedule) — CPM math happens server-side; engineKey is
 *    honestly ABSENT (platform core, not an engine). The analysis view renders
 *    the server's eos-cpm/1 numbers verbatim: activity table (ES/EF/LS/LF/TF),
 *    critical-path highlight, read-only CSS Gantt bars scaled to the project
 *    duration (no editing, no drag), critical-path chip list;
 *  - recompute: only APPROVED estimates whose quantity sources are stale get
 *    the "Create revised draft" action; the POST /api/estimates/[id]/recompute
 *    semantics (new draft absorbing current quantities/rates, original frozen)
 *    are the server's — the toast names the absorbed stale sources and the
 *    server's 422s (non-approved, nothing-stale) surface verbatim. Estimates
 *    without stale sources render honest copy, no dead button;
 *  - the client's staleness hint reads REAL data only: a Journey-G stale mark
 *    on a source artifact's latest revision, or a source that gained a newer
 *    revision after its quantity row was taken. When the hint and the server's
 *    gate disagree, the server 422 wins — surfaced verbatim.
 */
import {
  AlertTriangle,
  ClipboardList,
  Info,
  Loader2,
  Play,
  Plus,
  Sigma,
  Trash2,
  TriangleAlert,
} from "lucide-react"
import { useMemo, useState } from "react"
import { toast } from "sonner"

import {
  analyzeSchedule,
  createSchedule,
  fetchRevisionText,
  recomputeEstimate,
  useApi,
  type ArtifactListItem,
  type CpmAnalysisPayload,
  type DeriveRunResult,
  type EstimateRow,
  type QuantityRow,
  type ScheduleActivityInput,
} from "@/components/product/api"
import { ApprovalBadge, KindBadge, StalenessBadge } from "@/components/product/badges"
import { formatDate, humanBytes, readCpmPayloadView, relTime } from "@/components/product/format"
import { EmptyState, ErrorState, InfoNote } from "@/components/product/parts"
import { GuardedButton } from "@/components/product/guarded-button"
import { canonicalScheduleJson, parseSchedule } from "@/core/analysis-schemas"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
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
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// Local display helpers
// ---------------------------------------------------------------------------

/** Display-only currency formatting — the numbers themselves are server-computed. */
function formatMoney(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(value)
  } catch {
    return `${currency} ${value.toFixed(2)}`
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/**
 * Read an eos-cpm/1 payload out of a server response object — the 201 envelope
 * key ({analysis}) is pinned but its inner layout is W3-f's; every plausible
 * embedding is tried, and the pinned §2 fields are read defensively. Numbers
 * render verbatim or not at all.
 */
function readCpmPayload(candidate: unknown): CpmAnalysisPayload | null {
  if (!isRecord(candidate)) return null
  // Slice 31: the pinned-field mapping is the shared readCpmPayloadView
  // (format.ts) — previously a byte-duplicate of the Simulation workspace's.
  // This reader keeps its own stricter envelope rule: an analysis carrier
  // without a non-empty activity list is not a CPM payload (null), while the
  // stored-payload reader renders the honest empty list.
  const view = readCpmPayloadView(candidate)
  if (view.activities.length === 0) return null
  return view
}

/** Try every plausible embedding of the CPM payload inside the 201 body. */
function extractCpmFromRun(run: DeriveRunResult): CpmAnalysisPayload | null {
  const carrier = run as unknown
  if (!isRecord(carrier)) return null
  for (const spot of [
    carrier,
    carrier.payload,
    carrier.analysis,
    carrier.cpm,
    carrier.document,
    carrier.result,
  ]) {
    const cpm = readCpmPayload(spot)
    if (cpm !== null) return cpm
  }
  return null
}

// ---------------------------------------------------------------------------
// Schedule analysis view (CPM table + read-only Gantt + critical-path chips)
// ---------------------------------------------------------------------------

function CriticalPathChips({ cpm }: { cpm: CpmAnalysisPayload }) {
  if (cpm.criticalPath.length === 0) {
    return <span className="text-xs text-muted-foreground">— (no critical activities)</span>
  }
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {cpm.criticalPath.map((id, i) => (
        <Badge
          key={`${id}-${i}`}
          variant="outline"
          className="font-mono text-[11px]"
          title={`critical path position ${i + 1}`}
        >
          {id}
          {i < cpm.criticalPath.length - 1 ? (
            <span aria-hidden className="text-muted-foreground">
              →
            </span>
          ) : null}
        </Badge>
      ))}
    </span>
  )
}

function CpmTableView({ cpm }: { cpm: CpmAnalysisPayload }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="eos-scroll overflow-x-auto rounded-lg border">
        <Table>
          <caption className="sr-only">
            Critical-path analysis — early/late schedules and total float per activity (days)
          </caption>
          <TableHeader>
            <TableRow>
              <TableHead>Activity</TableHead>
              <TableHead className="text-right">Duration</TableHead>
              <TableHead className="text-right">ES</TableHead>
              <TableHead className="text-right">EF</TableHead>
              <TableHead className="text-right">LS</TableHead>
              <TableHead className="text-right">LF</TableHead>
              <TableHead className="text-right">Total float</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {cpm.activities.map((a) => (
              <TableRow
                key={a.id}
                className={cn(
                  a.critical &&
                    "bg-emerald-50/70 font-medium dark:bg-emerald-950/40 dark:font-normal",
                )}
              >
                <TableCell>
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="truncate font-mono text-xs text-muted-foreground">{a.id}</span>
                    <span className="max-w-[220px] truncate">{a.name}</span>
                  </span>
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">{a.durationDays}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{a.es}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{a.ef}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{a.ls}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{a.lf}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  <span className="flex items-center justify-end gap-1.5">
                    {a.totalFloat}
                    {a.critical ? (
                      <Badge className="border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                        critical
                      </Badge>
                    ) : null}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <InfoNote>
        ES/EF = earliest start/finish, LS/LF = latest start/finish (days from project start), total
        float = LS − ES. Critical activities have zero float — a delay on any of them delays the
        project. All numbers are the platform core&apos;s eos-cpm/1 result, rendered verbatim.
      </InfoNote>
    </div>
  )
}

function GanttView({ cpm }: { cpm: CpmAnalysisPayload }) {
  const duration = cpm.durationDays
  if (!Number.isFinite(duration) || duration <= 0) {
    return (
      <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
        Project duration is {Number.isFinite(duration) ? duration : "—"} day(s) — all activities are
        zero-duration milestones, so there are no bars to scale.
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-muted/20 p-3">
      <p className="text-xs font-medium text-muted-foreground">
        Read-only Gantt — bars scaled to the {duration}-day project duration (no editing, no drag)
      </p>
      <ol className="flex flex-col gap-1.5" aria-label="Gantt bars per activity">
        {cpm.activities.map((a) => {
          const left = Number.isFinite(a.es) ? (a.es / duration) * 100 : 0
          const span = Number.isFinite(a.ef) ? a.ef - a.es : 0
          const width = Math.max((span / duration) * 100, span === 0 ? 0.6 : 0.75)
          const label = `${a.id} (${a.name}): day ${a.es}–${a.ef}${a.critical ? " — critical" : ""}`
          return (
            <li key={a.id} className="flex items-center gap-2">
              <span className="w-24 shrink-0 truncate font-mono text-[11px] text-muted-foreground" title={a.id}>
                {a.id}
              </span>
              <span className="relative h-3.5 min-w-0 flex-1 rounded-full bg-muted/60" aria-hidden>
                <span
                  className={cn(
                    "absolute top-0 h-3.5 rounded-full",
                    a.critical
                      ? "bg-emerald-600 dark:bg-emerald-500"
                      : "bg-stone-400 dark:bg-stone-600",
                  )}
                  style={{ left: `${Math.max(left, 0)}%`, width: `${Math.min(width, 100 - left)}%` }}
                />
              </span>
              <span className="sr-only">{label}</span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

// ---------------------------------------------------------------------------
// New schedule dialog (activity editor → canonical eos-schedule/1)
// ---------------------------------------------------------------------------

interface DraftRow {
  key: number
  id: string
  name: string
  durationDays: string
  predecessorIds: string
}

let draftRowSeq = 0
function newDraftRow(idSuggestion: string): DraftRow {
  draftRowSeq += 1
  return { key: draftRowSeq, id: idSuggestion, name: "", durationDays: "", predecessorIds: "" }
}

function NewScheduleDialog({
  projectId,
  open,
  onOpenChange,
  onCreated,
}: {
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (artifact: ArtifactListItem) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>New schedule</DialogTitle>
          <DialogDescription>
            Compose activities with durations and predecessors; the dialog builds the canonical{" "}
            <span className="font-mono">eos-schedule/1</span> JSON and registers it as a{" "}
            <span className="font-mono">schedule</span> artifact (revision 1). The same pure core
            the server runs validates the form — its exact verbatim messages appear below.
          </DialogDescription>
        </DialogHeader>
        {/* Radix unmounts DialogContent on close, so the form component below —
            and ALL of its state — dies with it: every open starts fresh, with
            no reset effects (react-hooks/set-state-in-effect compliant). */}
        <NewScheduleForm projectId={projectId} close={() => onOpenChange(false)} onCreated={onCreated} />
      </DialogContent>
    </Dialog>
  )
}

function NewScheduleForm({
  projectId,
  close,
  onCreated,
}: {
  projectId: string
  close: () => void
  onCreated: (artifact: ArtifactListItem) => void
}) {
  const [name, setName] = useState("")
  const [rows, setRows] = useState<DraftRow[]>(() => [
    newDraftRow("a1"),
    newDraftRow("a2"),
  ])
  const [validationError, setValidationError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const addRow = () => {
    const existing = new Set(rows.map((r) => r.id.trim()).filter(Boolean))
    let n = rows.length + 1
    while (existing.has(`a${n}`)) n += 1
    setRows((prev) => [...prev, newDraftRow(`a${n}`)])
  }

  const removeRow = (key: number) => {
    setRows((prev) => prev.filter((r) => r.key !== key))
  }

  const setRow = (key: number, patch: Partial<Omit<DraftRow, "key">>) => {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  }

  /** Build the §3.1 document from the editor rows (blank rows are omitted). */
  const buildActivities = (): ScheduleActivityInput[] =>
    rows
      .filter((r) => r.id.trim() !== "" || r.name.trim() !== "" || r.durationDays.trim() !== "" || r.predecessorIds.trim() !== "")
      .map((r) => ({
        id: r.id.trim(),
        name: r.name.trim(),
        durationDays: r.durationDays.trim() === "" ? Number.NaN : Number(r.durationDays),
        predecessorIds: r.predecessorIds
          .split(/[,\s]+/)
          .map((p) => p.trim())
          .filter(Boolean),
      }))

  const activities = buildActivities()

  /** The REAL pure-core parse — the exact verbatim 422 material the server enforces. */
  const parseResult = useMemo(() => {
    if (name.trim() === "" && activities.length === 0) return null
    return parseSchedule({
      format: "eos-schedule/1",
      name: name.trim(),
      activities,
    })
  }, [name, activities])

  const canonicalPreview =
    parseResult && parseResult.ok ? canonicalScheduleJson(parseResult.value) : null

  const submit = async () => {
    if (submitting) return
    if (name.trim() === "") {
      setValidationError("schedule name is required")
      return
    }
    if (activities.length === 0) {
      setValidationError("invalid schedule: at least one activity is required — add a row with an id")
      return
    }
    const parsed = parseSchedule({
      format: "eos-schedule/1",
      name: name.trim(),
      activities,
    })
    if (!parsed.ok) {
      // The pure core's verbatim, joined message — identical to the server's 422.
      setValidationError(parsed.error)
      return
    }
    setValidationError(null)
    setSubmitting(true)
    try {
      const data = await createSchedule(projectId, {
        format: "eos-schedule/1",
        name: parsed.value.name,
        activities: parsed.value.activities,
      })
      toast.success(
        `Schedule "${data.artifact.name}" registered as artifact kind schedule (revision 1) — run Analyze to compute the critical path`,
      )
      close()
      onCreated(data.artifact)
    } catch (err) {
      // Server 422 (zod defense-in-depth) surfaces verbatim.
      setValidationError(err instanceof Error ? err.message : "Could not create the schedule")
      toast.error(err instanceof Error ? err.message : "Could not create the schedule")
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
      <div className="space-y-2">
        <Label htmlFor="schedule-name">
          Schedule name <span aria-hidden className="text-destructive">*</span>
        </Label>
        <Input
          id="schedule-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Harbour View — piling programme"
          maxLength={200}
          autoFocus
        />
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">
          Activities <span className="text-xs font-normal text-muted-foreground">(1–64 · ids: lowercase letters, digits, dashes)</span>
        </legend>
        <div className="eos-scroll max-h-72 overflow-y-auto rounded-lg border p-2">
          <table className="w-full min-w-[560px] text-sm">
            <caption className="sr-only">Activity editor — id, name, duration in days, comma-separated predecessor ids</caption>
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th scope="col" className="px-1 pb-1 font-medium">Id</th>
                <th scope="col" className="px-1 pb-1 font-medium">Name</th>
                <th scope="col" className="w-20 px-1 pb-1 font-medium">Days</th>
                <th scope="col" className="px-1 pb-1 font-medium">Predecessors</th>
                <th scope="col" className="w-10 px-1 pb-1 font-medium" aria-label="Remove row" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <td className="p-1">
                    <Input
                      value={row.id}
                      onChange={(e) => setRow(row.key, { id: e.target.value })}
                      aria-label={`Activity ${row.key} id`}
                      className="h-9 font-mono text-xs"
                      placeholder="a1"
                      maxLength={32}
                    />
                  </td>
                  <td className="p-1">
                    <Input
                      value={row.name}
                      onChange={(e) => setRow(row.key, { name: e.target.value })}
                      aria-label={`Activity ${row.key} name`}
                      className="h-9"
                      placeholder="e.g. Pile caps"
                      maxLength={200}
                    />
                  </td>
                  <td className="p-1">
                    <Input
                      type="number"
                      min={0}
                      max={10000}
                      value={row.durationDays}
                      onChange={(e) => setRow(row.key, { durationDays: e.target.value })}
                      aria-label={`Activity ${row.key} duration in days`}
                      className="h-9 font-mono tabular-nums"
                      placeholder="0"
                    />
                  </td>
                  <td className="p-1">
                    <Input
                      value={row.predecessorIds}
                      onChange={(e) => setRow(row.key, { predecessorIds: e.target.value })}
                      aria-label={`Activity ${row.key} predecessor ids, comma separated`}
                      className="h-9 font-mono text-xs"
                      placeholder="e.g. a1, a2"
                    />
                  </td>
                  <td className="p-1 text-right">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-9"
                      aria-label={`Remove activity row ${row.key}`}
                      onClick={() => removeRow(row.key)}
                    >
                      <Trash2 className="size-4" aria-hidden />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Button type="button" variant="outline" className="h-9" onClick={addRow}>
          <Plus aria-hidden /> Add activity
        </Button>
        <p className="text-xs text-muted-foreground">
          Predecessors are comma-separated activity ids from the rows above. Zero-duration
          activities are allowed (milestones). Cycles and unknown predecessors are refused with the
          exact server messages.
        </p>
      </fieldset>

      {validationError ? (
        <Alert variant="destructive" role="alert">
          <AlertTriangle aria-hidden />
          <AlertTitle>Invalid schedule</AlertTitle>
          <AlertDescription>
            <span className="break-words font-mono text-xs">{validationError}</span>
          </AlertDescription>
        </Alert>
      ) : null}

      {canonicalPreview ? (
        <div className="space-y-1.5">
          <p className="text-sm font-medium">
            Canonical JSON preview{" "}
            <span className="text-xs font-normal text-muted-foreground">
              (sent to the server exactly as shown)
            </span>
          </p>
          <pre className="eos-scroll max-h-56 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
            {canonicalPreview}
          </pre>
        </div>
      ) : (
        <p className="rounded-lg border border-dashed px-4 py-4 text-center text-xs text-muted-foreground">
          Fill in a schedule name and at least one activity — the canonical eos-schedule/1 JSON is
          validated and previewed here before it is sent.
        </p>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={close}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting ? "Registering…" : "Register schedule"}
        </Button>
      </DialogFooter>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Estimates panel (recompute machine)
// ---------------------------------------------------------------------------

interface StaleSource {
  artifactId: string
  name: string
  reasons: string[]
}

function EstimateCard({
  estimate,
  staleSources,
  recomputing,
  onRecompute,
}: {
  estimate: EstimateRow
  staleSources: StaleSource[]
  recomputing: boolean
  onRecompute: () => void
}) {
  const hasStale = staleSources.length > 0
  return (
    <Card className={cn(hasStale && "border-amber-300 dark:border-amber-800")}>
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h4 className="flex flex-wrap items-center gap-2 text-sm font-semibold tracking-tight">
              <span className="truncate" title={estimate.id}>
                {estimate.name}
              </span>
              <ApprovalBadge state={estimate.status} />
            </h4>
            <p className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
              <span className="font-mono tabular-nums">
                {formatMoney(estimate.totals.grandTotal, estimate.totals.currency)}
              </span>
              <span>· {estimate.lines.length} line{estimate.lines.length === 1 ? "" : "s"}</span>
              {estimate.approval ? (
                <span title={estimate.approval.approvedAt}>
                  · approved {formatDate(estimate.approval.approvedAt)} by{" "}
                  {estimate.approval.approvedBy}
                </span>
              ) : null}
            </p>
          </div>
        </div>

        {hasStale ? (
          <>
            <Alert className="border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
              <TriangleAlert aria-hidden />
              <AlertTitle>Stale quantity sources behind this estimate</AlertTitle>
              <AlertDescription className="text-amber-900/90 dark:text-amber-300/90">
                <ul className="list-inside list-disc space-y-0.5">
                  {staleSources.map((s) => (
                    <li key={s.artifactId} className="break-words">
                      <span className="font-medium">{s.name}</span>
                      <span> — {s.reasons.join("; ")}</span>
                    </li>
                  ))}
                </ul>
                Recompute creates a NEW draft that absorbs the current quantity rows and the
                currently-effective rates. This approved estimate stays untouched — its lines are
                frozen for audit.
              </AlertDescription>
            </Alert>
            <GuardedButton className="h-10 self-start" disabled={recomputing} onClick={onRecompute}>
              {recomputing ? <Loader2 className="animate-spin" aria-hidden /> : <ClipboardList aria-hidden />}
              {recomputing ? "Recomputing…" : "Create revised draft"}
            </GuardedButton>
          </>
        ) : (
          <p className="text-xs leading-relaxed text-muted-foreground">
            No stale quantity sources — this estimate reflects the current quantity rows and rates.
            A revised draft is created only when at least one source artifact behind its lines has
            moved on or carries a staleness mark.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

const noop = () => {}

interface AnalysisViewState {
  scheduleId: string
  scheduleName: string
  loading: boolean
  error: string | null
  cpm: CpmAnalysisPayload | null
  run: DeriveRunResult | null
  raw: string | null
}

export function ControlsWorkspace({
  projectId,
  onMutated,
}: {
  projectId: string
  /** Parent-side cache nudge: schedule creation and analysis runs create
   *  artifacts the project-level caches don't observe on their own (useApi is
   *  manual-refresh — the Phase-4 Artifacts-tab lesson, now a standard). */
  onMutated?: () => void
}) {
  const artifacts = useApi<{ artifacts: ArtifactListItem[] }>(`/api/projects/${projectId}/artifacts`)
  const estimates = useApi<{ estimates: EstimateRow[] }>(`/api/projects/${projectId}/estimates`)
  const quantities = useApi<{ quantities: QuantityRow[] }>(`/api/projects/${projectId}/quantities`)
  const notifyMutated = onMutated ?? noop

  const [tab, setTab] = useState<"schedules" | "estimates">("schedules")
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [analyzingId, setAnalyzingId] = useState<string | null>(null)
  const [analysisView, setAnalysisView] = useState<AnalysisViewState | null>(null)
  const [recomputingId, setRecomputingId] = useState<string | null>(null)

  const artifactRows = useMemo(() => artifacts.data?.artifacts ?? [], [artifacts.data])
  const scheduleRows = useMemo(
    () => artifactRows.filter((a) => a.kind === "schedule"),
    [artifactRows],
  )
  const estimateRows = useMemo(() => estimates.data?.estimates ?? [], [estimates.data])
  const quantityRows = useMemo(() => quantities.data?.quantities ?? [], [quantities.data])

  // --- client-side staleness hint (real data only; the server gate wins) ----
  const quantityIndex = useMemo(() => {
    const map = new Map<string, QuantityRow>()
    for (const q of quantityRows) map.set(q.id, q)
    return map
  }, [quantityRows])

  const artifactIndex = useMemo(() => {
    const map = new Map<string, ArtifactListItem>()
    for (const a of artifactRows) map.set(a.id, a)
    return map
  }, [artifactRows])

  const staleSourcesByEstimate = useMemo(() => {
    const map = new Map<string, StaleSource[]>()
    for (const estimate of estimateRows) {
      if (estimate.status !== "approved") continue
      const byArtifact = new Map<string, StaleSource>()
      for (const line of estimate.lines) {
        const q = quantityIndex.get(line.quantityId)
        if (!q || !q.sourceArtifact) continue
        const artifact = artifactIndex.get(q.sourceArtifact.id)
        if (!artifact || !artifact.latestRevision) continue
        const reasons: string[] = []
        if (artifact.latestRevision.staleness === "stale") {
          reasons.push("flagged stale by a source revision (Journey-G staleness cascade)")
        }
        if (artifact.latestRevision.revNumber > q.sourceArtifact.revNumber) {
          reasons.push(
            `its quantity row was taken at r${q.sourceArtifact.revNumber}; the artifact is now at r${artifact.latestRevision.revNumber}`,
          )
        }
        if (reasons.length > 0) {
          const existing = byArtifact.get(artifact.id)
          if (existing) existing.reasons.push(...reasons)
          else byArtifact.set(artifact.id, { artifactId: artifact.id, name: artifact.name, reasons })
        }
      }
      if (byArtifact.size > 0) {
        map.set(estimate.id, Array.from(byArtifact.values()))
      }
    }
    return map
  }, [estimateRows, quantityIndex, artifactIndex])

  // --- analyze ----------------------------------------------------------------

  const analyze = async (schedule: ArtifactListItem) => {
    if (analyzingId !== null) return
    setAnalyzingId(schedule.id)
    setAnalysisView({
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      loading: true,
      error: null,
      cpm: null,
      run: null,
      raw: null,
    })
    try {
      const data = await analyzeSchedule(projectId, schedule.id)
      const run = data.analysis
      const cpm = extractCpmFromRun(run)
      if (cpm !== null) {
        setAnalysisView({
          scheduleId: schedule.id,
          scheduleName: schedule.name,
          loading: false,
          error: null,
          cpm,
          run,
          raw: null,
        })
        toast.success(
          `Critical-path analysis complete — ${cpm.durationDays}-day project duration, ${cpm.criticalPath.length} critical activities (stored as an analysis artifact)`,
        )
      } else {
        // Fallback: the 201 body may carry identity only; the stored payload
        // is read through the revision download URL (honest 404 handling).
        const fresh = await artifacts.refresh()
        const row = (fresh?.artifacts ?? []).find((a) => a.id === run.artifactId)
        const revId = row?.latestRevision?.id ?? null
        let fromStore: CpmAnalysisPayload | null = null
        let storeRaw: string | null = null
        let storeError: string | null = null
        if (revId !== null) {
          try {
            const text = await fetchRevisionText(revId)
            const parsed: unknown = JSON.parse(text)
            fromStore = readCpmPayload(parsed)
            if (fromStore === null) storeRaw = text
          } catch (err) {
            storeError = err instanceof Error ? err.message : "Could not read the stored analysis payload"
          }
        }
        if (fromStore !== null) {
          setAnalysisView({
            scheduleId: schedule.id,
            scheduleName: schedule.name,
            loading: false,
            error: null,
            cpm: fromStore,
            run,
            raw: null,
          })
          toast.success(
            `Critical-path analysis complete — ${fromStore.durationDays}-day project duration (stored payload read from the analysis revision)`,
          )
        } else {
          setAnalysisView({
            scheduleId: schedule.id,
            scheduleName: schedule.name,
            loading: false,
            error:
              storeError ??
              "the analysis artifact was created, but its eos-cpm/1 payload could not be read in this session",
            cpm: null,
            run,
            raw: storeRaw ?? JSON.stringify(data, null, 2),
          })
          toast.warning("Analysis stored — see the analysis view for what could be read")
        }
      }
      // Cache nudges: the analysis artifact + audit event land in caches this
      // workspace does not own.
      void estimates.refresh()
      notifyMutated()
    } catch (err) {
      // 422s (schedule shape, cycle) surface verbatim.
      toast.error(err instanceof Error ? err.message : "Analysis failed")
      setAnalysisView({
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        loading: false,
        error: err instanceof Error ? err.message : "Analysis failed",
        cpm: null,
        run: null,
        raw: null,
      })
    } finally {
      setAnalyzingId(null)
    }
  }

  // --- recompute ----------------------------------------------------------------

  const recompute = async (estimate: EstimateRow, staleSources: StaleSource[]) => {
    if (recomputingId !== null) return
    setRecomputingId(estimate.id)
    try {
      const data = await recomputeEstimate(estimate.id)
      // Name the absorbed stale sources: prefer the server's own list when it
      // mirrors the audit detail; fall back to the sources this UI detected.
      const serverIds = Array.isArray(data.staleSourceArtifactIds) ? data.staleSourceArtifactIds : []
      const names = (
        serverIds.length > 0
          ? serverIds.map((id) => artifactIndex.get(id)?.name ?? id)
          : staleSources.map((s) => s.name)
      ).join(", ")
      const newName = data.estimate?.name ?? "the revised draft"
      toast.success(
        `Revised draft created — ${newName} absorbed the stale source${serverIds.length > 1 || staleSources.length > 1 ? "s" : ""}: ${names}. Continue in Takeoff & Estimating → Estimates.`,
      )
      void estimates.refresh()
      void artifacts.refresh()
      notifyMutated()
    } catch (err) {
      // Verbatim: only-approved guard, nothing-stale guard, unknown estimate.
      toast.error(err instanceof Error ? err.message : "Recompute failed")
    } finally {
      setRecomputingId(null)
    }
  }

  const approvedEstimates = estimateRows.filter((e) => e.status === "approved")

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight">
          <ClipboardList className="size-4 text-muted-foreground" aria-hidden /> Project Controls
        </h2>
        <Alert>
          <Info aria-hidden />
          <AlertTitle>Schedules, critical paths and refreshed estimates</AlertTitle>
          <AlertDescription>
            Schedules are canonical <span className="font-mono">eos-schedule/1</span> artifacts;
            analysis runs the platform&apos;s CPM core through the broker (no engine — the
            provenance record says so honestly) and stores an{" "}
            <span className="font-mono">analysis</span> artifact linked to the schedule. Approved
            estimates whose quantity sources moved on get a revised draft through the real
            recompute route; the original stays frozen for audit.
          </AlertDescription>
        </Alert>
      </header>

      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList aria-label="Project Controls sections">
          <TabsTrigger value="schedules">Schedules</TabsTrigger>
          <TabsTrigger value="estimates">Estimates</TabsTrigger>
        </TabsList>

        {/* ---------------- Schedules ---------------- */}
        <TabsContent value="schedules" className="mt-4 flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold tracking-tight">Schedules ({scheduleRows.length})</h3>
            <span className="text-xs text-muted-foreground">artifact kind schedule</span>
            {analyzingId !== null ? (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
                <Loader2 className="size-3.5 animate-spin" aria-hidden /> analyzing…
              </span>
            ) : null}
            <GuardedButton className="ml-auto h-10" onClick={() => setScheduleOpen(true)}>
              <Plus aria-hidden /> New schedule
            </GuardedButton>
          </div>

          {artifacts.error ? (
            <ErrorState message={artifacts.error} onRetry={() => void artifacts.refresh()} />
          ) : artifacts.loading ? (
            <div className="rounded-lg border p-4">
              <Skeleton className="mb-2 h-10 w-full" />
              <Skeleton className="h-10 w-2/3" />
            </div>
          ) : scheduleRows.length === 0 ? (
            <EmptyState
              icon={ClipboardList}
              title="No schedules yet — create the first one"
              description="Compose activities with durations and predecessors; the canonical schedule JSON is registered as an artifact and analyzed by the platform's critical-path core."
              actionLabel="New schedule"
              onAction={() => setScheduleOpen(true)}
            />
          ) : (
            <div className="eos-scroll max-h-[28rem] overflow-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead className="text-center">Rev</TableHead>
                    <TableHead className="text-right">Size</TableHead>
                    <TableHead>Review state</TableHead>
                    <TableHead>Staleness</TableHead>
                    <TableHead className="text-right">Updated</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {scheduleRows.map((schedule) => (
                    <TableRow key={schedule.id}>
                      <TableCell className="max-w-[260px] truncate font-medium" title={schedule.id}>
                        {schedule.name}
                      </TableCell>
                      <TableCell>
                        <KindBadge kind={schedule.kind} />
                      </TableCell>
                      <TableCell className="text-center font-mono text-xs">
                        {schedule.latestRevision ? `r${schedule.latestRevision.revNumber}` : "—"}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {schedule.latestRevision ? humanBytes(schedule.latestRevision.sizeBytes) : "—"}
                      </TableCell>
                      <TableCell>
                        {schedule.latestRevision ? (
                          <ApprovalBadge state={schedule.latestRevision.approvalState} />
                        ) : (
                          <span className="text-xs text-muted-foreground">No revisions</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {schedule.latestRevision ? <StalenessBadge state={schedule.latestRevision.staleness} /> : null}
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground" title={schedule.updatedAt}>
                        {relTime(schedule.updatedAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        <GuardedButton
                          variant="outline"
                          className="h-9"
                          disabled={analyzingId !== null}
                          onClick={() => void analyze(schedule)}
                          aria-label={`Analyze schedule ${schedule.name} (critical path)`}
                        >
                          {analyzingId === schedule.id ? (
                            <Loader2 className="animate-spin" aria-hidden />
                          ) : (
                            <Play aria-hidden />
                          )}
                          {analyzingId === schedule.id ? "Analyzing…" : "Analyze"}
                        </GuardedButton>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {/* ---------------- CPM analysis view ---------------- */}
          {analysisView !== null ? (
            <Card>
              <CardContent className="flex flex-col gap-4 p-4 sm:p-6">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h4 className="flex flex-wrap items-center gap-2 text-sm font-semibold tracking-tight">
                      <span className="truncate">Critical-path analysis — {analysisView.scheduleName}</span>
                      <Badge variant="outline" className="font-mono text-[11px]">
                        eos-cpm/1
                      </Badge>
                      <Badge variant="outline" className="text-muted-foreground" title="platform core — no engine, honestly recorded">
                        platform core
                      </Badge>
                    </h4>
                    {analysisView.run ? (
                      <p className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                        <span title={analysisView.run.artifactId}>
                          stored as analysis artifact {analysisView.run.name}
                          {analysisView.run.revisionNumber ? ` r${analysisView.run.revisionNumber}` : ""}
                        </span>
                        {analysisView.run.durationMs !== undefined && analysisView.run.durationMs !== null ? (
                          <span className="font-mono tabular-nums">
                            · computed in {analysisView.run.durationMs} ms
                          </span>
                        ) : null}
                        {analysisView.run.engineKey ? (
                          <span className="font-mono">· engine {analysisView.run.engineKey}</span>
                        ) : (
                          <span>· no engine — pure platform math (engineKey honestly absent)</span>
                        )}
                      </p>
                    ) : null}
                  </div>
                </div>

                {analysisView.loading ? (
                  <div className="flex flex-col gap-3" role="status" aria-label="Analyzing schedule">
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-24 w-full" />
                    <Skeleton className="h-24 w-2/3" />
                  </div>
                ) : analysisView.cpm !== null ? (
                  <>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                      <span className="font-mono text-sm tabular-nums" title="project duration (max EF)">
                        {analysisView.cpm.durationDays} day{analysisView.cpm.durationDays === 1 ? "" : "s"} project duration
                      </span>
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="text-xs font-medium text-muted-foreground">Critical path:</span>
                        <CriticalPathChips cpm={analysisView.cpm} />
                      </span>
                    </div>
                    <CpmTableView cpm={analysisView.cpm} />
                    <GanttView cpm={analysisView.cpm} />
                    <InfoNote>
                      The analysis is stored as a derived <span className="font-mono">analysis</span>{" "}
                      artifact (eos-cpm/1, byte-deterministic) linked to the schedule — revising the
                      schedule marks it stale. Re-analyzing appends a new revision; the old result
                      stays for audit.
                    </InfoNote>
                  </>
                ) : (
                  <Alert variant="destructive" role="alert">
                    <AlertTriangle aria-hidden />
                    <AlertTitle>Analysis stored, but the CPM view could not be read</AlertTitle>
                    <AlertDescription className="flex flex-col gap-2">
                      <span className="break-words font-mono text-xs">{analysisView.error}</span>
                      {analysisView.raw ? (
                        <pre className="eos-scroll max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
                          {analysisView.raw.slice(0, 2000)}
                        </pre>
                      ) : null}
                      <span className="text-xs">
                        The raw server response above is verbatim — nothing was invented to fill the
                        gap. Re-run Analyze after the backend settles.
                      </span>
                    </AlertDescription>
                  </Alert>
                )}
              </CardContent>
            </Card>
          ) : !artifacts.loading && !artifacts.error && scheduleRows.length > 0 ? (
            <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
              Press Analyze on a schedule to compute and display its critical path.
            </p>
          ) : null}
        </TabsContent>

        {/* ---------------- Estimates (recompute panel) ---------------- */}
        <TabsContent value="estimates" className="mt-4 flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold tracking-tight">
              Approved estimates ({approvedEstimates.length})
            </h3>
            <span className="text-xs text-muted-foreground">
              the recompute machine — drafts and in-review estimates stay in Takeoff &amp; Estimating
            </span>
            {recomputingId !== null ? (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
                <Loader2 className="size-3.5 animate-spin" aria-hidden /> recomputing…
              </span>
            ) : null}
          </div>

          {estimates.error ? (
            <ErrorState message={estimates.error} onRetry={() => void estimates.refresh()} />
          ) : quantities.error ? (
            <ErrorState message={quantities.error} onRetry={() => void quantities.refresh()} />
          ) : estimates.loading || quantities.loading ? (
            <div className="grid gap-4 sm:grid-cols-2" aria-label="Loading estimates">
              <Skeleton className="h-40" />
              <Skeleton className="h-40" />
            </div>
          ) : approvedEstimates.length === 0 ? (
            <EmptyState
              icon={Sigma}
              title="No approved estimates"
              description="Create and approve an estimate in Takeoff & Estimating first. Once approved, its lines freeze — this panel then tracks whether the quantity sources behind them move on."
            />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {approvedEstimates.map((estimate) => (
                <EstimateCard
                  key={estimate.id}
                  estimate={estimate}
                  staleSources={staleSourcesByEstimate.get(estimate.id) ?? []}
                  recomputing={recomputingId !== null}
                  onRecompute={() =>
                    void recompute(estimate, staleSourcesByEstimate.get(estimate.id) ?? [])
                  }
                />
              ))}
            </div>
          )}

          <InfoNote>
            “Create revised draft” calls POST /api/estimates/[id]/recompute: the server rebuilds the
            lines from the project&apos;s CURRENT quantity rows, prices them at currently-effective
            rates, and returns a NEW draft titled “&lt;original&gt; — revised draft”. The approved
            original is never edited — its lines stay frozen for audit. The client&apos;s stale-source
            hint reads real staleness marks and revision numbers; the server&apos;s gate is
            authoritative and its refusals (e.g. “nothing to recompute: no quantity source behind
            this estimate is stale”) surface verbatim.
          </InfoNote>
        </TabsContent>
      </Tabs>

      <NewScheduleDialog
        projectId={projectId}
        open={scheduleOpen}
        onOpenChange={setScheduleOpen}
        onCreated={() => {
          // The new schedule lands in the register via the artifacts refresh;
          // the project-level caches hear about it through the nudge.
          void artifacts.refresh()
          notifyMutated()
        }}
      />
    </div>
  )
}
