"use client"

/**
 * Small client-side formatting + badge helpers shared across workspaces.
 */
import { formatDistanceToNowStrict } from "date-fns"

export function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—"
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

export function shortHash(hash: string | null | undefined): string {
  if (!hash) return "—"
  return hash.length <= 16 ? hash : `${hash.slice(0, 10)}…${hash.slice(-4)}`
}

export function relTime(iso: string | null | undefined): string {
  if (!iso) return "—"
  try {
    return formatDistanceToNowStrict(new Date(iso), { addSuffix: true })
  } catch {
    return "—"
  }
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—"
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    })
  } catch {
    return "—"
  }
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "?"
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

/** Phase-1 vocabularies re-exported for badges (source: docs/03-data). */
export const RELATION_HELP: Record<string, { text: string; impact: boolean }> = {
  derived_from: { text: "This artifact is derived from the target — target changes mark this artifact stale.", impact: true },
  analyzes: { text: "This artifact analyzes the target (analysis run, check, report).", impact: true },
  quantifies: { text: "This artifact quantifies the target (e.g. a takeoff of a drawing).", impact: true },
  validates: { text: "This artifact validates the target against rules or requirements.", impact: true },
  supersedes: { text: "This artifact replaces the target (issued revision replaces the old one).", impact: false },
  depends_on: { text: "This artifact depends on the target — target changes mark this artifact stale.", impact: true },
  scheduled_as: { text: "This artifact is scheduled as the target (task or control link).", impact: false },
  approved_by: { text: "This artifact is approved by the target (reviewer identity).", impact: false },
}

/**
 * Slice 31 consolidation (the OSS Reuse & Consolidation Audit v1 §5): the
 * pinned eos-cpm/1 field mapping and the duration formatter each existed as
 * byte-identical duplicates in two workspaces — one shared implementation
 * now lives here. Semantics are preserved exactly; the caller keeps its own
 * envelope guards (the Controls run-envelope reader requires ≥1 activity,
 * the Simulation stored-payload reader renders the honest empty list).
 */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

export interface CpmActivityView {
  id: string
  name: string
  durationDays: number
  es: number
  ef: number
  ls: number
  lf: number
  totalFloat: number
  critical: boolean
}

export interface CpmPayloadView {
  format: "eos-cpm/1"
  sourceArtifactName: string
  activities: CpmActivityView[]
  criticalPath: string[]
  durationDays: number
}

/** Read the pinned eos-cpm/1 fields defensively — numbers render verbatim or not at all. */
export function readCpmPayloadView(candidate: Record<string, unknown>): CpmPayloadView {
  return {
    format: "eos-cpm/1",
    sourceArtifactName:
      typeof candidate.sourceArtifactName === "string" ? candidate.sourceArtifactName : "—",
    activities: (Array.isArray(candidate.activities) ? candidate.activities.filter(isRecord) : []).map((a) => ({
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
    criticalPath: (Array.isArray(candidate.criticalPath) ? candidate.criticalPath : []).map(String),
    durationDays: Number(candidate.durationDays ?? NaN),
  }
}

/** Display-only duration from the server-recorded durationMs — no client math beyond formatting. */
export function formatDuration(ms: number | null | undefined): string {
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
