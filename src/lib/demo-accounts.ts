/**
 * Demo accounts — shared constants (single source of truth).
 *
 * Post-Phase-6 addition (contract §1.8, see docs/00-architecture/
 * phase-6-hardening-contract.md). The provisioning route and the auth-surface
 * quick-login panel import the SAME roster + password, so the two can never
 * drift.
 *
 * Honest by design: the shared password is a PUBLIC constant. It only ever
 * authenticates accounts created with isDemo=true, every quick sign-in runs
 * through the real NextAuth credentials flow (no shortcut, no fake session),
 * and the personas are clearly-labelled demo data — nothing here can touch
 * operator accounts (setup counts non-demo users only).
 */
export const DEMO_ACCOUNT_PASSWORD = "demo1234"

export type DemoAccountRole = "admin" | "engineer" | "viewer"

export interface DemoAccountSpec {
  name: string
  email: string
  role: DemoAccountRole
  title: string
  /** What this persona demonstrates (rendered on the quick-login card). */
  blurb: string
}

/**
 * The fixed provisionable roster. The provisioning route creates exactly
 * these accounts (isDemo=true) and accepts NO client-supplied fields — no
 * custom names, roles or passwords — so provisioning can never be abused to
 * mint a privileged non-demo account.
 */
export const DEMO_ACCOUNTS: readonly DemoAccountSpec[] = [
  {
    name: "Ama Boateng",
    email: "ama.demo@eos.local",
    role: "admin",
    title: "Program Director",
    blurb: "Full control — approvals, team management, demo-account removal",
  },
  {
    name: "Kwame Mensah",
    email: "kwame.demo@eos.local",
    role: "engineer",
    title: "Lead Estimator",
    blurb: "Create projects, takeoff, rates and estimates",
  },
  {
    name: "Zara Ahmed",
    email: "zara.demo@eos.local",
    role: "viewer",
    title: "Site Reviewer",
    blurb: "Read-only review — mutating actions disabled",
  },
]
