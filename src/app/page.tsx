"use client";

/**
 * Project Home (workspace #1) — projects, counts, recent activity.
 * All data comes from the local API; every number shown is real.
 */
import { Boxes, Cpu, FolderTree, GitBranch, Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { apiJson, useApi, type AuditEventRow, type ProjectSummary, type StatusData } from "@/components/product/api";
import { DisciplineBadge } from "@/components/product/badges";
import { EventFeed } from "@/components/product/event-feed";
import { GuardedButton } from "@/components/product/guarded-button";
import { EmptyState, ErrorState, StatCard } from "@/components/product/parts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { DISCIPLINES, disciplineLabel } from "@/lib/disciplines";
import { formatDate, relTime } from "@/components/product/format";

function NewProjectDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (project: ProjectSummary) => void;
}) {
  const [name, setName] = useState("");
  const [discipline, setDiscipline] = useState<string>("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const valid = name.trim().length > 0 && discipline.length > 0;

  const submit = async () => {
    if (!valid || submitting) return;
    setSubmitting(true);
    try {
      const data = await apiJson<{ project: ProjectSummary }>("/api/projects", "POST", {
        name: name.trim(),
        discipline,
        description: description.trim().length > 0 ? description.trim() : undefined,
      });
      toast.success(`Project "${data.project.name}" created`);
      onCreated(data.project);
      onOpenChange(false);
      setName("");
      setDiscipline("");
      setDescription("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create the project");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            A project is the root of the artifact graph — models, drawings, datasets and their
            change history live inside it.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="project-name">Name</Label>
            <Input
              id="project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Riverside Bridge Retrofit"
              required
              maxLength={120}
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="project-discipline">Discipline</Label>
            <Select value={discipline} onValueChange={setDiscipline} required>
              <SelectTrigger id="project-discipline" aria-label="Discipline">
                <SelectValue placeholder="Select a discipline" />
              </SelectTrigger>
              <SelectContent>
                {DISCIPLINES.map((d) => (
                  <SelectItem key={d.value} value={d.value}>
                    {d.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="project-description">Description</Label>
            <Textarea
              id="project-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Scope, client, location… (optional)"
              rows={3}
              maxLength={2000}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || submitting}>
              {submitting ? "Creating…" : "Create project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function ProjectHome() {
  const [dialogOpen, setDialogOpen] = useState(false);

  const status = useApi<StatusData>("/api/status");
  const projects = useApi<{ projects: ProjectSummary[] }>("/api/projects");
  const events = useApi<{ events: AuditEventRow[] }>("/api/events?limit=8");

  const refreshAll = () => {
    void status.refresh();
    void projects.refresh();
    void events.refresh();
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Project Home</h1>
          <p className="text-sm text-muted-foreground">
            Projects, artifact counts and audit activity across your local workspace.
          </p>
        </div>
        <GuardedButton className="h-10" onClick={() => setDialogOpen(true)}>
          <Plus aria-hidden /> New project
        </GuardedButton>
      </header>

      <section aria-label="Workspace statistics" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Projects" value={status.data?.counts.projects ?? 0} loading={status.loading} icon={FolderTree} />
        <StatCard label="Artifacts" value={status.data?.counts.artifacts ?? 0} loading={status.loading} icon={Boxes} />
        <StatCard
          label="Revisions"
          value={status.data?.counts.revisions ?? 0}
          loading={status.loading}
          icon={GitBranch}
        />
        <StatCard
          label="Engines installed"
          value={`${status.data?.engines.installed ?? 0} / ${status.data?.engines.total ?? 0}`}
          hint="Real PATH/python probes — see Engines & Discovery"
          loading={status.loading}
          icon={Cpu}
        />
      </section>

      <section aria-label="Projects" className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold tracking-tight">Projects</h2>
        </div>

        {projects.error ? (
          <ErrorState message={projects.error} onRetry={() => void projects.refresh()} />
        ) : projects.loading ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Card key={i}>
                <CardContent className="space-y-3 p-4">
                  <Skeleton className="h-5 w-2/3" />
                  <Skeleton className="h-4 w-1/3" />
                  <Skeleton className="h-4 w-1/2" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : projects.data && projects.data.projects.length === 0 ? (
          <EmptyState
            icon={FolderTree}
            title="No projects yet — create your first project"
            description="A project roots the artifact graph: register models, drawings and datasets, link them, and keep a hash-anchored revision history."
            actionLabel="New project"
            onAction={() => setDialogOpen(true)}
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {projects.data?.projects.map((project) => (
              <Link
                key={project.id}
                href={`/projects/${project.id}`}
                className="group rounded-xl outline-offset-4 focus-visible:outline-2"
                aria-label={`Open project ${project.name}`}
              >
                <Card className="h-full transition-colors group-hover:border-foreground/25">
                  <CardContent className="flex h-full flex-col gap-3 p-4">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="line-clamp-2 font-semibold leading-snug tracking-tight group-hover:underline group-hover:decoration-foreground/20 group-hover:underline-offset-4">
                        {project.name}
                      </h3>
                      <Badge variant="outline" className="shrink-0 text-muted-foreground">
                        {project.status}
                      </Badge>
                    </div>
                    <DisciplineBadge label={disciplineLabel(project.discipline)} />
                    {project.description ? (
                      <p className="line-clamp-2 text-sm text-muted-foreground">{project.description}</p>
                    ) : (
                      <p className="line-clamp-2 text-sm italic text-muted-foreground/60">No description</p>
                    )}
                    <div className="mt-auto flex items-center gap-4 border-t pt-3 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Boxes className="size-3.5" aria-hidden /> {project._count.artifacts} artifact
                        {project._count.artifacts === 1 ? "" : "s"}
                      </span>
                      <span>{project._count.members} member{project._count.members === 1 ? "" : "s"}</span>
                      <span className="ml-auto" title={`Updated ${project.updatedAt}`}>
                        {relTime(project.updatedAt)}
                      </span>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section aria-label="Recent activity" className="flex flex-col gap-3">
        <h2 className="text-base font-semibold tracking-tight">Recent activity</h2>
        <Card>
          <CardContent className="p-2 sm:p-4">
            {events.error ? (
              <ErrorState message={events.error} onRetry={() => void events.refresh()} />
            ) : events.loading ? (
              <div className="space-y-3 p-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            ) : (
              <EventFeed
                events={events.data?.events ?? []}
                showProject
                emptyLabel="No activity recorded yet — create a project to start the audit trail."
              />
            )}
          </CardContent>
        </Card>
      </section>

      <NewProjectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={() => refreshAll()}
      />
    </div>
  );
}
