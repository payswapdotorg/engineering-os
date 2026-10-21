"use client"

/**
 * Engineering OS — typed API client (W1 lane).
 *
 * Envelope contract (src/lib/api-utils.ts): success → {data}, failure →
 * {error:{code,message}}. No silent optimism: pages refetch after mutations.
 */
import { useCallback, useEffect, useRef, useState } from "react"

// Domain vocabulary re-used on the wire so UI and core can never drift
// (type-only — nothing from core is executed here).
import type {
  EstimateComponentKind,
  QuantityMethod,
  QuantityRecord,
  QuantityType,
  RateSource,
  RoundingMode,
} from "@/core/ledger"

export class ApiError extends Error {
  code: string
  status: number

  constructor(message: string, code: string, status: number) {
    super(message)
    this.code = code
    this.status = status
  }
}

async function unwrap<T>(res: Response): Promise<T> {
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    // fall through to error below
  }
  if (!res.ok || !body || typeof body !== "object" || !("data" in body)) {
    const err =
      body && typeof body === "object" && "error" in body
        ? (body as { error?: { code?: string; message?: string } }).error
        : undefined
    throw new ApiError(
      err?.message ?? `Request failed (${res.status})`,
      err?.code ?? "http_error",
      res.status,
    )
  }
  return (body as { data: T }).data
}

export async function apiGet<T>(path: string): Promise<T> {
  return unwrap<T>(await fetch(path, { cache: "no-store" }))
}

export async function apiJson<T>(path: string, method: "POST" | "PATCH" | "PUT" | "DELETE", body?: unknown): Promise<T> {
  return unwrap<T>(
    await fetch(path, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  )
}

export async function apiUpload<T>(path: string, formData: FormData): Promise<T> {
  return unwrap<T>(
    await fetch(path, {
      method: "POST",
      body: formData,
    }),
  )
}

/** Simple fetch hook with manual refresh; loading=true until the first settle. */
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState<boolean>(path !== null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const refresh = useCallback(async (): Promise<T | null> => {
    if (path === null) return null
    try {
      const result = await apiGet<T>(path)
      if (mounted.current) {
        setData(result)
        setError(null)
      }
      return result
    } catch (err) {
      if (mounted.current) {
        setError(err instanceof Error ? err.message : "Request failed")
        setData(null)
      }
      return null
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [path])

  useEffect(() => {
    if (path === null) {
      setLoading(false)
      return
    }
    setLoading(true)
    void refresh()
  }, [path, refresh])

  return { data, error, loading, refresh }
}

// ---------------------------------------------------------------------------
// Shared response types (mirror the API routes exactly)
// ---------------------------------------------------------------------------

export interface StatusData {
  version: string
  storageMode: string
  storageRoot: string
  dbProvider: string
  engines: { total: number; installed: number }
  counts: { projects: number; artifacts: number; revisions: number }
}

export interface ProjectSummary {
  id: string
  slug: string
  name: string
  discipline: string
  description: string | null
  status: string
  createdAt: string
  updatedAt: string
  _count: { artifacts: number; members: number }
  lastEventAt: string | null
}

export interface Member {
  id: string
  projectId: string
  name: string
  email: string | null
  role: string
  addedAt: string
}

export interface Revision {
  id: string
  artifactId: string
  revNumber: number
  contentHash: string
  sizeBytes: number
  storageKey: string
  mimeType: string | null
  note: string | null
  approvalState: "draft" | "in_review" | "approved" | "superseded"
  staleness: "current" | "stale" | "recomputing"
  uploadedBy: string
  createdAt: string
}

export interface ArtifactListItem {
  id: string
  projectId: string
  kind: string
  name: string
  description: string | null
  latestRevisionId: string | null
  latestRevision: Revision | null
  createdAt: string
  updatedAt: string
  _count?: { revisions: number }
}

export interface AuditEventRow {
  id: string
  projectId: string | null
  actorType: "user" | "agent" | "system"
  actorId: string
  action: string
  entityType: string
  entityId: string
  detail: string | null
  createdAt: string
  project: { name: string; discipline: string } | null
}

export interface ProjectDetail {
  project: {
    id: string
    slug: string
    name: string
    discipline: string
    description: string | null
    status: string
    createdAt: string
    updatedAt: string
    members: Member[]
    artifacts: ArtifactListItem[]
  }
  events: AuditEventRow[]
  counts: { artifacts: number; revisions: number; members: number }
}

export interface LinkRow {
  id: string
  fromArtifactId: string
  toArtifactId: string
  relationType: string
  createdBy: string
  createdAt: string
  toArtifact?: { id: string; name: string; kind: string }
  fromArtifact?: { id: string; name: string; kind: string }
}

export interface ArtifactDetail {
  artifact: ArtifactListItem & {
    revisions: Revision[]
    linksFrom: LinkRow[]
    linksTo: LinkRow[]
  }
}

export interface EngineUpstream {
  canonical: string
  repo?: string
  licenseSpdx?: string
  latestStable?: string
  verified: boolean
  verifiedAt?: string | null
  verifiedMethod?: string | null
}

export interface EngineRecord {
  key: string
  name: string
  domain: string
  description: string
  upstream: EngineUpstream
  integration: { mechanisms: string[]; notes?: string }
  state: string
  limitations: string[]
}

export interface ProbeResult {
  id: string
  engineKey: string
  state: "installed" | "not_installed"
  version: string | null
  executablePath: string | null
  probeOutput: string | null
  probedAt: string
}

export interface EnginesData {
  registry: EngineRecord[]
  probes: Record<string, ProbeResult>
}

export interface ProbeRunResult {
  results: ProbeResult[]
  installed: number
  total: number
}

export interface RevisionUploadResult {
  revision: Revision
  staleMarked: Array<{ artifactId: string; name: string; relation: string; path: string[] }>
}

// ---------------------------------------------------------------------------
// Takeoff & Estimating (Phase 3) — wire types + typed call sites
// ---------------------------------------------------------------------------
// Mirrors the pinned contracts exactly (worklog "TL-pinned contracts"); W3 owns
// the routes, this file owns the client-side shape of the wire. Estimate math
// NEVER happens client-side: line totals and totals arrive computed.
// ---------------------------------------------------------------------------

/** Serialized QuantityRecord + the joined source artifact identity. */
export interface QuantityRow extends QuantityRecord {
  sourceArtifact: { id: string; name: string; kind: string; revNumber: number } | null
}

export type QuantityTransitionAction = "submit" | "approve" | "reject" | "supersede"

/** POST /api/projects/[id]/quantities body (id/projectId are server-assigned). */
export interface QuantityCreateInput {
  sourceArtifactRevisionId: string
  sheetRef?: string
  elementRef?: string
  quantityType: QuantityType
  value: number
  unit: string
  method: QuantityMethod
  scale?: string
  quantityMethod?: string
  rulesetId: string
  rulesetVersion: string
  tradeAssemblyId?: string
  createdBy: string
}

export interface AssemblyComponentRow {
  id: string
  kind: EstimateComponentKind
  name: string
  /** amount of this component per unit of the measured quantity (> 0) */
  quantityPerUnit: number
  unit: string
  wastePct?: number
  productivityFactor?: number
}

export interface AssemblyRow {
  id: string
  projectId: string
  name: string
  trade: string
  components: AssemblyComponentRow[]
  createdAt: string
}

/** POST /api/projects/[id]/assemblies body (component ids are client-generated `cmp_<uuid>`). */
export interface AssemblyComponentInput {
  id: string
  kind: EstimateComponentKind
  name: string
  quantityPerUnit: number
  unit: string
  wastePct?: number
  productivityFactor?: number
}

export interface AssemblyCreateInput {
  name: string
  trade: string
  components: AssemblyComponentInput[]
}

export interface RateRow {
  id: string
  projectId: string
  componentId: string
  currency: string
  unitPrice: number
  source: RateSource
  effectiveFrom?: string
  createdBy: string
  createdAt: string
}

/** POST /api/projects/[id]/rates body (rates are engineer-entered only). */
export interface RateCreateInput {
  componentId: string
  currency: string
  unitPrice: number
  source: RateSource
  effectiveFrom?: string
}

export interface EstimateLineBreakdownRow {
  componentId: string
  kind: EstimateComponentKind
  name: string
  amount: number
  unit: string
  unitPrice: number
  cost: number
}

export interface EstimateLineRow {
  id: string
  estimateId: string
  quantityId: string
  assemblyId: string
  currency: string
  /** server-computed via src/core/ledger.ts estimateLineTotal — never client math */
  lineTotal: number
  rateIds: string[]
  breakdown: EstimateLineBreakdownRow[]
  createdAt: string
}

export interface EstimateTotals {
  linesSubtotal: number
  overhead: number
  profit: number
  tax: number
  grandTotal: number
  currency: string
}

export type EstimateStatus = "draft" | "in_review" | "approved" | "superseded"

/**
 * POST /api/estimates/[id]/transition actions — supersede is terminal and
 * allowed from draft|in_review|approved (lines stay frozen for audit).
 */
export type EstimateTransitionAction = "submit" | "approve" | "reject" | "supersede"

export interface EstimateRow {
  id: string
  projectId: string
  name: string
  currency: string
  overheadPct: number
  profitPct: number
  taxPct: number
  rounding: { mode: RoundingMode; decimals: number }
  status: EstimateStatus
  approval?: { approvedBy: string; approvedAt: string }
  createdBy: string
  createdAt: string
  lines: EstimateLineRow[]
  /** recomputed by the server on every read — never stored stale */
  totals: EstimateTotals
}

/** POST /api/projects/[id]/estimates body. */
export interface EstimateCreateInput {
  name: string
  currency: string
  overheadPct: number
  profitPct: number
  taxPct: number
  roundingMode: RoundingMode
  roundingDecimals: number
}

export async function listProjectArtifacts(projectId: string) {
  return apiGet<{ artifacts: ArtifactListItem[] }>(`/api/projects/${projectId}/artifacts`)
}

export async function listQuantities(projectId: string) {
  return apiGet<{ quantities: QuantityRow[] }>(`/api/projects/${projectId}/quantities`)
}

export async function createQuantity(projectId: string, input: QuantityCreateInput) {
  return apiJson<{ quantity: QuantityRow }>(`/api/projects/${projectId}/quantities`, "POST", input)
}

export async function transitionQuantity(quantityId: string, action: QuantityTransitionAction) {
  return apiJson<{ quantity: QuantityRow }>(`/api/quantities/${quantityId}/transition`, "POST", { action })
}

export async function deriveQuantities(projectId: string, artifactId: string) {
  return apiJson<{ quantities: QuantityRow[] }>(
    `/api/projects/${projectId}/artifacts/${artifactId}/derive-quantities`,
    "POST",
    {},
  )
}

export async function listAssemblies(projectId: string) {
  return apiGet<{ assemblies: AssemblyRow[] }>(`/api/projects/${projectId}/assemblies`)
}

export async function createAssembly(projectId: string, input: AssemblyCreateInput) {
  return apiJson<{ assembly: AssemblyRow }>(`/api/projects/${projectId}/assemblies`, "POST", input)
}

export async function listRates(projectId: string) {
  return apiGet<{ rates: RateRow[] }>(`/api/projects/${projectId}/rates`)
}

export async function createRate(projectId: string, input: RateCreateInput) {
  return apiJson<{ rate: RateRow }>(`/api/projects/${projectId}/rates`, "POST", input)
}

export async function listEstimates(projectId: string) {
  return apiGet<{ estimates: EstimateRow[] }>(`/api/projects/${projectId}/estimates`)
}

export async function createEstimate(projectId: string, input: EstimateCreateInput) {
  return apiJson<{ estimate: EstimateRow }>(`/api/projects/${projectId}/estimates`, "POST", input)
}

export async function getEstimate(estimateId: string) {
  return apiGet<{ estimate: EstimateRow }>(`/api/estimates/${estimateId}`)
}

/** The server resolves rates and computes the line total — the client sends no math. */
export async function addEstimateLine(estimateId: string, input: { quantityId: string; assemblyId: string }) {
  return apiJson<{ estimate: EstimateRow }>(`/api/estimates/${estimateId}/lines`, "POST", input)
}

export async function removeEstimateLine(estimateId: string, lineId: string) {
  return apiJson<{ estimate: EstimateRow }>(`/api/estimates/${estimateId}/lines/${lineId}`, "DELETE")
}

export async function transitionEstimate(estimateId: string, action: EstimateTransitionAction) {
  return apiJson<{ estimate: EstimateRow }>(`/api/estimates/${estimateId}/transition`, "POST", { action })
}

/**
 * BOQ export — plain fetch because the success response is a text/csv file, not
 * the {data} envelope. Failures still arrive as {error:{code,message}} and are
 * thrown with the server message verbatim (same idiom as unwrap); the caller
 * turns the returned blob into a browser download (boq-<estimateId>.csv,
 * matching the pinned Content-Disposition filename).
 */
export async function exportEstimateBoqCsv(estimateId: string): Promise<Blob> {
  const res = await fetch(`/api/estimates/${estimateId}/export?format=csv`, { cache: "no-store" })
  if (!res.ok) {
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      // fall through to the throw below (non-JSON body, e.g. an HTML 404)
    }
    const err =
      body && typeof body === "object" && "error" in body
        ? (body as { error?: { code?: string; message?: string } }).error
        : undefined
    throw new ApiError(
      err?.message ?? `Request failed (${res.status})`,
      err?.code ?? "http_error",
      res.status,
    )
  }
  return res.blob()
}
