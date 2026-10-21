"use client";

/**
 * Global Activity — the append-only audit feed across all projects, with
 * project + actor filters. Feeds fetch live; nothing is cached as a lie.
 */
import { Activity } from "lucide-react"
import { useMemo, useState } from "react"

import { useApi, type AuditEventRow, type ProjectSummary } from "@/components/product/api"
import { EventFeed } from "@/components/product/event-feed"
import { ErrorState } from "@/components/product/parts"
import { Card, CardContent } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"

export default function ActivityPage() {
  const [projectFilter, setProjectFilter] = useState("all")
  const [actorFilter, setActorFilter] = useState("all")

  const projects = useApi<{ projects: ProjectSummary[] }>("/api/projects")
  const feedPath = projectFilter === "all" ? "/api/events?limit=200" : `/api/events?projectId=${projectFilter}&limit=200`
  const feed = useApi<{ events: AuditEventRow[] }>(feedPath)

  const filtered = useMemo(() => {
    const list = feed.data?.events ?? []
    return actorFilter === "all" ? list : list.filter((e) => e.actorType === actorFilter)
  }, [feed.data?.events, actorFilter])

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Activity</h1>
        <p className="text-sm text-muted-foreground">
          Append-only audit events across all local projects. Every mutation in the product writes
          exactly one event (ADR-0006); events are never updated or deleted.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={projectFilter} onValueChange={setProjectFilter}>
          <SelectTrigger size="default" className="h-10 w-56" aria-label="Filter by project">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All projects</SelectItem>
            {projects.data?.projects.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={actorFilter} onValueChange={setActorFilter}>
          <SelectTrigger size="default" className="h-10 w-40" aria-label="Filter by actor type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All actors</SelectItem>
            <SelectItem value="user">user</SelectItem>
            <SelectItem value="agent">agent</SelectItem>
            <SelectItem value="system">system</SelectItem>
          </SelectContent>
        </Select>
        <span className="ml-auto text-xs text-muted-foreground">Newest first · max 200</span>
      </div>

      <Card>
        <CardContent className="p-2 sm:p-4">
          {feed.error ? (
            <ErrorState message={feed.error} onRetry={() => void feed.refresh()} />
          ) : feed.loading ? (
            <div className="space-y-3 p-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-9" />
              ))}
            </div>
          ) : (
            <EventFeed
              events={filtered}
              showProject
              emptyLabel={
                projectFilter === "all" && actorFilter === "all"
                  ? "No activity recorded yet — create a project to start the audit trail."
                  : "No events match the current filters."
              }
              maxHeightClass="max-h-[36rem]"
            />
          )}
        </CardContent>
      </Card>
    </div>
  )
}
