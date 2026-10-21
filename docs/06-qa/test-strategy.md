# Test Strategy

Owner: TL

## 1. Levels

| Level | Tool | Scope | Runs |
|---|---|---|---|
| Unit | `bun test` (bun:test) | `src/core/**` (pure domain logic), `src/engines/**` (detection with fake executables on PATH) | local + CI |
| Static | `bun run lint`, `bun run typecheck` | whole tree | local + CI |
| API/journey | manual + scripted (curl) during TL integration; scripted journey suite from Phase 4 | API routes against a dev DB | per milestone |
| Engineering validation | per-adapter conformance & benchmark fixtures | adapter outputs vs known answers | from Phase 2/3 |

## 2. Rules

1. **UI test ≠ engineering validity.** A rendering test can never mark a quantity, estimate or simulation as correct.
2. Domain logic tests use **no DB, no network, no fs** (`src/core` is pure). Detection tests fake engines via executable shell scripts in a temp PATH dir — no real engines required, no network.
3. Mocks are allowed **in tests only**. Production code paths never return simulated results (acceptance policy §10).
4. Every acceptance item links to: test file or executed command, observed output, date, verifier.
5. Regression fixtures live in `tests/fixtures/` (small, real engineering files). Discipline fixtures grow per engine pack (Phase 2+: IFC/FCStd conformance sets, benchmark takeoff drawings, known-answer solver cases).
6. Restart/recovery drills: API-level durability every milestone; full process-restart drill in Phase 6 hardening.

## 3. CI

`.github/workflows/ci.yml`: install → prisma generate → lint → typecheck → `bun test` on ubuntu-latest. CI green is necessary, never sufficient (see implementation-status).
