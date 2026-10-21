# ADR-0005 — Engine integration contract

Status: accepted · Date: 2025 (Phase 0)

## Context

Specialist capability must come from real engines, but hard-coding tool invocation across the UI creates an unmaintainable matrix and bypasses security. The mandate requires a supervisor/broker with discovery, contracts, isolation, provenance and permission enforcement.

## Decision

Every engine is represented by a **registry record** (`src/engines/registry.json`, mirrored in `EngineProbeResult`) and, from Phase 2, an **adapter module**. The registry record (data now, adapter code later) carries:

- identity: `key`, name, domain (cad/bim/gis/takeoff/ee/simulation/docs/controls)
- upstream: canonical URL, repo, license SPDX (verified — see ADR-0004), latest stable ref, verification date
- integration: mechanism(s) planned (`cli`, `python-module`, `server`, `mcp`, `native-process`), notes
- probes: how presence/version is detected (executables, version commands, or python module import)
- state: one of `planned | installed | available | implemented | tested | verified | production-ready`
- capabilities: coarse capability rows with their own states
- limitations: known constraints stated explicitly

Rules:
1. The **broker is the only execution path** for tools — UI and (later) agents never spawn engine processes directly.
2. Each adapter execution records: engine version, input artifact revisions (by content hash), command/inputs, exit code, logs, timing, output artifacts. Unregistered outputs never enter the graph.
3. Detection is honest: "not installed" is a first-class state with probe evidence, never an error.
4. Capability states are per-adapter and evidence-linked; the registry is generated/maintained from source-verified data (GitHub/GitLab API checks performed by Worker 2 against upstream repos at audit time, with dates).

## Consequences

- UI can render engine status truthfully before any adapter exists (Phase 1 shows registry + real probes).
- Adding engines = adding data + an adapter implementing the contract; no UI surgery.
- The registry in `src/engines/registry.json` is versioned code (reviewed in git), not runtime-editable config — auditability over convenience.
