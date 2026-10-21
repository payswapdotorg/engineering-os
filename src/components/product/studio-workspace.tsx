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
import {
  Boxes,
  CircleAlert,
  DraftingCompass,
  Info,
  Loader2,
  RefreshCw,
  TriangleAlert,
} from "lucide-react"
import { Component, useEffect, useMemo, useState, type ReactNode } from "react"
import { toast } from "sonner"

import {
  deriveModelMesh,
  getArtifactDetail,
  useApi,
  type ArtifactListItem,
  type MeshGetResult,
} from "@/components/product/api"
import { EmptyState, ErrorState, InfoNote } from "@/components/product/parts"
import { deriveKind } from "@/engines/adapters/derive-kind"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
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

export function StudioWorkspace({ projectId }: { projectId: string }) {
  const artifacts = useApi<{ artifacts: ArtifactListItem[] }>(`/api/projects/${projectId}/artifacts`)

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
        <Button className="h-11" disabled={generating} onClick={() => void generateMesh(false)}>
          {generating ? <Loader2 className="animate-spin" aria-hidden /> : <Boxes aria-hidden />}
          {generating ? "Generating…" : "Generate 3D view"}
        </Button>
      )
    }
    return (
      <Button variant="outline" className="h-11" disabled={generating} onClick={() => void generateMesh(true)}>
        {generating ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
        {generating ? "Regenerating…" : "Regenerate"}
      </Button>
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
                    <Button
                      variant="outline"
                      className="mt-1 h-11 border-amber-400 bg-amber-100/60 text-amber-900 hover:bg-amber-100 hover:text-amber-950 dark:border-amber-700 dark:bg-amber-900 dark:text-amber-200 dark:hover:bg-amber-900/80"
                      disabled={generating}
                      onClick={() => void generateMesh(true)}
                    >
                      {generating ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
                      {generating ? "Regenerating…" : "Regenerate"}
                    </Button>
                  </div>
                </Alert>
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
                          <li key={element.elementRef} className="border-b last:border-0">
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
