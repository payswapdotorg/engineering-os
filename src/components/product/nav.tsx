"use client"

/**
 * Primary workspaces (product-requirements.md §3) + platform group.
 * Implemented items navigate to their real route or in-project tab.
 */
import {
  Activity,
  Bot,
  Boxes,
  ClipboardList,
  Cpu,
  DraftingCompass,
  Files,
  FlaskConical,
  Home,
  Map,
  Ruler,
  ShieldCheck,
  Users,
  type LucideIcon,
} from "lucide-react"

export interface WorkspaceItem {
  key: string
  label: string
  icon: LucideIcon
  /** Implemented route (workspace is real in Phase 1) */
  href?: string
  /** Implemented, but scoped to the open project (tab name) */
  inProjectTab?: "artifacts" | "studio" | "team" | "takeoff" | "agents" | "sim" | "controls" | "docs"
  /** Planned-workspace badge, e.g. "Planned · Phase 2" */
  phaseNote?: string
  /** Honest explanation shown when the planned item is clicked */
  plannedToast?: string
}

export const WORKSPACES: WorkspaceItem[] = [
  { key: "project-home", label: "Project Home", icon: Home, href: "/" },
  { key: "design-studio", label: "Design Studio", icon: DraftingCompass, inProjectTab: "studio" },
  { key: "models", label: "Models & Drawings", icon: Boxes, inProjectTab: "artifacts" },
  { key: "takeoff", label: "Takeoff & Estimating", icon: Ruler, inProjectTab: "takeoff" },
  // Phase-5 workspaces (W1-f): real in-project tabs — the former planned
  // badges/toasts are gone; the tabs are implemented in project-workspace.tsx.
  { key: "simulation", label: "Simulation & Verification", icon: FlaskConical, inProjectTab: "sim" },
  { key: "controls", label: "Project Controls", icon: ClipboardList, inProjectTab: "controls" },
  { key: "documents", label: "Documents & Deliverables", icon: Files, inProjectTab: "docs" },
  { key: "agents", label: "Agents & Automations", icon: Bot, inProjectTab: "agents" },
  { key: "team", label: "Team & Administration", icon: Users, inProjectTab: "team" },
]

export interface PlatformItem {
  key: string
  label: string
  icon: LucideIcon
  href: string
  /** Render only for global admins (Slice 17 — the Administration surface). */
  adminOnly?: boolean
}

export const PLATFORM_NAV: PlatformItem[] = [
  { key: "engines", label: "Engines & Discovery", icon: Cpu, href: "/engines" },
  { key: "activity", label: "Activity", icon: Activity, href: "/activity" },
  { key: "status", label: "Status & Roadmap", icon: Map, href: "/status" },
  { key: "admin", label: "Administration", icon: ShieldCheck, href: "/admin", adminOnly: true },
]

export const GITHUB_REPO_URL = "https://github.com/payswapdotorg/engineering-os"
