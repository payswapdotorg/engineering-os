"use client"

/**
 * Append-only audit feed — shared by Project Home (recent), the project
 * Activity tab (full, filterable) and the global Activity page.
 */
import { Bot, ChevronRight, Server, User } from "lucide-react"
import { useState } from "react"

import { ActorBadge } from "@/components/product/badges"
import type { AuditEventRow } from "@/components/product/api"
import { relTime } from "@/components/product/format"
import { cn } from "@/lib/utils"

function ActorIcon({ actorType }: { actorType: string }) {
  const cls = "size-4 shrink-0 text-muted-foreground"
  if (actorType === "agent") return <Bot className={cls} aria-hidden />
  if (actorType === "system") return <Server className={cls} aria-hidden />
  return <User className={cls} aria-hidden />
}

function prettyDetail(detail: string | null): string | null {
  if (!detail) return null
  try {
    return JSON.stringify(JSON.parse(detail), null, 2)
  } catch {
    return detail
  }
}

export function EventFeed({
  events,
  showProject,
  maxHeightClass,
  emptyLabel = "No activity recorded yet.",
}: {
  events: AuditEventRow[]
  showProject?: boolean
  maxHeightClass?: string
  emptyLabel?: string
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  if (events.length === 0) {
    return <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">{emptyLabel}</p>
  }

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <ul
      className={cn("eos-scroll divide-y overflow-y-auto", maxHeightClass)}
      role="list"
    >
      {events.map((event) => {
        const detail = prettyDetail(event.detail)
        const isOpen = expanded.has(event.id)
        return (
          <li key={event.id} className="py-1">
            <div
              className={cn(
                "flex items-start gap-3 rounded-md px-2 py-2",
                detail ? "cursor-pointer hover:bg-muted/60" : "",
              )}
              role={detail ? "button" : undefined}
              tabIndex={detail ? 0 : undefined}
              aria-expanded={detail ? isOpen : undefined}
              onClick={detail ? () => toggle(event.id) : undefined}
              onKeyDown={
                detail
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault()
                        toggle(event.id)
                      }
                    }
                  : undefined
              }
            >
              <ActorIcon actorType={event.actorType} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="font-mono text-sm font-medium">{event.action}</span>
                  <ActorBadge actorType={event.actorType} />
                  {showProject && event.project ? (
                    <span className="text-xs text-muted-foreground">· {event.project.name}</span>
                  ) : null}
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground" title={event.createdAt}>
                    {relTime(event.createdAt)}
                  </span>
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {event.entityType} <span className="font-mono">{event.entityId}</span>
                </p>
                {isOpen && detail ? (
                  <pre className="eos-scroll mt-2 max-h-64 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
                    {detail}
                  </pre>
                ) : null}
              </div>
              {detail ? (
                <ChevronRight
                  aria-hidden
                  className={cn("mt-1 size-4 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-90")}
                />
              ) : null}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
