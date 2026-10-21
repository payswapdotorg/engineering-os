"use client"

/**
 * Project workspace — Overview / Artifacts (Models & Drawings) / Team / Activity.
 * The tab is the URL query (?tab=…), so workspace links (sidebar, Cmd+K)
 * deep-link straight into a tab.
 */
import { Boxes, FileUp, GitBranch, Info, Plus, UserPlus, Users } from "lucide-react"
import Link from "next/link"
import { useMemo, useState } from "react"
import { toast } from "sonner"

import { useApi, type ArtifactListItem, type AuditEventRow, type ProjectDetail } from "@/components/product/api"
import { ApprovalBadge, DisciplineBadge, KindBadge, StalenessBadge } from "@/components/product/badges"
import { ArtifactDetailDialog, RegisterArtifactDialog } from "@/components/product/artifact-dialogs"
import { EventFeed } from "@/components/product/event-feed"
import { formatDate, humanBytes, relTime } from "@/components/product/format"
import { AddMemberDialog, EditProjectDialog } from "@/components/product/project-dialogs"
import { EmptyState, ErrorState, StatCard } from "@/components/product/parts"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ARTIFACT_KINDS } from "@/lib/artifact-meta"
import { disciplineLabel } from "@/lib/disciplines"
import { initialsOf } from "@/components/product/format"

const TABS = ["overview", "artifacts", "team", "activity"] as const
type TabId = (typeof TABS)[number]

export function ProjectWorkspace({ projectId, tab, onTabChange }: { projectId: string; tab: TabId; onTabChange: (tab: TabId) => void }) {
  const workspace = useApi<ProjectDetail>(`/api/projects/${projectId}`)
  const activity = useApi<{ events: AuditEventRow[] }>(`/api/events?projectId=${projectId}&limit=200`)

  const [registerOpen, setRegisterOpen] = useState(false)
  const [memberOpen, setMemberOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [detailArtifactId, setDetailArtifactId] = useState<string | null>(null)

  const [search, setSearch] = useState("")
  const [kindFilter, setKindFilter] = useState("all")
  const [actorFilter, setActorFilter] = useState("all")

  const project = workspace.data?.project ?? null

  const refreshAll = () => {
    void workspace.refresh()
    void activity.refresh()
  }

  const openRegisterFromOverview = () => {
    onTabChange("artifacts")
    setRegisterOpen(true)
  }

  const openMemberFromOverview = () => {
    onTabChange("team")
    setMemberOpen(true)
  }

  const filteredArtifacts = useMemo(() => {
    const list = project?.artifacts ?? []
    const q = search.trim().toLowerCase()
    return list.filter((a) => {
      if (q.length > 0 && !a.name.toLowerCase().includes(q)) return false
      if (kindFilter !== "all" && a.kind !== kindFilter) return false
      return true
    })
  }, [project?.artifacts, search, kindFilter])

  const filteredEvents = useMemo(() => {
    const list = activity.data?.events ?? []
    return actorFilter === "all" ? list : list.filter((e) => e.actorType === actorFilter)
  }, [activity.data?.events, actorFilter])

  if (workspace.error) {
    return (
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
        <ErrorState message={workspace.error} onRetry={() => void workspace.refresh()} />
        <p className="text-sm text-muted-foreground">
          The project may not exist (it may have been created in another session).{" "}
          <Link className="underline underline-offset-2 hover:text-foreground" href="/">
            Back to Project Home
          </Link>
        </p>
      </div>
    )
  }

  if (!project) {
    return (
      <div className="mx-auto w-full max-w-6xl space-y-6">
        <Skeleton className="h-9 w-72" />
        <div className="grid grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
        <Skeleton className="h-64" />
      </div>
    )
  }

  const counts = workspace.data?.counts

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">{project.name}</h1>
              <DisciplineBadge label={disciplineLabel(project.discipline)} />
              <Badge variant="outline" className="text-muted-foreground">{project.status}</Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {project.description ?? "No description yet."} · Created {formatDate(project.createdAt)}
            </p>
          </div>
          <Button variant="outline" className="h-10" onClick={() => setEditOpen(true)}>
            Edit project
          </Button>
        </div>
      </header>

      <Tabs value={tab} onValueChange={(v) => onTabChange(v as TabId)}>
        <TabsList aria-label="Project workspace sections">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="artifacts">Artifacts</TabsTrigger>
          <TabsTrigger value="team">Team</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>

        {/* ---------------- Overview ---------------- */}
        <TabsContent value="overview" className="mt-4 flex flex-col gap-6">
          <section aria-label="Project statistics" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard label="Artifacts" value={counts?.artifacts ?? 0} icon={Boxes} />
            <StatCard label="Revisions" value={counts?.revisions ?? 0} icon={GitBranch} />
            <StatCard label="Members" value={counts?.members ?? 0} icon={Users} />
            <StatCard
              label="Audit events"
              value={activity.data?.events.length ?? 0}
              hint="append-only"
              icon={Info}
            />
          </section>

          <section aria-label="Quick actions" className="flex flex-wrap gap-3">
            <Button className="h-10" onClick={openRegisterFromOverview}>
              <FileUp aria-hidden /> Register artifact
            </Button>
            <Button variant="outline" className="h-10" onClick={openMemberFromOverview}>
              <UserPlus aria-hidden /> Add member
            </Button>
          </section>

          <section aria-label="Recent activity" className="flex flex-col gap-2">
            <h2 className="text-base font-semibold tracking-tight">Recent activity</h2>
            <Card>
              <CardContent className="p-2 sm:p-4">
                <EventFeed
                  events={(workspace.data?.events ?? []).slice(0, 8)}
                  emptyLabel="No activity in this project yet — register an artifact to start."
                />
              </CardContent>
            </Card>
          </section>
        </TabsContent>

        {/* ---------------- Artifacts ---------------- */}
        <TabsContent value="artifacts" className="mt-4 flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter artifacts…"
              aria-label="Filter artifacts by name"
              className="h-10 w-full sm:w-64"
            />
            <Select value={kindFilter} onValueChange={setKindFilter}>
              <SelectTrigger size="default" className="h-10 w-40" aria-label="Filter by kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All kinds</SelectItem>
                {ARTIFACT_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {k}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button className="ml-auto h-10" onClick={() => setRegisterOpen(true)}>
              <Plus aria-hidden /> Register artifact
            </Button>
          </div>

          {filteredArtifacts.length === 0 && project.artifacts.length === 0 ? (
            <EmptyState
              icon={Boxes}
              title="No artifacts yet — register the first one"
              description="Models, drawings, datasets, calculations… files are stored byte-exact with a SHA-256 anchor and sequential revisions."
              actionLabel="Register artifact"
              onAction={() => setRegisterOpen(true)}
            />
          ) : filteredArtifacts.length === 0 ? (
            <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
              No artifacts match the current filters.
            </p>
          ) : (
            <div className="eos-scroll overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead className="text-center">Rev</TableHead>
                    <TableHead className="text-right">Size</TableHead>
                    <TableHead>Approval</TableHead>
                    <TableHead>Staleness</TableHead>
                    <TableHead className="text-right">Updated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredArtifacts.map((artifact) => (
                    <TableRow
                      key={artifact.id}
                      className="cursor-pointer"
                      tabIndex={0}
                      aria-label={`Open artifact ${artifact.name}`}
                      onClick={() => setDetailArtifactId(artifact.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") setDetailArtifactId(artifact.id)
                      }}
                    >
                      <TableCell className="max-w-[260px] truncate font-medium">{artifact.name}</TableCell>
                      <TableCell>
                        <KindBadge kind={artifact.kind} />
                      </TableCell>
                      <TableCell className="text-center font-mono text-xs">
                        {artifact.latestRevision ? `r${artifact.latestRevision.revNumber}` : "—"}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {artifact.latestRevision ? humanBytes(artifact.latestRevision.sizeBytes) : "—"}
                      </TableCell>
                      <TableCell>
                        {artifact.latestRevision ? <ApprovalBadge state={artifact.latestRevision.approvalState} /> : <span className="text-xs text-muted-foreground">No revisions</span>}
                      </TableCell>
                      <TableCell>
                        {artifact.latestRevision ? <StalenessBadge state={artifact.latestRevision.staleness} /> : null}
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground" title={artifact.updatedAt}>
                        {relTime(artifact.updatedAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>

        {/* ---------------- Team ---------------- */}
        <TabsContent value="team" className="mt-4 flex flex-col gap-4">
          <Alert>
            <Info aria-hidden />
            <AlertTitle>Local single-operator mode</AlertTitle>
            <AlertDescription>
              Authentication ships in Phase 4 (see Security model) — members are a local roster with
              roles, not logged-in identities.
            </AlertDescription>
          </Alert>

          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold tracking-tight">Members ({project.members.length})</h2>
            <Button className="h-10" onClick={() => setMemberOpen(true)}>
              <UserPlus aria-hidden /> Add member
            </Button>
          </div>

          {project.members.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No members yet"
              description="Add reviewers or collaborators to the local roster."
              actionLabel="Add member"
              onAction={() => setMemberOpen(true)}
            />
          ) : (
            <div className="eos-scroll overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Member</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead className="text-right">Added</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {project.members.map((member) => (
                    <TableRow key={member.id}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <Avatar className="size-8">
                            <AvatarFallback className="text-xs">{initialsOf(member.name)}</AvatarFallback>
                          </Avatar>
                          <span className="font-medium">{member.name}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-muted-foreground">{member.role}</Badge>
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground" title={member.addedAt}>
                        {formatDate(member.addedAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>

        {/* ---------------- Activity ---------------- */}
        <TabsContent value="activity" className="mt-4 flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold tracking-tight">Audit trail</h2>
            <Select value={actorFilter} onValueChange={setActorFilter}>
              <SelectTrigger size="default" className="h-9 w-44" aria-label="Filter by actor">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All actors</SelectItem>
                <SelectItem value="user">user</SelectItem>
                <SelectItem value="agent">agent</SelectItem>
                <SelectItem value="system">system</SelectItem>
              </SelectContent>
            </Select>
            <span className="ml-auto text-xs text-muted-foreground">
              Append-only · newest first · max 200
            </span>
          </div>
          <Card>
            <CardContent className="p-2 sm:p-4">
              {activity.error ? (
                <ErrorState message={activity.error} onRetry={() => void activity.refresh()} />
              ) : activity.loading ? (
                <div className="space-y-3 p-2">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="h-8" />
                  ))}
                </div>
              ) : (
                <EventFeed
                  events={filteredEvents}
                  emptyLabel={actorFilter === "all" ? "No activity in this project yet." : "No events from this actor type."}
                  maxHeightClass="max-h-[32rem]"
                />
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <RegisterArtifactDialog
        projectId={projectId}
        open={registerOpen}
        onOpenChange={setRegisterOpen}
        onRegistered={refreshAll}
      />
      <AddMemberDialog
        projectId={projectId}
        open={memberOpen}
        onOpenChange={setMemberOpen}
        onAdded={refreshAll}
      />
      <EditProjectDialog project={project} open={editOpen} onOpenChange={setEditOpen} onSaved={refreshAll} />
      {detailArtifactId ? (
        <ArtifactDetailDialog
          artifactId={detailArtifactId}
          siblings={project.artifacts as ArtifactListItem[]}
          open={detailArtifactId !== null}
          onOpenChange={(open) => {
            if (!open) setDetailArtifactId(null)
          }}
          onChanged={refreshAll}
        />
      ) : null}
    </div>
  )
}
