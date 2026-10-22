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
  /** Phase-6 additive column (contract §1.1): the human actor's display name
   *  for session-user events; agent/system events keep it null. Optional on the
   *  wire so pre-Phase-6 rows (and a backend lane still warming up) render the
   *  actorId form unchanged. */
  userName?: string | null
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
  /** Phase-6 additive (contract §1.7): set to true when this component's
   *  resolved rate row has effectiveFrom in the future — the price is
   *  provisional. Optional: absent for old payloads. */
  futureDatedRate?: true
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
  /** Phase-6 additive (contract §1.7): a line-level mirror of the future-dated
   *  rate warning when the line's resolved rate is effective in the future.
   *  Optional: the UI guards on presence AND true. */
  futureDatedRate?: true
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

// ---------------------------------------------------------------------------
// Design Studio (Phase 2) — mesh derive/read wire types + typed call sites
// ---------------------------------------------------------------------------
// Mirrors the Phase-2 pinned contracts exactly (worklog "TL-pinned contracts —
// Phase 2" §D). W3-d owns the routes; this file owns the client-side shape of
// the wire. The mesh JSON itself (eos-mesh/1) is produced by the W2-d bridge
// and stored verbatim — the client NEVER rewrites vertices, up-axis or units.
// ---------------------------------------------------------------------------

/** Provenance block embedded in every stored eos-mesh/1 file. */
export interface MeshGeneratedBy {
  engineKey: string
  engineVersion: string
  adapterScript: string
  /** sha256 of the adapter script content (64-hex) */
  adapterHash: string
}

/** One tessellated element — `elementRef` matches the quantity-ledger refs. */
export interface MeshElementRow {
  /** `step:solid:<i>` or `ifc:#<GlobalId>` — cross-reference with quantity rows */
  elementRef: string
  name: string
  /** vertices in meters, source up-axis preserved */
  vertices: number[][]
  /** 0-based triangle indices into `vertices` */
  triangles: number[][]
}

/** Stored eos-mesh/1 payload (GET …/mesh returns it including `generatedBy`). */
export interface MeshPayloadRow {
  format: string
  units: string
  /** source up-axis declared by the adapter — the VIEWER rotates, never the adapter */
  upAxis: "z" | "y"
  /** linear deflection used, in meters */
  tolerance: number
  generatedBy?: MeshGeneratedBy
  elements: MeshElementRow[]
}

/** GET /api/artifacts/[id]/mesh — 200 `{data:{mesh, meta}}` per pinned contract. */
export interface MeshGetResult {
  mesh: MeshPayloadRow
  meta: {
    artifactId: string
    name: string
    revisionNumber: number
    contentHash: string
    sizeBytes: number
    /** live staleness of the mesh vs its source model's latest revision */
    staleSource: boolean
    staleness: "current" | "stale" | "recomputing"
    derivedFromArtifactId: string | null
    derivedFromRevisionId: string | null
    sourceLatestRevisionId: string | null
    sourceArtifactName: string | null
    /** read from the stored payload's generatedBy — null if a hand-stored file lacks it */
    engineKey: string | null
    engineVersion: string | null
    adapterScript: string | null
    adapterHash: string | null
    /** the mesh revision's createdAt — the only timestamp, lives in the DB not the file */
    generatedAt: string
  }
}

/** POST …/derive-mesh 201 `{data:{mesh}}` per pinned contract. */
export interface DerivedMeshRow {
  artifactId: string
  name: string
  kind: "mesh"
  revisionNumber: number
  contentHash: string
  sizeBytes: number
  elementCount: number
  vertexCount: number
  triangleCount: number
  engineKey: string
  engineVersion: string
  adapterScript: string
  adapterHash: string
  derivedFromArtifactId: string
  derivedFromRevisionId: string
  sourceLatestRevisionId: string
  staleSource: boolean
}

/**
 * POST /api/projects/[id]/artifacts/[artifactId]/derive-mesh — tessellates the
 * latest revision via the real engine bridge and appends/creates the derived
 * mesh artifact. 422s (unsupported extension, engine_unavailable) carry the
 * server message verbatim via the shared unwrap idiom.
 */
export async function deriveModelMesh(projectId: string, artifactId: string) {
  return apiJson<{ mesh: DerivedMeshRow }>(
    `/api/projects/${projectId}/artifacts/${artifactId}/derive-mesh`,
    "POST",
    {},
  )
}

/** GET /api/artifacts/[id]/mesh — parsed eos-mesh/1 payload + live staleness meta. */
export async function fetchModelMesh(meshArtifactId: string) {
  return apiGet<MeshGetResult>(`/api/artifacts/${meshArtifactId}/mesh`)
}

/**
 * GET /api/artifacts/[id] — artifact detail incl. linksFrom/linksTo. The
 * artifacts LIST payload carries no links, so the Design Studio maps
 * source → mesh through each mesh artifact's `derived_from` link (honest gap:
 * O(#meshes) extra fetches; noted for TL in the worklog).
 */
export async function getArtifactDetail(artifactId: string) {
  return apiGet<ArtifactDetail>(`/api/artifacts/${artifactId}`)
}

// ---------------------------------------------------------------------------
// Agents & Automations — workflow runtime (Phase 4) — wire types + typed call sites
// ---------------------------------------------------------------------------
// Mirrors the pinned contract (docs/00-architecture/workflow-runtime-contract.md
// §1/§6) exactly; W3 owns the routes + src/core/workflow.ts, this file owns the
// client-side shape of the wire. The UI never computes the state machine:
// every state change POSTs to the transition route and 409/422 messages
// surface verbatim in toasts (the takeoff-workspace idiom). JSON-typed columns
// (definition/failure/inputRevisionIds/…) arrive as raw strings per the row
// contract and are parsed display-side, never re-written.
// ---------------------------------------------------------------------------

/** Workflow-level state machine (contract §3) — 8 states; 3 terminal. */
export type WorkflowState =
  | "draft"
  | "ready"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "awaiting_approval"

/** Per-step run state (contract §1 WorkflowStepRun.state). */
export type WorkflowStepRunState =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "awaiting_approval"

/** One definition step (contract §2 — the JSON stored on Workflow.definition). */
export interface WorkflowStepDefinition {
  /** ^[a-z0-9-]{1,32}$, unique in the definition */
  id: string
  /** BROKER_OPERATIONS key: derive_quantities | derive_mesh | build_report */
  operation: string
  /** derive ops: exactly one model artifact (artifactId); report: artifactIds */
  inputs: { artifactId?: string; artifactIds?: string[] }
  /** op-specific, default {} */
  parameters: Record<string, unknown>
  /** default {1, 0} = no retry */
  retry: { maxAttempts: number; backoffMs: number }
  /** true → pause BEFORE publishing (ADR-0006 gate; honored by publishing ops) */
  requiresApproval: boolean
  /** true → step failure marks the step skipped, flow continues */
  skipOnError: boolean
}

/** Parsed Workflow.definition (contract §2) — 1..8 steps, seq = array order. */
export interface WorkflowDefinition {
  steps: WorkflowStepDefinition[]
}

/** Parsed Workflow.failure (contract §1) — JSON {stepId, attempt, error, at}. */
export interface WorkflowFailure {
  stepId: string
  attempt: number
  error: string
  at: string
}

/** GET /api/projects/[id]/workflows row — raw row, JSON fields stay strings. */
export interface WorkflowRow {
  id: string
  projectId: string
  name: string
  state: WorkflowState
  /** JSON text of a WorkflowDefinition */
  definition: string
  /** "local-operator" | "agent:<name>" (contract §1) */
  createdBy: string
  /** JSON text of a WorkflowFailure — set on failed, cleared on retry */
  failure: string | null
  createdAt: string
  updatedAt: string
  currentStateSince: string | null
  finishedAt: string | null
}

/** GET /api/workflows/[id] step row (contract §1 WorkflowStepRun). */
export interface WorkflowStepRow {
  id: string
  workflowId: string
  stepId: string
  seq: number
  state: WorkflowStepRunState
  attempt: number
  maxAttempts: number
  operation: string
  engineKey: string | null
  /** JSON text: string[] — artifact revision ids locked at queue time */
  inputRevisionIds: string
  /** JSON text: string[] — sha256 of those revisions' content */
  inputHashes: string
  outputArtifactRevisionId: string | null
  /** JSON text — per-op structured summary; NO free-form numbers */
  outputSummary: string | null
  /** last 2000 chars, verbatim */
  stdoutTail: string | null
  /** last 2000 chars, verbatim */
  stderrTail: string | null
  exitCode: number | null
  engineVersion: string | null
  adapterScript: string | null
  adapterHash: string | null
  startedAt: string | null
  endedAt: string | null
  durationMs: number | null
}

/** GET /api/workflows/[id] event row (contract §1 WorkflowEvent). */
export interface WorkflowEventRow {
  id: string
  workflowId: string
  /** per-workflow monotonic (1, 2, …) — event order is content */
  seq: number
  /** §7 closed vocabulary (workflow.* / step.* / storage.*) */
  kind: string
  actorType: "user" | "agent" | "system"
  /** "local-operator" | "agent:<name>" | "system:executor" | "system:recovery" */
  actorId: string
  /** JSON text — kind-specific; failures carry the verbatim adapter error */
  payload: string | null
  createdAt: string
}

/** GET /api/workflows/[id] → workflow + step rows + newest events. */
export interface WorkflowDetail {
  workflow: WorkflowRow
  steps: WorkflowStepRow[]
  events: WorkflowEventRow[]
  /** server verdict on whether the current (human) session may approve */
  canApprove: boolean
}

/**
 * POST /api/workflows/[id]/transition actions (contract §3/§6). approve/reject
 * are human-only server-side (actorType "user") — the body carries no actor.
 */
export type WorkflowTransitionAction = "mark-ready" | "queue" | "cancel" | "retry" | "approve" | "reject"

/** POST /api/projects/[id]/workflows body (createdBy validated: "local-operator" | ^agent:[a-z0-9-]{1,32}$). */
export interface WorkflowCreateInput {
  name: string
  /** structured on the wire (the assemblies/components precedent); the server persists it as JSON text */
  definition: WorkflowDefinition
  createdBy?: string
}

export async function listProjectWorkflows(projectId: string) {
  return apiGet<{ workflows: WorkflowRow[] }>(`/api/projects/${projectId}/workflows`)
}

export async function createProjectWorkflow(projectId: string, input: WorkflowCreateInput) {
  return apiJson<{ workflow: WorkflowRow }>(`/api/projects/${projectId}/workflows`, "POST", input)
}

/** GET /api/workflows/[id] — detail incl. step rows + newest 200 events. */
export async function getWorkflowDetail(workflowId: string) {
  return apiGet<WorkflowDetail>(`/api/workflows/${workflowId}`)
}

/**
 * POST /api/workflows/[id]/transition — the ONLY state-change path (contract §3:
 * applyWorkflowAction is the single authority). `note` travels only when the
 * reviewer typed one (reject dialog); JSON.stringify drops it otherwise, so the
 * server sees {action} alone for note-less transitions. 409/422 surface verbatim
 * via the shared unwrap idiom.
 */
export async function transitionWorkflow(workflowId: string, action: WorkflowTransitionAction, note?: string) {
  return apiJson<{ workflow: WorkflowRow }>(`/api/workflows/${workflowId}/transition`, "POST", { action, note })
}

// ---------------------------------------------------------------------------
// Extended disciplines (Phase 5) — wire types + typed call sites
// ---------------------------------------------------------------------------
// Mirrors docs/00-architecture/phase5-disciplines-contract.md §8 (routes) and
// §2 (stored payload formats) exactly. W3-f owns the routes, W2-f the broker
// ops; this file owns the client-side shape of the wire.
//
// HONEST TOLERANCE NOTE: the contract freezes the route families and their
// 201 envelope keys ({femesh} {powerflow} {sim} {pdf} {analysis} {artifact})
// plus the STORED payload formats — the inner field lists of the 201 bodies
// follow the Phase-4 derive-mesh precedent (DerivedMeshRow) extended with the
// full BrokerOutcome (stdout/stderr tails, exitCode, durationMs), but they are
// not byte-pinned in the contract. Every result field below is therefore
// optional except the identity trio the UI needs to point at the produced
// artifact; the workspaces render each field only when the server sent it and
// never invent a value. 422 refusals (BrokerRefusalError mapping) surface
// VERBATIM via the shared unwrap idiom.
// ---------------------------------------------------------------------------

/** 201 inner shape shared by all derive/convert/analyze results (tolerant). */
export interface DeriveRunResult {
  /** produced (or appended-to) derived artifact — present in every 201 */
  artifactId: string
  name: string
  kind: string
  revisionNumber?: number | null
  contentHash?: string | null
  sizeBytes?: number | null
  /** engine identity — ABSENT/null for platform-core ops (analyze_schedule) */
  engineKey?: string | null
  engineVersion?: string | null
  adapterScript?: string | null
  /** sha256 of the adapter script content (64-hex) */
  adapterHash?: string | null
  /** last 2000 chars, verbatim */
  stdoutTail?: string | null
  /** last 2000 chars, verbatim */
  stderrTail?: string | null
  exitCode?: number | null
  durationMs?: number | null
  /** derived_from link identity (the broker find-or-create precedent) */
  derivedFromArtifactId?: string | null
  derivedFromRevisionId?: string | null
  sourceLatestRevisionId?: string | null
  staleSource?: boolean | null
  /** the PARSED stored document (§2 payload) — JSON outputs only; the PDF
   *  route serves meta only. Source of truth for the result tables. */
  document?: unknown
  // --- op-appropriate structural summary fields (the meshCounts convention) ---
  /** eos-femesh/1 */
  nodeCount?: number
  elementCount?: number
  solidCount?: number
  /** eos-powerflow/1 */
  converged?: boolean
  busCount?: number
  lineCount?: number
  /** eos-des/1 */
  makespan?: number
  resourceCount?: number
  jobCount?: number
  /** eos-cpm/1 */
  activityCount?: number
  criticalPathCount?: number
  durationDays?: number
}

// --- Stored payload formats (contract §2 — frozen, JSON, byte-deterministic) ---

/** eos-femesh/1 — gmsh linear-tet FE-mesh summary. */
export interface FeMeshPayload {
  format: "eos-femesh/1"
  sourceArtifactName: string
  units: string
  generatedBy?: { engineKey: string; engineVersion: string; adapterScript: string }
  meshSizeMin: number
  meshSizeMax: number
  elementOrder: number
  nodes: { count: number }
  elements: { type: string; count: number }
  solids: Array<{ ref: string; name?: string; tetCount: number; meshVolume: number }>
  quality: { min: number; mean: number }
}

/** eos-powerflow/1 — pandapower result frame, numbers copied verbatim. */
export interface PowerFlowPayload {
  format: "eos-powerflow/1"
  sourceArtifactName: string
  converged: boolean
  buses: Array<{ id: string; vmPu: number; angleDeg: number; pMw: number; qMvar: number }>
  lines: Array<{ fromBus: string; toBus: string; iKa: number; pLossMw: number; qLossMvar: number }>
  totals: { lossMw: number; loadMw: number }
}

/** eos-des/1 — SimPy FIFO discrete-event record. */
export interface DesPayload {
  format: "eos-des/1"
  sourceArtifactName: string
  policy: string
  makespan: number
  resources: Array<{ id: string; busy: number; utilization: number }>
  jobs: Array<{ id: string; startAt: number; endAt: number }>
}

/** eos-cpm/1 — platform-core critical-path result (no engine). */
export interface CpmAnalysisPayload {
  format: "eos-cpm/1"
  sourceArtifactName: string
  activities: Array<{
    id: string
    name: string
    durationDays: number
    es: number
    ef: number
    ls: number
    lf: number
    totalFloat: number
    critical: boolean
  }>
  criticalPath: string[]
  durationDays: number
}

/** Which stored payload a derived artifact revision carries (discriminated by format). */
export type AnalysisPayload = PowerFlowPayload | DesPayload | CpmAnalysisPayload

// --- §8 routes (thin wrappers over broker cores; 422s verbatim) --------------

/** POST /api/projects/[id]/artifacts/[aid]/fe-mesh — 201 {femesh}. */
export async function runFeMesh(projectId: string, artifactId: string) {
  return apiJson<{ femesh: DeriveRunResult }>(
    `/api/projects/${projectId}/artifacts/${artifactId}/fe-mesh`,
    "POST",
    {},
  )
}

/** POST /api/projects/[id]/artifacts/[aid]/powerflow — 201 {powerflow}. */
export async function runPowerFlow(projectId: string, artifactId: string) {
  return apiJson<{ powerflow: DeriveRunResult }>(
    `/api/projects/${projectId}/artifacts/${artifactId}/powerflow`,
    "POST",
    {},
  )
}

/** POST /api/projects/[id]/artifacts/[aid]/simulate — 201 {sim}. */
export async function runDiscreteEvent(projectId: string, artifactId: string) {
  return apiJson<{ sim: DeriveRunResult }>(
    `/api/projects/${projectId}/artifacts/${artifactId}/simulate`,
    "POST",
    {},
  )
}

/** POST /api/projects/[id]/artifacts/[aid]/convert-document — 201 {pdf}. */
export async function convertDocument(projectId: string, artifactId: string) {
  return apiJson<{ pdf: DeriveRunResult }>(
    `/api/projects/${projectId}/artifacts/${artifactId}/convert-document`,
    "POST",
    {},
  )
}

/** POST /api/projects/[id]/artifacts/[aid]/analyze-schedule — 201 {analysis}. */
export async function analyzeSchedule(projectId: string, artifactId: string) {
  return apiJson<{ analysis: DeriveRunResult }>(
    `/api/projects/${projectId}/artifacts/${artifactId}/analyze-schedule`,
    "POST",
    {},
  )
}

// --- §3.1 schedule input (frozen; created through the Controls workspace) -----

/** One eos-schedule/1 activity row (contract §3.1). */
export interface ScheduleActivityInput {
  id: string
  name: string
  durationDays: number
  predecessorIds: string[]
}

/** POST /api/projects/[id]/schedules body — canonical eos-schedule/1 JSON. */
export interface ScheduleCreateInput {
  format: "eos-schedule/1"
  name: string
  activities: ScheduleActivityInput[]
}

/** POST /api/projects/[id]/schedules — 201 {artifact} (kind `schedule`, rev 1). */
export async function createSchedule(projectId: string, input: ScheduleCreateInput) {
  return apiJson<{ artifact: ArtifactListItem }>(`/api/projects/${projectId}/schedules`, "POST", input)
}

// --- §9 estimate recompute -----------------------------------------------------

/** POST /api/estimates/[id]/recompute {} — tolerant: the contract pins the
 *  semantics and the audit event, not the 201 body; every field is optional. */
export interface EstimateRecomputeResult {
  /** the NEW draft estimate ("<original> — revised draft") */
  estimate?: EstimateRow
  /** ids of the stale sources the recompute absorbed (audit-detail mirror) */
  staleSourceArtifactIds?: string[]
  newDraftId?: string
}

/** POST /api/estimates/[id]/recompute — approved+stale gates 422 verbatim. */
export async function recomputeEstimate(estimateId: string) {
  return apiJson<EstimateRecomputeResult>(`/api/estimates/${estimateId}/recompute`, "POST", {})
}

// --- Revision content (payload reads for derived JSON + PDF downloads) --------

/**
 * GET /api/revisions/[id]/download — raw revision bytes (the SAME URL the
 * artifact-detail dialog's Download button uses). Not the {data} envelope, so
 * failures surface with the server message verbatim (the exportEstimateBoqCsv
 * idiom). Callers parse text/JSON themselves; a non-JSON body is returned as
 * text and left to the caller to reject honestly.
 */
export async function fetchRevisionText(revisionId: string): Promise<string> {
  const res = await fetch(`/api/revisions/${revisionId}/download`, { cache: "no-store" })
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
  return res.text()
}

/**
 * GET /api/revisions/[id]/download — binary variant of fetchRevisionText (the
 * exportEstimateBoqCsv idiom) for the Sheet Measure tab's pdf.js render: the
 * success response is raw bytes, not the {data} envelope, so failures surface
 * with the server message verbatim (401 session expiry / 404 unknown revision
 * are NEVER swallowed into a silent blank canvas). Callers hand the blob to
 * pdf.js via arrayBuffer().
 */
export async function downloadRevisionBytes(revisionId: string): Promise<Blob> {
  const res = await fetch(`/api/revisions/${revisionId}/download`, { cache: "no-store" })
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
