"use client"

/**
 * Primary workspaces (product-requirements.md §3) + platform group.
 * Implemented items navigate; planned items respond with an honest toast.
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
  inProjectTab?: "artifacts" | "team"
  /** Planned-workspace badge, e.g. "Planned · Phase 2" */
  phaseNote?: string
  /** Honest explanation shown when the planned item is clicked */
  plannedToast?: string
}

export const WORKSPACES: WorkspaceItem[] = [
  { key: "project-home", label: "Project Home", icon: Home, href: "/" },
  {
    key: "design-studio",
    label: "Design Studio",
    icon: DraftingCompass,
    phaseNote: "Planned · Phase 2",
    plannedToast: "Design Studio ships with Phase 2 CAD/BIM integration — see Status & Roadmap",
  },
  { key: "models", label: "Models & Drawings", icon: Boxes, inProjectTab: "artifacts" },
  {
    key: "takeoff",
    label: "Takeoff & Estimating",
    icon: Ruler,
    phaseNote: "Planned · Phase 3",
    plannedToast: "Takeoff & Estimating ships with the Phase 3 quantity ledger — see Status & Roadmap",
  },
  {
    key: "simulation",
    label: "Simulation & Verification",
    icon: FlaskConical,
    phaseNote: "Planned · Phase 4–5",
    plannedToast: "Simulation & Verification ships with Phases 4–5 engine-run integration — see Status & Roadmap",
  },
  {
    key: "controls",
    label: "Project Controls",
    icon: ClipboardList,
    phaseNote: "Planned · Phase 3+",
    plannedToast: "Project Controls ships with Phase 3+ schedule and controls integration — see Status & Roadmap",
  },
  {
    key: "documents",
    label: "Documents & Deliverables",
    icon: Files,
    phaseNote: "Planned · Phase 3+",
    plannedToast: "Documents & Deliverables ship with Phase 3+ review and issue states — see Status & Roadmap",
  },
  {
    key: "agents",
    label: "Agents & Automations",
    icon: Bot,
    phaseNote: "Planned · Phase 4",
    plannedToast: "Agents & Automations ship with the Phase 4 durable workflow runtime — see Status & Roadmap",
  },
  { key: "team", label: "Team & Administration", icon: Users, inProjectTab: "team" },
]

export interface PlatformItem {
  key: string
  label: string
  icon: LucideIcon
  href: string
}

export const PLATFORM_NAV: PlatformItem[] = [
  { key: "engines", label: "Engines & Discovery", icon: Cpu, href: "/engines" },
  { key: "activity", label: "Activity", icon: Activity, href: "/activity" },
  { key: "status", label: "Status & Roadmap", icon: Map, href: "/status" },
]

export const GITHUB_REPO_URL = "https://github.com/payswapdotorg/engineering-os"
