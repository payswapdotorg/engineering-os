"use client"

/**
 * Takeoff & Estimating workspace (W1 lane, Phase 3 vertical slice; Sheet
 * Measure tab added in Slice 8 / lane 8-b).
 *
 * Four inner tabs over the pinned API contracts: Quantity Ledger, Assemblies
 * & Rates, Estimates, Sheet Measure. Honesty rules this UI follows:
 *  - drawing-measured and model-derived quantities are visually distinct
 *    (amber vs emerald) and are never merged or re-labeled;
 *  - estimate math NEVER happens client-side — line totals and totals come
 *    from the server (deterministic, src/core/ledger.ts) and are refetched
 *    after every mutation; there are no optimistic updates anywhere;
 *  - server 422 messages (transition guards, approve blockers, missing rates)
 *    surface verbatim in toasts;
 *  - Sheet Measure rows are real drawing-measured records from the calibrated
 *    pdf.js surface (sheet-measure.tsx) — the same ledger, the same gates.
 */
import { Boxes, ChevronDown, ClipboardList, Download, Info, Layers, Plus, Ruler, Sigma, Trash2 } from "lucide-react"
import { useMemo, useState } from "react"
import { toast } from "sonner"

import {
  exportEstimateBoqCsv,
  removeEstimateLine,
  transitionEstimate,
  transitionQuantity,
  useApi,
  type ArtifactListItem,
  type AssemblyRow,
  type EstimateRow,
  type EstimateTransitionAction,
  type QuantityRow,
  type QuantityTransitionAction,
  type RateRow,
} from "@/components/product/api"
import { ApprovalBadge, FutureRateBadge } from "@/components/product/badges"
import { formatDate } from "@/components/product/format"
import { GuardedButton } from "@/components/product/guarded-button"
import { EmptyState, ErrorState, InfoNote, RowSkeleton } from "@/components/product/parts"
import {
  AddEstimateLineDialog,
  AddRateDialog,
  DeriveQuantitiesDialog,
  NewAssemblyDialog,
  NewEstimateDialog,
  RecordQuantityDialog,
  SupersedeEstimateDialog,
  type ArtifactSourceState,
} from "@/components/product/takeoff-dialogs"
import { SheetMeasure } from "@/components/product/sheet-measure"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Separator } from "@/components/ui/separator"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// Local display helpers
// ---------------------------------------------------------------------------

/**
 * Method badge — the two quantity origins are deliberately distinct colors:
 * amber for drawing-measured, emerald for model-derived (consistent with the
 * badges.tsx palette; never blue/indigo). A reviewer can always see where a
 * number came from at a glance.
 */
function MethodBadge({ method }: { method: string }) {
  if (method === "model-derived") {
    return (
      <Badge className="border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
        model-derived
      </Badge>
    )
  }
  return (
    <Badge className="border-amber-300 bg-amber-100 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
      drawing-measured
    </Badge>
  )
}

/** Rate source badge — engineer-entered provenance (see AddRateDialog). */
function RateSourceBadge({ source }: { source: string }) {
  switch (source) {
    case "contract":
      return (
        <Badge className="border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
          contract
        </Badge>
      )
    case "quote":
      return (
        <Badge className="border-amber-300 bg-amber-100 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
          quote
        </Badge>
      )
    case "price-book":
    default:
      return <Badge variant="outline" className="text-muted-foreground">price-book</Badge>
  }
}

/** Display-only currency formatting — the numbers themselves are server-computed. */
function formatMoney(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(value)
  } catch {
    // Unknown currency code — render explicitly rather than crash the table.
    return `${currency} ${value.toFixed(2)}`
  }
}

function formatAmount(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(value)
}

const QUANTITY_TRANSITION_TOAST: Record<QuantityTransitionAction, string> = {
  submit: "Quantity submitted for review",
  approve: "Quantity approved",
  reject: "Quantity returned to draft",
  supersede: "Quantity superseded — kept in the ledger for audit",
}

const ESTIMATE_TRANSITION_TOAST: Record<EstimateTransitionAction, string> = {
  submit: "Estimate submitted for review",
  approve: "Estimate approved",
  reject: "Estimate returned to draft",
  supersede: "Estimate superseded — kept in the ledger for audit",
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

const noop = () => {}

export function TakeoffWorkspace({
  projectId,
  onMutated,
}: {
  projectId: string
  /** Parent-side cache nudge (Phase-6 known-limitation #13): the
   *  derive-quantities action appends audit events (and can surface failures
   *  that change source staleness) the project-level caches don't observe on
   *  their own — the AgentsWorkspace.onMutated pattern, mirrored exactly. */
  onMutated?: () => void
}) {
  const quantities = useApi<{ quantities: QuantityRow[] }>(`/api/projects/${projectId}/quantities`)
  const assemblies = useApi<{ assemblies: AssemblyRow[] }>(`/api/projects/${projectId}/assemblies`)
  const rates = useApi<{ rates: RateRow[] }>(`/api/projects/${projectId}/rates`)
  const estimates = useApi<{ estimates: EstimateRow[] }>(`/api/projects/${projectId}/estimates`)
  const artifacts = useApi<{ artifacts: ArtifactListItem[] }>(`/api/projects/${projectId}/artifacts`)
  const notifyMutated = onMutated ?? noop

  const [tab, setTab] = useState<"ledger" | "assemblies" | "estimates" | "sheet">("ledger")

  const [recordOpen, setRecordOpen] = useState(false)
  const [deriveOpen, setDeriveOpen] = useState(false)
  const [assemblyOpen, setAssemblyOpen] = useState(false)
  const [rateOpen, setRateOpen] = useState(false)
  const [estimateOpen, setEstimateOpen] = useState(false)
  const [lineOpen, setLineOpen] = useState(false)
  const [supersedeOpen, setSupersedeOpen] = useState(false)
  const [selectedEstimateId, setSelectedEstimateId] = useState<string | null>(null)

  // One mutation in flight per action family — no optimistic updates anywhere.
  const [transitioningId, setTransitioningId] = useState<string | null>(null)
  const [estimateAction, setEstimateAction] = useState<EstimateTransitionAction | null>(null)
  const [removingLineId, setRemovingLineId] = useState<string | null>(null)
  const [exportingBoq, setExportingBoq] = useState(false)

  const quantityRows = quantities.data?.quantities ?? []
  const assemblyRows = assemblies.data?.assemblies ?? []
  const rateRows = rates.data?.rates ?? []
  const estimateRows = estimates.data?.estimates ?? []

  const selectedEstimate = estimateRows.find((e) => e.id === selectedEstimateId) ?? null

  // Rates reference components by id — index assemblies once for the rates table.
  const componentIndex = useMemo(() => {
    const map = new Map<string, { name: string; kind: string; assemblyName: string }>()
    for (const assembly of assemblyRows) {
      for (const component of assembly.components) {
        map.set(component.id, { name: component.name, kind: component.kind, assemblyName: assembly.name })
      }
    }
    return map
  }, [assemblyRows])

  const quantityIndex = useMemo(() => {
    const map = new Map<string, QuantityRow>()
    for (const q of quantityRows) map.set(q.id, q)
    return map
  }, [quantityRows])

  const assemblyIndex = useMemo(() => {
    const map = new Map<string, AssemblyRow>()
    for (const a of assemblyRows) map.set(a.id, a)
    return map
  }, [assemblyRows])

  const artifactSource: ArtifactSourceState = {
    rows: artifacts.data?.artifacts ?? [],
    loading: artifacts.loading,
    error: artifacts.error,
    onRetry: () => void artifacts.refresh(),
  }

  // -- transitions (server-enforced; 422s surface verbatim) ------------------

  const applyQuantityTransition = async (quantity: QuantityRow, action: QuantityTransitionAction) => {
    if (transitioningId !== null) return
    setTransitioningId(quantity.id)
    try {
      await transitionQuantity(quantity.id, action)
      toast.success(QUANTITY_TRANSITION_TOAST[action])
      void quantities.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Transition failed")
    } finally {
      setTransitioningId(null)
    }
  }

  const applyEstimateTransition = async (estimate: EstimateRow, action: EstimateTransitionAction) => {
    if (estimateAction !== null) return
    setEstimateAction(action)
    try {
      await transitionEstimate(estimate.id, action)
      toast.success(ESTIMATE_TRANSITION_TOAST[action])
      void estimates.refresh()
    } catch (err) {
      // Approve gate blockers (unapproved quantities, currency mismatches) are
      // listed by the server — show the list verbatim.
      toast.error(err instanceof Error ? err.message : "Transition failed")
    } finally {
      setEstimateAction(null)
    }
  }

  const removeLine = async (estimate: EstimateRow, lineId: string) => {
    if (removingLineId !== null) return
    setRemovingLineId(lineId)
    try {
      await removeEstimateLine(estimate.id, lineId)
      toast.success("Line removed — totals recomputed server-side")
      void estimates.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove the line")
    } finally {
      setRemovingLineId(null)
    }
  }

  // BOQ export — read-only download; the server gates it to approved estimates
  // and its 422 (e.g. superseded elsewhere after this view loaded) surfaces verbatim.
  const exportBoq = async (estimate: EstimateRow) => {
    if (exportingBoq) return
    setExportingBoq(true)
    try {
      const blob = await exportEstimateBoqCsv(estimate.id)
      // Standard browser download: object URL → <a download> click → revoke.
      const url = URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = url
      link.download = `boq-${estimate.id}.csv`
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
      toast.success(`BOQ exported — boq-${estimate.id}.csv`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed")
    } finally {
      setExportingBoq(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight">
          <Ruler className="size-4 text-muted-foreground" aria-hidden /> Takeoff &amp; Estimating
        </h2>
        <Alert>
          <Info aria-hidden />
          <AlertTitle>Honest status</AlertTitle>
          <AlertDescription>
            Quantities are not yet benchmark-verified against reference datasets (validation harness
            planned). Drawing-measured and model-derived rows are kept strictly distinct, and all
            estimate math is computed server-side behind review gates.
          </AlertDescription>
        </Alert>
      </header>

      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        {/* The 4 inner tabs overflow at 390px without horizontal scroll —
            mirrors project-workspace's TabsList pattern (max-w-full +
            overflow-x-auto): the strip scrolls, the page never does. */}
        <TabsList aria-label="Takeoff & Estimating sections" className="eos-scroll max-w-full overflow-x-auto">
          <TabsTrigger value="ledger">Quantity Ledger</TabsTrigger>
          <TabsTrigger value="assemblies">Assemblies &amp; Rates</TabsTrigger>
          <TabsTrigger value="estimates">Estimates</TabsTrigger>
          <TabsTrigger value="sheet">Sheet Measure</TabsTrigger>
        </TabsList>

        {/* ---------------- Quantity Ledger ---------------- */}
        <TabsContent value="ledger" className="mt-4 flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold tracking-tight">Quantity ledger ({quantityRows.length})</h3>
            <div className="ml-auto flex flex-wrap gap-2">
              <GuardedButton variant="outline" className="h-10" onClick={() => setDeriveOpen(true)}>
                <Boxes aria-hidden /> Derive from model…
              </GuardedButton>
              <GuardedButton className="h-10" onClick={() => setRecordOpen(true)}>
                <Plus aria-hidden /> Record quantity
              </GuardedButton>
            </div>
          </div>

          {quantities.error ? (
            <ErrorState message={quantities.error} onRetry={() => void quantities.refresh()} />
          ) : quantities.loading ? (
            <div className="rounded-lg border p-4">
              <RowSkeleton cols={5} />
            </div>
          ) : quantityRows.length === 0 ? (
            <EmptyState
              icon={ClipboardList}
              title="No quantities recorded yet"
              description="Record a drawing-measured quantity, or derive model quantities from a STEP/IFC artifact. Every row starts as draft and unverified — review gates apply before anything feeds an estimate."
              actionLabel="Record quantity"
              onAction={() => setRecordOpen(true)}
            />
          ) : (
            <div className="eos-scroll max-h-[32rem] overflow-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-right">Value</TableHead>
                    <TableHead>Method</TableHead>
                    <TableHead>Source artifact</TableHead>
                    <TableHead>Sheet / element</TableHead>
                    <TableHead>Ruleset</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {quantityRows.map((q) => (
                    // Superseded rows stay visible (audit) but greyed and inert.
                    <TableRow
                      key={q.id}
                      className={cn("cursor-default", q.status === "superseded" && "text-muted-foreground/60")}
                    >
                      <TableCell className="font-medium">
                        <span title={q.id}>{q.quantityType}</span>
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {q.value} <span className="text-muted-foreground">{q.unit}</span>
                      </TableCell>
                      <TableCell>
                        <MethodBadge method={q.method} />
                      </TableCell>
                      <TableCell>
                        {q.sourceArtifact ? (
                          <span className="flex max-w-[220px] items-baseline gap-1.5 truncate">
                            <span className="truncate">{q.sourceArtifact.name}</span>
                            <span className="shrink-0 font-mono text-xs text-muted-foreground">
                              r{q.sourceArtifact.revNumber}
                            </span>
                          </span>
                        ) : (
                          <span className="text-xs">—</span>
                        )}
                      </TableCell>
                      <TableCell className="max-w-[180px] truncate font-mono text-xs" title={q.sheetRef ?? q.elementRef ?? undefined}>
                        {q.method === "drawing-measured" ? (q.sheetRef ?? "—") : (q.elementRef ?? "—")}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        <span title={`${q.rulesetId} v${q.rulesetVersion}`}>
                          {q.rulesetId} v{q.rulesetVersion}
                        </span>
                      </TableCell>
                      <TableCell>
                        <ApprovalBadge state={q.status} />
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground" title={q.provenance.createdAt}>
                        by {q.provenance.createdBy} · {formatDate(q.provenance.createdAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        <QuantityActions
                          quantity={q}
                          busy={transitioningId !== null}
                          onTransition={(action) => void applyQuantityTransition(q, action)}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <InfoNote>
            Rows always point at an immutable artifact revision. Transitions are enforced server-side:
            draft → in_review → approved; superseding is terminal and keeps the row for audit.
          </InfoNote>
        </TabsContent>

        {/* ---------------- Assemblies & Rates ---------------- */}
        <TabsContent value="assemblies" className="mt-4 flex flex-col gap-6">
          <section aria-label="Trade assemblies" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold tracking-tight">Trade assemblies ({assemblyRows.length})</h3>
              <GuardedButton className="ml-auto h-10" onClick={() => setAssemblyOpen(true)}>
                <Plus aria-hidden /> New assembly
              </GuardedButton>
            </div>
            {assemblies.error ? (
              <ErrorState message={assemblies.error} onRetry={() => void assemblies.refresh()} />
            ) : assemblies.loading ? (
              <div className="rounded-lg border p-4">
                <RowSkeleton cols={4} />
              </div>
            ) : assemblyRows.length === 0 ? (
              <EmptyState
                icon={Layers}
                title="No assemblies yet"
                description="An assembly pairs a measured quantity with per-unit components (materials and labor) — the recipe estimate lines are priced from."
                actionLabel="New assembly"
                onAction={() => setAssemblyOpen(true)}
              />
            ) : (
              <div className="eos-scroll overflow-x-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Trade</TableHead>
                      <TableHead className="min-w-[280px]">Components</TableHead>
                      <TableHead className="text-right">Created</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {assemblyRows.map((a) => (
                      <TableRow key={a.id}>
                        <TableCell>
                          <span className="font-medium" title={a.id}>
                            {a.name}
                          </span>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-muted-foreground">{a.trade}</Badge>
                        </TableCell>
                        <TableCell className="whitespace-normal text-xs text-muted-foreground">
                          {a.components
                            .map(
                              (c) =>
                                `${c.name} (${c.kind}, ${c.quantityPerUnit} ${c.unit}${c.wastePct !== undefined ? `, +${c.wastePct}% waste` : ""}${c.productivityFactor !== undefined ? `, prod ×${c.productivityFactor}` : ""})`,
                            )
                            .join(" + ")}
                        </TableCell>
                        <TableCell className="text-right text-xs text-muted-foreground" title={a.createdAt}>
                          {formatDate(a.createdAt)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </section>

          <section aria-label="Component rates" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold tracking-tight">Rates ({rateRows.length})</h3>
              <GuardedButton variant="outline" className="ml-auto h-10" onClick={() => setRateOpen(true)}>
                <Plus aria-hidden /> Add rate
              </GuardedButton>
            </div>
            <InfoNote>
              Rates are engineer-entered records with an explicit source — agents and adapters never
              create rates. Estimate lines resolve the latest rate per component.
            </InfoNote>
            {rates.error ? (
              <ErrorState message={rates.error} onRetry={() => void rates.refresh()} />
            ) : rates.loading ? (
              <div className="rounded-lg border p-4">
                <RowSkeleton cols={4} />
              </div>
            ) : rateRows.length === 0 ? (
              <EmptyState
                icon={Sigma}
                title="No rates yet"
                description="Price assembly components (GHS by default) with a source — price-book, contract or quote. Estimate lines fail with an explicit 422 while a component has no rate."
                actionLabel="Add rate"
                onAction={() => setRateOpen(true)}
              />
            ) : (
              <div className="eos-scroll overflow-x-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Component</TableHead>
                      <TableHead>Assembly</TableHead>
                      <TableHead>Currency</TableHead>
                      <TableHead className="text-right">Unit price</TableHead>
                      <TableHead>Source</TableHead>
                      <TableHead>Effective from</TableHead>
                      <TableHead className="text-right">Added</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rateRows.map((r) => {
                      const component = componentIndex.get(r.componentId)
                      return (
                        <TableRow key={r.id}>
                          <TableCell>
                            {component ? (
                              <span className="flex max-w-[240px] items-baseline gap-1.5 truncate">
                                <span className="truncate font-medium">{component.name}</span>
                                <Badge variant="outline" className="shrink-0 text-muted-foreground">
                                  {component.kind}
                                </Badge>
                              </span>
                            ) : (
                              // Honest fallback when the parent assembly is not (yet) loadable.
                              <span className="font-mono text-xs" title={r.componentId}>
                                {r.componentId}
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="max-w-[180px] truncate text-muted-foreground">
                            {component?.assemblyName ?? "—"}
                          </TableCell>
                          <TableCell className="font-mono text-xs">{r.currency}</TableCell>
                          <TableCell className="text-right font-mono tabular-nums">
                            {formatMoney(r.unitPrice, r.currency)}
                          </TableCell>
                          <TableCell>
                            <RateSourceBadge source={r.source} />
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {r.effectiveFrom ? formatDate(r.effectiveFrom) : "—"}
                          </TableCell>
                          <TableCell className="text-right text-xs text-muted-foreground" title={r.createdAt}>
                            {formatDate(r.createdAt)}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </section>
        </TabsContent>

        {/* ---------------- Estimates ---------------- */}
        <TabsContent value="estimates" className="mt-4 flex flex-col gap-4">
          <Alert>
            <Sigma aria-hidden />
            <AlertTitle>Deterministic server-side math</AlertTitle>
            <AlertDescription>
              Line totals, subtotals and grand totals are computed by the server (deterministic
              rounding in src/core/ledger.ts) and recomputed on every read — this UI performs no
              estimate arithmetic. Approving requires every line&apos;s quantity to be approved; the
              server rejects with the blocker list otherwise.
            </AlertDescription>
          </Alert>

          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold tracking-tight">Estimates ({estimateRows.length})</h3>
            <GuardedButton className="ml-auto h-10" onClick={() => setEstimateOpen(true)}>
              <Plus aria-hidden /> New estimate
            </GuardedButton>
          </div>

          {estimates.error ? (
            <ErrorState message={estimates.error} onRetry={() => void estimates.refresh()} />
          ) : estimates.loading ? (
            <div className="rounded-lg border p-4">
              <RowSkeleton cols={5} />
            </div>
          ) : estimateRows.length === 0 ? (
            <EmptyState
              icon={Sigma}
              title="No estimates yet"
              description="Create an estimate, then add lines pairing approved-track quantities with trade assemblies. Grand totals are computed server-side with deterministic rounding."
              actionLabel="New estimate"
              onAction={() => setEstimateOpen(true)}
            />
          ) : (
            <div className="eos-scroll overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Currency</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-center">Lines</TableHead>
                    <TableHead className="text-right">Grand total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {estimateRows.map((est) => (
                    <TableRow
                      key={est.id}
                      className="cursor-pointer"
                      tabIndex={0}
                      aria-selected={selectedEstimateId === est.id}
                      aria-label={`Inspect estimate ${est.name}`}
                      onClick={() => setSelectedEstimateId(est.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") setSelectedEstimateId(est.id)
                      }}
                    >
                      <TableCell className="max-w-[260px] truncate font-medium" title={est.id}>
                        {est.name}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{est.currency}</TableCell>
                      <TableCell>
                        <ApprovalBadge state={est.status} />
                      </TableCell>
                      <TableCell className="text-center font-mono tabular-nums">{est.lines.length}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {formatMoney(est.totals.grandTotal, est.totals.currency)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {!selectedEstimate && !estimates.loading && !estimates.error && estimateRows.length > 0 ? (
            <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
              Select an estimate above to inspect its lines, breakdown and totals.
            </p>
          ) : null}

          {selectedEstimate ? (
            <Card>
              <CardContent className="flex flex-col gap-4 p-4 sm:p-6">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h4 className="flex flex-wrap items-center gap-2 text-sm font-semibold tracking-tight">
                      <span className="truncate">{selectedEstimate.name}</span>
                      <ApprovalBadge state={selectedEstimate.status} />
                    </h4>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {selectedEstimate.currency} · overhead {selectedEstimate.overheadPct}% · profit{" "}
                      {selectedEstimate.profitPct}% · tax {selectedEstimate.taxPct}% · rounding{" "}
                      {selectedEstimate.rounding.mode} @ {selectedEstimate.rounding.decimals} · by{" "}
                      {selectedEstimate.createdBy} {formatDate(selectedEstimate.createdAt)}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {selectedEstimate.status === "draft" ? (
                      <>
                        <GuardedButton variant="outline" className="h-9" onClick={() => setLineOpen(true)}>
                          <Plus aria-hidden /> Add line
                        </GuardedButton>
                        <GuardedButton
                          className="h-9"
                          disabled={estimateAction !== null}
                          onClick={() => void applyEstimateTransition(selectedEstimate, "submit")}
                        >
                          {estimateAction === "submit" ? "Submitting…" : "Submit for review"}
                        </GuardedButton>
                        <GuardedButton
                          variant="ghost"
                          className="h-9 text-muted-foreground"
                          disabled={estimateAction !== null}
                          onClick={() => setSupersedeOpen(true)}
                        >
                          Supersede
                        </GuardedButton>
                      </>
                    ) : null}
                    {selectedEstimate.status === "in_review" ? (
                      <>
                        <GuardedButton
                          variant="outline"
                          className="h-9"
                          disabled={estimateAction !== null}
                          onClick={() => void applyEstimateTransition(selectedEstimate, "reject")}
                        >
                          {estimateAction === "reject" ? "Rejecting…" : "Reject"}
                        </GuardedButton>
                        <GuardedButton
                          className="h-9"
                          disabled={estimateAction !== null}
                          onClick={() => void applyEstimateTransition(selectedEstimate, "approve")}
                        >
                          {estimateAction === "approve" ? "Approving…" : "Approve"}
                        </GuardedButton>
                        <GuardedButton
                          variant="ghost"
                          className="h-9 text-muted-foreground"
                          disabled={estimateAction !== null}
                          onClick={() => setSupersedeOpen(true)}
                        >
                          Supersede
                        </GuardedButton>
                      </>
                    ) : null}
                    {selectedEstimate.status === "approved" ? (
                      <>
                        <Button
                          variant="outline"
                          className="h-9"
                          disabled={exportingBoq}
                          onClick={() => void exportBoq(selectedEstimate)}
                        >
                          <Download aria-hidden /> {exportingBoq ? "Exporting…" : "Export BOQ (CSV)"}
                        </Button>
                        <GuardedButton
                          variant="ghost"
                          className="h-9 text-muted-foreground"
                          disabled={estimateAction !== null}
                          onClick={() => setSupersedeOpen(true)}
                        >
                          Supersede
                        </GuardedButton>
                      </>
                    ) : null}
                  </div>
                </div>

                {selectedEstimate.status === "approved" ? (
                  <p className="text-xs text-muted-foreground">
                    Locked — approved{selectedEstimate.approval ? ` by ${selectedEstimate.approval.approvedBy} on ${formatDate(selectedEstimate.approval.approvedAt)}` : ""}.
                    Lines and totals are frozen; supersede or copy into a new estimate to change them.
                  </p>
                ) : null}
                {selectedEstimate.status === "superseded" ? (
                  <p className="text-xs text-muted-foreground">
                    Superseded — this estimate is kept for audit and can no longer be edited.
                  </p>
                ) : null}
                {selectedEstimate.status === "in_review" ? (
                  <p className="text-xs text-muted-foreground">
                    Under review — lines are frozen. Approve requires every line&apos;s quantity to be
                    approved (the server lists any blockers verbatim).
                  </p>
                ) : null}
                {selectedEstimate.lines.some(
                  (line) => line.futureDatedRate === true || line.breakdown.some((b) => b.futureDatedRate === true),
                ) ? (
                  // Phase-6 future-dated rate warning (known-limitation #9):
                  // rendered only when the additive per-line field is present AND
                  // true. Amber treatment from the existing palette.
                  <p
                    role="note"
                    className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
                  >
                    <FutureRateBadge />
                    <span>
                      rate effectiveFrom is in the future — price is provisional
                    </span>
                  </p>
                ) : null}

                {/* Lines */}
                {selectedEstimate.lines.length === 0 ? (
                  <EmptyState
                    title="No lines yet"
                    description="Add a line: pick a quantity and an assembly — the server resolves rates and computes the line total. Draft quantities can be added, but approval requires them all to be approved."
                    actionLabel={selectedEstimate.status === "draft" ? "Add line" : undefined}
                    onAction={selectedEstimate.status === "draft" ? () => setLineOpen(true) : undefined}
                  />
                ) : (
                  <div className="eos-scroll overflow-x-auto rounded-lg border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Quantity</TableHead>
                          <TableHead>Assembly</TableHead>
                          <TableHead className="text-right">Line total</TableHead>
                          <TableHead>Breakdown</TableHead>
                          {selectedEstimate.status === "draft" ? <TableHead className="w-12" /> : null}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {selectedEstimate.lines.map((line) => {
                          const quantity = quantityIndex.get(line.quantityId)
                          const assembly = assemblyIndex.get(line.assemblyId)
                          // Phase-6 additive field — guard on presence AND true.
                          const lineFutureRate =
                            line.futureDatedRate === true ||
                            line.breakdown.some((b) => b.futureDatedRate === true)
                          return (
                            <TableRow key={line.id}>
                              <TableCell>
                                {quantity ? (
                                  <span className="flex flex-col gap-1">
                                    <span className="font-medium">
                                      {quantity.quantityType} · <span className="font-mono">{quantity.value} {quantity.unit}</span>
                                    </span>
                                    <span className="flex items-center gap-1.5">
                                      <MethodBadge method={quantity.method} />
                                      <ApprovalBadge state={quantity.status} />
                                    </span>
                                  </span>
                                ) : (
                                  // Honest fallback if the ledger is not (yet) loadable.
                                  <span className="font-mono text-xs" title={line.quantityId}>
                                    {line.quantityId}
                                  </span>
                                )}
                              </TableCell>
                              <TableCell>
                                {assembly ? (
                                  <span className="flex max-w-[200px] flex-col truncate">
                                    <span className="truncate font-medium">{assembly.name}</span>
                                    <span className="text-xs text-muted-foreground">{assembly.trade}</span>
                                  </span>
                                ) : (
                                  <span className="font-mono text-xs" title={line.assemblyId}>
                                    {line.assemblyId}
                                  </span>
                                )}
                              </TableCell>
                              <TableCell className="text-right font-mono tabular-nums">
                                <span className="flex flex-col items-end gap-1">
                                  <span>{formatMoney(line.lineTotal, line.currency)}</span>
                                  {lineFutureRate ? <FutureRateBadge /> : null}
                                </span>
                              </TableCell>
                              <TableCell>
                                <Collapsible>
                                  <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline">
                                    <ChevronDown className="size-3.5" aria-hidden />
                                    {line.breakdown.length} component{line.breakdown.length === 1 ? "" : "s"}
                                  </CollapsibleTrigger>
                                  <CollapsibleContent>
                                    <ul className="mt-2 space-y-1.5 border-l pl-3">
                                      {line.breakdown.map((b) => (
                                        <li
                                          key={b.componentId}
                                          className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-muted-foreground"
                                        >
                                          <span className="font-medium text-foreground">{b.name}</span>
                                          <Badge variant="outline" className="text-muted-foreground">{b.kind}</Badge>
                                          <span className="font-mono tabular-nums">
                                            {formatAmount(b.amount)} {b.unit}
                                          </span>
                                          <span aria-hidden>×</span>
                                          <span className="font-mono tabular-nums">
                                            {formatMoney(b.unitPrice, line.currency)}
                                          </span>
                                          {b.futureDatedRate === true ? <FutureRateBadge /> : null}
                                          <span aria-hidden>=</span>
                                          <span className="font-mono tabular-nums text-foreground">
                                            {formatMoney(b.cost, line.currency)}
                                          </span>
                                        </li>
                                      ))}
                                    </ul>
                                  </CollapsibleContent>
                                </Collapsible>
                              </TableCell>
                              {selectedEstimate.status === "draft" ? (
                                <TableCell className="text-right">
                                  <GuardedButton
                                    variant="ghost"
                                    size="icon"
                                    className="size-8"
                                    aria-label={`Remove line ${line.id}`}
                                    disabled={removingLineId !== null}
                                    onClick={() => void removeLine(selectedEstimate, line.id)}
                                  >
                                    <Trash2 className="size-4" aria-hidden />
                                  </GuardedButton>
                                </TableCell>
                              ) : null}
                            </TableRow>
                          )
                        })}
                      </TableBody>
                    </Table>
                  </div>
                )}

                {/* Totals — server-computed, display-only */}
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <InfoNote>
                    Totals are recomputed by the server on every read (lines subtotal → overhead →
                    profit → tax → grand total, each rounded {selectedEstimate.rounding.mode} at{" "}
                    {selectedEstimate.rounding.decimals} decimals) — never stored stale.
                  </InfoNote>
                  <dl className="flex w-full flex-col gap-1.5 rounded-lg border p-4 text-sm sm:w-80">
                    <div className="flex items-baseline justify-between gap-4">
                      <dt className="text-muted-foreground">Lines subtotal</dt>
                      <dd className="font-mono tabular-nums">
                        {formatMoney(selectedEstimate.totals.linesSubtotal, selectedEstimate.totals.currency)}
                      </dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-4">
                      <dt className="text-muted-foreground">Overhead ({selectedEstimate.overheadPct}%)</dt>
                      <dd className="font-mono tabular-nums">
                        {formatMoney(selectedEstimate.totals.overhead, selectedEstimate.totals.currency)}
                      </dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-4">
                      <dt className="text-muted-foreground">Profit ({selectedEstimate.profitPct}%)</dt>
                      <dd className="font-mono tabular-nums">
                        {formatMoney(selectedEstimate.totals.profit, selectedEstimate.totals.currency)}
                      </dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-4">
                      <dt className="text-muted-foreground">Tax ({selectedEstimate.taxPct}%)</dt>
                      <dd className="font-mono tabular-nums">
                        {formatMoney(selectedEstimate.totals.tax, selectedEstimate.totals.currency)}
                      </dd>
                    </div>
                    <Separator className="my-1" />
                    <div className="flex items-baseline justify-between gap-4">
                      <dt className="font-semibold">Grand total</dt>
                      <dd className="font-mono text-base font-semibold tabular-nums">
                        {formatMoney(selectedEstimate.totals.grandTotal, selectedEstimate.totals.currency)}
                      </dd>
                    </div>
                  </dl>
                </div>
              </CardContent>
            </Card>
          ) : null}
        </TabsContent>

        {/* ---------------- Sheet Measure (Lane 8-b, contract §3) ---------------- */}
        <TabsContent value="sheet" className="mt-4 flex flex-col gap-4">
          {/* onSaved mirrors RecordQuantityDialog.onCreated: 201 → the ledger
              list refetches (nothing optimistic anywhere). */}
          <SheetMeasure
            projectId={projectId}
            artifacts={artifactSource}
            onSaved={() => void quantities.refresh()}
          />
        </TabsContent>
      </Tabs>

      {/* ---------------- Dialogs ---------------- */}
      <RecordQuantityDialog
        projectId={projectId}
        artifacts={artifactSource}
        assemblies={assemblyRows}
        open={recordOpen}
        onOpenChange={setRecordOpen}
        onCreated={() => void quantities.refresh()}
      />
      <DeriveQuantitiesDialog
        projectId={projectId}
        artifacts={artifactSource}
        open={deriveOpen}
        onOpenChange={setDeriveOpen}
        onDerived={() => {
          void quantities.refresh()
          // Cache nudge (Phase-6 #13): the derivation appends audit events the
          // project-level activity/artifact caches don't observe on their own.
          notifyMutated()
        }}
      />
      <NewAssemblyDialog
        projectId={projectId}
        open={assemblyOpen}
        onOpenChange={setAssemblyOpen}
        onCreated={() => void assemblies.refresh()}
      />
      <AddRateDialog
        projectId={projectId}
        assemblies={assemblyRows}
        assembliesError={assemblies.error}
        open={rateOpen}
        onOpenChange={setRateOpen}
        onCreated={() => void rates.refresh()}
      />
      <NewEstimateDialog
        projectId={projectId}
        open={estimateOpen}
        onOpenChange={setEstimateOpen}
        onCreated={(estimate) => {
          setSelectedEstimateId(estimate.id)
          void estimates.refresh()
        }}
      />
      {selectedEstimate ? (
        <AddEstimateLineDialog
          estimate={selectedEstimate}
          quantities={quantityRows}
          assemblies={assemblyRows}
          open={lineOpen}
          onOpenChange={setLineOpen}
          onCreated={() => void estimates.refresh()}
        />
      ) : null}
      {selectedEstimate ? (
        <SupersedeEstimateDialog
          estimate={selectedEstimate}
          open={supersedeOpen}
          onOpenChange={setSupersedeOpen}
          onConfirm={() => {
            // The workspace owns the transition call so its verbatim 422
            // surfacing, in-flight guard and refetch stay in one place.
            setSupersedeOpen(false)
            void applyEstimateTransition(selectedEstimate, "supersede")
          }}
        />
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Ledger row actions — exactly the pinned transition map
// ---------------------------------------------------------------------------

function QuantityActions({
  quantity,
  busy,
  onTransition,
}: {
  quantity: QuantityRow
  busy: boolean
  onTransition: (action: QuantityTransitionAction) => void
}) {
  if (quantity.status === "superseded") return null

  switch (quantity.status) {
    case "draft":
      return (
        <span className="flex justify-end gap-1.5">
          <GuardedButton size="sm" className="h-8" disabled={busy} onClick={() => onTransition("submit")}>
            Submit for review
          </GuardedButton>
          <GuardedButton
            size="sm"
            variant="ghost"
            className="h-8 text-muted-foreground"
            disabled={busy}
            onClick={() => onTransition("supersede")}
          >
            Supersede
          </GuardedButton>
        </span>
      )
    case "in_review":
      return (
        <span className="flex justify-end gap-1.5">
          <GuardedButton size="sm" className="h-8" disabled={busy} onClick={() => onTransition("approve")}>
            Approve
          </GuardedButton>
          <GuardedButton size="sm" variant="outline" className="h-8" disabled={busy} onClick={() => onTransition("reject")}>
            Reject
          </GuardedButton>
        </span>
      )
    case "approved":
      return (
        <span className="flex justify-end gap-1.5">
          <GuardedButton
            size="sm"
            variant="ghost"
            className="h-8 text-muted-foreground"
            disabled={busy}
            onClick={() => onTransition("supersede")}
          >
            Supersede
          </GuardedButton>
        </span>
      )
  }
}
