"use client"

/**
 * Project workspace — Overview / Artifacts (Models & Drawings) / Design
 * Studio / Takeoff / Simulation & Verification / Project Controls /
 * Documents & Deliverables / Agents & Automations / Team / Activity. The tab
 * is the URL query (?tab=…), so workspace links (sidebar, Cmd+K) deep-link
 * straight into a tab — the page guard in src/app/projects/[id]/page.tsx
 * routes every tab id below, sim/controls/docs included.
 */
import { Boxes, DraftingCompass, FileUp, GitBranch, Info, Plus, Ruler, Trash2, UserPlus, Users } from "lucide-react"
import Link from "next/link"
import { useMemo, useState } from "react"
import { toast } from "sonner"

import { updateMemberRole, useApi, type ArtifactListItem, type AuditEventRow, type Member, type ProjectDetail } from "@/components/product/api"
import { ApprovalBadge, DisciplineBadge, KindBadge, StalenessBadge } from "@/components/product/badges"
import { ArtifactDetailDialog, RegisterArtifactDialog } from "@/components/product/artifact-dialogs"
import { AgentsWorkspace } from "@/components/product/agents-workspace"
import { ControlsWorkspace } from "@/components/product/controls-workspace"
import { DocsWorkspace } from "@/components/product/docs-workspace"
import { SimWorkspace } from "@/components/product/sim-workspace"
import { EventFeed } from "@/components/product/event-feed"
import { formatDate, humanBytes, relTime } from "@/components/product/format"
import { GuardedButton, PROJECT_MANAGE_DISABLED_REASON, TEAM_MANAGE_DISABLED_REASON } from "@/components/product/guarded-button"
import { AddMemberDialog, EditProjectDialog, RemoveMemberDialog } from "@/components/product/project-dialogs"
import { EmptyState, ErrorState, StatCard } from "@/components/product/parts"
import { useSessionUser } from "@/components/product/session-user"
import { StudioWorkspace } from "@/components/product/studio-workspace"
import { TakeoffWorkspace } from "@/components/product/takeoff-workspace"
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
import { TEAM_ROLES } from "@/core"
import { disciplineLabel } from "@/lib/disciplines"
import { initialsOf } from "@/components/product/format"

const TABS = [
  "overview",
  "artifacts",
  "studio",
  "takeoff",
  "sim",
  "controls",
  "docs",
  "agents",
  "team",
  "activity",
] as const
type TabId = (typeof TABS)[number]

export function ProjectWorkspace({ projectId, tab, onTabChange, locate }: { projectId: string; tab: TabId; onTabChange: (tab: TabId) => void; locate?: { elementRef: string; sourceId: string | null } | null }) {
  const activeTab = tab

  const workspace = useApi<ProjectDetail>(`/api/projects/${projectId}`)
  const activity = useApi<{ events: AuditEventRow[] }>(`/api/events?projectId=${projectId}&limit=200`)
  const sessionUser = useSessionUser()

  const [registerOpen, setRegisterOpen] = useState(false)
  const [memberOpen, setMemberOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<Member | null>(null)
  const [detailArtifactId, setDetailArtifactId] = useState<string | null>(null)
  /** Slice-14 role PATCH in flight — the row's Select disables while the
   *  server answer is pending (no optimistic UI: a refused change — e.g. the
   *  409 last-owner demote — snaps back to the server truth on refresh). */
  const [rolePendingId, setRolePendingId] = useState<string | null>(null)

  const [search, setSearch] = useState("")
  const [kindFilter, setKindFilter] = useState("all")
  const [actorFilter, setActorFilter] = useState("all")

  const project = workspace.data?.project ?? null

  /** Slice-10 owner-row match (contract §6 client mirror): the linked grant
   *  first (userId === the session user's id — the exact server match), then
   *  the pre-slice legacy fallback (email, then exact name) for owner rows
   *  created before the userId link existed. The server is authoritative;
   *  this mirror only drives the visible-disabled gates. */
  const sessionOwnsProject = (() => {
    if (sessionUser === null || sessionUser === "loading") return false
    if (!project) return false
    return project.members.some(
      (m) =>
        m.role === "owner" &&
        (m.userId === sessionUser.id ||
          (m.email !== null && m.email.toLowerCase() === sessionUser.email.toLowerCase()) ||
          m.name.trim().toLowerCase() === sessionUser.name.trim().toLowerCase()),
    )
  })()

  /** Team-member management gate (contract §1.3): the session user must be a
   *  global admin or the project owner (the TeamMember row with role "owner",
   *  matched by the linked userId grant first, email/name fallback retained).
   *  The server remains authoritative; this mirrors the most defensible
   *  client-side computation with the verbatim refusal text. */
  const isTeamManager = (() => {
    if (sessionUser === null || sessionUser === "loading") return false
    if (sessionUser.role === "admin") return true
    if (sessionUser.role === "viewer") return false
    return sessionOwnsProject
  })()
  const teamManageReason = isTeamManager ? null : TEAM_MANAGE_DISABLED_REASON

  /** Slice-10 project-manage gate (contract §6): project settings/identity is
   *  owner/admin-only (the server's "manage" need — PATCH /api/projects/[id]).
   *  Non-owner engineers see the Edit opener disabled with the verbatim
   *  refusal copy; viewers keep today's viewer read-only disablement (applied
   *  by GuardedButton itself — the server's global-viewer 403 outranks the
   *  domain gates). */
  const isProjectManager = (() => {
    if (sessionUser === null || sessionUser === "loading") return false
    if (sessionUser.role === "admin") return true
    return sessionOwnsProject
  })()
  const projectManageReason = isProjectManager ? null : PROJECT_MANAGE_DISABLED_REASON

  const refreshAll = () => {
    void workspace.refresh()
    void activity.refresh()
  }

  /** Slice-14 role change through the REAL PATCH route. Never optimistic:
   *  the row's Select stays on the SERVER role until the refresh lands, so
   *  a refused change (409 last-owner demote — verbatim in the toast) snaps
   *  back visibly. */
  const changeMemberRole = async (member: Member, role: string) => {
    if (role === member.role || rolePendingId !== null) return
    setRolePendingId(member.id)
    try {
      const data = await updateMemberRole(projectId, member.id, role)
      toast.success(`"${data.member.name}" is now ${data.member.role}`)
    } catch (err) {
      // Server refusal VERBATIM (ApiError carries the pinned envelope text).
      toast.error(err instanceof Error ? err.message : "role change failed")
    } finally {
      setRolePendingId(null)
      refreshAll()
    }
  }

  const openRegisterFromOverview = () => {
    onTabChange("artifacts")
    setRegisterOpen(true)
  }

  const openMemberFromOverview = () => {
    onTabChange("team")
    setMemberOpen(true)
  }

  const openTakeoffFromOverview = () => {
    onTabChange("takeoff")
  }

  const openStudioFromOverview = () => {
    onTabChange("studio")
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
          <GuardedButton
            variant="outline"
            className="h-10"
            disabledReason={projectManageReason}
            onClick={() => setEditOpen(true)}
          >
            Edit project
          </GuardedButton>
        </div>
      </header>

      <Tabs value={activeTab} onValueChange={(v) => onTabChange(v as TabId)}>
        {/* The tab strip overflows 390 px viewports, so it scrolls
            horizontally when needed (same eos-scroll convention as the
            tables) instead of pushing the page wide. */}
        <TabsList aria-label="Project workspace sections" className="eos-scroll max-w-full overflow-x-auto">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="artifacts">Artifacts</TabsTrigger>
          <TabsTrigger value="studio">Design Studio</TabsTrigger>
          <TabsTrigger value="takeoff">Takeoff</TabsTrigger>
          <TabsTrigger value="sim">Simulation</TabsTrigger>
          <TabsTrigger value="controls">Controls</TabsTrigger>
          <TabsTrigger value="docs">Documents</TabsTrigger>
          <TabsTrigger value="agents">Agents</TabsTrigger>
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
            <GuardedButton className="h-10" onClick={openRegisterFromOverview}>
              <FileUp aria-hidden /> Register artifact
            </GuardedButton>
            <Button variant="outline" className="h-10" onClick={openTakeoffFromOverview}>
              <Ruler aria-hidden /> Takeoff & estimating
            </Button>
            <Button variant="outline" className="h-10" onClick={openStudioFromOverview}>
              <DraftingCompass aria-hidden /> Design studio
            </Button>
            <GuardedButton variant="outline" className="h-10" onClick={openMemberFromOverview} disabledReason={teamManageReason}>
              <UserPlus aria-hidden /> Add member
            </GuardedButton>
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
            <GuardedButton className="ml-auto h-10" onClick={() => setRegisterOpen(true)}>
              <Plus aria-hidden /> Register artifact
            </GuardedButton>
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

        {/* ---------------- Design Studio ---------------- */}
        {/* onMutated: derive/regenerate actions refresh the project-level caches
            (the AgentsWorkspace.onMutated pattern, Phase-6 known-limitation #13).
            locate: the ?element=/?source= deep-link seed (limitation #12) — the
            Studio consumes it as a source pre-select + element pick. */}
        <TabsContent value="studio" className="mt-4 flex flex-col gap-4">
          <StudioWorkspace key={project.id} projectId={project.id} onMutated={refreshAll} locate={locate} />
        </TabsContent>

        {/* ---------------- Takeoff ---------------- */}
        {/* locate: the same seed's elementRef half — the ledger highlights its
            matching rows (limitation #12's ledger→3D→ledger round trip). */}
        <TabsContent value="takeoff" className="mt-4 flex flex-col gap-4">
          <TakeoffWorkspace key={project.id} projectId={project.id} onMutated={refreshAll} locate={locate} />
        </TabsContent>

        {/* ---------------- Simulation & Verification (W1-f, Phase 5) ---------------- */}
        {/* Same key/onMutated wiring as AgentsWorkspace: a project switch
            remounts the workspace, and every mutation nudges the project-level
            caches (the Phase-4 Artifacts-tab lesson, now the product standard). */}
        <TabsContent value="sim" className="mt-4 flex flex-col gap-4">
          <SimWorkspace key={project.id} projectId={project.id} onMutated={refreshAll} />
        </TabsContent>

        {/* ---------------- Project Controls (W1-f, Phase 5) ---------------- */}
        <TabsContent value="controls" className="mt-4 flex flex-col gap-4">
          <ControlsWorkspace key={project.id} projectId={project.id} onMutated={refreshAll} />
        </TabsContent>

        {/* ---------------- Documents & Deliverables (W1-f, Phase 5) ---------------- */}
        <TabsContent value="docs" className="mt-4 flex flex-col gap-4">
          <DocsWorkspace key={project.id} projectId={project.id} onMutated={refreshAll} />
        </TabsContent>

        {/* ---------------- Agents & Automations ---------------- */}
        {/* key: a project switch remounts the workspace so its selection/poll
            state can never leak across projects. onMutated: workflow runs
            produce/publish artifacts the project-level caches must hear about
            (useApi is manual-refresh — without the nudge the Artifacts tab
            stays stale until the next explicit action). */}
        <TabsContent value="agents" className="mt-4 flex flex-col gap-4">
          <AgentsWorkspace key={project.id} projectId={project.id} onMutated={refreshAll} />
        </TabsContent>

        {/* ---------------- Team ---------------- */}
        <TabsContent value="team" className="mt-4 flex flex-col gap-4">
          <Alert>
            <Info aria-hidden />
            <AlertTitle>Project roster and access</AlertTitle>
            <AlertDescription>
              A member added by email with a matching account holds real, role-scoped project access (Slice
              10: owner manages settings and team, editor works the project, viewer is read-only in-project);
              an email with no account yet is a pending invitation — it activates automatically when that
              person signs up (Slice 14). Rows added without an email are display-only roster entries. The
              server enforces every rule — non-members cannot see this project at all.
            </AlertDescription>
          </Alert>

          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold tracking-tight">Members ({project.members.length})</h2>
            <GuardedButton className="h-10" onClick={() => setMemberOpen(true)} disabledReason={teamManageReason}>
              <UserPlus aria-hidden /> Add member
            </GuardedButton>
          </div>

          {project.members.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No members yet"
              description="Add reviewers or collaborators to the local roster."
              actionLabel="Add member"
              onAction={() => setMemberOpen(true)}
              actionDisabledReason={teamManageReason}
            />
          ) : (
            <div className="eos-scroll overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Member</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Access</TableHead>
                    <TableHead className="text-right">Added</TableHead>
                    <TableHead className="w-12" />
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
                        {isTeamManager ? (
                          <Select
                            value={member.role}
                            onValueChange={(role) => {
                              void changeMemberRole(member, role)
                            }}
                            disabled={rolePendingId === member.id}
                          >
                            <SelectTrigger
                              size="default"
                              className="h-8 w-28"
                              aria-label={`Change ${member.name}'s project role`}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {TEAM_ROLES.map((r) => (
                                <SelectItem key={r} value={r}>
                                  {r}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <Badge variant="outline" className="text-muted-foreground">{member.role}</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {member.userId !== null ? (
                          <Badge variant="outline" className="text-muted-foreground">
                            access · {member.role}
                          </Badge>
                        ) : (
                          <span
                            className="text-xs text-muted-foreground"
                            title="Display-only roster row — no project access"
                          >
                            roster only
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground" title={member.addedAt}>
                        {formatDate(member.addedAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        <GuardedButton
                          variant="ghost"
                          size="icon"
                          className="size-8"
                          aria-label={`Remove ${member.name} from the roster`}
                          disabledReason={teamManageReason}
                          onClick={() => setRemoveTarget(member)}
                        >
                          <Trash2 className="size-4" aria-hidden />
                        </GuardedButton>
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
      <RemoveMemberDialog
        projectId={projectId}
        member={removeTarget}
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null)
        }}
        onRemoved={refreshAll}
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
