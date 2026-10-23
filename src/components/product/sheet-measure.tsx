"use client"

/**
 * Sheet Measure — calibrated PDF measurement surface (Lane 8-b, Slice 8,
 * contract §3 of docs/00-architecture/integrity-measure-contract.md; the
 * Journey D completion piece) + Slice 13 additions (limitation #5):
 *
 *  - PERSISTENT SHEET MARKUPS: every saved measurement also persists its
 *    on-sheet geometry (POST /api/projects/<id>/markups, the ledger row link
 *    carried as quantityId), and the overlay re-renders all saved markups
 *    from GET …/markups?revisionId=… on every visit — a reviewer can see
 *    WHERE each amber ledger number came from. Deleting a markup never
 *    touches its ledger row (separate lifecycles, the route's scope note).
 *  - DURABLE CALIBRATION: applying a calibration persists it as a
 *    kind="calibration" markup (one per revision — a new calibration
 *    replaces the previous row); loading a sheet with a saved calibration
 *    RESTORES it automatically (toast says so). Global viewers keep the
 *    calibration in-session only (server refuses writes; nothing pretends
 *    otherwise).
 *  - SYMBOL AUTO-COUNT (the "autocount" tool): pick a box around ONE symbol
 *    instance → the page is rendered offscreen at a FIXED 2× scale
 *    (zoom-independent, like the click math) → deterministic NCC template
 *    matching (src/core/symbol-match.ts, threshold ≥ 0.85 default) → the
 *    hits are drawn as boxes → "Accept N" produces the same save panel as a
 *    manual count, with quantityMethod "eos-symbol-template/1 (NCC ≥ T)" and
 *    a kind="symbol-hits" markup carrying every hit box. Honest limits:
 *    matches instances the SAME rendered size as the picked template; a
 *    rotated page (/Rotate ≠ 0) inherits the Slice-8 click-mapping caveat.
 *
 * Honesty rules this component follows (mirrors takeoff-workspace.tsx):
 *  - every measurement is REAL: bytes come from GET /api/revisions/<id>/download
 *    (same-origin fetch, session cookie attached); a 401/404 surfaces as a
 *    verbatim sonner toast AND an inline retry state — never a silent blank
 *    canvas;
 *  - all measurement math happens in PDF-point space through src/core/measure
 *    (lane 8-c, frozen signatures): canvas click coords are divided by the
 *    render scale BEFORE any math, so zoom cannot change a result;
 *  - saved rows are the real POST /api/projects/<id>/quantities contract:
 *    method drawing-measured, sheetRef "<artifact name> — p<page>", the
 *    calibrated scale record, quantityMethod "eos-pdf-measure/1
 *    (browser-calibrated)"; server 422s surface verbatim in toasts;
 *  - nothing optimistic: 201 → toast + caller-side ledger refetch (the
 *    RecordQuantityDialog onCreated pattern); the markup POST happens AFTER
 *    the ledger 201 and a failure is reported honestly (row saved, geometry
 *    not persisted) — the ledger row is never lost or duplicated to mask it;
 *  - switching pages clears the in-progress measurement with an honest inline
 *    notice — saved rows are already in the ledger AND their markups reload;
 *  - the viewer role can measure/scan but Save and markup-delete are
 *    visible-but-disabled with the pinned tooltip "viewer role is read-only"
 *    (GuardedButton); a project-viewer's write attempts surface the server's
 *    verbatim 403.
 *
 * pdf.js provenance: dependency pdfjs-dist@4.10.38 (exact pin, package.json);
 * the worker is a vendored copy of node_modules/pdfjs-dist/build/pdf.worker.min.mjs
 * at public/vendor/pdf.worker.min.mjs (kept in the working tree). pdf.js is
 * imported DYNAMICALLY inside the load effect (never at module scope) so no
 * SSR/build-time evaluation happens.
 *
 * Honest limitation (recorded, not hidden): click→point mapping assumes the
 * page /Rotate is 0 (the pinned A3 fixture is); a rotated page renders upright
 * but picks would land in unrotated coordinates.
 */
import {
  ChevronLeft,
  ChevronRight,
  FileWarning,
  Maximize,
  MousePointerClick,
  PencilRuler,
  Ruler,
  ScanSearch,
  Shapes,
  Trash2,
  TriangleAlert,
  ZoomIn,
  ZoomOut,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import type { PDFDocumentProxy } from "pdfjs-dist"

import {
  createMarkup,
  createQuantity,
  deleteMarkup,
  downloadRevisionBytes,
  listMarkups,
  type ArtifactListItem,
  type QuantityCreateInput,
  type SheetMarkupRow,
} from "@/components/product/api"
import { GuardedButton } from "@/components/product/guarded-button"
import { useSessionUser } from "@/components/product/session-user"
import { ErrorState, InfoNote, RowSkeleton } from "@/components/product/parts"
import type { ArtifactSourceState } from "@/components/product/takeoff-dialogs"
import {
  MeasureError,
  PT_MM,
  calibrate,
  distance,
  polygonArea,
  polylineLength,
  toLedgerQuantity,
  type Pt,
} from "@/core/measure"
import {
  DEFAULT_SCAN_OPTIONS,
  SymbolMatchError,
  extractTemplate,
  nccScan,
  toGray,
} from "@/core/symbol-match"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// Local helpers + types
// ---------------------------------------------------------------------------

/** pdf.js render scale clamp (contract §3.1: "clamp 0.5–4× page scale"). */
const MIN_RENDER_SCALE = 0.5
const MAX_RENDER_SCALE = 4
/** Zoom is a multiplier over the fit-width base scale, same clamp. */
const MIN_ZOOM = 0.5
const MAX_ZOOM = 4
const ZOOM_STEP = 0.25
/** Double-click produces click,click,dblclick — the last two picks overlap. */
const DBLCLICK_DEDUP_PT = 1.5
/** Vendored worker (header comment documents the provenance). */
const PDF_WORKER_SRC = "/vendor/pdf.worker.min.mjs"
/** Contract §3.1 honest empty-state copy (verbatim). */
const NO_PDF_SHEETS_COPY =
  "No PDF drawing sheets in this project yet — upload one from Artifacts"

type MeasureTool = "calibrate" | "length" | "area" | "count" | "autocount"
type CalibUnit = "m" | "mm" | "ft"

/** A finished measurement awaiting the save panel (contract §3.3; Slice 13
 *  adds the symbol-template provenance so auto-counts are distinguishable
 *  from manual counts in the ledger's quantityMethod). */
interface FinishedMeasurement {
  tool: Exclude<MeasureTool, "calibrate" | "autocount">
  /** honest raw measured number in core units (mm / mm²) before ledger mapping */
  rawMm: number
  /** toLedgerQuantity() output — value is NOT rounded for storage */
  ledger: { value: number; unit: "m" | "m²" | "each"; display: string }
  count: number
  /** manual = picked by hand; template = NCC symbol auto-count (Slice 13) */
  provenance: "manual" | "template"
  /** template provenance only: the scan context for the save panel's copy */
  templateInfo?: { threshold: number; templateWpt: number; templateHpt: number }
}

/** One accepted symbol-scan hit, already mapped back to PDF-point space. */
interface SymbolHit {
  tl: Pt
  br: Pt
  score: number
}

/** Saved-markup overlay palette (emerald = persisted; amber = in-progress). */
const SAVED_STROKE = "#047857" // emerald-700
const SAVED_GUIDE = "#059669" // emerald-600
const SAVED_FILL = "rgba(5, 150, 105, 0.10)"

/** Auto-count scans at a FIXED 2× page scale regardless of the user's zoom —
 *  results are zoom-independent (mirrors the click-math rule). The fixture's
 *  10 pt symbols rasterize to ≈20 px here, comfortably above the 2 px core
 *  floor; the exhaustive stride-1 scan (DEFAULT_SCAN_OPTIONS) takes ~1–3 s
 *  on an A3 sheet at 2× — the button shows its busy state while it runs. */
const SCAN_SCALE = 2

/** Calibration result kept in state (contract §3.2). */
interface Calibration {
  mmPerPt: number
  /** exact persisted scale record (§3.3 format) */
  scaleRecord: string
  /** header summary, e.g. "35.28 mm/pt · 1:100" */
  summary: string
}

function clampScale(v: number): number {
  return Math.min(MAX_RENDER_SCALE, Math.max(MIN_RENDER_SCALE, v))
}

/** 3 significant figures, trailing zeros stripped (contract §3.2). */
function sig3(v: number): string {
  return String(Number(v.toPrecision(3)))
}

/** Saved-markup chip value display (3 decimals, honest). */
function trim3(v: number): string {
  return String(Number(v.toFixed(3)))
}

function isPdfRenderCancel(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "RenderingCancelledException" || /cancel/i.test(err.message))
  )
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SheetMeasure({
  projectId,
  artifacts,
  onSaved,
}: {
  projectId: string
  /** Project artifacts + fetch state (the workspace's own useApi list — same
   *  source the RecordQuantityDialog picker uses, so the two never drift). */
  artifacts: ArtifactSourceState
  /** 201 → caller refetches the ledger (RecordQuantityDialog.onCreated idiom). */
  onSaved: () => void
}) {
  // -- sheet picker -----------------------------------------------------------
  const [sheetArtifactId, setSheetArtifactId] = useState("")

  // -- pdf.js lifecycle -------------------------------------------------------
  const pdfDocRef = useRef<PDFDocumentProxy | null>(null)
  const renderTaskRef = useRef<{ cancel: () => void } | null>(null)
  const pdfCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const dprRef = useRef(1)
  const [docReady, setDocReady] = useState(0)
  const [loadPhase, setLoadPhase] = useState<"idle" | "loading" | "ready" | "error">("idle")
  const [loadError, setLoadError] = useState<string | null>(null)
  const [retryNonce, setRetryNonce] = useState(0)
  const [pageCount, setPageCount] = useState(0)
  const [pageNumber, setPageNumber] = useState(1)
  const [containerWidth, setContainerWidth] = useState(0)

  // -- view state -------------------------------------------------------------
  const [zoom, setZoom] = useState(1)
  const [renderScale, setRenderScale] = useState(1)
  const [pageDims, setPageDims] = useState<{ wPt: number; hPt: number } | null>(null)
  const [rendering, setRendering] = useState(false)

  // -- measurement state ------------------------------------------------------
  const [tool, setTool] = useState<MeasureTool>("calibrate")
  const [calib, setCalib] = useState<Calibration | null>(null)
  const [calibPicks, setCalibPicks] = useState<Pt[]>([])
  const [calibInput, setCalibInput] = useState("")
  const [calibUnit, setCalibUnit] = useState<CalibUnit>("m")
  const [calibError, setCalibError] = useState<string | null>(null)
  const [points, setPoints] = useState<Pt[]>([])
  const [cursorPt, setCursorPt] = useState<Pt | null>(null)
  const [finished, setFinished] = useState<FinishedMeasurement | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // -- save panel state (RecordQuantityDialog semantics) ----------------------
  const [label, setLabel] = useState("")
  const [rulesetId, setRulesetId] = useState("eos-pdf-measure")
  const [rulesetVersion, setRulesetVersion] = useState("1")
  const [createdBy, setCreatedBy] = useState("local-operator")
  const [saving, setSaving] = useState(false)

  // -- Slice 13: persistent markups + symbol auto-count state ------------------

  const sessionUser = useSessionUser()
  const isGlobalViewer = sessionUser !== "loading" && sessionUser !== null && sessionUser.role === "viewer"

  const [markups, setMarkups] = useState<SheetMarkupRow[]>([])
  const [markupsPhase, setMarkupsPhase] = useState<"idle" | "loading" | "ready" | "error">("idle")
  const [markupsError, setMarkupsError] = useState<string | null>(null)
  const [deletingMarkupId, setDeletingMarkupId] = useState<string | null>(null)
  /** nonce bumped after create/delete so the overlay + list refetch (nothing optimistic) */
  const [markupsNonce, setMarkupsNonce] = useState(0)

  const [autoPicks, setAutoPicks] = useState<Pt[]>([])
  const [autoThreshold, setAutoThreshold] = useState(DEFAULT_SCAN_OPTIONS.minScore)
  const [autoHits, setAutoHits] = useState<SymbolHit[] | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)

  // Derived picker data — only drawing artifacts whose latest revision is a
  // real PDF (the serialized ArtifactListItem carries latestRevision.mimeType).
  const pdfSheets = useMemo(
    () =>
      artifacts.rows.filter(
        (a) =>
          a.kind === "drawing" &&
          a.latestRevision !== null &&
          a.latestRevision.mimeType === "application/pdf",
      ),
    [artifacts.rows],
  )
  const selected: ArtifactListItem | null =
    pdfSheets.find((a) => a.id === sheetArtifactId) ?? null
  const revisionId = selected?.latestRevision?.id ?? null

  /** Honest inline notice whenever in-progress work is cleared. */
  const clearInProgress = useCallback((reason: string | null) => {
    if (reason !== null) setNotice(reason)
    else setNotice(null)
    setPoints((pts) => (pts.length > 0 ? [] : pts))
    setCalibPicks((prev) => (prev.length > 0 ? [] : prev))
    setCursorPt(null)
  }, [])

  const discardFinished = useCallback(() => {
    setFinished(null)
    setPoints([])
    setCursorPt(null)
    setLabel("")
    // A discarded template count also clears the scan it came from.
    setAutoHits(null)
    setScanError(null)
  }, [])

  /** Reset the whole measuring session for a (new) sheet. */
  const resetSession = useCallback(() => {
    setCalib(null)
    setCalibPicks([])
    setCalibInput("")
    setCalibUnit("m")
    setCalibError(null)
    setPoints([])
    setCursorPt(null)
    setFinished(null)
    setNotice(null)
    setLabel("")
    setTool("calibrate")
    setZoom(1)
    setPageNumber(1)
    setAutoPicks([])
    setAutoHits(null)
    setScanError(null)
  }, [])

  const onSheetChange = (nextId: string) => {
    setSheetArtifactId(nextId)
    resetSession()
  }

  const changeTool = (next: MeasureTool) => {
    if (next === tool) return
    // Auto-count needs NO calibration (a count is scale-free — the same rule
    // the core's count mapping encodes); length/area/count stay gated.
    if (next !== "calibrate" && next !== "autocount" && calib === null) {
      // Defensive: the toggles are disabled while uncalibrated, but the
      // attempt still explains itself (contract §3.2 — no dead buttons).
      setNotice("Measure tools need a calibration first — set one with the Calibrate tool.")
      return
    }
    if (points.length > 0 || calibPicks.length > 0) {
      clearInProgress(
        "Tool switched — the in-progress measurement was cleared. Saved rows are untouched.",
      )
    }
    if (autoPicks.length > 0 || autoHits !== null) {
      setAutoPicks([])
      setAutoHits(null)
      setScanError(null)
    }
    setTool(next)
    setCursorPt(null)
  }

  const goToPage = (next: number) => {
    if (next === pageNumber || next < 1 || next > pageCount) return
    // Contract §3.2: page switch clears the in-progress measurement with an
    // honest notice — saved rows live in the ledger already, and their
    // markups reload with the page's overlay (Slice 13).
    if (points.length > 0 || calibPicks.length > 0 || finished !== null) {
      clearInProgress(
        `Switched to page ${next} — the in-progress measurement was cleared. Saved rows are never lost.`,
      )
      setFinished(null)
    }
    if (autoPicks.length > 0 || autoHits !== null) {
      setAutoPicks([])
      setAutoHits(null)
      setScanError(null)
      setNotice(`Switched to page ${next} — the auto-count template and hits were cleared (the scan is per-page).`)
    }
    setPageNumber(next)
  }

  // -- pdf.js load (dynamic import, client-side only) -------------------------

  useEffect(() => {
    if (revisionId === null) {
      setLoadPhase("idle")
      setLoadError(null)
      setPageCount(0)
      setPageDims(null)
      setDocReady(0)
      const stale = pdfDocRef.current
      pdfDocRef.current = null
      if (stale) void stale.destroy()
      return
    }
    let cancelled = false
    let localDoc: PDFDocumentProxy | null = null
    setLoadPhase("loading")
    setLoadError(null)
    void (async () => {
      try {
        // DYNAMIC import inside the effect — never at module scope (contract
        // §3.1: no SSR evaluation, no build-time worker bundling).
        const pdfjs = await import("pdfjs-dist")
        pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC
        const blob = await downloadRevisionBytes(revisionId)
        const data = new Uint8Array(await blob.arrayBuffer())
        const doc = await pdfjs.getDocument({ data }).promise
        if (cancelled) {
          void doc.destroy()
          return
        }
        localDoc = doc
        pdfDocRef.current = doc
        setPageCount(doc.numPages)
        setPageNumber(1)
        setDocReady((n) => n + 1)
        setLoadPhase("ready")
      } catch (err) {
        if (cancelled) return
        // 401 (session expired) / 404 (unknown revision) / invalid PDF bytes —
        // the server message surfaces verbatim; never a silent blank canvas.
        const msg = errorMessage(err, "Could not load the sheet")
        setLoadError(msg)
        setLoadPhase("error")
        toast.error(msg)
      }
    })()
    return () => {
      cancelled = true
      if (localDoc && pdfDocRef.current === localDoc) pdfDocRef.current = null
      if (localDoc) void localDoc.destroy()
    }
  }, [revisionId, retryNonce])

  // -- Slice 13: saved markups for this revision (fetch on sheet/nonce) --------

  useEffect(() => {
    if (revisionId === null) {
      setMarkups([])
      setMarkupsPhase("idle")
      setMarkupsError(null)
      return
    }
    let cancelled = false
    setMarkupsPhase("loading")
    setMarkupsError(null)
    void (async () => {
      try {
        const data = await listMarkups(projectId, revisionId)
        if (cancelled) return
        setMarkups(data.markups)
        setMarkupsPhase("ready")
      } catch (err) {
        if (cancelled) return
        setMarkupsError(errorMessage(err, "Could not load the saved markups"))
        setMarkupsPhase("error")
      }
    })()
    return () => {
      cancelled = true
    }
  }, [projectId, revisionId, markupsNonce])

  // Calibration restore: when a sheet's saved markups arrive and no live
  // calibration exists, the latest persisted calibration row comes back —
  // the sheet's scale record is DURABLE (Slice 13). Global viewers restore it
  // too (markups are readable); they only cannot persist new ones.
  const restoredRevisionRef = useRef<string | null>(null)
  useEffect(() => {
    if (markupsPhase !== "ready" || revisionId === null || calib !== null) return
    if (restoredRevisionRef.current === revisionId) return
    const calibRow = [...markups].reverse().find((m) => m.kind === "calibration")
    if (!calibRow || !(calibRow.value > 0)) return
    restoredRevisionRef.current = revisionId
    const mmPerPt = calibRow.value
    const scaleRecord = calibRow.scale ?? `restored from markup ${calibRow.id}`
    setCalib({
      mmPerPt,
      scaleRecord,
      summary: `${mmPerPt.toFixed(2)} mm/pt · 1:${sig3(mmPerPt / PT_MM)} · restored`,
    })
    setTool((t) => (t === "calibrate" ? "length" : t))
    toast.success(`Calibration restored from a saved markup — ${mmPerPt.toFixed(2)} mm/pt`)
  }, [markupsPhase, markups, revisionId, calib])

  // -- container width (fit-width base scale) ---------------------------------

  // The canvas scroll container mounts only in the "ready" phase — observe it
  // from that moment so fit-width always has a real client width.
  const canvasMounted = revisionId !== null && loadPhase === "ready"
  useEffect(() => {
    if (!canvasMounted) return
    const el = scrollRef.current
    if (!el) return
    const update = () => {
      const w = el.clientWidth
      setContainerWidth((prev) => (Math.abs(prev - w) > 1 ? w : prev))
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [canvasMounted])

  // -- pdf page render (fit-width default, zoom 0.5–4) -------------------------

  useEffect(() => {
    const doc = pdfDocRef.current
    if (doc === null || loadPhase !== "ready" || containerWidth < 50) return
    let cancelled = false
    setRendering(true)
    void (async () => {
      try {
        const page = await doc.getPage(pageNumber)
        if (cancelled) return
        const base = page.getViewport({ scale: 1 })
        const fitScale = containerWidth / base.width
        const scale = clampScale(fitScale * zoom)
        const viewport = page.getViewport({ scale })
        const dpr = window.devicePixelRatio || 1
        const canvas = pdfCanvasRef.current
        if (canvas === null || cancelled) return
        canvas.width = Math.floor(viewport.width * dpr)
        canvas.height = Math.floor(viewport.height * dpr)
        canvas.style.width = `${Math.floor(viewport.width)}px`
        canvas.style.height = `${Math.floor(viewport.height)}px`
        dprRef.current = dpr
        // Points are stored in PDF space; the mapping factors must move to the
        // new scale BEFORE the render finishes so the overlay never drifts.
        setPageDims({ wPt: base.width, hPt: base.height })
        setRenderScale(scale)
        const ctx = canvas.getContext("2d")
        if (ctx === null) throw new Error("Canvas 2D context unavailable in this browser")
        renderTaskRef.current?.cancel()
        const task = page.render({
          canvasContext: ctx,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        })
        renderTaskRef.current = task
        await task.promise
        if (cancelled) return
      } catch (err) {
        if (cancelled || isPdfRenderCancel(err)) return
        const msg = errorMessage(err, "Rendering the sheet page failed")
        setLoadError(msg)
        setLoadPhase("error")
        toast.error(msg)
      } finally {
        if (!cancelled) setRendering(false)
      }
    })()
    return () => {
      cancelled = true
      renderTaskRef.current?.cancel()
      renderTaskRef.current = null
    }
  }, [docReady, pageNumber, containerWidth, zoom, loadPhase])

  // -- overlay canvas (markers, polyline, rubber band) -------------------------

  const drawOverlay = useCallback(() => {
    const overlay = overlayCanvasRef.current
    const pdf = pdfCanvasRef.current
    if (!overlay || !pdf || !pageDims) return
    overlay.width = pdf.width
    overlay.height = pdf.height
    const ctx = overlay.getContext("2d")
    if (!ctx) return
    const dpr = dprRef.current || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, overlay.width / dpr, overlay.height / dpr)

    // Amber on the white sheet (workspace drawing-measured palette; never
    // blue/indigo). PDF points → viewport CSS px: x*s, (hPt − y)*s.
    const stroke = "#b45309" // amber-700
    const guide = "#d97706" // amber-600
    const toPx = (p: Pt): [number, number] => [
      p.x * renderScale,
      (pageDims.hPt - p.y) * renderScale,
    ]

    const drawDot = (p: Pt) => {
      const [x, y] = toPx(p)
      ctx.beginPath()
      ctx.arc(x, y, 4, 0, Math.PI * 2)
      ctx.fillStyle = guide
      ctx.fill()
      ctx.lineWidth = 1.5
      ctx.strokeStyle = stroke
      ctx.stroke()
    }

    const drawLine = (a: Pt, b: Pt, dashed: boolean) => {
      const [x1, y1] = toPx(a)
      const [x2, y2] = toPx(b)
      ctx.beginPath()
      ctx.moveTo(x1, y1)
      ctx.lineTo(x2, y2)
      ctx.lineWidth = 2
      ctx.strokeStyle = guide
      ctx.setLineDash(dashed ? [6, 4] : [])
      ctx.stroke()
      ctx.setLineDash([])
    }

    // -- Slice 13: the SAVED layer (emerald — persisted markups of THIS page) --
    const drawSavedChip = (anchor: Pt, text: string) => {
      const [ax, ay] = toPx(anchor)
      ctx.font = "600 11px ui-monospace, monospace"
      const w = ctx.measureText(text).width + 10
      const x = Math.min(Math.max(2, ax + 8), overlay.width / dpr - w - 2)
      const y = Math.max(14, ay - 10)
      ctx.beginPath()
      ctx.roundRect(x, y - 11, w, 16, 3)
      ctx.fillStyle = "rgba(255, 255, 255, 0.92)"
      ctx.fill()
      ctx.strokeStyle = SAVED_GUIDE
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.fillStyle = SAVED_STROKE
      ctx.fillText(text, x + 5, y)
    }

    const savedForPage = markups.filter((m) => m.page === pageNumber)
    for (const m of savedForPage) {
      if (m.points.length === 0) continue
      if (m.kind === "calibration") {
        // dashed emerald span — the persisted scale picks
        const [x1, y1] = toPx(m.points[0])
        const [x2, y2] = toPx(m.points[1])
        ctx.beginPath()
        ctx.moveTo(x1, y1)
        ctx.lineTo(x2, y2)
        ctx.lineWidth = 1.5
        ctx.strokeStyle = SAVED_GUIDE
        ctx.setLineDash([3, 5])
        ctx.stroke()
        ctx.setLineDash([])
        drawSavedChip(m.points[0], "calibration")
      } else if (m.kind === "length") {
        ctx.beginPath()
        const [x0, y0] = toPx(m.points[0])
        ctx.moveTo(x0, y0)
        for (let i = 1; i < m.points.length; i += 1) {
          const [x, y] = toPx(m.points[i])
          ctx.lineTo(x, y)
        }
        ctx.lineWidth = 2
        ctx.strokeStyle = SAVED_STROKE
        ctx.stroke()
        drawSavedChip(m.points[0], `${trim3(m.value)} ${m.unit}`)
      } else if (m.kind === "area") {
        ctx.beginPath()
        const [x0, y0] = toPx(m.points[0])
        ctx.moveTo(x0, y0)
        for (let i = 1; i < m.points.length; i += 1) {
          const [x, y] = toPx(m.points[i])
          ctx.lineTo(x, y)
        }
        ctx.closePath()
        ctx.fillStyle = SAVED_FILL
        ctx.fill()
        ctx.lineWidth = 2
        ctx.strokeStyle = SAVED_STROKE
        ctx.stroke()
        drawSavedChip(m.points[0], `${trim3(m.value)} ${m.unit}`)
      } else if (m.kind === "count") {
        for (const p of m.points) {
          const [x, y] = toPx(p)
          ctx.beginPath()
          ctx.arc(x, y, 4, 0, Math.PI * 2)
          ctx.fillStyle = SAVED_GUIDE
          ctx.fill()
          ctx.lineWidth = 1.5
          ctx.strokeStyle = SAVED_STROKE
          ctx.stroke()
        }
        drawSavedChip(m.points[0], `${m.value} ${m.unit}`)
      } else if (m.kind === "symbol-hits") {
        // [tl, br] pairs — a box per accepted template hit
        for (let i = 0; i + 1 < m.points.length; i += 2) {
          const [x1, y1] = toPx(m.points[i])
          const [x2, y2] = toPx(m.points[i + 1])
          ctx.beginPath()
          ctx.rect(x1, y1, x2 - x1, y2 - y1)
          ctx.lineWidth = 1.5
          ctx.strokeStyle = SAVED_STROKE
          ctx.stroke()
        }
        if (m.points.length >= 2) drawSavedChip(m.points[0], `${m.value} ${m.unit}`)
      }
    }

    // -- Slice 13: the auto-count layer (template box + unaccepted hits) -------
    if (tool === "autocount") {
      if (autoPicks.length === 2) {
        const [x1, y1] = toPx(autoPicks[0])
        const [x2, y2] = toPx(autoPicks[1])
        ctx.beginPath()
        ctx.rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1))
        ctx.lineWidth = 2
        ctx.strokeStyle = SAVED_GUIDE
        ctx.setLineDash([6, 4])
        ctx.stroke()
        ctx.setLineDash([])
      } else if (autoPicks.length === 1) {
        const [x, y] = toPx(autoPicks[0])
        ctx.beginPath()
        ctx.arc(x, y, 4, 0, Math.PI * 2)
        ctx.fillStyle = SAVED_GUIDE
        ctx.fill()
      }
      if (autoHits !== null) {
        for (const h of autoHits) {
          const [x1, y1] = toPx(h.tl)
          const [x2, y2] = toPx(h.br)
          ctx.beginPath()
          ctx.rect(x1, y1, x2 - x1, y2 - y1)
          ctx.lineWidth = 1.5
          ctx.strokeStyle = SAVED_STROKE
          ctx.stroke()
        }
      }
    }

    // Calibration picks (crosshairs + dashed span).
    if (tool === "calibrate") {
      for (const p of calibPicks) drawDot(p)
      if (calibPicks.length === 2) drawLine(calibPicks[0], calibPicks[1], true)
    }

    // Measurement: frozen (finished) or in-progress points.
    if (tool !== "calibrate" && points.length > 0) {
      if (tool === "area" && points.length >= 2) {
        ctx.beginPath()
        const [x0, y0] = toPx(points[0])
        ctx.moveTo(x0, y0)
        for (let i = 1; i < points.length; i += 1) {
          const [x, y] = toPx(points[i])
          ctx.lineTo(x, y)
        }
        ctx.closePath()
        ctx.fillStyle = "rgba(217, 119, 6, 0.12)"
        ctx.fill()
      }
      for (let i = 1; i < points.length; i += 1) drawLine(points[i - 1], points[i], false)
      if (tool === "area" && points.length >= 3) drawLine(points[points.length - 1], points[0], true)
      for (const p of points) drawDot(p)
      // Rubber band to the cursor (in-progress only).
      if (cursorPt !== null && finished === null && points.length > 0 && (tool === "length" || tool === "area")) {
        drawLine(points[points.length - 1], cursorPt, true)
      }
    }
  }, [tool, calibPicks, points, cursorPt, finished, renderScale, pageDims, markups, pageNumber, autoPicks, autoHits])

  useEffect(() => {
    drawOverlay()
  }, [drawOverlay])

  // -- Slice 13: symbol auto-count (template pick → offscreen 2× render → NCC) --

  /** Clears the template box + hits with an honest inline notice. */
  const clearAuto = useCallback((reason: string | null) => {
    if (reason !== null) setNotice(reason)
    setAutoPicks([])
    setAutoHits(null)
    setScanError(null)
  }, [])

  /**
   * Runs the deterministic NCC scan: renders the CURRENT page offscreen at
   * the FIXED SCAN_SCALE (2× — independent of zoom, like the click math),
   * crops the template around the picked box, scans, and maps the accepted
   * hit boxes back to PDF-point space. Errors from the core
   * (SymbolMatchError: flat template, bad options) surface inline verbatim.
   */
  const runAutoCount = useCallback(async () => {
    const doc = pdfDocRef.current
    if (doc === null || pageDims === null || scanning) return
    if (autoPicks.length !== 2) {
      setScanError("Pick two opposite corners of a box around ONE symbol instance first.")
      return
    }
    const threshold = Math.min(0.99, Math.max(0.5, autoThreshold))
    if (threshold !== autoThreshold) setAutoThreshold(threshold)
    setScanning(true)
    setScanError(null)
    try {
      const page = await doc.getPage(pageNumber)
      const viewport = page.getViewport({ scale: SCAN_SCALE })
      const off = document.createElement("canvas")
      off.width = Math.max(1, Math.floor(viewport.width))
      off.height = Math.max(1, Math.floor(viewport.height))
      const ctx = off.getContext("2d", { willReadFrequently: true })
      if (ctx === null) throw new Error("Canvas 2D context unavailable in this browser")
      // pdf.js leaves unpainted regions transparent; the core's luminance
      // expects paper-white, so paint the page background first.
      ctx.fillStyle = "#ffffff"
      ctx.fillRect(0, 0, off.width, off.height)
      await page.render({ canvasContext: ctx, viewport }).promise
      const img = ctx.getImageData(0, 0, off.width, off.height)
      const gray = toGray(img.data, off.width, off.height)

      // Template rect: PDF-pt box → raster px (y flipped), rounded to ints —
      // extractTemplate validates the bounds again with a specific message.
      const minX = Math.min(autoPicks[0].x, autoPicks[1].x)
      const maxX = Math.max(autoPicks[0].x, autoPicks[1].x)
      const minY = Math.min(autoPicks[0].y, autoPicks[1].y)
      const maxY = Math.max(autoPicks[0].y, autoPicks[1].y)
      const rect = {
        x: Math.round(minX * SCAN_SCALE),
        y: Math.round((pageDims.hPt - maxY) * SCAN_SCALE),
        width: Math.max(2, Math.round((maxX - minX) * SCAN_SCALE)),
        height: Math.max(2, Math.round((maxY - minY) * SCAN_SCALE)),
      }
      const template = extractTemplate(gray, rect)
      const boxes = nccScan(gray, template, { minScore: threshold })

      // Raster px → PDF pt (y flip back). tl/br in PDF space for the markup.
      const hits: SymbolHit[] = boxes.map((b) => ({
        tl: { x: b.x / SCAN_SCALE, y: pageDims.hPt - b.y / SCAN_SCALE },
        br: {
          x: (b.x + b.width) / SCAN_SCALE,
          y: pageDims.hPt - (b.y + b.height) / SCAN_SCALE,
        },
        score: b.score,
      }))
      setAutoHits(hits)
      if (hits.length === 0) {
        setScanError(
          `No matches at NCC ≥ ${threshold} — pick a tighter box around ONE symbol instance (blank margin included helps), or lower the threshold.`,
        )
      } else {
        toast.success(
          `${hits.length} symbol${hits.length === 1 ? "" : "s"} matched at NCC ≥ ${threshold} — review the boxes, then Accept.`,
        )
      }
    } catch (err) {
      if (err instanceof SymbolMatchError) {
        setScanError(err.message)
      } else {
        setScanError(errorMessage(err, "The symbol scan failed"))
      }
    } finally {
      setScanning(false)
    }
  }, [autoPicks, autoThreshold, pageNumber, pageDims, scanning])

  /** Accept the reviewed hits as the finished count measurement (save panel). */
  const acceptAutoHits = useCallback(() => {
    if (autoHits === null || autoHits.length === 0 || finished !== null) return
    const n = autoHits.length
    const minX = Math.min(autoPicks[0].x, autoPicks[1].x)
    const maxX = Math.max(autoPicks[0].x, autoPicks[1].x)
    const minY = Math.min(autoPicks[0].y, autoPicks[1].y)
    const maxY = Math.max(autoPicks[0].y, autoPicks[1].y)
    setFinished({
      tool: "count",
      rawMm: n,
      ledger: toLedgerQuantity(n, "count", n),
      count: n,
      provenance: "template",
      templateInfo: {
        threshold: Math.min(0.99, Math.max(0.5, autoThreshold)),
        templateWpt: maxX - minX,
        templateHpt: maxY - minY,
      },
    })
  }, [autoHits, autoPicks, autoThreshold, finished])

  // -- pointer handlers --------------------------------------------------------

  /** Canvas CSS px → PDF points: divide by the render scale BEFORE any math
   *  (contract §3.1); PDF y grows up, viewport y grows down. */
  const eventToPt = (e: React.MouseEvent<HTMLCanvasElement>): Pt | null => {
    const canvas = overlayCanvasRef.current
    if (!canvas || !pageDims) return null
    const rect = canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    const dpr = dprRef.current || 1
    // Device px (canvas.width carries the DPR) → CSS px → PDF points: divide
    // by the render scale BEFORE any math (contract §3.1); flip y (PDF grows up).
    const cssX = ((e.clientX - rect.left) * canvas.width) / rect.width / dpr
    const cssY = ((e.clientY - rect.top) * canvas.height) / rect.height / dpr
    return { x: cssX / renderScale, y: pageDims.hPt - cssY / renderScale }
  }

  const handleOverlayClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (loadPhase !== "ready" || pageDims === null) return
    const pt = eventToPt(e)
    if (pt === null) return
    setNotice(null)

    if (tool === "calibrate") {
      if (finished !== null) return
      if (calibPicks.length >= 2) {
        // Re-pick from scratch — a third click starts a fresh 2-point span.
        setCalibPicks([pt])
        setCalibError(null)
        return
      }
      setCalibPicks((prev) => [...prev, pt])
      return
    }

    if (tool === "autocount") {
      if (finished !== null) return
      setScanError(null)
      // Double-click echo: a click within the dedup radius of the last pick
      // is the second click of a dblclick — ignore it so the box survives.
      if (
        autoPicks.length > 0 &&
        distance(pt, autoPicks[autoPicks.length - 1]) <= DBLCLICK_DEDUP_PT
      ) {
        return
      }
      if (autoPicks.length >= 2) {
        // Re-pick from scratch — a third click starts a fresh template box.
        setAutoPicks([pt])
        setAutoHits(null)
        return
      }
      setAutoPicks((prev) => [...prev, pt])
      return
    }

    if (finished !== null) return // awaiting save/discard — clicks are inert
    setPoints((prev) => [...prev, pt])
  }

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (tool !== "length" && tool !== "area") return
    if (finished !== null || points.length === 0) {
      if (cursorPt !== null) setCursorPt(null)
      return
    }
    const pt = eventToPt(e)
    setCursorPt(pt)
  }

  const handleMouseLeave = () => {
    if (cursorPt !== null) setCursorPt(null)
  }

  /** Finish the in-progress measurement (Enter / double-click / Finish button). */
  const finishMeasurement = useCallback(
    (pts: Pt[]) => {
      if (calib === null || finished !== null) return
      try {
        if (tool === "length") {
          if (pts.length < 2) {
            setNotice("Length needs at least 2 points before it can finish.")
            return
          }
          const rawMm = polylineLength(pts, calib.mmPerPt)
          setFinished({
            tool: "length",
            rawMm,
            ledger: toLedgerQuantity(rawMm, "length"),
            count: pts.length,
            provenance: "manual",
          })
        } else if (tool === "area") {
          if (pts.length < 3) {
            setNotice("Area needs at least 3 points before it can finish.")
            return
          }
          const rawMm = polygonArea(pts, calib.mmPerPt)
          setFinished({
            tool: "area",
            rawMm,
            ledger: toLedgerQuantity(rawMm, "area"),
            count: pts.length,
            provenance: "manual",
          })
        } else if (tool === "count") {
          if (pts.length < 1) {
            setNotice("Count needs at least 1 clicked item.")
            return
          }
          setFinished({
            tool: "count",
            rawMm: pts.length,
            ledger: toLedgerQuantity(pts.length, "count", pts.length),
            count: pts.length,
            provenance: "manual",
          })
        }
        setCursorPt(null)
      } catch (err) {
        // Degenerate geometry — core MeasureError messages surface inline.
        if (err instanceof MeasureError) {
          setNotice(err.message)
          return
        }
        throw err
      }
    },
    [calib, tool, finished],
  )

  const handleDoubleClick = () => {
    if (tool === "calibrate" || tool === "autocount" || finished !== null) return
    // The second click of a double-click re-adds the last point — dedup it
    // so double-click means "finish here", not "finish with a duplicate".
    let pts = points
    if (
      pts.length >= 2 &&
      distance(pts[pts.length - 1], pts[pts.length - 2]) <= DBLCLICK_DEDUP_PT
    ) {
      pts = pts.slice(0, -1)
      setPoints(pts)
    }
    finishMeasurement(pts)
  }

  const handleOverlayKeyDown = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (e.key === "Enter") {
      e.preventDefault()
      if (finished !== null) return
      if (tool === "calibrate") return
      if (tool === "autocount") {
        // Keyboard path for the scan: box complete → Enter scans.
        if (autoPicks.length === 2) void runAutoCount()
        return
      }
      finishMeasurement(points)
    } else if (e.key === "Escape") {
      e.preventDefault()
      if (finished !== null) {
        discardFinished()
        setNotice("Measurement discarded — it was not saved to the ledger.")
        return
      }
      if (tool === "autocount" && (autoPicks.length > 0 || autoHits !== null)) {
        clearAuto("Auto-count cancelled — the template box and hits were cleared.")
        return
      }
      if (points.length > 0 || calibPicks.length > 0) {
        clearInProgress("Measurement cancelled — it was not saved to the ledger.")
      }
    }
  }

  // -- calibration -------------------------------------------------------------

  const calibPickDistance = useMemo(
    () => (calibPicks.length === 2 ? distance(calibPicks[0], calibPicks[1]) : null),
    [calibPicks],
  )

  /**
   * Slice 13: persists the applied calibration as a kind="calibration"
   * markup — ONE per revision: a previous calibration row is deleted first
   * (the invariant "one durable scale record per sheet", enforced here at
   * the only writer). Global viewers skip persistence (the server would
   * 403): their calibration stays in-session and the toast says so. A
   * persistence failure NEVER blocks the live calibration — it is reported
   * honestly and the session continues.
   */
  const persistCalibration = (picks: [Pt, Pt], mmPerPt: number, scaleRecord: string, by: string) => {
    if (revisionId === null || isGlobalViewer) {
      if (isGlobalViewer) {
        toast.info("Calibration applied for this session — viewers cannot persist it (read-only role).")
      }
      return
    }
    void (async () => {
      try {
        const previous = markups.find((m) => m.kind === "calibration")
        if (previous !== undefined) {
          await deleteMarkup(projectId, previous.id)
        }
        await createMarkup(projectId, {
          revisionId,
          page: pageNumber,
          kind: "calibration",
          points: picks,
          value: mmPerPt,
          unit: "mm/pt",
          scale: scaleRecord,
          label: scaleRecord,
          createdBy: by.trim().length > 0 ? by.trim() : "local-operator",
        })
        setMarkupsNonce((n) => n + 1)
      } catch (err) {
        toast.error(
          `Calibration applied, but persisting it failed: ${errorMessage(err, "unknown error")} — it stays for this session only.`,
        )
      }
    })()
  }

  const applyCalibration = () => {
    if (calibPicks.length !== 2 || calibPickDistance === null) {
      setCalibError("Pick two points on the sheet first — click the scale-bar ticks.")
      return
    }
    const parsed = Number(calibInput)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setCalibError("Enter the real-world distance between the two picks as a number > 0.")
      return
    }
    try {
      // Frozen core signature (contract §2.1) — throws MeasureError on
      // coincident/non-finite picks or non-positive length.
      const mmPerPt = calibrate(
        [calibPicks[0], calibPicks[1]],
        parsed,
        calibUnit,
      )
      const scaleRecord = `calibrated 2-pt, ${parsed} ${calibUnit} ↔ ${calibPickDistance.toFixed(2)} pt — ${mmPerPt.toFixed(2)} mm/pt`
      const summary = `${mmPerPt.toFixed(2)} mm/pt · 1:${sig3(mmPerPt / PT_MM)}`
      setCalib({ mmPerPt, scaleRecord, summary })
      const picks: [Pt, Pt] = [calibPicks[0], calibPicks[1]]
      const by = createdBy
      setCalibPicks([])
      setCalibInput("")
      setCalibError(null)
      setTool("length")
      toast.success(`Sheet calibrated — ${summary}`)
      persistCalibration(picks, mmPerPt, scaleRecord, by)
    } catch (err) {
      setCalibError(err instanceof MeasureError ? err.message : errorMessage(err, "Calibration failed"))
    }
  }

  const recalibrate = () => {
    setCalib(null)
    setCalibPicks([])
    setCalibInput("")
    setCalibError(null)
    setTool("calibrate")
    clearInProgress(null)
  }

  // -- live readout --------------------------------------------------------------

  const liveReadout = useMemo<
    { value: number; unit: string; display: string } | { error: string } | null
  >(() => {
    // Auto-count is scale-free: its readout is the hit tally, no calib needed.
    // A zero-hit scan is NOT a count of 0 (the core refuses count < 1 — an
    // honest rule); the panel's inline scanError explains it instead.
    if (tool === "autocount") {
      if (finished !== null) return null
      if (autoHits !== null && autoHits.length > 0) {
        return toLedgerQuantity(autoHits.length, "count", autoHits.length)
      }
      return null
    }
    if (calib === null || finished !== null) return null
    try {
      if (tool === "length" && points.length >= 2) {
        return toLedgerQuantity(polylineLength(points, calib.mmPerPt), "length")
      }
      if (tool === "area" && points.length >= 3) {
        return toLedgerQuantity(polygonArea(points, calib.mmPerPt), "area")
      }
      if (tool === "count" && points.length >= 1) {
        return toLedgerQuantity(points.length, "count", points.length)
      }
      return null
    } catch (err) {
      if (err instanceof MeasureError) return { error: err.message }
      throw err
    }
  }, [tool, points, calib, finished, autoHits])

  // -- save panel (POST /api/projects/<id>/quantities) ---------------------------

  const saveToLedger = async () => {
    if (saving || finished === null || selected === null || revisionId === null) return
    // Manual measurements are produced by calibration-gated tools, so calib
    // is non-null there; a TEMPLATE count is scale-free and may be saved
    // uncalibrated (scale omitted — honest, not guessed).
    if (finished.provenance === "manual" && calib === null) return
    if (rulesetId.trim() === "" || rulesetVersion.trim() === "") {
      // Mirrored verbatim from RecordQuantityDialog's pre-flight.
      toast.error("rulesetId and rulesetVersion must be non-empty")
      return
    }
    setSaving(true)
    try {
      // EXACTLY the contract §3.3 body: drawing-measured row pointing at the
      // rendered revision, with the browser-calibrated scale record. Slice 13:
      // a template count carries its own quantityMethod so auto-counts are
      // distinguishable from manual counts in the ledger.
      const input: QuantityCreateInput = {
        sourceArtifactRevisionId: revisionId,
        quantityType: finished.tool,
        value: finished.ledger.value,
        unit: finished.ledger.unit,
        method: "drawing-measured",
        sheetRef: `${selected.name} — p${pageNumber}`,
        scale: calib !== null ? calib.scaleRecord : undefined,
        quantityMethod:
          finished.provenance === "template"
            ? `eos-symbol-template/1 (NCC ≥ ${finished.templateInfo?.threshold ?? "0.85"})`
            : "eos-pdf-measure/1 (browser-calibrated)",
        rulesetId: rulesetId.trim(),
        rulesetVersion: rulesetVersion.trim(),
        createdBy: createdBy.trim().length > 0 ? createdBy.trim() : "local-operator",
      }
      // Contract §3.3: the save-panel label travels as elementRef (optional
      // field; the core schema allows it alongside a drawing-measured sheetRef).
      const trimmedLabel = label.trim()
      if (trimmedLabel.length > 0) input.elementRef = trimmedLabel

      const data = await createQuantity(projectId, input)
      toast.success(
        `Quantity recorded — ${data.quantity.quantityType} ${data.quantity.value} ${data.quantity.unit} (draft, unverified)`,
      )

      // -- Slice 13: persist the markup (the row's provenance geometry) --------
      // Runs AFTER the 201; a failure is reported honestly — the ledger row
      // is safe and never duplicated to mask a markup failure.
      if (!isGlobalViewer) {
        const geometry: Pt[] =
          finished.provenance === "template"
            ? (autoHits ?? []).flatMap((h) => [h.tl, h.br])
            : points
        try {
          await createMarkup(projectId, {
            revisionId,
            page: pageNumber,
            kind: finished.provenance === "template" ? "symbol-hits" : finished.tool,
            points: geometry,
            label: trimmedLabel.length > 0 ? trimmedLabel : undefined,
            value: finished.ledger.value,
            unit: finished.ledger.unit,
            scale: calib !== null ? calib.scaleRecord : undefined,
            quantityId: data.quantity.id,
            createdBy: createdBy.trim().length > 0 ? createdBy.trim() : "local-operator",
          })
          setMarkupsNonce((n) => n + 1)
        } catch (markupErr) {
          toast.error(
            `Ledger row saved, but the markup could not be persisted: ${errorMessage(markupErr, "unknown error")} — the row is safe in the ledger; the on-sheet geometry was not saved.`,
          )
        }
      }

      setFinished(null)
      setPoints([])
      setAutoHits(null)
      setScanError(null)
      setLabel("")
      // 201 → refetch the ledger (nothing optimistic anywhere).
      onSaved()
    } catch (err) {
      // Server 422s surface verbatim in the toast (never paraphrased away).
      toast.error(errorMessage(err, "Could not record the quantity"))
    } finally {
      setSaving(false)
    }
  }

  /** Slice 13: deletes one saved markup (never its ledger row) + refetch. */
  const removeMarkup = async (markupId: string) => {
    if (deletingMarkupId !== null) return
    setDeletingMarkupId(markupId)
    try {
      await deleteMarkup(projectId, markupId)
      setMarkupsNonce((n) => n + 1)
      toast.success("Markup removed — its ledger row is untouched (the ledger has its own lifecycle).")
    } catch (err) {
      toast.error(errorMessage(err, "Could not remove the markup"))
    } finally {
      setDeletingMarkupId(null)
    }
  }

  // -- a11y description for the interactive canvas -------------------------------

  const canvasAria = useMemo(() => {
    const parts: string[] = []
    parts.push(`PDF sheet ${selected?.name ?? ""}, page ${pageNumber} of ${pageCount}.`)
    if (tool === "calibrate") {
      parts.push(`Calibrate tool active, ${calibPicks.length} of 2 scale picks set.`)
    } else if (tool === "autocount") {
      parts.push(
        `Symbol auto-count active, ${autoPicks.length} of 2 template corners set${autoHits !== null ? `, ${autoHits.length} hits` : ""}.`,
      )
    } else {
      parts.push(`${tool} tool active, ${points.length} points.`)
    }
    if (liveReadout !== null && "display" in liveReadout) {
      parts.push(`Running value ${liveReadout.display}.`)
    }
    if (tool === "autocount") parts.push("Press Enter to scan, Escape to cancel.")
    else if (tool !== "calibrate") parts.push("Press Enter to finish, Escape to cancel.")
    return parts.join(" ")
  }, [selected, pageNumber, pageCount, tool, calibPicks.length, points.length, liveReadout, autoPicks.length, autoHits])

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const toolHint =
    tool === "calibrate"
      ? calib
        ? "Recalibrating — click two points a known real distance apart."
        : "Click two points a known real distance apart (e.g. the scale-bar end ticks), then enter that distance."
      : tool === "length"
        ? "Click along the line to measure. Double-click or press Enter to finish, Esc to cancel."
        : tool === "area"
          ? "Click the boundary corners in order (≥3 points). Double-click or press Enter to finish, Esc to cancel."
          : tool === "autocount"
            ? "Click two opposite corners of a box around ONE symbol instance (include some blank margin), then Scan this page."
            : "Click each item to count it. Press Enter or double-click to finish the tally, Esc to cancel."

  return (
    <section aria-label="Sheet Measure" className="flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <PencilRuler className="size-4 text-muted-foreground" aria-hidden /> Sheet Measure
        </h3>
        <InfoNote>
          Measure real lengths, areas and counts directly on a PDF drawing sheet. Calibrate once
          against a known distance (e.g. a scale bar): every click is converted to PDF-point space
          before any math, so zooming cannot change a measured value. Saved rows land in the
          Quantity Ledger as draft, unverified, drawing-measured records — the amber ones — and
          (Slice 13) their on-sheet geometry persists as emerald markups: reopening the sheet
          shows WHERE each number came from, and the calibration restores itself. The Auto-count
          tool scans the page for copies of a picked symbol (deterministic template matching,
          threshold ≥ 0.85) so fixture counts don't need hand-clicking.
        </InfoNote>
      </header>

      {/* -- Sheet picker ------------------------------------------------------ */}
      <div className="flex flex-col gap-2">
        <Label htmlFor="sm-sheet">Drawing sheet (PDF)</Label>
        {artifacts.error ? (
          <ErrorState message={artifacts.error} onRetry={artifacts.onRetry} />
        ) : artifacts.loading ? (
          <div className="rounded-lg border p-4">
            <RowSkeleton cols={2} />
          </div>
        ) : pdfSheets.length === 0 ? (
          <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
            {NO_PDF_SHEETS_COPY} (drawings whose latest revision is a <span className="font-mono text-xs">application/pdf</span> file).
          </p>
        ) : (
          <Select value={sheetArtifactId} onValueChange={onSheetChange}>
            <SelectTrigger id="sm-sheet" className="h-10 w-full sm:w-96" aria-label="Drawing sheet (PDF)">
              <SelectValue
                placeholder={pdfSheets.length === 0 ? NO_PDF_SHEETS_COPY : "Pick a sheet to start measuring"}
              />
            </SelectTrigger>
            <SelectContent>
              {pdfSheets.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name} (r{a.latestRevision?.revNumber} · {a.kind})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {selected !== null ? (
        <div className="flex flex-col gap-3">
          {/* -- Toolbar: tools · page nav · zoom · calibration ----------------- */}
          <div className="flex flex-wrap items-center gap-2">
            <ToggleGroup
              type="single"
              variant="outline"
              value={tool}
              // 390px (Slice-13 journey): five tool buttons + page/zoom controls
              // cannot fit one row — the GROUP wraps (the project-workspace
              // pattern; no hidden controls, touch targets keep their size).
              className="flex-wrap"
              onValueChange={(v) => {
                if (v !== "") changeTool(v as MeasureTool)
              }}
              aria-label="Measure tool"
            >
              <ToggleGroupItem
                value="calibrate"
                aria-label="Calibrate tool: pick two points a known distance apart"
                title={calib === null ? "Set the sheet scale from a known distance" : "Recalibrate the sheet scale"}
                className="h-9 px-3 data-[state=on]:border-amber-300 data-[state=on]:bg-amber-100 data-[state=on]:text-amber-900 dark:data-[state=on]:border-amber-700 dark:data-[state=on]:bg-amber-900 dark:data-[state=on]:text-amber-200"
              >
                <PencilRuler className="size-4" aria-hidden /> Calibrate
              </ToggleGroupItem>
              <ToggleGroupItem
                value="length"
                aria-label="Length tool: polyline measurement"
                disabled={calib === null}
                title={calib === null ? "Calibrate the sheet first — pick two points on a known distance" : "Polyline length (double-click or Enter to finish)"}
                className="h-9 px-3 data-[state=on]:border-amber-300 data-[state=on]:bg-amber-100 data-[state=on]:text-amber-900 dark:data-[state=on]:border-amber-700 dark:data-[state=on]:bg-amber-900 dark:data-[state=on]:text-amber-200"
              >
                <Ruler className="size-4" aria-hidden /> Length
              </ToggleGroupItem>
              <ToggleGroupItem
                value="area"
                aria-label="Area tool: polygon measurement"
                disabled={calib === null}
                title={calib === null ? "Calibrate the sheet first — pick two points on a known distance" : "Polygon area, ≥3 points (double-click or Enter to finish)"}
                className="h-9 px-3 data-[state=on]:border-amber-300 data-[state=on]:bg-amber-100 data-[state=on]:text-amber-900 dark:data-[state=on]:border-amber-700 dark:data-[state=on]:bg-amber-900 dark:data-[state=on]:text-amber-200"
              >
                <Shapes className="size-4" aria-hidden /> Area
              </ToggleGroupItem>
              <ToggleGroupItem
                value="count"
                aria-label="Count tool: click tally"
                disabled={calib === null}
                title={calib === null ? "Calibrate the sheet first — pick two points on a known distance" : "Click tally (Enter to finish)"}
                className="h-9 px-3 data-[state=on]:border-amber-300 data-[state=on]:bg-amber-100 data-[state=on]:text-amber-900 dark:data-[state=on]:border-amber-700 dark:data-[state=on]:bg-amber-900 dark:data-[state=on]:text-amber-200"
              >
                <MousePointerClick className="size-4" aria-hidden /> Count
              </ToggleGroupItem>
              <ToggleGroupItem
                value="autocount"
                aria-label="Auto-count tool: pick one symbol instance, scan the page for copies"
                title="Symbol auto-count — pick a box around ONE instance, scan the page (no calibration needed: a count is scale-free)"
                className="h-9 px-3 data-[state=on]:border-emerald-300 data-[state=on]:bg-emerald-100 data-[state=on]:text-emerald-900 dark:data-[state=on]:border-emerald-700 dark:data-[state=on]:bg-emerald-900 dark:data-[state=on]:text-emerald-200"
              >
                <ScanSearch className="size-4" aria-hidden /> Auto-count
              </ToggleGroupItem>
            </ToggleGroup>

            <span className="flex items-center gap-1">
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-9"
                aria-label="Previous page"
                disabled={pageNumber <= 1}
                onClick={() => goToPage(pageNumber - 1)}
              >
                <ChevronLeft className="size-4" aria-hidden />
              </Button>
              <span className="min-w-20 text-center font-mono text-xs text-muted-foreground">
                Page {pageNumber} of {pageCount || "…"}
              </span>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-9"
                aria-label="Next page"
                disabled={pageNumber >= pageCount}
                onClick={() => goToPage(pageNumber + 1)}
              >
                <ChevronRight className="size-4" aria-hidden />
              </Button>
            </span>

            <span className="flex items-center gap-1">
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-9"
                aria-label="Zoom out"
                disabled={zoom <= MIN_ZOOM + 1e-9}
                onClick={() => setZoom((z) => Math.max(MIN_ZOOM, Math.round((z - ZOOM_STEP) * 100) / 100))}
              >
                <ZoomOut className="size-4" aria-hidden />
              </Button>
              <span className="min-w-14 text-center font-mono text-xs text-muted-foreground" aria-label="Zoom level">
                {Math.round(zoom * 100)}%
              </span>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-9"
                aria-label="Zoom in"
                disabled={zoom >= MAX_ZOOM - 1e-9}
                onClick={() => setZoom((z) => Math.min(MAX_ZOOM, Math.round((z + ZOOM_STEP) * 100) / 100))}
              >
                <ZoomIn className="size-4" aria-hidden />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9"
                aria-label="Fit sheet to width"
                disabled={zoom === 1}
                onClick={() => setZoom(1)}
              >
                <Maximize className="size-4" aria-hidden /> Fit
              </Button>
            </span>

            <span className="ml-auto flex flex-wrap items-center gap-2">
              {calib === null ? (
                <Badge
                  className="border-amber-300 bg-amber-100 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300"
                  title="No calibration yet — measure tools are disabled until the sheet scale is set"
                >
                  not calibrated
                </Badge>
              ) : (
                <>
                  <Badge
                    className="border-transparent bg-emerald-100 font-mono text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                    title={calib.scaleRecord}
                  >
                    {calib.summary}
                  </Badge>
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-9 text-muted-foreground"
                    onClick={recalibrate}
                  >
                    Recalibrate
                  </Button>
                </>
              )}
            </span>
          </div>

          {/* -- Honest notices + uncalibrated warning -------------------------- */}
          {calib === null ? (
            <p
              role="note"
              className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
            >
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>
                Measure tools are disabled until the sheet is calibrated — with the Calibrate tool,
                click two points a known real distance apart (the scale-bar end ticks are exact),
                then enter that distance. Nothing is guessed: without a calibration there is no
                honest scale to measure in.
              </span>
            </p>
          ) : null}
          {notice !== null ? (
            <p
              role="status"
              className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
            >
              <FileWarning className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>{notice}</span>
            </p>
          ) : null}

          {/* -- Calibration input (two picks set) ------------------------------ */}
          {tool === "calibrate" && calibPicks.length === 2 && calibPickDistance !== null ? (
            <form
              className="flex flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 sm:flex-row sm:items-end dark:border-amber-800 dark:bg-amber-950"
              onSubmit={(e) => {
                e.preventDefault()
                applyCalibration()
              }}
            >
              <p className="flex-1 text-xs text-amber-900 dark:text-amber-200">
                Two picks set — <span className="font-mono">{calibPickDistance.toFixed(2)} pt</span>{" "}
                apart on the sheet. Enter the real-world distance between them.
              </p>
              <div className="flex flex-wrap items-end gap-2">
                <div className="w-36">
                  <Label htmlFor="sm-calib-length" className="text-xs text-amber-900 dark:text-amber-200">
                    Real distance
                  </Label>
                  <Input
                    id="sm-calib-length"
                    type="number"
                    step="any"
                    min="0"
                    inputMode="decimal"
                    value={calibInput}
                    onChange={(e) => setCalibInput(e.target.value)}
                    placeholder="e.g. 10"
                    aria-label="Real-world distance between the two calibration picks"
                    required
                  />
                </div>
                <div className="w-24">
                  <Label htmlFor="sm-calib-unit" className="sr-only">
                    Unit
                  </Label>
                  <Select value={calibUnit} onValueChange={(v) => setCalibUnit(v as CalibUnit)}>
                    <SelectTrigger id="sm-calib-unit" className="h-10" aria-label="Real distance unit">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="m">m</SelectItem>
                      <SelectItem value="mm">mm</SelectItem>
                      <SelectItem value="ft">ft</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button type="submit" className="h-10">
                  Apply calibration
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="h-10"
                  onClick={() => {
                    setCalibPicks([])
                    setCalibError(null)
                    setCalibInput("")
                  }}
                >
                  Cancel
                </Button>
              </div>
              {calibError !== null ? (
                <p
                  role="alert"
                  className="basis-full text-xs font-medium text-amber-900 dark:text-amber-200"
                >
                  {calibError}
                </p>
              ) : null}
            </form>
          ) : null}

          {/* -- Auto-count control panel (Slice 13) ---------------------------- */}
          {tool === "autocount" ? (
            <div className="flex flex-col gap-3 rounded-lg border border-emerald-300 bg-emerald-50 p-3 dark:border-emerald-800 dark:bg-emerald-950">
              <div className="flex flex-wrap items-end gap-3">
                <div className="w-28">
                  <Label htmlFor="sm-auto-threshold" className="text-xs text-emerald-900 dark:text-emerald-200">
                    NCC threshold
                  </Label>
                  <Input
                    id="sm-auto-threshold"
                    type="number"
                    step="0.01"
                    min="0.5"
                    max="0.99"
                    inputMode="decimal"
                    value={autoThreshold}
                    disabled={scanning || finished !== null}
                    onChange={(e) => {
                      const v = Number(e.target.value)
                      if (Number.isFinite(v)) setAutoThreshold(v)
                    }}
                    aria-label="Minimum NCC correlation score for a symbol match (0.5 to 0.99)"
                  />
                </div>
                <Button
                  type="button"
                  className="h-10"
                  disabled={scanning || autoPicks.length !== 2 || finished !== null}
                  onClick={() => void runAutoCount()}
                >
                  <ScanSearch className="size-4" aria-hidden />
                  {scanning ? "Scanning…" : autoHits !== null ? "Rescan page" : "Scan this page"}
                </Button>
                {autoHits !== null && autoHits.length > 0 && finished === null ? (
                  <Button type="button" variant="outline" className="h-10" onClick={acceptAutoHits}>
                    Accept {autoHits.length} hit{autoHits.length === 1 ? "" : "s"} as count
                  </Button>
                ) : null}
                {autoPicks.length > 0 || autoHits !== null ? (
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-10 text-muted-foreground"
                    disabled={scanning || finished !== null}
                    onClick={() => clearAuto("Auto-count cleared — pick a new template box to scan again.")}
                  >
                    Clear
                  </Button>
                ) : null}
              </div>
              <p className="text-xs text-emerald-900 dark:text-emerald-200">
                {autoPicks.length < 2
                  ? `Template box: ${autoPicks.length} of 2 corners picked — draw it around ONE symbol instance, including a little blank margin.`
                  : autoHits === null
                    ? "Template box ready — Scan renders the page at a fixed 2× scale (independent of your zoom) and matches every instance above the threshold."
                    : autoHits.length === 0
                      ? "Scan complete — no matches. Check the message below the toolbar."
                      : `Scan complete — ${autoHits.length} instance${autoHits.length === 1 ? "" : "s"} boxed in emerald. Review them on the sheet, then Accept (or adjust the threshold and Rescan).`}
              </p>
              {scanError !== null ? (
                <p role="alert" className="text-xs font-medium text-emerald-900 dark:text-emerald-200">
                  {scanError}
                </p>
              ) : null}
            </div>
          ) : null}

          {/* -- Live readout ---------------------------------------------------- */}
          <div
            role="status"
            aria-live="polite"
            className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2"
          >
            {finished !== null ? (
              <>
                <span className="text-xs text-muted-foreground">Finished {finished.tool}</span>
                <span className="font-mono text-base font-semibold tabular-nums" title={`raw: ${finished.rawMm}`}>
                  {finished.ledger.display}
                </span>
                <span className="text-xs text-muted-foreground">
                  fill the label below and save it to the ledger — Esc discards
                </span>
              </>
            ) : liveReadout !== null && "display" in liveReadout ? (
              <>
                <span className="text-xs text-muted-foreground">Running {tool}</span>
                <span className="font-mono text-base font-semibold tabular-nums">
                  {liveReadout.display}
                </span>
                <span className="text-xs text-muted-foreground">
                  {points.length} point{points.length === 1 ? "" : "s"}
                </span>
              </>
            ) : liveReadout !== null && "error" in liveReadout ? (
              <span className="text-xs font-medium text-amber-900 dark:text-amber-200">{liveReadout.error}</span>
            ) : (
              <span className="text-xs text-muted-foreground">{toolHint}</span>
            )}
            {rendering ? (
              <span className="ml-auto text-xs text-muted-foreground">Rendering…</span>
            ) : null}
          </div>

          {/* -- Canvas ---------------------------------------------------------- */}
          {loadPhase === "error" && loadError !== null ? (
            <ErrorState
              message={loadError}
              onRetry={() => {
                setLoadError(null)
                setLoadPhase("idle")
                setRetryNonce((n) => n + 1)
              }}
            />
          ) : loadPhase === "loading" || loadPhase === "idle" ? (
            <div className="flex min-h-64 items-center justify-center rounded-lg border border-dashed">
              <p className="text-sm text-muted-foreground">
                {loadPhase === "loading" ? "Loading sheet bytes…" : "Pick a sheet to render it here."}
              </p>
            </div>
          ) : (
            <div
              ref={scrollRef}
              className="eos-scroll max-h-[70vh] overflow-auto rounded-lg border bg-muted/30"
            >
              <div className="relative inline-block">
                <canvas
                  ref={pdfCanvasRef}
                  className="block"
                  role="img"
                  aria-label={`Rendered PDF page ${pageNumber} of the drawing sheet ${selected.name}`}
                />
                <canvas
                  ref={overlayCanvasRef}
                  className="absolute inset-0 cursor-crosshair focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  tabIndex={0}
                  aria-label={canvasAria}
                  onClick={handleOverlayClick}
                  onDoubleClick={handleDoubleClick}
                  onKeyDown={handleOverlayKeyDown}
                  onMouseMove={handleMouseMove}
                  onMouseLeave={handleMouseLeave}
                />
              </div>
            </div>
          )}

          {/* -- Saved markups on this sheet (Slice 13) ------------------------- */}
          {revisionId !== null ? (
            <div className="flex flex-col gap-2 rounded-lg border p-3 sm:p-4">
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="text-sm font-semibold tracking-tight">Saved markups on this sheet</h4>
                <Badge variant="outline" className="font-mono">
                  {markups.length} total
                </Badge>
                <span className="text-xs text-muted-foreground">
                  the emerald overlay — every drawing-measured number's on-sheet evidence; deleting a
                  markup never touches its ledger row
                </span>
              </div>
              {markupsPhase === "loading" ? (
                <div className="rounded-lg border p-4">
                  <RowSkeleton cols={3} />
                </div>
              ) : markupsPhase === "error" ? (
                <ErrorState message={markupsError ?? "Could not load the saved markups"} onRetry={() => setMarkupsNonce((n) => n + 1)} />
              ) : markups.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No markups yet on this sheet — calibrate or save a measurement and its geometry
                  (plus the calibration record) persists here for every reviewer.
                </p>
              ) : (
                <ul className="eos-scroll max-h-96 divide-y overflow-y-auto rounded-lg border" aria-label="Saved markups list">
                  {markups.map((m) => (
                    <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                      <Badge
                        className={
                          m.kind === "calibration"
                            ? "border-emerald-300 bg-emerald-100 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                            : "border-emerald-200 bg-transparent text-emerald-700 dark:border-emerald-800 dark:text-emerald-300"
                        }
                        title={m.scale ?? undefined}
                      >
                        {m.kind}
                      </Badge>
                      <span className="font-mono text-xs text-muted-foreground">p{m.page}</span>
                      <span className="min-w-0 max-w-56 truncate text-sm" title={m.label ?? undefined}>
                        {m.label ?? <span className="text-muted-foreground">unlabeled</span>}
                      </span>
                      <span className="font-mono text-sm tabular-nums">
                        {trim3(m.value)} {m.unit}
                      </span>
                      {m.quantityId !== null ? (
                        <Badge variant="outline" className="text-xs" title={`ledger row ${m.quantityId}`}>
                          → ledger
                        </Badge>
                      ) : null}
                      <span className="ml-auto text-xs text-muted-foreground" title={m.createdAt}>
                        {m.createdBy}
                      </span>
                      <GuardedButton
                        type="button"
                        variant="ghost"
                        className="size-8 p-0 text-muted-foreground hover:text-destructive"
                        disabled={deletingMarkupId !== null}
                        aria-label={`Delete ${m.kind} markup on page ${m.page}`}
                        onClick={() => void removeMarkup(m.id)}
                      >
                        <Trash2 className="size-4" aria-hidden />
                      </GuardedButton>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}

          {/* -- Save panel (finished measurement) ------------------------------- */}
          {finished !== null && selected !== null ? (
            <form
              className="flex flex-col gap-3 rounded-lg border p-3 sm:p-4"
              onSubmit={(e) => {
                e.preventDefault()
                void saveToLedger()
              }}
            >
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="text-sm font-semibold tracking-tight">Save to the Quantity Ledger</h4>
                <Badge className="border-amber-300 bg-amber-100 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
                  drawing-measured
                </Badge>
                <span className="font-mono text-sm tabular-nums" title={`raw measured value: ${finished.rawMm}`}>
                  {finished.ledger.display}
                </span>
                {finished.provenance === "template" ? (
                  <Badge
                    className="border-emerald-300 bg-emerald-100 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                    title="Counted by the deterministic NCC template scan, not by hand"
                  >
                    symbol auto-count · NCC ≥ {finished.templateInfo?.threshold ?? "0.85"}
                  </Badge>
                ) : null}
              </div>
              <InfoNote>
                Posts a draft, unverified ledger row pinned to revision r{selected.latestRevision?.revNumber} of{" "}
                {selected.name} — sheet <span className="font-mono">{`${selected.name} — p${pageNumber}`}</span>, scale{" "}
                <span className="font-mono">
                  {calib !== null
                    ? calib.scaleRecord
                    : "none — a symbol count is scale-free, so none was needed"}
                </span>. The measured value is read-only: it is the honest number from the
                canvas, never re-typed. {finished.provenance === "template" ? "Every accepted hit box persists as a symbol-hits markup — the count's evidence stays on the sheet. " : "Its on-sheet geometry persists as an emerald markup. "}
                The quantityMethod will read{" "}
                <span className="font-mono">
                  {finished.provenance === "template"
                    ? `eos-symbol-template/1 (NCC ≥ ${finished.templateInfo?.threshold ?? "0.85"})`
                    : "eos-pdf-measure/1 (browser-calibrated)"}
                </span>
                .
              </InfoNote>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="sm-label">Label (optional)</Label>
                  <Input
                    id="sm-label"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="e.g. Room 101 perimeter"
                    maxLength={200}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="sm-createdby">Recorded by</Label>
                  <Input
                    id="sm-createdby"
                    value={createdBy}
                    onChange={(e) => setCreatedBy(e.target.value)}
                    maxLength={80}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="sm-ruleset">Ruleset id</Label>
                  <Input
                    id="sm-ruleset"
                    value={rulesetId}
                    onChange={(e) => setRulesetId(e.target.value)}
                    maxLength={80}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="sm-ruleset-version">Ruleset version</Label>
                  <Input
                    id="sm-ruleset-version"
                    value={rulesetVersion}
                    onChange={(e) => setRulesetVersion(e.target.value)}
                    maxLength={20}
                  />
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <GuardedButton type="submit" disabled={saving}>
                  {saving ? "Saving…" : "Save to ledger"}
                </GuardedButton>
                <Button
                  type="button"
                  variant="outline"
                  disabled={saving}
                  onClick={() => {
                    discardFinished()
                    setNotice("Measurement discarded — it was not saved to the ledger.")
                  }}
                >
                  Discard
                </Button>
              </div>
            </form>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
