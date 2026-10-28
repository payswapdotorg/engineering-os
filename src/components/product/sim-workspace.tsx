"use client"

/**
 * Simulation & Verification workspace (W1-f lane, Phase 5) — FE meshing, power
 * flow and discrete-event simulation over the pinned Phase-5 API contracts
 * (docs/00-architecture/phase5-disciplines-contract.md §8/§11).
 *
 * Honesty rules this workspace follows:
 *  - every run is a REAL broker call (POST …/fe-mesh, …/powerflow, …/simulate);
 *    the client never fabricates results — 422 refusals (unsupported input,
 *    engine_unavailable, non-convergence) surface VERBATIM in toasts (the
 *    takeoff-workspace idiom);
 *  - results are DERIVED artifacts (kind `fe-mesh` / `analysis`, derived_from
 *    the picked source). The register reads the real artifact list; the source
 *    links resolve through artifact details (the Design Studio mapping
 *    pattern — O(#results) fetches, an honest gap kept);
 *  - provenance: in-session runs show the full execution record from the 201
 *    response (engine badge, version, adapter hash, duration, exit code,
 *    verbatim stdout/stderr tails — the agents-workspace execution-record
 *    pattern). Pre-existing rows show what the stored payload carries
 *    (eos-femesh/1 embeds generatedBy; power-flow/DES/CPM payloads identify
 *    the producing op by their frozen `format` field — the engine is named
 *    from the contract table, never invented beyond it). Fields the platform
 *    does not store on the artifact (tails/duration for direct runs) render
 *    an honest note, never a placeholder number;
 *  - staleness follows the Journey-G machinery: a revised source marks the
 *    derived artifact stale (list data); Regenerate re-runs the SAME op on
 *    the SAME source through the route (the studio pattern — appends a new
 *    revision, never edits history);
 *  - payload reads go through the revision download URL; if that route is
 *    unavailable the detail shows the honest error and everything else still
 *    renders — nothing is simulated to fill the gap.
 */
import {
  Boxes,
  ChevronDown,
  Droplets,
  FlaskConical,
  Hourglass,
  Info,
  Loader2,
  Play,
  RefreshCw,
  Ruler,
  TriangleAlert,
  Zap,
} from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import {
  analyzeSchedule,
  fetchRevisionText,
  getArtifactDetail,
  runDiscreteEvent,
  runFeMesh,
  runFea,
  runPowerFlow,
  runSwmm,
  useApi,
  type ArtifactListItem,
  type CpmAnalysisPayload,
  type DeriveRunResult,
  type DesPayload,
  type FeMeshPayload,
  type FeaPayload,
  type SwmmPayload,
  type PowerFlowPayload,
} from "@/components/product/api"
import { ApprovalBadge, KindBadge, StalenessBadge } from "@/components/product/badges"
import { formatDate, humanBytes, relTime, shortHash } from "@/components/product/format"
import { EmptyState, ErrorState, InfoNote } from "@/components/product/parts"
import { GuardedButton } from "@/components/product/guarded-button"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { deriveKind } from "@/engines/adapters/derive-kind"

// ---------------------------------------------------------------------------
// Local display helpers + constants
// ---------------------------------------------------------------------------

/** Which §8 route a register row was produced by (Regenerate needs it). */
type SimOp = "fe-mesh" | "powerflow" | "simulate" | "solve-fea" | "run-swmm" | "analyze-schedule"

const OP_RUN_LABEL: Record<SimOp, string> = {
  "fe-mesh": "Meshing…",
  powerflow: "Solving power flow…",
  simulate: "Running simulation…",
  "solve-fea": "Solving plane-stress FEA…",
  "run-swmm": "Running stormwater drainage…",
  "analyze-schedule": "Analyzing schedule…",
}

/** Producing engine per frozen payload format (contract §4 table — honest, contract-pinned). */
const FORMAT_ENGINE: Record<string, { engineKey: string; platform: boolean }> = {
  "eos-femesh/1": { engineKey: "gmsh", platform: false },
  "eos-powerflow/1": { engineKey: "pandapower", platform: false },
  "eos-des/1": { engineKey: "simpy", platform: false },
  "eos-fea/1": { engineKey: "scikit-fem", platform: false },
  "eos-swmm/1": { engineKey: "pyswmm", platform: false },
  "eos-cpm/1": { engineKey: "platform core", platform: true },
}

const FORMAT_OP: Record<string, SimOp> = {
  "eos-femesh/1": "fe-mesh",
  "eos-powerflow/1": "powerflow",
  "eos-des/1": "simulate",
  "eos-fea/1": "solve-fea",
  "eos-swmm/1": "run-swmm",
  "eos-cpm/1": "analyze-schedule",
}

/** Display-only duration from the server-recorded durationMs — no client math beyond formatting. */
function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "—"
  if (ms < 1000) return `${Math.round(ms)} ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`
  const minutes = Math.floor(seconds / 60)
  const rem = Math.round(seconds % 60)
  if (minutes < 60) return `${minutes}m ${rem}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** Union of every §2 payload this workspace can render. */
type DerivedPayload = FeMeshPayload | PowerFlowPayload | DesPayload | CpmAnalysisPayload | FeaPayload | SwmmPayload

/**
 * Read a stored derived payload (§2 formats) from an already-parsed object.
 * The formats are frozen, so after matching the `format` discriminator the
 * pinned fields are read defensively — a missing field renders as absent
 * rather than crashing the workspace.
 */
function readDerivedPayload(parsed: unknown): DerivedPayload | null {
  if (!isRecord(parsed) || typeof parsed.format !== "string") return null
  const format = parsed.format
  if (format === "eos-femesh/1") {
    const solids = Array.isArray(parsed.solids) ? parsed.solids : []
    return {
      format,
      sourceArtifactName: typeof parsed.sourceArtifactName === "string" ? parsed.sourceArtifactName : "—",
      units: typeof parsed.units === "string" ? parsed.units : "—",
      generatedBy: isRecord(parsed.generatedBy)
        ? {
            engineKey: String(parsed.generatedBy.engineKey ?? "—"),
            engineVersion: String(parsed.generatedBy.engineVersion ?? "—"),
            adapterScript: String(parsed.generatedBy.adapterScript ?? "—"),
          }
        : undefined,
      meshSizeMin: Number(parsed.meshSizeMin ?? NaN),
      meshSizeMax: Number(parsed.meshSizeMax ?? NaN),
      elementOrder: Number(parsed.elementOrder ?? NaN),
      nodes: { count: Number(isRecord(parsed.nodes) ? parsed.nodes.count : NaN) },
      elements: {
        type: String(isRecord(parsed.elements) ? parsed.elements.type : "—"),
        count: Number(isRecord(parsed.elements) ? parsed.elements.count : NaN),
      },
      solids: solids.filter(isRecord).map((s) => ({
        ref: String(s.ref ?? "—"),
        name: typeof s.name === "string" ? s.name : undefined,
        tetCount: Number(s.tetCount ?? NaN),
        meshVolume: Number(s.meshVolume ?? NaN),
      })),
      quality: {
        min: Number(isRecord(parsed.quality) ? parsed.quality.min : NaN),
        mean: Number(isRecord(parsed.quality) ? parsed.quality.mean : NaN),
      },
    } satisfies FeMeshPayload
  }
  if (format === "eos-powerflow/1") {
    return {
      format,
      sourceArtifactName: typeof parsed.sourceArtifactName === "string" ? parsed.sourceArtifactName : "—",
      converged: parsed.converged === true,
      buses: (Array.isArray(parsed.buses) ? parsed.buses.filter(isRecord) : []).map((b) => ({
        id: String(b.id ?? "—"),
        vmPu: Number(b.vmPu ?? NaN),
        angleDeg: Number(b.angleDeg ?? NaN),
        pMw: Number(b.pMw ?? NaN),
        qMvar: Number(b.qMvar ?? NaN),
      })),
      lines: (Array.isArray(parsed.lines) ? parsed.lines.filter(isRecord) : []).map((l) => ({
        fromBus: String(l.fromBus ?? "—"),
        toBus: String(l.toBus ?? "—"),
        iKa: Number(l.iKa ?? NaN),
        pLossMw: Number(l.pLossMw ?? NaN),
        qLossMvar: Number(l.qLossMvar ?? NaN),
      })),
      totals: {
        lossMw: Number(isRecord(parsed.totals) ? parsed.totals.lossMw : NaN),
        loadMw: Number(isRecord(parsed.totals) ? parsed.totals.loadMw : NaN),
      },
    } satisfies PowerFlowPayload
  }
  if (format === "eos-des/1") {
    return {
      format,
      sourceArtifactName: typeof parsed.sourceArtifactName === "string" ? parsed.sourceArtifactName : "—",
      policy: typeof parsed.policy === "string" ? parsed.policy : "—",
      makespan: Number(parsed.makespan ?? NaN),
      resources: (Array.isArray(parsed.resources) ? parsed.resources.filter(isRecord) : []).map((r) => ({
        id: String(r.id ?? "—"),
        busy: Number(r.busy ?? NaN),
        utilization: Number(r.utilization ?? NaN),
      })),
      jobs: (Array.isArray(parsed.jobs) ? parsed.jobs.filter(isRecord) : []).map((j) => ({
        id: String(j.id ?? "—"),
        startAt: Number(j.startAt ?? NaN),
        endAt: Number(j.endAt ?? NaN),
      })),
    } satisfies DesPayload
  }
  if (format === "eos-cpm/1") {
    return {
      format,
      sourceArtifactName: typeof parsed.sourceArtifactName === "string" ? parsed.sourceArtifactName : "—",
      activities: (Array.isArray(parsed.activities) ? parsed.activities.filter(isRecord) : []).map((a) => ({
        id: String(a.id ?? "—"),
        name: String(a.name ?? "—"),
        durationDays: Number(a.durationDays ?? NaN),
        es: Number(a.es ?? NaN),
        ef: Number(a.ef ?? NaN),
        ls: Number(a.ls ?? NaN),
        lf: Number(a.lf ?? NaN),
        totalFloat: Number(a.totalFloat ?? NaN),
        critical: a.critical === true,
      })),
      criticalPath: (Array.isArray(parsed.criticalPath) ? parsed.criticalPath : []).map(String),
      durationDays: Number(parsed.durationDays ?? NaN),
    } satisfies CpmAnalysisPayload
  }
  if (format === "eos-fea/1") {
    const samples = Array.isArray(parsed.samples) ? parsed.samples.filter(isRecord) : []
    const mesh = isRecord(parsed.mesh) ? parsed.mesh : {}
    const stress = isRecord(parsed.stress) ? parsed.stress : {}
    return {
      format,
      sourceArtifactName: typeof parsed.sourceArtifactName === "string" ? parsed.sourceArtifactName : "—",
      analysis: parsed.analysis === "plane_stress" ? "plane_stress" : "plane_stress",
      mesh: {
        elementType: String(mesh.elementType ?? "—"),
        refinement: Number(mesh.refinement ?? NaN),
        elementCount: Number(mesh.elementCount ?? NaN),
        nodeCount: Number(mesh.nodeCount ?? NaN),
      },
      thicknessMm: Number(parsed.thicknessMm ?? NaN),
      elasticModulusMpa: Number(parsed.elasticModulusMpa ?? NaN),
      poissonRatio: Number(parsed.poissonRatio ?? NaN),
      samples: samples.map((s) => ({
        x: Number(s.x ?? NaN),
        y: Number(s.y ?? NaN),
        ux: Number(s.ux ?? NaN),
        uy: Number(s.uy ?? NaN),
      })),
      maxDisplacementMagnitudeMm: Number(parsed.maxDisplacementMagnitudeMm ?? NaN),
      stress: {
        sigmaXxMinMpa: Number(stress.sigmaXxMinMpa ?? NaN),
        sigmaXxMaxMpa: Number(stress.sigmaXxMaxMpa ?? NaN),
        vonMisesMaxMpa: Number(stress.vonMisesMaxMpa ?? NaN),
      },
      generatedBy: isRecord(parsed.generatedBy)
        ? {
            engineKey: String(parsed.generatedBy.engineKey ?? "—"),
            engineVersion: String(parsed.generatedBy.engineVersion ?? "—"),
            adapterScript: String(parsed.generatedBy.adapterScript ?? "—"),
            adapterHash: String(parsed.generatedBy.adapterHash ?? "—"),
          }
        : undefined,
    } satisfies FeaPayload
  }
  if (format === "eos-swmm/1") {
    const rain = isRecord(parsed.rain) ? parsed.rain : {}
    const routing = isRecord(parsed.routing) ? parsed.routing : {}
    const continuity = isRecord(parsed.continuity) ? parsed.continuity : {}
    const peaks = isRecord(parsed.peaks) ? parsed.peaks : {}
    const depths = Array.isArray(parsed.depths) ? parsed.depths.filter(isRecord) : []
    return {
      format,
      sourceArtifactName: typeof parsed.sourceArtifactName === "string" ? parsed.sourceArtifactName : "—",
      analysis: "drainage",
      rain: {
        intensityMMperHr: Number(rain.intensityMMperHr ?? NaN),
        durationMin: Number(rain.durationMin ?? NaN),
        totalDepthMm: Number(rain.totalDepthMm ?? NaN),
        totalVolumeM3: Number(rain.totalVolumeM3 ?? NaN),
      },
      routing: {
        model: "kinematic_wave",
        routingStepSec: Number(routing.routingStepSec ?? NaN),
      },
      continuity: {
        runoffErrorPct: Number(continuity.runoffErrorPct ?? NaN),
        routingErrorPct: Number(continuity.routingErrorPct ?? NaN),
      },
      outfallVolumeM3: Number(parsed.outfallVolumeM3 ?? NaN),
      volumeBalancePct: Number(parsed.volumeBalancePct ?? NaN),
      peaks: {
        maxRunoffCms: Number(peaks.maxRunoffCms ?? NaN),
        maxConduitFlowCms: Number(peaks.maxConduitFlowCms ?? NaN),
      },
      depths: depths.map((d) => ({
        id: String(d.id ?? "—"),
        maxDepthM: Number(d.maxDepthM ?? NaN),
      })),
      generatedBy: isRecord(parsed.generatedBy)
        ? {
            engineKey: String(parsed.generatedBy.engineKey ?? "—"),
            engineVersion: String(parsed.generatedBy.engineVersion ?? "—"),
            adapterScript: String(parsed.generatedBy.adapterScript ?? "—"),
            adapterHash: String(parsed.generatedBy.adapterHash ?? "—"),
          }
        : undefined,
    } satisfies SwmmPayload
  }
  return null
}

// ---------------------------------------------------------------------------
// Capability cards (input picker + Run)
// ---------------------------------------------------------------------------

interface CapabilitySpec {
  op: Extract<SimOp, "fe-mesh" | "powerflow" | "simulate" | "solve-fea" | "run-swmm">
  title: string
  engineKey: string
  icon: typeof Boxes
  blurb: string
  pickerLabel: string
  runLabel: string
  eligible: (a: ArtifactListItem) => boolean
  emptyNote: string
}

/** .step/.stp/.ifc on the latest revision — the canonical multi-signal detector. */
function feMeshEligible(a: ArtifactListItem): boolean {
  const rev = a.latestRevision
  if (!rev) return false
  return deriveKind(rev.storageKey, a.name, rev.mimeType) !== null
}

/** `.json` extension + kind `dataset` (contract §11; the route validates for real). */
function jsonDatasetEligible(a: ArtifactListItem): boolean {
  if (a.kind !== "dataset" || !a.latestRevision) return false
  const lower = a.name.toLowerCase()
  return lower.endsWith(".json") || a.latestRevision.storageKey.toLowerCase().endsWith(".json")
}

const CAPABILITIES: CapabilitySpec[] = [
  {
    op: "fe-mesh",
    title: "FE mesh",
    engineKey: "gmsh",
    icon: Boxes,
    blurb:
      "Generates a linear-tetrahedron FE mesh from a STEP/IFC model revision (gmsh). Default sizes " +
      "2.0–4.0 mm, element order 1 — the route applies its pinned defaults; results are stored as " +
      "kind `fe-mesh` artifacts with per-solid tet counts and divergence-theorem volumes.",
    pickerLabel: "Model artifact (.step / .stp / .ifc)",
    runLabel: "Generate FE mesh",
    eligible: feMeshEligible,
    emptyNote:
      "No derivable model artifacts in this project — register a .step, .stp or .ifc artifact first. " +
      "The route refuses geometry-free or non-model inputs honestly.",
  },
  {
    op: "powerflow",
    title: "Power flow",
    engineKey: "pandapower",
    icon: Zap,
    blurb:
      "Solves a Newton-Raphson power flow on an eos-powerflow-network/1 JSON dataset (pandapower). " +
      "Bus voltages, line flows and losses are copied verbatim from the engine result frame into an " +
      "`analysis` artifact.",
    pickerLabel: "Network JSON artifact (kind dataset)",
    runLabel: "Run power flow",
    eligible: jsonDatasetEligible,
    emptyNote:
      "No .json dataset artifacts in this project yet — upload a network JSON (kind `dataset`). " +
      "The route validates the eos-powerflow-network/1 shape and refuses it honestly otherwise.",
  },
  {
    op: "simulate",
    title: "Discrete-event simulation",
    engineKey: "simpy",
    icon: Hourglass,
    blurb:
      "Runs a deterministic FIFO discrete-event simulation of an eos-des-scenario/1 JSON dataset " +
      "(SimPy) — per-job start/end times and per-resource busy/utilization land in an `analysis` " +
      "artifact.",
    pickerLabel: "Scenario JSON artifact (kind dataset)",
    runLabel: "Run simulation",
    eligible: jsonDatasetEligible,
    emptyNote:
      "No .json dataset artifacts in this project yet — upload a scenario JSON (kind `dataset`). " +
      "The route validates the eos-des-scenario/1 shape and refuses it honestly otherwise.",
  },
  {
    op: "solve-fea",
    title: "Plane-stress FEA",
    engineKey: "scikit-fem",
    icon: Ruler,
    blurb:
      "Solves a linear plane-stress FEA of an eos-fea-model/1 JSON dataset (scikit-fem, BSD-3) — " +
      "a rectangular plate under per-edge traction/shear with per-edge supports; corner + center " +
      "displacements, per-element stress statistics and max deflection land in an `analysis` " +
      "artifact. Under-constrained models are refused honestly, never solved by guessing.",
    pickerLabel: "FEA model JSON artifact (kind dataset)",
    runLabel: "Solve FEA",
    eligible: jsonDatasetEligible,
    emptyNote:
      "No .json dataset artifacts in this project yet — upload an eos-fea-model/1 JSON (kind " +
      "`dataset`). The route validates the model shape and refuses it honestly otherwise.",
  },
  {
    op: "run-swmm",
    title: "Stormwater drainage",
    engineKey: "pyswmm",
    icon: Droplets,
    blurb:
      "Runs an EPA SWMM5 drainage simulation (pyswmm, BSD-2 + CC0/MIT) of an " +
      "eos-swmm-model/1 JSON dataset — impervious catchments routing one uniform rain event " +
      "through junctions and rectangular conduits to free outfalls; outfall volume, peak flows, " +
      "per-node/conduit max depths and the engine's own continuity errors land in an `analysis` " +
      "artifact. Networks without an outfall are refused honestly, never solved by guessing.",
    pickerLabel: "SWMM model JSON artifact (kind dataset)",
    runLabel: "Run drainage",
    eligible: jsonDatasetEligible,
    emptyNote:
      "No .json dataset artifacts in this project yet — upload an eos-swmm-model/1 JSON (kind " +
      "`dataset`). The route validates the model shape and refuses it honestly otherwise.",
  },
]

function CapabilityCard({
  spec,
  rows,
  artifactsError,
  artifactsLoading,
  onRetryArtifacts,
  running,
  onRun,
}: {
  spec: CapabilitySpec
  rows: ArtifactListItem[]
  artifactsError: string | null
  artifactsLoading: boolean
  onRetryArtifacts: () => void
  running: SimOp | null
  onRun: (op: Extract<SimOp, "fe-mesh" | "powerflow" | "simulate" | "solve-fea" | "run-swmm">, artifactId: string) => void
}) {
  const eligible = useMemo(() => rows.filter(spec.eligible), [rows, spec])
  // The picked id is DERIVED at render time (the react-hooks/set-state-in-effect
  // convention): state stores only the user's explicit choice; an invalid or
  // absent choice falls back to the first eligible artifact — no reset effect.
  const [userPick, setUserPick] = useState<string | null>(null)
  const picked =
    userPick !== null && eligible.some((a) => a.id === userPick)
      ? userPick
      : (eligible[0]?.id ?? "")

  const busy = running !== null

  return (
    <Card className="min-w-0">
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <spec.icon className="size-4 text-muted-foreground" aria-hidden />
            <h3 className="text-sm font-semibold tracking-tight">{spec.title}</h3>
          </div>
          <Badge variant="outline" className="font-mono text-[11px] uppercase" title={`engine: ${spec.engineKey}`}>
            {spec.engineKey}
          </Badge>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">{spec.blurb}</p>

        {artifactsError ? (
          <ErrorState message={artifactsError} onRetry={onRetryArtifacts} />
        ) : artifactsLoading ? (
          <Skeleton className="h-11 w-full" />
        ) : (
          <Select value={picked} onValueChange={setUserPick} disabled={eligible.length === 0}>
            <SelectTrigger
              size="default"
              className="h-11 w-full min-w-0"
              aria-label={`${spec.title} input artifact`}
            >
              <SelectValue placeholder={spec.pickerLabel} />
            </SelectTrigger>
            <SelectContent>
              {eligible.map((a) => (
                <SelectItem key={a.id} value={a.id} className="py-2.5">
                  <span className="min-w-0 truncate">{a.name}</span>
                  <Badge variant="outline" className="font-mono text-[11px]">
                    {a.kind}
                  </Badge>
                  <span className="font-mono text-xs text-muted-foreground">
                    r{a.latestRevision?.revNumber ?? "—"}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {eligible.length === 0 && !artifactsLoading && !artifactsError ? (
          <p className="rounded-md border border-dashed px-3 py-3 text-xs text-muted-foreground">
            {spec.emptyNote}
          </p>
        ) : (
          <GuardedButton
            className="h-11"
            disabled={busy || picked === ""}
            onClick={() => onRun(spec.op, picked)}
          >
            {running === spec.op ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : (
              <Play aria-hidden />
            )}
            {running === spec.op ? OP_RUN_LABEL[spec.op] : spec.runLabel}
          </GuardedButton>
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Register row card (grid)
// ---------------------------------------------------------------------------

function RegisterRowCard({
  row,
  selected,
  onSelect,
}: {
  row: ArtifactListItem
  selected: boolean
  onSelect: () => void
}) {
  const rev = row.latestRevision
  return (
    <Card
      className={cn(
        "min-w-0 transition-colors",
        selected ? "border-orange-300 bg-accent/40 dark:border-orange-700" : "hover:bg-accent/30",
      )}
    >
      <CardContent className="p-4">
        <button
          type="button"
          onClick={onSelect}
          aria-pressed={selected}
          aria-label={`Inspect result ${row.name} (${row.kind})`}
          className="flex min-h-11 w-full flex-col items-start gap-2 text-left"
        >
          <span className="flex w-full items-start justify-between gap-2">
            <span className="min-w-0 truncate font-medium" title={row.id}>
              {row.name}
            </span>
            <KindBadge kind={row.kind} />
          </span>
          <span className="flex flex-wrap items-center gap-1.5">
            {rev ? <ApprovalBadge state={rev.approvalState} /> : null}
            {rev ? <StalenessBadge state={rev.staleness} /> : null}
          </span>
          <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 font-mono text-xs text-muted-foreground">
            {rev ? <span>r{rev.revNumber}</span> : <span>no revisions</span>}
            {rev ? <span>· {humanBytes(rev.sizeBytes)}</span> : null}
            <span title={row.updatedAt}>· {relTime(row.updatedAt)}</span>
          </span>
        </button>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Selected-result detail card
// ---------------------------------------------------------------------------

function ProvenanceBar({
  run,
  payloadFormat,
  payloadGeneratedBy,
}: {
  run: DeriveRunResult | null
  payloadFormat: string | null
  payloadGeneratedBy?: FeMeshPayload["generatedBy"]
}) {
  // Engine identity resolution (honest, in order): the run response (the
  // execution record), the stored payload's generatedBy block (femesh), or the
  // frozen §4 format→engine table (contract-pinned, title says so).
  const fromRun = run && (run.engineKey ?? null)
  const fromPayload = payloadGeneratedBy?.engineKey ?? null
  const fromFormat = payloadFormat ? FORMAT_ENGINE[payloadFormat] : undefined
  const engineKey = fromRun ?? fromPayload ?? fromFormat?.engineKey ?? null
  const engineVersion =
    run?.engineVersion ?? payloadGeneratedBy?.engineVersion ?? null
  const engineTitle = fromRun
    ? "recorded by this run's execution record"
    : fromPayload
      ? `embedded in the stored payload (adapter ${payloadGeneratedBy?.adapterScript})`
      : fromFormat
        ? "identified by the payload's frozen format per the contract §4 engine table"
        : undefined

  return (
    <section
      aria-label="Provenance"
      className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border bg-card px-4 py-2.5 text-xs text-muted-foreground"
    >
      {engineKey ? (
        <span className="flex items-center gap-1.5" title={engineTitle}>
          <Badge variant="outline" className="font-mono text-[11px] uppercase">
            {engineKey}
          </Badge>
          <span className="font-medium text-foreground">
            {engineVersion ? `${engineKey} ${engineVersion}` : engineKey}
          </span>
        </span>
      ) : (
        <span className="italic">engine not recorded on this artifact</span>
      )}
      {run?.adapterScript ? (
        <span
          className="font-mono"
          title={`adapter ${run.adapterScript} — sha256 ${run.adapterHash ?? "n/a"}`}
        >
          adapter {run.adapterScript} ({shortHash(run.adapterHash)})
        </span>
      ) : payloadGeneratedBy ? (
        <span className="font-mono" title={`adapter script recorded in the stored payload`}>
          adapter {payloadGeneratedBy.adapterScript}
        </span>
      ) : null}
      {run?.exitCode !== undefined && run?.exitCode !== null ? (
        <span className="font-mono tabular-nums">exit {run.exitCode}</span>
      ) : null}
      {run?.durationMs !== undefined && run?.durationMs !== null ? (
        <span className="font-mono tabular-nums">took {formatDuration(run.durationMs)}</span>
      ) : null}
      {payloadFormat ? (
        <Badge variant="outline" className="font-mono text-[11px]">
          {payloadFormat}
        </Badge>
      ) : null}
    </section>
  )
}

function ExecutionRecordSection({ run }: { run: DeriveRunResult | null }) {
  if (run === null) {
    return (
      <InfoNote>
        Execution record (stdout/stderr tails, exit code, duration) is returned by the run itself and
        kept on the workflow step rows — direct runs in an earlier session did not store tails on
        artifact. Re-run the op to capture a fresh verbatim record.
      </InfoNote>
    )
  }
  return (
    <Collapsible>
      <CollapsibleTrigger className="flex min-h-8 items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline">
        <ChevronDown className="size-3.5" aria-hidden />
        Execution record &amp; logs (this session&apos;s run)
      </CollapsibleTrigger>
      <CollapsibleContent>
        <dl className="mt-1 grid gap-x-4 gap-y-1.5 rounded-lg border bg-muted/30 p-3 text-xs sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">Produced</dt>
            <dd className="font-mono">
              {run.revisionNumber !== undefined && run.revisionNumber !== null
                ? `revision r${run.revisionNumber}`
                : "—"}
              {run.sizeBytes ? ` · ${humanBytes(run.sizeBytes)}` : ""}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Exit code</dt>
            <dd className="font-mono">{run.exitCode !== undefined && run.exitCode !== null ? run.exitCode : "—"}</dd>
          </div>
        </dl>
        {run.stdoutTail ? (
          <div>
            <p className="mt-2 text-xs font-medium text-muted-foreground">stdout (tail, verbatim)</p>
            <pre className="eos-scroll mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
              {run.stdoutTail}
            </pre>
          </div>
        ) : null}
        {run.stderrTail ? (
          <div>
            <p className="mt-2 text-xs font-medium text-muted-foreground">stderr (tail, verbatim)</p>
            <pre className="eos-scroll mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
              {run.stderrTail}
            </pre>
          </div>
        ) : null}
        {!run.stdoutTail && !run.stderrTail ? (
          <p className="mt-2 text-xs text-muted-foreground">
            The run produced no stdout/stderr tails worth recording (empty adapter streams).
          </p>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  )
}

/** Payload results per frozen §2 format — numbers render verbatim, never reformatted. */
function PayloadSection({
  payload,
}: {
  payload: DerivedPayload
}) {
  if (payload.format === "eos-femesh/1") {
    const p = payload
    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 rounded-lg border bg-muted/30 px-4 py-2.5 font-mono text-xs text-muted-foreground">
          <span className="tabular-nums" title="node count">
            {p.nodes.count} nodes
          </span>
          <span className="tabular-nums" title="element count and type">
            {p.elements.count} {p.elements.type} elements
          </span>
          <span className="tabular-nums" title="mesh sizes in mm">
            sizes {p.meshSizeMin}–{p.meshSizeMax} mm · order {p.elementOrder}
          </span>
          <span className="tabular-nums" title="quality min/mean">
            quality {Number.isFinite(p.quality.min) ? p.quality.min.toFixed(3) : "—"} /{" "}
            {Number.isFinite(p.quality.mean) ? p.quality.mean.toFixed(3) : "—"}
          </span>
          <span title="units">units {p.units}</span>
        </div>
        <div className="eos-scroll max-h-64 overflow-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted">
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th scope="col" className="px-3 py-2 font-medium">Solid ref</th>
                <th scope="col" className="px-3 py-2 font-medium">Name</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Tets</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Mesh volume ({p.units})</th>
              </tr>
            </thead>
            <tbody>
              {p.solids.map((s) => (
                <tr key={s.ref} className="border-b last:border-0">
                  <td className="px-3 py-2 font-mono text-xs">{s.ref}</td>
                  <td className="px-3 py-2">{s.name ?? <span className="text-xs text-muted-foreground">—</span>}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {Number.isFinite(s.tetCount) ? s.tetCount.toLocaleString() : "—"}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {Number.isFinite(s.meshVolume) ? s.meshVolume.toLocaleString() : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <InfoNote>
          Mesh volume is the divergence-theorem volume of the tets attributed to each solid — an honest
          mesh-derived quantity, never claimed analytic. Linear tets under-trap curved surfaces; the
          bias shrinks with mesh size.
        </InfoNote>
      </div>
    )
  }
  if (payload.format === "eos-powerflow/1") {
    const p = payload
    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border bg-muted/30 px-4 py-2.5 text-xs text-muted-foreground">
          {p.converged ? (
            <Badge className="border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
              converged
            </Badge>
          ) : (
            <Badge variant="destructive">not converged</Badge>
          )}
          <span className="font-mono tabular-nums" title="total losses">
            losses {Number.isFinite(p.totals.lossMw) ? p.totals.lossMw : "—"} MW
          </span>
          <span className="font-mono tabular-nums" title="total load">
            load {Number.isFinite(p.totals.loadMw) ? p.totals.loadMw : "—"} MW
          </span>
        </div>
        <div className="eos-scroll max-h-72 overflow-auto rounded-lg border">
          <table className="w-full text-sm">
            <caption className="sr-only">Power flow results — bus voltages and line flows, verbatim from the engine</caption>
            <thead className="sticky top-0 bg-muted">
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th scope="col" className="px-3 py-2 font-medium">Bus</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">vm (pu)</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">angle (°)</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">P (MW)</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Q (Mvar)</th>
              </tr>
            </thead>
            <tbody>
              {p.buses.map((b) => (
                <tr key={b.id} className="border-b last:border-0">
                  <td className="px-3 py-2 font-mono text-xs">{b.id}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{b.vmPu}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{b.angleDeg}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{b.pMw}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{b.qMvar}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">
          Line flows —{" "}
          {p.lines.length > 0 ? (
            <span className="font-mono">
              {p.lines
                .map((l) => `${l.fromBus}→${l.toBus}: ${l.iKa} kA, ${l.pLossMw} MW loss`)
                .join(" · ")}
            </span>
          ) : (
            <span>no lines recorded</span>
          )}
        </p>
      </div>
    )
  }
  if (payload.format === "eos-des/1") {
    const p = payload
    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border bg-muted/30 px-4 py-2.5 text-xs text-muted-foreground">
          <Badge variant="outline" className="font-mono text-[11px] uppercase">
            policy {p.policy}
          </Badge>
          <span className="font-mono tabular-nums" title="makespan in scenario time units">
            makespan {Number.isFinite(p.makespan) ? p.makespan : "—"}
          </span>
          <span className="font-mono tabular-nums">{p.jobs.length} jobs</span>
        </div>
        <div className="eos-scroll max-h-64 overflow-auto rounded-lg border">
          <table className="w-full text-sm">
            <caption className="sr-only">Discrete-event results — resource utilization and job timelines</caption>
            <thead className="sticky top-0 bg-muted">
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th scope="col" className="px-3 py-2 font-medium">Resource</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Busy</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Utilization</th>
              </tr>
            </thead>
            <tbody>
              {p.resources.map((r) => (
                <tr key={r.id} className="border-b last:border-0">
                  <td className="px-3 py-2 font-mono text-xs">{r.id}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{r.busy}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {Number.isFinite(r.utilization) ? r.utilization.toFixed(3) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">
          Job timelines —{" "}
          {p.jobs.length > 0 ? (
            <span className="font-mono">
              {p.jobs.map((j) => `${j.id}: ${j.startAt}→${j.endAt}`).join(" · ")}
            </span>
          ) : (
            <span>no jobs recorded</span>
          )}
        </p>
      </div>
    )
  }
  if (payload.format === "eos-fea/1") {
    const p = payload
    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border bg-muted/30 px-4 py-2.5 text-xs text-muted-foreground">
          <Badge className="border-transparent bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300">
            plane stress
          </Badge>
          <span className="font-mono tabular-nums" title="max displacement magnitude over all dof points">
            max |u| {Number.isFinite(p.maxDisplacementMagnitudeMm) ? p.maxDisplacementMagnitudeMm.toFixed(6) : "—"} mm
          </span>
          <span className="font-mono tabular-nums" title="max von Mises stress across elements">
            von Mises max {Number.isFinite(p.stress.vonMisesMaxMpa) ? p.stress.vonMisesMaxMpa.toFixed(3) : "—"} MPa
          </span>
          <span className="font-mono tabular-nums" title="uniform tri6 mesh at the pinned refinement">
            {Number.isFinite(p.mesh.elementCount) ? p.mesh.elementCount.toLocaleString() : "—"} {p.mesh.elementType} elements
          </span>
        </div>
        <div className="eos-scroll max-h-72 overflow-auto rounded-lg border">
          <table className="w-full text-sm">
            <caption className="sr-only">FEA results — corner and center sample displacements, verbatim from the engine</caption>
            <thead className="sticky top-0 bg-muted">
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th scope="col" className="px-3 py-2 font-medium">Sample (mm)</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">u_x (mm)</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">u_y (mm)</th>
              </tr>
            </thead>
            <tbody>
              {p.samples.map((s, i) => (
                <tr key={`${s.x}-${s.y}-${i}`} className="border-b last:border-0">
                  <td className="px-3 py-2 font-mono text-xs">
                    ({Number.isFinite(s.x) ? s.x : "—"}, {Number.isFinite(s.y) ? s.y : "—"})
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {Number.isFinite(s.ux) ? s.ux : "—"}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {Number.isFinite(s.uy) ? s.uy : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <InfoNote>
          Linear plane-stress solve (scikit-fem) — sample displacements at the 4 domain corners + center;
          stress stats are per-element means (a P0 mass-lumped projection of C·ε(u)); every number is
          copied verbatim from the engine. Under-constrained models are refused, never guessed.
        </InfoNote>
      </div>
    )
  }
  if (payload.format === "eos-swmm/1") {
    const p = payload
    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border bg-muted/30 px-4 py-2.5 text-xs text-muted-foreground">
          <Badge className="border-transparent bg-cyan-100 text-cyan-800 dark:bg-cyan-950 dark:text-cyan-300">
            drainage
          </Badge>
          <span className="font-mono tabular-nums" title="trapezoid-integrated outfall volume over the run">
            outfall {Number.isFinite(p.outfallVolumeM3) ? p.outfallVolumeM3.toFixed(2) : "—"} m³
          </span>
          <span
            className="font-mono tabular-nums"
            title="our honesty metric: 100·(outfall − rainfall)/rainfall — the engine must not lose water"
          >
            rain {Number.isFinite(p.rain.totalVolumeM3) ? p.rain.totalVolumeM3.toFixed(2) : "—"} m³ · balance{" "}
            {Number.isFinite(p.volumeBalancePct) ? (p.volumeBalancePct >= 0 ? "+" : "") + p.volumeBalancePct.toFixed(3) : "—"}%
          </span>
          <span className="font-mono tabular-nums" title="the engine's own .rpt continuity errors">
            continuity {Number.isFinite(p.continuity.runoffErrorPct) ? p.continuity.runoffErrorPct : "—"}% /{" "}
            {Number.isFinite(p.continuity.routingErrorPct) ? p.continuity.routingErrorPct : "—"}%
          </span>
          <span className="font-mono tabular-nums" title="peak conduit flow (kinematic wave)">
            peak Q {Number.isFinite(p.peaks.maxConduitFlowCms) ? p.peaks.maxConduitFlowCms : "—"} m³/s
          </span>
        </div>
        <div className="eos-scroll max-h-72 overflow-auto rounded-lg border">
          <table className="w-full text-sm">
            <caption className="sr-only">
              Drainage results — per-node and per-conduit maximum depths, verbatim from the engine
            </caption>
            <thead className="sticky top-0 bg-muted">
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th scope="col" className="px-3 py-2 font-medium">Node / conduit</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Max depth (m)</th>
              </tr>
            </thead>
            <tbody>
              {p.depths.map((d) => (
                <tr key={d.id} className="border-b last:border-0">
                  <td className="px-3 py-2 font-mono text-xs">{d.id}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {Number.isFinite(d.maxDepthM) ? d.maxDepthM : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <InfoNote>
          Stormwater drainage (EPA SWMM5 via pyswmm, kinematic wave, {p.routing.routingStepSec}s routing step) —
          impervious catchments under one uniform rain event; every number is copied verbatim from the
          engine, whose own .rpt continuity errors ride along. Networks without an outfall are refused,
          never guessed.
        </InfoNote>
      </div>
    )
  }
  // eos-cpm/1 — full CPM view lives in Project Controls (its own workspace);
  // here an honest compact summary + pointer.
  const p = payload
  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-muted/30 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
        <span className="font-mono tabular-nums">
          project duration {Number.isFinite(p.durationDays) ? p.durationDays : "—"} days
        </span>
        <span className="font-mono tabular-nums">{p.activities.length} activities</span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted-foreground">Critical path:</span>
        {p.criticalPath.length === 0 ? (
          <span className="text-xs">—</span>
        ) : (
          p.criticalPath.map((id, i) => (
            <Badge key={id} variant="outline" className="font-mono text-[11px]" title={`critical path position ${i + 1}`}>
              {id}
              {i < p.criticalPath.length - 1 ? <span aria-hidden className="text-muted-foreground"> →</span> : null}
            </Badge>
          ))
        )}
      </div>
      <InfoNote>
        This is a platform-core critical-path analysis (no engine). The full activity table and Gantt
        view live in Project Controls — create or pick the schedule there and press Analyze.
      </InfoNote>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

const noop = () => {}

interface RowLinks {
  /** derived_from targets (usually exactly one: the picked source artifact) */
  sources: Array<{ id: string; name: string; kind: string }>
}

export function SimWorkspace({
  projectId,
  onMutated,
}: {
  projectId: string
  /** Parent-side cache nudge: runs create/append artifact revisions the
   *  project-level caches don't observe on their own (useApi is
   *  manual-refresh — the Phase-4 Artifacts-tab lesson, now a standard). */
  onMutated?: () => void
}) {
  const artifacts = useApi<{ artifacts: ArtifactListItem[] }>(`/api/projects/${projectId}/artifacts`)
  const notifyMutated = onMutated ?? noop

  const rows = useMemo(() => artifacts.data?.artifacts ?? [], [artifacts.data])
  const registerRows = useMemo(
    () => rows.filter((a) => a.kind === "fe-mesh" || a.kind === "analysis"),
    [rows],
  )

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [running, setRunning] = useState<SimOp | null>(null)
  /** In-session run records keyed by the produced artifact id. */
  const [runByArtifact, setRunByArtifact] = useState<Record<string, { op: SimOp; result: DeriveRunResult }>>({})

  // --- derived_from link resolution (studio mesh-map pattern, O(#rows)) -------
  const [linksByRow, setLinksByRow] = useState<Record<string, RowLinks>>({})
  const [linksLoading, setLinksLoading] = useState(false)
  const [linksError, setLinksError] = useState<string | null>(null)
  useEffect(() => {
    if (registerRows.length === 0) {
      setLinksByRow({})
      setLinksLoading(false)
      setLinksError(null)
      return
    }
    let cancelled = false
    setLinksLoading(true)
    void (async () => {
      try {
        const details = await Promise.all(registerRows.map((a) => getArtifactDetail(a.id)))
        if (cancelled) return
        const map: Record<string, RowLinks> = {}
        for (const detail of details) {
          const sources: RowLinks["sources"] = []
          for (const link of detail.artifact.linksFrom) {
            if (link.relationType === "derived_from" && link.toArtifact) {
              sources.push({
                id: link.toArtifact.id,
                name: link.toArtifact.name,
                kind: link.toArtifact.kind,
              })
            }
          }
          map[detail.artifact.id] = { sources }
        }
        setLinksByRow(map)
        setLinksError(null)
      } catch (err) {
        if (!cancelled) {
          setLinksError(err instanceof Error ? err.message : "Could not resolve the derived-from links")
        }
      } finally {
        if (!cancelled) setLinksLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [registerRows])

  // Selection is DERIVED at render time (the react-hooks/set-state-in-effect
  // convention): `selectedId` stores only an explicit choice (a click or a
  // just-finished run); when it is absent or no longer in the register, the
  // first row stands in — no reset effect.
  const selected = useMemo(() => {
    if (selectedId !== null) {
      const hit = registerRows.find((r) => r.id === selectedId)
      if (hit) return hit
    }
    return registerRows[0] ?? null
  }, [registerRows, selectedId])
  const effectiveSelectedId = selected?.id ?? null

  // --- selected-row payload read (selection-driven; honest 404 handling) -----
  const [payloadRead, setPayloadRead] = useState<{
    rowId: string
    loading: boolean
    error: string | null
    raw: string | null
    payload: DerivedPayload | null
  }>({ rowId: "", loading: false, error: null, raw: null, payload: null })
  const selectedRevisionId = selected?.latestRevision?.id ?? null
  useEffect(() => {
    if (selected === null || selectedRevisionId === null) {
      setPayloadRead({ rowId: "", loading: false, error: null, raw: null, payload: null })
      return
    }
    let cancelled = false
    setPayloadRead({ rowId: selected.id, loading: true, error: null, raw: null, payload: null })
    void (async () => {
      try {
        const text = await fetchRevisionText(selectedRevisionId)
        if (cancelled) return
        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch {
          setPayloadRead({
            rowId: selected.id,
            loading: false,
            error: "the stored revision is not valid JSON — nothing to display",
            raw: text,
            payload: null,
          })
          return
        }
        const payload = readDerivedPayload(parsed)
        if (payload !== null) {
          setPayloadRead({ rowId: selected.id, loading: false, error: null, raw: null, payload })
        } else {
          setPayloadRead({
            rowId: selected.id,
            loading: false,
            error: "the stored revision carries no recognizable derived-payload format field",
            raw: text,
            payload: null,
          })
        }
      } catch (err) {
        if (!cancelled) {
          setPayloadRead({
            rowId: selected.id,
            loading: false,
            error: err instanceof Error ? err.message : "Could not read the stored payload",
            raw: null,
            payload: null,
          })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [selected, selectedRevisionId])

  const inSessionRun = effectiveSelectedId !== null ? runByArtifact[effectiveSelectedId] ?? null : null
  // The payload display prefers the freshly-read stored revision; a run made
  // in THIS session carries the parsed document from its 201 response and
  // fills the gap when the revision download route is unavailable mid-flight.
  const runPayload = inSessionRun !== null ? readDerivedPayload(inSessionRun.result.document) : null
  const storedPayload =
    payloadRead.rowId === (selected?.id ?? "") && !payloadRead.loading ? payloadRead.payload : null
  const payload = storedPayload ?? runPayload
  const payloadError =
    payloadRead.rowId === (selected?.id ?? "") && !payloadRead.loading ? payloadRead.error : null
  const payloadRaw =
    payloadRead.rowId === (selected?.id ?? "") && !payloadRead.loading ? payloadRead.raw : null
  const payloadFormat = payload?.format ?? null

  // --- run / regenerate -------------------------------------------------------

  const applyRun = async (op: SimOp, artifactId: string) => {
    if (running !== null) return
    setRunning(op)
    try {
      let result: DeriveRunResult
      if (op === "fe-mesh") result = (await runFeMesh(projectId, artifactId)).femesh
      else if (op === "powerflow") result = (await runPowerFlow(projectId, artifactId)).powerflow
      else if (op === "simulate") result = (await runDiscreteEvent(projectId, artifactId)).sim
      else if (op === "solve-fea") result = (await runFea(projectId, artifactId)).fea
      else if (op === "run-swmm") result = (await runSwmm(projectId, artifactId)).swmm
      else result = (await analyzeSchedule(projectId, artifactId)).analysis
      toast.success(
        `${op === "fe-mesh" ? "FE mesh" : op === "powerflow" ? "Power flow" : op === "simulate" ? "Simulation" : op === "solve-fea" ? "FEA solve" : op === "run-swmm" ? "Drainage simulation" : "Schedule analysis"} complete — ${result.name}${result.revisionNumber ? ` r${result.revisionNumber}` : ""} stored as a derived artifact`,
      )
      setRunByArtifact((prev) => ({ ...prev, [result.artifactId]: { op, result } }))
      setSelectedId(result.artifactId)
      // Cache nudges: the register + Artifacts tab + activity feed all read
      // project-level caches that refresh only on their own triggers.
      void artifacts.refresh()
      notifyMutated()
    } catch (err) {
      // 422 refusals (unsupported input, engine_unavailable, honest engine
      // errors) surface verbatim — never paraphrased.
      toast.error(err instanceof Error ? err.message : "Run failed")
    } finally {
      setRunning(null)
    }
  }

  /**
   * Regenerate re-runs the SAME op on the SAME source artifact (studio
   * pattern). Requires: the source (derived_from link) and the op — known
   * from the row kind (fe-mesh), the payload format, or this session's run.
   */
  const regenerateOp: SimOp | null = (() => {
    if (selected === null) return null
    if (selected.kind === "fe-mesh") return "fe-mesh"
    if (inSessionRun !== null) return inSessionRun.op
    if (payloadFormat && FORMAT_OP[payloadFormat]) return FORMAT_OP[payloadFormat]
    return null
  })()
  const regenerateSourceId: string | null = (() => {
    if (selected === null) return null
    const linkSource = linksByRow[selected.id]?.sources[0]?.id ?? null
    return linkSource ?? inSessionRun?.result.derivedFromArtifactId ?? null
  })()

  const regenerable =
    selected !== null &&
    selected.latestRevision !== null &&
    regenerateOp !== null &&
    regenerateSourceId !== null

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight">
          <FlaskConical className="size-4 text-muted-foreground" aria-hidden /> Simulation &amp; Verification
        </h2>
        <Alert>
          <Info aria-hidden />
          <AlertTitle>Real engine runs, honestly recorded</AlertTitle>
          <AlertDescription>
            Each capability calls the registered engine through the broker — gmsh for FE meshing,
            pandapower for power flow, SimPy for discrete-event simulation. Results are stored as
            derived artifacts (kind <span className="font-mono">fe-mesh</span> /{" "}
            <span className="font-mono">analysis</span>) linked to their source, go stale when the
            source is revised, and carry the engine&apos;s numbers verbatim — the platform never
            rounds, rescales or invents a value.
          </AlertDescription>
        </Alert>
      </header>

      {/* ---------------- Capability cards ---------------- */}
      <section aria-label="Capabilities" className="grid min-w-0 gap-4 md:grid-cols-3">
        {CAPABILITIES.map((spec) => (
          <CapabilityCard
            key={spec.op}
            spec={spec}
            rows={rows}
            artifactsError={artifacts.error}
            artifactsLoading={artifacts.loading}
            onRetryArtifacts={() => void artifacts.refresh()}
            running={running}
            onRun={(op, artifactId) => void applyRun(op, artifactId)}
          />
        ))}
      </section>

      {/* ---------------- Results register ---------------- */}
      <section aria-label="Simulation results" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold tracking-tight">
            Results ({registerRows.length})
          </h3>
          <span className="text-xs text-muted-foreground">
            derived artifacts of kind <span className="font-mono">fe-mesh</span> and{" "}
            <span className="font-mono">analysis</span> in this project
          </span>
          {running !== null ? (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
              <Loader2 className="size-3.5 animate-spin" aria-hidden /> engine running…
            </span>
          ) : null}
        </div>

        {artifacts.error ? (
          <ErrorState message={artifacts.error} onRetry={() => void artifacts.refresh()} />
        ) : artifacts.loading ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Loading results">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-28" />
            ))}
          </div>
        ) : registerRows.length === 0 ? (
          <EmptyState
            icon={FlaskConical}
            title="No simulation results yet"
            description="Run a capability above — FE mesh, power flow or discrete-event simulation. Every run stores its output as a derived artifact with provenance, and nothing appears here until an engine actually succeeds."
          />
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {registerRows.map((row) => (
                <RegisterRowCard
                  key={row.id}
                  row={row}
                  selected={row.id === effectiveSelectedId}
                  onSelect={() => setSelectedId(row.id)}
                />
              ))}
            </div>

            {selected === null ? (
              <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                Select a result to inspect its provenance, payload and logs.
              </p>
            ) : (
              <Card>
                <CardContent className="flex flex-col gap-4 p-4 sm:p-6">
                  {/* ---------- Header ---------- */}
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h4 className="flex flex-wrap items-center gap-2 text-sm font-semibold tracking-tight">
                        <span className="truncate" title={selected.id}>
                          {selected.name}
                        </span>
                        <KindBadge kind={selected.kind} />
                        {selected.latestRevision ? (
                          <Badge variant="outline" className="font-mono text-xs">
                            r{selected.latestRevision.revNumber}
                          </Badge>
                        ) : null}
                      </h4>
                      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                        {selected.latestRevision ? (
                          <>
                            <ApprovalBadge state={selected.latestRevision.approvalState} />
                            <span title={selected.latestRevision.createdAt}>
                              generated {formatDate(selected.latestRevision.createdAt)}
                            </span>
                            <span>· {humanBytes(selected.latestRevision.sizeBytes)}</span>
                          </>
                        ) : (
                          <span>no revisions</span>
                        )}
                      </p>
                    </div>
                    <StalenessBadge state={selected.latestRevision?.staleness ?? "current"} />
                  </div>

                  {/* ---------- Staleness banner + Regenerate (studio pattern) ---------- */}
                  {selected.latestRevision?.staleness === "stale" ? (
                    <Alert className="border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
                      <TriangleAlert aria-hidden />
                      <AlertTitle>Stale result</AlertTitle>
                      <AlertDescription className="text-amber-900/90 dark:text-amber-300/90">
                        The source artifact has a newer revision — this result was generated from an
                        older revision and is kept for provenance until you regenerate it.
                        Regenerating appends a new revision; the stale one stays for audit.
                      </AlertDescription>
                      <div className="col-start-2">
                        {regenerable ? (
                          <GuardedButton
                            variant="outline"
                            className="mt-1 h-11 border-amber-400 bg-amber-100/60 text-amber-900 hover:bg-amber-100 hover:text-amber-950 dark:border-amber-700 dark:bg-amber-900 dark:text-amber-200 dark:hover:bg-amber-900/80"
                            disabled={running !== null}
                            onClick={() => void applyRun(regenerateOp!, regenerateSourceId!)}
                          >
                            {running !== null ? (
                              <Loader2 className="animate-spin" aria-hidden />
                            ) : (
                              <RefreshCw aria-hidden />
                            )}
                            {running !== null ? OP_RUN_LABEL[regenerateOp!] : "Regenerate"}
                          </GuardedButton>
                        ) : (
                          <p className="mt-1 text-xs">
                            The producing operation cannot be resolved in this session (its stored
                            payload is not readable) — re-run the capability above on the source
                            artifact instead.
                          </p>
                        )}
                      </div>
                    </Alert>
                  ) : null}

                  {/* ---------- Derived-from link chips ---------- */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs font-medium text-muted-foreground">Derived from:</span>
                    {linksLoading ? (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground" role="status">
                        <Loader2 className="size-3 animate-spin" aria-hidden /> resolving links…
                      </span>
                    ) : linksError ? (
                      <span className="text-xs text-destructive" role="alert">
                        {linksError}
                      </span>
                    ) : (linksByRow[selected.id]?.sources ?? []).length === 0 ? (
                      <span className="text-xs text-muted-foreground">—</span>
                    ) : (
                      linksByRow[selected.id].sources.map((s) => (
                        <Badge
                          key={s.id}
                          variant="outline"
                          className="max-w-[220px] font-mono text-[11px]"
                          title={`${s.id} (kind ${s.kind})`}
                        >
                          {s.name}
                        </Badge>
                      ))
                    )}
                  </div>

                  {/* ---------- Provenance bar ---------- */}
                  <ProvenanceBar
                    run={inSessionRun?.result ?? null}
                    payloadFormat={payloadFormat}
                    payloadGeneratedBy={payload?.format === "eos-femesh/1" ? payload.generatedBy : undefined}
                  />

                  {/* ---------- Execution record (verbatim tails) ---------- */}
                  <ExecutionRecordSection run={inSessionRun?.result ?? null} />

                  {/* ---------- Stored payload ---------- */}
                  <section aria-label="Stored result payload" className="flex flex-col gap-2">
                    <h3 className="text-sm font-semibold tracking-tight">Result payload</h3>
                    {payloadRead.loading ? (
                      <Skeleton className="h-24 w-full" />
                    ) : payload !== null ? (
                      <>
                        {storedPayload === null && inSessionRun !== null ? (
                          <p className="text-xs text-muted-foreground">
                            Shown from this session&apos;s run response — the stored revision could
                            not be read directly ({payloadError ?? "no revision to read"}).
                          </p>
                        ) : null}
                        <PayloadSection payload={payload} />
                      </>
                    ) : payloadError ? (
                      <div className="flex flex-col gap-2" role="alert">
                        <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
                          {payloadError} — the register entry, provenance links and staleness above
                          are unaffected; the raw revision bytes could not be read in this build.
                        </p>
                        {payloadRaw ? (
                          <pre className="eos-scroll max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
                            {payloadRaw.slice(0, 2000)}
                          </pre>
                        ) : null}
                      </div>
                    ) : (
                      <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
                        Reading the stored revision…
                      </p>
                    )}
                  </section>
                </CardContent>
              </Card>
            )}
          </>
        )}
      </section>
    </div>
  )
}
