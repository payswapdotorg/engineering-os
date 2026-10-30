# ADR-0010: Workflow execution foundation — Stage-2 spike outcome and the seam

Status: accepted (2026-10-30, ADR-0009 Stage 2) · Supersedes: none · Extends:
ADR-0009 (decision #11 and migration Stage 2), ADR-0005 (the broker stays the
only tool path), ADR-0006 §3 (the approval red line), ADR-0002 (platform core
stays pure)

## Context

ADR-0009 decision #11 froze the semantics of the durable workflow executor
(`src/core/runtime/executor.ts`, 786 LOC — an in-process serial queue: durable
records, not durable execution; no timers, no distributed workers, no
parallelism) and mandated this spike: choose ONE execution foundation —
Temporal (MIT, v1.32.1) vs Kestra (Apache-2.0, v2.0.7), Windmill excluded
(AGPL-3.0, verified from repo text — GitHub license detection false-negative)
— behind a flag, with four binding conditions: the approval red line, revision
publication, the closed event vocabulary (contract §7) and broker
authorization remain platform-owned regardless of foundation, and no
replacement retires the current executor without passing the same acceptance
suite (e2e-p4-workflows 49 PASS + recovery drill 16 PASS). The directive
behind it: do not introduce multiple overlapping orchestration platforms.

## What the spike shipped (code, not just paper)

1. **The seam** — `src/core/runtime/foundation.ts`: the
   `WorkflowExecutionFoundation` port (`enqueue`, `recoverOrphans`,
   `describe`), a registry, and the `EOS_WORKFLOW_RUNTIME` flag. The port is
   deliberately minimal: a foundation owns ONLY execution mechanics (claiming
   queued work, step dispatch, retry scheduling, orphan recovery). The
   decision-#11 binding conditions are enforced BY CONSTRUCTION — the port has
   no operation that could express an approval, a publication, an event kind
   or a broker call, so no foundation can ever absorb them.
2. **The embedded adapter** — `src/core/runtime/foundation-embedded.ts`:
   wraps the existing executor queue mechanics and registers itself as
   `"embedded"`; `describe()` states the audit's characterization as data
   (`durableExecution: false, parallelWorkers: false, timers: false`).
   Importing the module also resolves the active foundation once at module
   load — the `.eos-engine-pin` convention: a misconfigured flag surfaces at
   boot with the verbatim seam error, never as a silent fallback discovered
   on the first request.
3. **Route wiring** — the two routes that claim and recover work
   (`POST /api/workflows/[id]/transition` ×2 enqueue sites, and
   `GET /api/projects/[id]/workflows` recoverOrphans + the queued re-claim
   loop) now go through `getFoundation()`. The platform-owned operations
   (`approveWorkflow`, `snapshotStepInputs`, `recordWorkflowEvent`) stay
   DIRECT executor imports by design — they are semantics, not mechanics.
4. **Pins** — `src/core/runtime/foundation.test.ts` (10 tests): flag
   default/empty/whitespace → embedded; EXACT id match (`"EMBEDDED"` is an
   error, not a synonym); unknown value → hard verbatim error listing the
   registered foundations; the port-shape pin (a foundation owns exactly
   `id`/`enqueue`/`recoverOrphans`/`describe`); the embedded describe()
   honesty; and the contract-§7 vocabulary freeze (the exact 17-kind
   `WORKFLOW_EVENT_KINDS` set — a foundation swap can never extend it).

Unit suite: **801 pass / 0 fail** (791 + 10 new) · typecheck clean · lint
clean.

## Candidate evaluation (paper spike, honestly labeled)

No Temporal or Kestra server was stood up on the dev host for this spike —
the evaluation below is from the candidates' documentation, source layout and
license terms, and it says so. The swap itself (if ever triggered) would be
its own acceptance-gated change; this section records the lane so it is not
re-litigated from scratch.

| Dimension | Temporal v1.32.1 (MIT) | Kestra v2.0.7 (Apache-2.0) | Embedded executor (retain) |
|---|---|---|---|
| Durable execution | Yes — event-sourced workflow history, resume mid-workflow | Yes — flow executions persisted | No — durable records only; recovery-mark + explicit retry (honest, contract §8) |
| Where platform semantics live | Activities + platform-side signals: the state machine, approvals and event vocabulary stay in platform code; the foundation only schedules | The YAML flow language WANTS to own states, errors, retries — platform-owned semantics would migrate INTO flow definitions | All platform-owned, in-repo, pinned by 49+16 acceptance PASS |
| Deployment footprint vs the single-operator SQLite form factor | Production: server process + separate persistence (Postgres/MySQL/Cassandra) + worker processes; dev: temporalite single binary | JVM server + its own persistence | None — in-process |
| TS story | First-class SDK (deterministic workflow code) | REST/declarative; no TS SDK for flow semantics | Native |
| License | MIT | Apache-2.0 | Platform code |

**The Kestra rejection is architectural, not preferential:** its flow
semantics would absorb exactly the four binding conditions (§Context) that
decision #11 pins to the platform — the approval red line as a flow-level
state, the closed vocabulary as Kestra event kinds. That is the ADR-0005
lesson in another shape: the moment the platform's safety semantics live in
an external system's language, they are no longer the platform's to guarantee.

## Decision

1. **RETAIN the embedded executor as the only registered foundation** — flag
   default `embedded`. Neither candidate is adopted today: the swap's
   benefits (mid-workflow resume, timers, parallel workers) answer
   requirements the single-operator form factor does not have, and both
   candidates add an external server process the product cannot yet carry.
   The 786-LOC executor stays frozen-semantics platform core (decision #11)
   behind the seam.
2. **DESIGNATE Temporal as the single successor lane.** When a trigger
   fires (below), the Temporal adapter ships as its own module registering
   through `registerFoundation` — the seam does not change, and
   `EOS_WORKFLOW_RUNTIME=temporal` becomes selectable. Never multiple
   overlapping orchestration platforms (the directive), never a silent
   fallback (unknown flag values are a hard error at boot).
3. **REJECT Kestra for this product** (flow-semantics absorption + JVM
   footprint) — recorded so the evaluation is not re-run.
4. **The swap gate is unchanged and binding:** e2e-p4-workflows 49 PASS +
   recovery drill 16 PASS + the platform-owned pins (vocabulary freeze, red
   line) on the replacement, BEFORE the current executor is retired.

## Trigger criteria (any one fires the Temporal adapter work)

- multi-operator / multi-server deployment — the serial in-process queue
  becomes the bottleneck (its documented exclusion, contract §8);
- scheduled or timer-based steps become a product requirement;
- workflow volumes where mid-workflow crash resume (vs recovery-mark +
  explicit retry) materially changes operator experience;
- the recovery drill's honest no-auto-resume becomes a measured support
  burden rather than a documented exclusion.

## Consequences

- The seam is real but thin: routes choose a foundation through one call;
  everything dangerous stays platform-owned by construction, and the
  port-shape pin fails any future adapter that tries to grow an approve or
  publish operation.
- `EOS_WORKFLOW_RUNTIME` is the only switch; unknown values fail fast at
  boot with the verbatim error (a foundation selector is not a tuning knob —
  contrast `EOS_RECOVERY_CUTOFF_MS`, which falls back by design).
- Zero upstream code added: the spike is a RETAIN/DESIGNATE decision
  recorded through ~200 LOC of platform glue + pins, not a BUILD — the
  reuse-directive accounting for Stage 2 closes with no new self-built
  engine or orchestration logic.
