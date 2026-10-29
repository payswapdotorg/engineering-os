"use client"

/**
 * Design Studio workspace (W1-d lane, Phase 2).
 *
 * Per-model mesh state over the pinned Phase-2 API contracts:
 *  - the picker lists ONLY artifacts whose latest revision is derivable
 *    (.step/.stp/.ifc — same canonical multi-signal detector as the backend
 *    route, src/engines/adapters/derive-kind.ts);
 *  - no mesh yet → "Generate 3D view" (POST derive-mesh; 422s — unsupported
 *    extension, engine_unavailable — surface VERBATIM in a toast, the
 *    takeoff-workspace idiom);
 *  - mesh present → viewer + Regenerate; staleSource → amber banner with the
 *    pinned message + Regenerate.
 *
 * Slice 16 (the Phase-2 EDITING journey — roadmap-gap-audit item 2): the
 * PARAMETRIC section above the viewer — a registered .py parametric-model
 * artifact (kind `calculation`) renders its declared PARAM_SCHEMA as a
 * values-only form (label/unit/min-max/default per parameter; editing the
 * SCRIPT itself stays an ordinary new artifact revision — never an IDE in
 * the browser), and "Rebuild model" runs the real cadquery adapter through
 * the broker: the rebuilt STEP lands on a find-or-create kind-`model` artifact
 * derived_from the script (sequential revisions), downstream meshes go stale
 * (the cascade, surfaced in the result), and the rebuilt model immediately
 * appears in the "Model to view" picker above — script → rebuilt model → 3D
 * view is one honest chain with no mock geometry anywhere.
 *
 * Honesty rules this workspace follows:
 *  - meshes are DERIVED artifacts (kind "mesh", derived_from the source); the
 *    source → mesh mapping is resolved through the real artifact links, not
 *    guessed from names. The artifacts LIST payload carries no links, so each
 *    mesh artifact's detail is fetched (O(#meshes)) — honest gap, noted for TL;
 *  - WebGL is probed before the Canvas mounts — an unavailable context renders
 *    a clear message, never a crash (headless browsers hit this state), and an
 *    error boundary wraps the viewer as a second net;
 *  - element refs, units, up-axis and tolerance are the stored payload,
 *    verbatim — the client never rewrites geometry, and the element refs
 *    cross-reference the quantity ledger.
 */
import dynamic from "next/dynamic"
import { useRouter } from "next/navigation"
import {
  Boxes,
  CircleAlert,
  ClipboardList,
  Crosshair,
  DraftingCompass,
  Info,
  Loader2,
  PencilRuler,
  RefreshCw,
  RotateCcw,
  TriangleAlert,
} from "lucide-react"
import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { toast } from "sonner"

import {
  deriveModelMesh,
  getArtifactDetail,
  getParametricSchema,
  rebuildParametric,
  useApi,
  type ArtifactListItem,
  type MeshGetResult,
  type ParametricSchemaGetResult,
  type RebuildParametricResult,
} from "@/components/product/api"
import { EmptyState, ErrorState, InfoNote } from "@/components/product/parts"
import { GuardedButton } from "@/components/product/guarded-button"
import { deriveKind } from "@/engines/adapters/derive-kind"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { humanBytes, relTime, shortHash } from "@/components/product/format"

// three.js viewer — dynamic + ssr:false INSIDE this client component (never in
// a server component), so the 3D stack stays out of the server bundle entirely.
// Nothing may import model-viewer.tsx statically (not even for a helper), or
// the whole stack lands in the initial chunk — hence colorOf lives here.
const ModelViewer = dynamic(() => import("@/components/product/model-viewer"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center" role="status" aria-label="Loading 3D viewer">
      <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden />
    </div>
  ),
})

/** Deterministic element colors — warm/earthy ramp, never blue/indigo-dominant. */
const ELEMENT_PALETTE = [
  "#b45309", // amber-700
  "#a16207", // yellow-700
  "#4d7c0f", // lime-700
  "#15803d", // green-700
  "#0f766e", // teal-700
  "#9f1239", // rose-800
  "#9a3412", // orange-800
  "#57534e", // stone-600
] as const

/** Same color for canvas + element list at a given index — deterministic. */
function elementColor(index: number): string {
  return ELEMENT_PALETTE[index % ELEMENT_PALETTE.length]
}

/** Second net around the Canvas: a render failure becomes a message, not a crash. */
class ViewerErrorBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { hasError: boolean }> {
  state = { hasError: false }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  render() {
    return this.state.hasError ? this.props.fallback : this.props.children
  }
}

function webglSupported(): boolean {
  try {
    const canvas = document.createElement("canvas")
    return !!(canvas.getContext("webgl2") ?? canvas.getContext("webgl"))
  } catch {
    return false
  }
}

const noop = () => {}

// ---------------------------------------------------------------------------
// Parametric rebuild (Slice 16 — the Phase-2 editing journey)
// ---------------------------------------------------------------------------

/** A .py artifact with a latest revision (the parametric-model signal — the
 * same detection the route core uses: name or MIME, never the kind guess). */
function parametricSignal(a: ArtifactListItem): boolean {
  if (a.latestRevision === null) return false
  const name = a.name.toLowerCase()
  const mime = a.latestRevision.mimeType ?? ""
  return name.endsWith(".py") || mime === "text/x-python" || mime === "application/x-python"
}

/** Form state: raw input strings ("" = cleared — sent as null, the server's
 * verbatim type refusal is the honest answer, never a silent default). */
function ParametricSection({
  projectId,
  rows,
  onRebuilt,
}: {
  projectId: string
  rows: ArtifactListItem[]
  onRebuilt: () => void
}) {
  const models = useMemo(() => rows.filter(parametricSignal), [rows])

  const [selectedId, setSelectedId] = useState<string | null>(null)
  useEffect(() => {
    if (models.length === 0) {
      setSelectedId(null)
      return
    }
    if (selectedId === null || !models.some((m) => m.id === selectedId)) {
      setSelectedId(models[0].id)
    }
  }, [models, selectedId])

  // The schema fetch is per-model and MANUAL-flow (not useApi) so a rebuild
  // never re-runs it and a refused selection keeps the honest error inline.
  const [schema, setSchema] = useState<ParametricSchemaGetResult | null>(null)
  const [schemaLoading, setSchemaLoading] = useState(false)
  const [schemaError, setSchemaError] = useState<string | null>(null)

  const [values, setValues] = useState<Record<string, string>>({})
  const [rebuilding, setRebuilding] = useState(false)
  const [result, setResult] = useState<RebuildParametricResult["model"] | null>(null)

  useEffect(() => {
    if (selectedId === null) return
    let cancelled = false
    setSchema(null)
    setSchemaError(null)
    setResult(null)
    setSchemaLoading(true)
    void (async () => {
      try {
        const s = await getParametricSchema(projectId, selectedId)
        if (cancelled) return
        setSchema(s)
        // Seed the form from the authored defaults (values-only editing).
        const seeded: Record<string, string> = {}
        for (const [key, spec] of Object.entries(s.schema.properties)) {
          seeded[key] = String(s.defaults[key] ?? spec.default ?? "")
        }
        setValues(seeded)
      } catch (err) {
        if (!cancelled) {
          setSchemaError(err instanceof Error ? err.message : "Could not read the model schema")
        }
      } finally {
        if (!cancelled) setSchemaLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [projectId, selectedId])

  if (models.length === 0) return null

  const selected = models.find((m) => m.id === selectedId) ?? null

  const resetToDefaults = () => {
    if (!schema) return
    const seeded: Record<string, string> = {}
    for (const [key, spec] of Object.entries(schema.schema.properties)) {
      seeded[key] = String(schema.defaults[key] ?? spec.default ?? "")
    }
    setValues(seeded)
  }

  const rebuild = async () => {
    if (rebuilding || selectedId === null) return
    setRebuilding(true)
    try {
      // Raw input strings → numbers | null (cleared inputs surface the
      // server's verbatim type refusal — the client never guesses).
      const payload: Record<string, number | null> = {}
      for (const [key, raw] of Object.entries(values)) {
        const trimmed = raw.trim()
        if (trimmed === "") {
          payload[key] = null
        } else {
          const parsed = Number(trimmed)
          payload[key] = Number.isFinite(parsed) ? parsed : Number.NaN
        }
      }
      const response = await rebuildParametric(projectId, selectedId, payload)
      setResult(response.model)
      toast.success(
        `Model rebuilt — r${response.model.revisionNumber}, volume ${response.model.volumeMm3.toLocaleString("en-US", { maximumFractionDigits: 2 })} mm³`,
      )
      onRebuilt() // the rebuilt model appears in the "Model to view" picker + Artifacts tab
    } catch (err) {
      // 422s (range / unknown key / geometry contradiction / ground-truth
      // disagreement) surface verbatim — the takeoff idiom.
      toast.error(err instanceof Error ? err.message : "Rebuild failed")
    } finally {
      setRebuilding(false)
    }
  }

  return (
    <section aria-label="Parametric models" className="flex flex-col gap-3">
      <Card className="min-w-0">
        <CardContent className="flex flex-col gap-4 p-4 sm:p-6">
          <div className="flex flex-col gap-2">
            <h3 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
              <PencilRuler className="size-4 text-muted-foreground" aria-hidden /> Parametric models
            </h3>
            <p className="text-sm text-muted-foreground">
              A registered <span className="font-mono">.py</span> parametric-model script declares its own
              parameters (label, unit, min/max, authored defaults). Values-only editing here rebuilds
              the real geometry through cadquery; editing the script itself is an ordinary new
              revision of the model artifact.
            </p>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Select
              value={selectedId ?? ""}
              onValueChange={(v) => {
                setSelectedId(v)
                setResult(null)
              }}
            >
              <SelectTrigger size="default" className="h-11 w-full min-w-0 sm:w-96" aria-label="Parametric model">
                <SelectValue placeholder="Pick a parametric model…" />
              </SelectTrigger>
              <SelectContent>
                {models.map((m) => (
                  <SelectItem key={m.id} value={m.id} className="py-2.5">
                    <span className="min-w-0 truncate">{m.name}</span>
                    <span className="font-mono text-xs text-muted-foreground">
                      r{m.latestRevision?.revNumber ?? "—"}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {schema ? (
              <Button
                variant="ghost"
                className="h-11 shrink-0"
                onClick={resetToDefaults}
                aria-label="Reset parameter values to the authored defaults"
              >
                <RotateCcw aria-hidden /> Defaults
              </Button>
            ) : null}
          </div>

          {selected === null ? null : schemaLoading ? (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-11 w-full sm:w-96" />
              <Skeleton className="h-11 w-full sm:w-96" />
              <Skeleton className="h-11 w-full sm:w-96" />
            </div>
          ) : schemaError ? (
            <ErrorState message={schemaError} onRetry={() => setSelectedId(selected.id)} />
          ) : schema ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {Object.entries(schema.schema.properties).map(([key, spec]) => (
                  <div key={key} className="flex min-w-0 flex-col gap-1.5">
                    <Label htmlFor={`param-${key}`} className="flex items-baseline justify-between gap-2">
                      <span className="min-w-0 truncate">{spec.label ?? key}</span>
                      <span className="shrink-0 font-mono text-[11px] font-normal text-muted-foreground">
                        {key}
                        {spec.unit ? ` · ${spec.unit}` : ""}
                      </span>
                    </Label>
                    <Input
                      id={`param-${key}`}
                      type="number"
                      inputMode="decimal"
                      className="h-11"
                      value={values[key] ?? ""}
                      min={spec.minimum}
                      max={spec.maximum}
                      step="any"
                      onChange={(e) => setValues((prev) => ({ ...prev, [key]: e.target.value }))}
                      aria-label={`${spec.label ?? key} parameter`}
                    />
                    <p className="text-[11px] text-muted-foreground">
                      {typeof spec.minimum === "number" || typeof spec.maximum === "number"
                        ? `range ${spec.minimum ?? "−∞"}…${spec.maximum ?? "∞"}`
                        : "no declared range"}
                      {typeof spec.default === "number" ? ` · authored default ${spec.default}` : ""}
                    </p>
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <GuardedButton className="h-11" disabled={rebuilding} onClick={() => void rebuild()}>
                  {rebuilding ? <Loader2 className="animate-spin" aria-hidden /> : <PencilRuler aria-hidden />}
                  {rebuilding ? "Rebuilding…" : "Rebuild model"}
                </GuardedButton>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {schema.engineKey} {schema.engineVersion} · adapter {shortHash(schema.adapterHash)} ·
                  model {shortHash(schema.modelScriptHash)}
                </span>
              </div>

              {result ? (
                <div
                  role="status"
                  className="flex flex-col gap-2 rounded-lg border bg-muted/30 px-4 py-3 text-sm"
                >
                  <p className="font-medium">
                    Rebuilt —{" "}
                    <span className="font-mono">
                      {result.name} r{result.revisionNumber}
                    </span>{" "}
                    <Badge variant="outline" className="ml-1 font-mono text-[11px] uppercase">
                      {result.kind}
                    </Badge>
                  </p>
                  <dl className="grid grid-cols-1 gap-x-6 gap-y-1 font-mono text-xs text-muted-foreground sm:grid-cols-2">
                    <div className="flex justify-between gap-4">
                      <dt>volume</dt>
                      <dd>
                        {result.volumeMm3.toLocaleString("en-US", { maximumFractionDigits: 4 })} mm³
                      </dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt>surface area</dt>
                      <dd>
                        {result.areaMm2.toLocaleString("en-US", { maximumFractionDigits: 4 })} mm²
                      </dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt>bbox (x·y·z)</dt>
                      <dd>
                        {result.bboxMm.map((n) => n.toFixed(1)).join(" · ")} mm
                      </dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt>ground-truth gate</dt>
                      <dd>
                        rel {result.checks.volumeRelErr.toExponential(2)} ·{" "}
                        {result.checks.passed ? "passed" : "FAILED"}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt>content</dt>
                      <dd title={result.contentHash ?? ""}>
                        {shortHash(result.contentHash ?? "")} · {humanBytes(result.sizeBytes ?? 0)}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt>params used</dt>
                      <dd className="min-w-0 truncate" title={JSON.stringify(result.paramsUsed)}>
                        {Object.entries(result.paramsUsed)
                          .map(([k, v]) => `${k}=${v}`)
                          .join(" · ")}
                      </dd>
                    </div>
                  </dl>
                  {result.staleMarked.length > 0 ? (
                    <p className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400">
                      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                      <span>
                        {result.staleMarked.length} downstream artifact
                        {result.staleMarked.length === 1 ? "" : "s"} marked stale:{" "}
                        {result.staleMarked.map((s) => s.name).join(", ")} — regenerate them from the
                        picker above.
                      </span>
                    </p>
                  ) : null}
                  <p className="text-xs text-muted-foreground">
                    The rebuilt STEP is a real model artifact — pick it under “Model to view” above to
                    generate its 3D view.
                  </p>
                </div>
              ) : null}
            </>
          ) : null}
        </CardContent>
      </Card>
    </section>
  )
}

export function StudioWorkspace({
  projectId,
  onMutated,
  locate,
}: {
  projectId: string
  /** Parent-side cache nudge (Phase-6 known-limitation #13): derive/regenerate
   *  create derived mesh artifacts + audit events the project-level caches
   *  don't observe on their own (useApi is manual-refresh — the
   *  AgentsWorkspace.onMutated pattern, mirrored exactly). */
  onMutated?: () => void
  /** Cross-navigation seed (limitation #12's closing lane): ?element= (+ the
   *  optional ?source= artifact id) arrives from the Takeoff ledger's "Locate
   *  in 3D". Consumed once per elementRef value: the named source is
   *  pre-selected when it is a derivable one, then when its mesh payload is
   *  on screen the element is picked (3D + list) and scrolled into view — or
   *  an honest note names what was searched when the ref is not in that mesh.
   *  Never a guess: an absent element picks nothing. */
  locate?: { elementRef: string; sourceId: string | null } | null
}) {
  const router = useRouter()
  const artifacts = useApi<{ artifacts: ArtifactListItem[] }>(`/api/projects/${projectId}/artifacts`)
  const notifyMutated = onMutated ?? noop

  // WebGL capability — probed client-side once; "probing" defers the verdict.
  const [webgl, setWebgl] = useState<"probing" | "available" | "unavailable">("probing")
  useEffect(() => {
    setWebgl(webglSupported() ? "available" : "unavailable")
  }, [])

  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [pickedElementRef, setPickedElementRef] = useState<string | null>(null)
  const [meshBySource, setMeshBySource] = useState<Record<string, string>>({})
  const [meshMapLoading, setMeshMapLoading] = useState(false)
  const [meshMapError, setMeshMapError] = useState<string | null>(null)

  // ---- Cross-navigation seed state (limitation #12) ----
  const [locateSeed, setLocateSeed] = useState<string | null>(null)
  const [locateStatus, setLocateStatus] = useState<"idle" | "pending" | "found" | "missing">("idle")
  // elementRef → <li> node — the located element scrolls into view inside the
  // Elements list (its own scroll container; scrollIntoView reaches it).
  const elementItemRefs = useMemo(() => new Map<string, HTMLLIElement | null>(), [])
  const lastSeedRef = useRef<string | null>(null)
  const locateRefValue = locate?.elementRef ?? null
  const locateSourceValue = locate?.sourceId ?? null

  const rows = useMemo(() => artifacts.data?.artifacts ?? [], [artifacts.data])

  /** Derivable sources — the same detection the derive-mesh route uses. */
  const sources = useMemo(
    () =>
      rows
        .filter((a) => a.latestRevision !== null)
        .map((a) => ({
          artifact: a,
          kind: deriveKind(
            a.latestRevision?.storageKey ?? "",
            a.name,
            a.latestRevision?.mimeType ?? null,
          ),
        }))
        .filter((entry): entry is { artifact: ArtifactListItem; kind: "step" | "ifc" } => entry.kind !== null),
    [rows],
  )

  const meshArtifacts = useMemo(() => rows.filter((a) => a.kind === "mesh"), [rows])

  // Resolve source → mesh artifact through the REAL derived_from links (the
  // mesh artifact points at its source). The list payload carries no links, so
  // each mesh artifact's detail is fetched once per list change.
  useEffect(() => {
    if (meshArtifacts.length === 0) {
      setMeshBySource({})
      setMeshMapLoading(false)
      setMeshMapError(null)
      return
    }
    let cancelled = false
    setMeshMapLoading(true)
    void (async () => {
      try {
        const details = await Promise.all(meshArtifacts.map((a) => getArtifactDetail(a.id)))
        if (cancelled) return
        const map: Record<string, string> = {}
        for (const detail of details) {
          for (const link of detail.artifact.linksFrom) {
            if (link.relationType === "derived_from") {
              // newest-first list order; the route keeps ONE mesh per source
              map[link.toArtifactId] ??= detail.artifact.id
            }
          }
        }
        setMeshBySource(map)
        setMeshMapError(null)
      } catch (err) {
        if (!cancelled) {
          setMeshMapError(err instanceof Error ? err.message : "Could not resolve the mesh links")
        }
      } finally {
        if (!cancelled) setMeshMapLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [meshArtifacts])

  // Keep the selection valid as the artifact list changes (generate, uploads).
  useEffect(() => {
    if (artifacts.loading) return
    if (selectedSourceId !== null && sources.some((s) => s.artifact.id === selectedSourceId)) return
    setSelectedSourceId(sources[0]?.artifact.id ?? null)
  }, [artifacts.loading, sources, selectedSourceId])

  const selectedSource = sources.find((s) => s.artifact.id === selectedSourceId) ?? null
  const meshArtifactId = selectedSource ? meshBySource[selectedSource.artifact.id] ?? null : null

  const meshData = useApi<MeshGetResult>(meshArtifactId ? `/api/artifacts/${meshArtifactId}/mesh` : null)
  // Guard against useApi's stale data after the path flips back to null.
  const meshResult = meshArtifactId !== null ? meshData : null
  const mesh = meshResult && !meshResult.loading ? meshResult.data : null
  const meta = mesh?.meta ?? null

  /** Counts of what is ACTUALLY rendered — computed from the stored payload. */
  const counts = useMemo(() => {
    if (!mesh) return { elements: 0, vertices: 0, triangles: 0 }
    let vertices = 0
    let triangles = 0
    for (const element of mesh.mesh.elements) {
      vertices += element.vertices.length
      triangles += element.triangles.length
    }
    return { elements: mesh.mesh.elements.length, vertices, triangles }
  }, [mesh])

  // ---- Cross-navigation seed consumption (limitation #12) ----
  // 1) Accept the seed (once per elementRef value — a list refresh mid-visit
  //    must not re-announce): pre-select the named source when it is a
  //    derivable one. WAITS for the artifact list first (found live: firing on
  //    mount raced the fetch and the pre-select missed an empty sources
  //    array, leaving the DEFAULT source selected — a mesh-less one, the
  //    honest-but-wrong "Generate 3D view" state). An unknown/absent source
  //    id is NOT a hard error: the seed still resolves against whatever
  //    source is selected, honestly.
  useEffect(() => {
    if (locateRefValue === null || locateRefValue === "") return
    if (artifacts.loading) return // sources not on screen yet — the seed waits
    if (lastSeedRef.current === locateRefValue) return
    lastSeedRef.current = locateRefValue
    setLocateSeed(locateRefValue)
    setLocateStatus("pending")
    if (locateSourceValue !== null) {
      const hit = sources.find((s) => s.artifact.id === locateSourceValue)
      if (hit) setSelectedSourceId(hit.artifact.id)
    }
  }, [locateRefValue, locateSourceValue, sources, artifacts.loading])

  // 2) Resolve the seed once the selected source's mesh payload is on screen:
  //    pick + scroll + announce, or the honest missing note. A source with NO
  //    mesh yet stays pending — the locate note below names that state.
  const meshElements = mesh?.mesh.elements ?? null
  useEffect(() => {
    if (locateStatus !== "pending" || locateSeed === null) return
    if (!meshElements) return
    const hit = meshElements.find((e) => e.elementRef === locateSeed) ?? null
    if (hit) {
      setPickedElementRef(locateSeed)
      setLocateStatus("found")
      elementItemRefs.get(locateSeed)?.scrollIntoView({ block: "center", behavior: "smooth" })
    } else {
      setLocateStatus("missing")
    }
  }, [locateStatus, locateSeed, meshElements, elementItemRefs])

  // The picked element's friendly name (for the picked bar + announcements).
  const pickedElement = pickedElementRef !== null && meshElements !== null
    ? meshElements.find((e) => e.elementRef === pickedElementRef) ?? null
    : null

  const generateMesh = async (regenerate: boolean) => {
    if (generating || !selectedSource) return
    setGenerating(true)
    try {
      const result = await deriveModelMesh(projectId, selectedSource.artifact.id)
      const m = result.mesh
      toast.success(
        `3D view ${regenerate ? "regenerated" : "generated"} — r${m.revisionNumber}, ${m.elementCount} element${m.elementCount === 1 ? "" : "s"}, ${m.triangleCount} triangles`,
      )
      setPickedElementRef(null)
      void artifacts.refresh() // rebuilds the source → mesh map through the effect
      void meshData.refresh() // re-reads the mesh when it already existed (regenerate)
      // Cache nudge: the new derived mesh artifact + audit event belong to the
      // project-level caches too (Artifacts tab, activity feed) — the
      // AgentsWorkspace.onMutated pattern, now applied to the Studio derive
      // actions (Phase-6 known-limitation #13).
      notifyMutated()
    } catch (err) {
      // 422s (unsupported extension, engine_unavailable) surface verbatim.
      toast.error(err instanceof Error ? err.message : "Mesh generation failed")
    } finally {
      setGenerating(false)
    }
  }

  // ---------------------------------------------------------------------------
  // Picker + per-model action
  // ---------------------------------------------------------------------------

  const renderAction = () => {
    if (!selectedSource) return null
    if (meshMapLoading) {
      return (
        <Button variant="outline" className="h-11" disabled>
          <Loader2 className="animate-spin" aria-hidden /> Resolving…
        </Button>
      )
    }
    if (meshArtifactId === null) {
      return (
        <GuardedButton className="h-11" disabled={generating} onClick={() => void generateMesh(false)}>
          {generating ? <Loader2 className="animate-spin" aria-hidden /> : <Boxes aria-hidden />}
          {generating ? "Generating…" : "Generate 3D view"}
        </GuardedButton>
      )
    }
    return (
      <GuardedButton variant="outline" className="h-11" disabled={generating} onClick={() => void generateMesh(true)}>
        {generating ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
        {generating ? "Regenerating…" : "Regenerate"}
      </GuardedButton>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight">
          <DraftingCompass className="size-4 text-muted-foreground" aria-hidden /> Design Studio
        </h2>
        <Alert>
          <Info aria-hidden />
          <AlertTitle>How 3D views work</AlertTitle>
          <AlertDescription>
            Views are tessellated by the registered geometry engine (cadquery for STEP, IfcOpenShell
            for IFC) from the artifact&apos;s latest revision and stored as a derived artifact (kind{" "}
            <span className="font-mono">mesh</span>) — they keep their own revision history, go stale
            when the source model is revised, and their element refs match the quantity ledger. The
            up-axis and units of the source are preserved; the viewer does the rotating.
          </AlertDescription>
        </Alert>
      </header>

      {/* Slice 16 — the editing journey: hidden entirely when the project has
          no .py parametric models (no dead UI for other project shapes). */}
      <ParametricSection
        projectId={projectId}
        rows={rows}
        onRebuilt={() => {
          void artifacts.refresh() // the rebuilt model joins the derivable picker
          void meshData.refresh() // the selected model's mesh may now be STALE (the cascade) — re-read its meta so the banner shows honestly
          notifyMutated() // + the project-level caches (Artifacts tab, feed)
        }}
      />

      {artifacts.error ? (
        <ErrorState message={artifacts.error} onRetry={() => void artifacts.refresh()} />
      ) : artifacts.loading ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-11 w-full sm:w-96" />
          <Skeleton className="h-[340px] w-full sm:h-[440px]" />
        </div>
      ) : sources.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title="No derivable model artifacts"
          description="Register a .step, .stp or .ifc artifact in this project first — the Design Studio generates 3D views from the latest model revision. Artifacts the geometry engines cannot derive (drawings, datasets, documents…) are hidden from this picker by design."
        />
      ) : (
        <>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Select
              value={selectedSourceId ?? ""}
              onValueChange={(v) => {
                setSelectedSourceId(v)
                setPickedElementRef(null)
              }}
            >
              <SelectTrigger size="default" className="h-11 w-full min-w-0 sm:w-96" aria-label="Model to view">
                <SelectValue placeholder="Pick a model…" />
              </SelectTrigger>
              <SelectContent>
                {sources.map(({ artifact, kind }) => (
                  <SelectItem key={artifact.id} value={artifact.id} className="py-2.5">
                    <span className="min-w-0 truncate">{artifact.name}</span>
                    <Badge variant="outline" className="font-mono text-[11px] uppercase">
                      {kind}
                    </Badge>
                    <span className="font-mono text-xs text-muted-foreground">
                      r{artifact.latestRevision?.revNumber ?? "—"}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex shrink-0 gap-2">{renderAction()}</div>
          </div>

          {selectedSource === null ? null : meshMapError ? (
            <ErrorState
              message={meshMapError}
              onRetry={() => void artifacts.refresh()}
            />
          ) : meshArtifactId === null ? (
            meshMapLoading ? (
              <Skeleton className="h-[340px] w-full sm:h-[440px]" />
            ) : (
              <div className="flex flex-col gap-2 rounded-lg border border-dashed px-6 py-10 text-center">
                <Boxes className="mx-auto size-6 text-muted-foreground" aria-hidden />
                <p className="text-sm font-medium">No 3D view for this model yet</p>
                <p className="mx-auto max-w-md text-sm text-muted-foreground">
                  “Generate 3D view” runs the real engine adapter on{" "}
                  <span className="font-medium">{selectedSource.artifact.name}</span> r
                  {selectedSource.artifact.latestRevision?.revNumber} — the tessellated mesh is
                  stored as a derived artifact and appears in the Artifacts tab with kind{" "}
                  <span className="font-mono">mesh</span>. Nothing is rendered until the engine
                  actually succeeds.
                </p>
              </div>
            )
          ) : meshResult?.error ? (
            <ErrorState message={meshResult.error} onRetry={() => void meshData.refresh()} />
          ) : !mesh || !meta ? (
            <Skeleton className="h-[340px] w-full sm:h-[440px]" />
          ) : (
            <>
              {meta.staleSource ? (
                <Alert className="border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
                  <TriangleAlert aria-hidden />
                  <AlertTitle>Stale 3D view</AlertTitle>
                  <AlertDescription className="text-amber-900/90 dark:text-amber-300/90">
                    The source model has a newer revision — this 3D view was generated from an older
                    revision and is kept for provenance until you regenerate it.
                  </AlertDescription>
                  <div className="col-start-2">
                    <GuardedButton
                      variant="outline"
                      className="mt-1 h-11 border-amber-400 bg-amber-100/60 text-amber-900 hover:bg-amber-100 hover:text-amber-950 dark:border-amber-700 dark:bg-amber-900 dark:text-amber-200 dark:hover:bg-amber-900/80"
                      disabled={generating}
                      onClick={() => void generateMesh(true)}
                    >
                      {generating ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
                      {generating ? "Regenerating…" : "Regenerate"}
                    </GuardedButton>
                  </div>
                </Alert>
              ) : null}

              {/* Locate-result note (limitation #12): the seed's honest outcome.
                  found → polite confirmation (the pick + scroll already landed);
                  missing → names exactly what was searched, never a fake pick;
                  pending with NO mesh generated yet → the generate-first truth. */}
              {locateSeed !== null && (locateStatus === "found" || locateStatus === "missing") ? (
                <div
                  role="status"
                  className={
                    locateStatus === "found"
                      ? "flex items-center gap-2 rounded-lg border bg-muted/30 px-4 py-2 text-sm"
                      : "flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
                  }
                >
                  {locateStatus === "found" ? (
                    <>
                      <Crosshair className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <p>
                        Located{" "}
                        <span className="font-medium">{pickedElement ? pickedElement.name : "element"}</span>{" "}
                        <span className="font-mono text-xs">{locateSeed}</span> — picked in the 3D view and the
                        element list.
                      </p>
                    </>
                  ) : (
                    <>
                      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                      <p>
                        Element <span className="font-mono text-xs">{locateSeed}</span> is not in this
                        model’s mesh. It may come from a different revision, a different model, or a mesh
                        that has not been generated yet — nothing was picked.
                      </p>
                    </>
                  )}
                </div>
              ) : locateSeed !== null && locateStatus === "pending" &&
                !meshMapLoading && meshArtifactId === null && selectedSource !== null ? (
                <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                  <p>
                    No 3D view exists for{" "}
                    <span className="font-medium">{selectedSource.artifact.name}</span> yet — generate one
                    below to locate element <span className="font-mono text-xs">{locateSeed}</span>.
                  </p>
                </div>
              ) : null}

              <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
                <div className="flex min-w-0 flex-col gap-4">
                  <div className="relative h-[340px] overflow-hidden rounded-lg border bg-muted/40 sm:h-[440px] lg:h-[520px]">
                    {webgl === "probing" ? (
                      <div className="flex h-full items-center justify-center" role="status" aria-label="Checking 3D support">
                        <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden />
                      </div>
                    ) : webgl === "unavailable" ? (
                      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                        <TriangleAlert className="size-5 text-amber-600" aria-hidden />
                        <p className="text-sm font-medium">3D acceleration unavailable</p>
                        <p className="max-w-md text-sm text-muted-foreground">
                          This browser could not create a WebGL context, so the model cannot be
                          rendered here. The mesh data, provenance and element list are complete —
                          open this project in a WebGL-capable browser to see the 3D scene.
                        </p>
                      </div>
                    ) : mesh.mesh.elements.length === 0 ? (
                      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                        <CircleAlert className="size-5 text-muted-foreground" aria-hidden />
                        <p className="text-sm font-medium">Mesh carries zero elements</p>
                        <p className="max-w-md text-sm text-muted-foreground">
                          The stored mesh for this model contains no tessellated elements — nothing
                          to render.
                        </p>
                      </div>
                    ) : (
                      <ViewerErrorBoundary
                        fallback={
                          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                            <CircleAlert className="size-5 text-muted-foreground" aria-hidden />
                            <p className="text-sm font-medium">The 3D view could not be displayed</p>
                            <p className="max-w-md text-sm text-muted-foreground">
                              The renderer raised an error while drawing this mesh. The mesh data,
                              provenance and element list below are unaffected.
                            </p>
                          </div>
                        }
                      >
                        <ModelViewer
                          mesh={mesh.mesh}
                          pickedElementRef={pickedElementRef}
                          onPickElement={setPickedElementRef}
                          colorOf={elementColor}
                        />
                      </ViewerErrorBoundary>
                    )}
                  </div>

                  {/* Picked-element bar (limitation #12's 3D→ledger half): the
                      current pick is announced here and cross-links straight to
                      the Takeoff ledger rows that reference the same ref. */}
                  {pickedElementRef !== null ? (
                    <div
                      role="status"
                      className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 rounded-lg border bg-muted/30 px-4 py-2 text-sm"
                    >
                      <span className="min-w-0">
                        <Crosshair className="mr-1.5 inline size-3.5 text-muted-foreground" aria-hidden />
                        <span className="font-medium">Picked:</span>{" "}
                        {pickedElement ? pickedElement.name : "element"}{" "}
                        <span className="font-mono text-xs text-muted-foreground">{pickedElementRef}</span>
                        <span className="text-muted-foreground"> — cross-references the quantity ledger</span>
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-9 shrink-0"
                        aria-label={`View quantity rows referencing element ${pickedElementRef} in the Takeoff ledger`}
                        onClick={() =>
                          router.push(
                            `/projects/${projectId}?tab=takeoff&element=${encodeURIComponent(pickedElementRef)}`,
                          )
                        }
                      >
                        <ClipboardList aria-hidden />
                        View quantity rows
                      </Button>
                    </div>
                  ) : null}

                  <section
                    aria-label="Mesh provenance"
                    className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border bg-card px-4 py-2.5 text-xs text-muted-foreground"
                  >
                    <span
                      className="font-medium text-foreground"
                      title={`${meta.engineKey ?? "unknown engine"} ${meta.engineVersion ?? ""}`.trim()}
                    >
                      {meta.engineKey ?? "unknown engine"}
                      {meta.engineVersion ? ` ${meta.engineVersion}` : ""}
                    </span>
                    <span
                      className="font-mono"
                      title={`adapter ${meta.adapterScript ?? "unknown"} — sha256 ${meta.adapterHash ?? "n/a"}`}
                    >
                      adapter {shortHash(meta.adapterHash)}
                    </span>
                    <span className="font-mono" title={`mesh revision — content sha256 ${meta.contentHash}`}>
                      mesh r{meta.revisionNumber}
                    </span>
                    <span className="font-mono tabular-nums">
                      {counts.elements} element{counts.elements === 1 ? "" : "s"} ·{" "}
                      {counts.vertices} verts · {counts.triangles} tris
                    </span>
                    <span className="font-mono" title="source up-axis and units are preserved — the viewer rotates">
                      up {mesh.mesh.upAxis} · {mesh.mesh.units} · tol {mesh.mesh.tolerance} m
                    </span>
                    <span className="font-mono" title={`stored size ${humanBytes(meta.sizeBytes)}`}>
                      {humanBytes(meta.sizeBytes)}
                    </span>
                    <span className="ml-auto" title={meta.generatedAt}>
                      generated {relTime(meta.generatedAt)}
                    </span>
                  </section>
                </div>

                <Card className="min-w-0 self-start overflow-hidden">
                  <CardContent className="p-0">
                    <div className="border-b px-4 py-3">
                      <h3 className="text-sm font-semibold tracking-tight">
                        Elements ({mesh.mesh.elements.length})
                      </h3>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Refs match the quantity ledger — click to inspect
                      </p>
                    </div>
                    <ul
                      className="eos-scroll max-h-64 overflow-y-auto lg:max-h-[30.5rem]"
                      aria-label="Mesh elements"
                    >
                      {mesh.mesh.elements.map((element, i) => {
                        const picked = pickedElementRef === element.elementRef
                        return (
                          <li
                            key={element.elementRef}
                            className="border-b last:border-0"
                            ref={(node) => {
                              // locate-seed scroll target (limitation #12)
                              elementItemRefs.set(element.elementRef, node)
                            }}
                          >
                            <button
                              type="button"
                              onClick={() =>
                                setPickedElementRef(picked ? null : element.elementRef)
                              }
                              aria-pressed={picked}
                              aria-label={`Inspect element ${element.name} (${element.elementRef})`}
                              className={cn(
                                "flex min-h-11 w-full items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-accent",
                                picked && "bg-accent",
                              )}
                            >
                              <span
                                className="size-2.5 shrink-0 rounded-[3px] border border-black/10 dark:border-white/10"
                                style={{ backgroundColor: elementColor(i) }}
                                aria-hidden
                              />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm font-medium">{element.name}</span>
                                <span className="block truncate font-mono text-[11px] text-muted-foreground">
                                  {element.elementRef}
                                </span>
                              </span>
                              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                                {element.triangles.length} tris
                              </span>
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  </CardContent>
                </Card>
              </div>

              <InfoNote>
                The viewer is a read-only preview: orbit, zoom and pick elements to cross-reference
                them with quantity rows — no measurement or editing happens here. Meshes regenerate
                only on request; a revision of the source model marks this view stale (banner above).
              </InfoNote>
            </>
          )}
        </>
      )}
    </div>
  )
}
