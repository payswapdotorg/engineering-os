"use client"

/**
 * Engineering OS — typed API client (W1 lane).
 *
 * Envelope contract (src/lib/api-utils.ts): success → {data}, failure →
 * {error:{code,message}}. No silent optimism: pages refetch after mutations.
 */
import { useCallback, useEffect, useRef, useState } from "react"

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
