"use client"

/**
 * Honest state badges — colors encode the state machines in docs/03-data
 * (approval: draft → in_review → approved → superseded; staleness:
 * current → stale → recomputing).
 */
import { Loader2 } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

export function ApprovalBadge({ state }: { state: string }) {
  switch (state) {
    case "approved":
      return (
        <Badge className="border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
          Approved
        </Badge>
      )
    case "in_review":
      return (
        <Badge className="border-amber-300 bg-amber-100 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
          In review
        </Badge>
      )
    case "superseded":
      return <Badge variant="secondary">Superseded</Badge>
    case "draft":
    default:
      return <Badge variant="secondary">Draft</Badge>
  }
}

export function StalenessBadge({ state, subtle }: { state: string; subtle?: boolean }) {
  switch (state) {
    case "stale":
      return (
        <Badge className="border-amber-400/60 bg-amber-100 text-amber-900 dark:border-amber-700 dark:bg-amber-900 dark:text-amber-200">
          Stale
        </Badge>
      )
    case "recomputing":
      return (
        <Badge className="border-transparent bg-muted text-muted-foreground">
          <Loader2 className="animate-spin" aria-hidden /> Recomputing
        </Badge>
      )
    case "current":
    default:
      if (subtle) return <Badge variant="outline" className="text-muted-foreground">Current</Badge>
      return null
  }
}

export function RelationBadge({ relation, impactHint }: { relation: string; impactHint?: boolean }) {
  return (
    <Badge variant="outline" className="font-mono text-[11px]" title={impactHint ? "Impact relation — source changes mark the source artifact stale" : undefined}>
      {relation}
      {impactHint ? <span aria-hidden className="text-amber-600 dark:text-amber-400">·impact</span> : null}
    </Badge>
  )
}

export function KindBadge({ kind }: { kind: string }) {
  return (
    <Badge variant="outline" className="text-muted-foreground">
      {kind}
    </Badge>
  )
}

export function DisciplineBadge({ label }: { label: string }) {
  return (
    <Badge
      variant="outline"
      className={cn("border-orange-300/70 text-orange-800 dark:border-orange-800/60 dark:text-orange-300")}
    >
      {label}
    </Badge>
  )
}

export function ActorBadge({ actorType }: { actorType: string }) {
  switch (actorType) {
    case "agent":
      return <Badge variant="outline" className="text-muted-foreground">agent</Badge>
    case "system":
      return <Badge variant="outline" className="text-muted-foreground">system</Badge>
    case "user":
    default:
      return <Badge variant="outline" className="text-muted-foreground">user</Badge>
  }
}

export function StateBadge({ state }: { state: string }) {
  // Status vocabulary: planned → installed → available → implemented → tested → verified
  switch (state) {
    case "planned":
      return <Badge variant="secondary">planned</Badge>
    case "installed":
      return <Badge className="border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">installed</Badge>
    case "available":
      return <Badge className="border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">available</Badge>
    case "implemented":
      return <Badge className="border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">implemented</Badge>
    case "tested":
      return <Badge className="border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">tested</Badge>
    case "verified":
      return <Badge className="border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">verified</Badge>
    default:
      return <Badge variant="outline" className="font-mono">{state}</Badge>
  }
}
