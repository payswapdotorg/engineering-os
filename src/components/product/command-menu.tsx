"use client"

/**
 * Cmd+K palette — workspaces + local project index (honest scope: no global
 * artifact search in Phase 1; the index lists projects only).
 */
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { WORKSPACES, type WorkspaceItem } from "@/components/product/nav"
import { disciplineLabel } from "@/lib/disciplines"
import type { ProjectSummary } from "@/components/product/api"

export function CommandMenu({
  open,
  onOpenChange,
  projects,
  activeProjectId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projects: ProjectSummary[]
  activeProjectId: string | null
}) {
  const router = useRouter()

  const go = (href: string) => {
    onOpenChange(false)
    router.push(href)
  }

  const activateWorkspace = (item: WorkspaceItem) => {
    if (item.href) {
      go(item.href)
      return
    }
    if (item.inProjectTab) {
      if (activeProjectId) {
        go(`/projects/${activeProjectId}?tab=${item.inProjectTab}`)
      } else {
        onOpenChange(false)
        toast.info("Open a project first — pick one from Project Home")
        router.push("/")
      }
      return
    }
    onOpenChange(false)
    if (item.plannedToast) toast.info(item.plannedToast)
  }

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Search workspaces and projects…" />
      <CommandList>
        <CommandEmpty>No matches in the local index.</CommandEmpty>
        <CommandGroup heading="Workspaces">
          {WORKSPACES.map((item) => (
            <CommandItem key={item.key} value={`workspace ${item.label}`} onSelect={() => activateWorkspace(item)}>
              <item.icon aria-hidden />
              <span>{item.label}</span>
              {item.phaseNote ? (
                <span className="ml-auto flex items-center gap-1">
                  <Badge variant="secondary">{item.phaseNote}</Badge>
                </span>
              ) : item.inProjectTab && activeProjectId ? (
                <span className="ml-auto text-xs text-muted-foreground">in open project</span>
              ) : null}
            </CommandItem>
          ))}
        </CommandGroup>
        {projects.length > 0 ? (
          <CommandGroup heading="Projects">
            {projects.map((project) => (
              <CommandItem
                key={project.id}
                value={`project ${project.name} ${disciplineLabel(project.discipline)}`}
                onSelect={() => go(`/projects/${project.id}`)}
              >
                <span className="font-mono text-xs text-muted-foreground">{project.id.slice(0, 11)}</span>
                <span className="truncate">{project.name}</span>
                <span className="ml-auto text-xs text-muted-foreground">{disciplineLabel(project.discipline)}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
      </CommandList>
      <p className="border-t px-3 py-2 text-xs text-muted-foreground">Local index — projects only</p>
    </CommandDialog>
  )
}
