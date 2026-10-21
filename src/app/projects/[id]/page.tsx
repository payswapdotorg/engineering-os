"use client";

/**
 * /projects/[id] — client page. The active tab lives in ?tab= so workspace
 * navigation (sidebar, Cmd+K) deep-links directly into Models & Drawings,
 * Takeoff & Estimating or Team. useSearchParams requires a Suspense boundary
 * in Next 16.
 */
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback } from "react";

import { ProjectWorkspace } from "@/components/product/project-workspace";
import { Skeleton } from "@/components/ui/skeleton";

const TABS = ["overview", "artifacts", "takeoff", "team", "activity"] as const;
type TabId = (typeof TABS)[number];

function isTabId(v: string | null): v is TabId {
  return v !== null && (TABS as readonly string[]).includes(v);
}

function ProjectPageSkeleton() {
  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <Skeleton className="h-9 w-72" />
      <Skeleton className="h-10 w-96" />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
    </div>
  );
}

function ProjectPageInner() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();

  const rawTab = searchParams.get("tab");
  const tab: TabId = isTabId(rawTab) ? rawTab : "overview";

  const setTab = useCallback(
    (next: TabId) => {
      router.replace(`/projects/${params.id}?tab=${next}`, { scroll: false });
    },
    [router, params.id],
  );

  if (!params.id) {
    return <p className="text-sm text-muted-foreground">Invalid project id.</p>;
  }

  return <ProjectWorkspace projectId={params.id} tab={tab} onTabChange={setTab} />;
}

export default function ProjectPage() {
  return (
    <Suspense fallback={<ProjectPageSkeleton />}>
      <ProjectPageInner />
    </Suspense>
  );
}
