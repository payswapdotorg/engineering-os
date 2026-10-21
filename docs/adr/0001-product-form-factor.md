# ADR-0001 — Product form factor: local-first web application

Status: accepted · Date: 2025 (Phase 0)

## Context

The mandate requires a desktop-first Ubuntu product that engineers install and launch, unifying many native open-source engines that are themselves desktop or CLI applications. Options: (a) native desktop framework (Qt/GTK), (b) Electron/Tauri wrapper, (c) local web application served on localhost and opened in the system browser.

## Decision

Implement the product shell as a **local-first web application** (Next.js 16 App Router, TypeScript) served on `localhost` — one process, one browser tab — with native engines launched as supervised child processes by adapters. Desktop packaging (system service + menu entry, or a lightweight wrapper) is a Phase 6 packaging concern, not an architecture fork.

## Consequences

- One interaction model (HTML/CSS/React) across all nine workspaces; responsive by construction.
- The "app" is installable and launchable via documented commands today; a packaged desktop identity lands with Phase 6.
- Complex native editing (e.g. FreeCAD GUI) opens the upstream editor in context; the unified product keeps project context, revisions and provenance. We do not pretend a viewer equals an editor.
- HTTP API routes are the internal contract — the same seams a remote/colocated deployment or Electron-style shell would use later.
