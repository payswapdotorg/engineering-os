"use client"

/**
 * Engineering OS product shell (W1 lane).
 *
 * Layout contract: root `min-h-screen flex flex-col` + footer `mt-auto` so the
 * footer is glued to the viewport bottom on short pages and pushed down
 * naturally on long ones. Workspaces per docs/01-product §3 — planned items are
 * visibly disabled and respond with an honest toast (never dead buttons).
 */
import { Github, Menu, Moon, Search, Sun } from "lucide-react"
import { useTheme } from "next-themes"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { Suspense, useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useApi, type ProjectSummary, type StatusData } from "@/components/product/api"
import { AuthSurface } from "@/components/product/auth-surface"
import { CommandMenu } from "@/components/product/command-menu"
import { DisciplineBadge } from "@/components/product/badges"
import { GITHUB_REPO_URL, PLATFORM_NAV, WORKSPACES, type WorkspaceItem } from "@/components/product/nav"
import { useSessionUser, type SessionUser } from "@/components/product/session-user"
import { UserMenu } from "@/components/product/user-menu"
import { disciplineLabel } from "@/lib/disciplines"
import { cn } from "@/lib/utils"

function BrandMark({ compact }: { compact?: boolean }) {
  return (
    <Link href="/" className="flex items-center gap-2.5 rounded-md px-1 py-1 outline-offset-2" aria-label="Engineering OS — Project Home">
      <span
        aria-hidden
        className="flex size-8 shrink-0 items-center justify-center rounded-md bg-orange-700 text-[13px] font-bold tracking-tight text-orange-50 dark:bg-orange-600 dark:text-orange-950"
      >
        EO
      </span>
      {compact ? null : (
        <span className="flex flex-col leading-none">
          <span className="text-sm font-semibold tracking-tight">Engineering OS</span>
          <span className="mt-0.5 text-[11px] text-muted-foreground">Open-source-first workspace</span>
        </span>
      )}
    </Link>
  )
}

function WorkspaceButton({
  item,
  activeProjectId,
  onActivate,
}: {
  item: WorkspaceItem
  activeProjectId: string | null
  onActivate: (item: WorkspaceItem) => void
}) {
  const pathname = usePathname()

  const isActive =
    item.href !== undefined
      ? item.href === "/"
        ? pathname === "/"
        : pathname.startsWith(item.href)
      : false

  const inProjectReady = item.inProjectTab !== undefined && activeProjectId !== null

  if (item.phaseNote) {
    return (
      <button
        type="button"
        aria-disabled="true"
        title={`${item.label} — ${item.phaseNote}`}
        onClick={() => onActivate(item)}
        className="flex min-h-10 w-full cursor-default items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-muted-foreground/75 hover:bg-muted/60 hover:text-muted-foreground"
      >
        <item.icon className="size-4 shrink-0" aria-hidden />
        <span className="flex-1 truncate">{item.label}</span>
        <Badge variant="secondary" className="max-w-[110px] truncate font-normal">
          {item.phaseNote}
        </Badge>
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={() => onActivate(item)}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "flex min-h-10 w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground",
        isActive ? "bg-accent font-medium text-accent-foreground" : "text-foreground/85",
      )}
    >
      <item.icon
        className={cn("size-4 shrink-0", isActive && item.href === "/" && "text-orange-700 dark:text-orange-400")}
        aria-hidden
      />
      <span className="flex-1 truncate">{item.label}</span>
      {inProjectReady ? (
        <span
          aria-hidden
          title="Available in the open project"
          className="size-1.5 shrink-0 rounded-full bg-orange-600 dark:bg-orange-400"
        />
      ) : item.inProjectTab ? (
        <span className="shrink-0 text-[10px] text-muted-foreground/70">needs project</span>
      ) : null}
    </button>
  )
}

function NavList({
  activeProjectId,
  onActivate,
  onActivatePlatform,
}: {
  activeProjectId: string | null
  onActivate: (item: WorkspaceItem) => void
  onActivatePlatform: (href: string) => void
}) {
  const pathname = usePathname()

  return (
    <nav aria-label="Primary" className="flex flex-col gap-5 px-3 py-4">
      <div>
        <p className="px-2.5 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Workspaces
        </p>
        <div className="flex flex-col gap-0.5">
          {WORKSPACES.map((item) => (
            <WorkspaceButton key={item.key} item={item} activeProjectId={activeProjectId} onActivate={onActivate} />
          ))}
        </div>
      </div>
      <div>
        <p className="px-2.5 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Platform
        </p>
        <div className="flex flex-col gap-0.5">
          {PLATFORM_NAV.map((item) => {
            const isActive = pathname.startsWith(item.href)
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => onActivatePlatform(item.href)}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "flex min-h-10 w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground",
                  isActive ? "bg-accent font-medium text-accent-foreground" : "text-foreground/85",
                )}
              >
                <item.icon
                  className={cn("size-4 shrink-0", isActive && "text-orange-700 dark:text-orange-400")}
                  aria-hidden
                />
                <span className="flex-1 truncate">{item.label}</span>
              </button>
            )
          })}
        </div>
      </div>
    </nav>
  )
}

const emptySubscribe = () => () => {}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  // Client-only mount flag without a setState effect (hydration-safe).
  const mounted = useSyncExternalStore(emptySubscribe, () => true, () => false)

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-9"
          aria-label={mounted && resolvedTheme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
        >
          {mounted && resolvedTheme === "dark" ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>Toggle light / dark theme</TooltipContent>
    </Tooltip>
  )
}

/** Session-loading screen — the existing skeleton standard, no flash of the
 * unauthenticated surface (Phase-6 auth gate). */
function BootSkeleton() {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground" role="status" aria-label="Loading session">
      <div className="border-b">
        <div className="flex h-14 items-center gap-2 px-3 sm:px-4 md:px-6">
          <Skeleton className="size-8 rounded-md" />
          <Skeleton className="h-4 w-28" />
          <div className="ml-auto flex items-center gap-1">
            <Skeleton className="h-9 w-32" />
            <Skeleton className="size-9 rounded-md" />
          </div>
        </div>
      </div>
      <main className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8">
        <Skeleton className="h-9 w-72" />
        <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
        <Skeleton className="mt-6 h-64" />
      </main>
    </div>
  )
}

/**
 * AppShell — the Phase-6 auth gate (W1-g lane). While the session is loading it
 * shows the skeleton standard; with no session the full-screen auth surface
 * REPLACES the shell; once authenticated the authenticated shell mounts FRESH
 * (its project/status fetches only start after a session exists, so they never
 * carry a stale 401 from the unauthenticated moment).
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const user = useSessionUser()
  if (user === "loading") return <BootSkeleton />
  if (user === null) return <AuthSurface />
  return <AuthenticatedShell user={user}>{children}</AuthenticatedShell>
}

function AuthenticatedShell({ user, children }: { user: SessionUser; children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()

  const [sheetOpen, setSheetOpen] = useState(false)
  const [commandOpen, setCommandOpen] = useState(false)

  const status = useApi<StatusData>("/api/status")
  const projects = useApi<{ projects: ProjectSummary[] }>("/api/projects")

  const activeProjectId = useMemo(() => {
    const match = pathname.match(/^\/projects\/([^/?#]+)/)
    return match ? match[1] : null
  }, [pathname])

  const activeProject = useMemo(
    () => projects.data?.projects.find((p) => p.id === activeProjectId) ?? null,
    [projects.data, activeProjectId],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setCommandOpen((v) => !v)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const activateWorkspace = (item: WorkspaceItem) => {
    setSheetOpen(false)
    if (item.href) {
      router.push(item.href)
      return
    }
    if (item.inProjectTab) {
      if (activeProjectId) {
        router.push(`/projects/${activeProjectId}?tab=${item.inProjectTab}`)
      } else {
        toast.info("Open a project first — pick one from Project Home")
        router.push("/")
      }
      return
    }
    if (item.plannedToast) toast.info(item.plannedToast)
  }

  const switchProject = (value: string) => {
    router.push(value === "all" ? "/" : `/projects/${value}`)
  }

  const enginesInstalled = status.data?.engines.installed
  const footerFacts =
    status.data === null
      ? status.loading
        ? "loading local status…"
        : "status unavailable"
      : `local · ${status.data.dbProvider} · engines: ${status.data.engines.installed} of ${status.data.engines.total} installed`

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-2 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-1.5 focus:text-sm focus:text-primary-foreground"
      >
        Skip to main content
      </a>

      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="flex h-14 items-center gap-2 px-3 sm:px-4 md:px-6">
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="size-9 md:hidden" aria-label="Open navigation menu">
                <Menu className="size-5" aria-hidden />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 bg-background p-0">
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              <SheetDescription className="sr-only">
                Engineering OS workspaces and platform pages
              </SheetDescription>
              <div className="border-b px-4 py-3.5">
                <BrandMark />
              </div>
              <NavList
                activeProjectId={activeProjectId}
                onActivate={activateWorkspace}
                onActivatePlatform={(href) => {
                  setSheetOpen(false)
                  router.push(href)
                }}
              />
            </SheetContent>
          </Sheet>

          <div className="hidden md:block">
            <BrandMark compact />
          </div>

          {activeProject ? (
            <span className="hidden min-w-0 items-center gap-2 rounded-full border px-3 py-1 text-sm md:flex md:max-w-[340px]">
              <span className="truncate font-medium">{activeProject.name}</span>
              <DisciplineBadge label={disciplineLabel(activeProject.discipline)} />
            </span>
          ) : null}

          <div className="ml-auto flex items-center gap-1">
            <Select value={activeProjectId ?? "all"} onValueChange={switchProject}>
              <SelectTrigger
                size="sm"
                className="hidden h-9 w-[190px] lg:w-[240px] sm:flex"
                aria-label="Switch project"
              >
                <SelectValue placeholder="All projects" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All projects</SelectItem>
                {projects.data?.projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button
              variant="ghost"
              size="icon"
              className="size-9"
              aria-label="Search workspaces and projects (Ctrl+K)"
              title="Search (Ctrl+K)"
              onClick={() => setCommandOpen(true)}
            >
              <Search className="size-4" aria-hidden />
            </Button>

            <ThemeToggle />

            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="size-9" asChild>
                  <a href={GITHUB_REPO_URL} target="_blank" rel="noopener noreferrer" aria-label="Engineering OS on GitHub">
                    <Github className="size-4" aria-hidden />
                  </a>
                </Button>
              </TooltipTrigger>
              <TooltipContent>payswapdotorg/engineering-os</TooltipContent>
            </Tooltip>

            <UserMenu user={user} />
          </div>
        </div>
      </header>

      <div className="flex flex-1">
        <aside
          aria-label="Workspaces"
          className="sticky top-14 hidden max-h-[calc(100dvh-3.5rem)] w-60 shrink-0 self-start overflow-y-auto border-r bg-background md:block"
        >
          <div className="px-3 pt-4">
            <BrandMark />
          </div>
          <NavList
            activeProjectId={activeProjectId}
            onActivate={activateWorkspace}
            onActivatePlatform={(href) => {
              setSheetOpen(false)
              router.push(href)
            }}
          />
        </aside>

        <main id="main-content" className="min-w-0 flex-1 px-4 py-6 md:px-8">
          {children}
        </main>
      </div>

      <footer className="mt-auto border-t bg-background px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 text-xs text-muted-foreground md:px-8">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>
            Engineering OS{status.data ? <span className="font-mono"> v{status.data.version}</span> : null} ·{" "}
            {footerFacts}
          </span>
          <span className="hidden sm:inline" aria-hidden>·</span>
          <span className="hidden sm:inline">{status.data ? status.data.storageMode : ""}</span>
          <span className="ml-auto flex items-center gap-3">
            {status.loading ? <Skeleton className="h-3 w-24" /> : null}
            <a
              className="underline-offset-2 hover:text-foreground hover:underline"
              href={`${GITHUB_REPO_URL}/blob/main/docs/07-release/implementation-status.md`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Status &amp; evidence
            </a>
          </span>
        </div>
      </footer>

      <Suspense fallback={null}>
        <CommandMenu
          open={commandOpen}
          onOpenChange={setCommandOpen}
          projects={projects.data?.projects ?? []}
          activeProjectId={activeProjectId}
        />
      </Suspense>
    </div>
  )
}
