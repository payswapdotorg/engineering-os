import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { EngineUnavailableError, parseDesAdapterStdout, runDesFromFile, type DesResult } from "./des"

/**
 * Discrete-event simulation bridge tests (W2-f completion, Phase 5 — contract
 * §5.3/§7.6-7).
 *
 * Honesty rules (ADR-0006 — the mesh.test.ts convention): the PURE tests feed
 * SYNTHETIC protocol strings into the bridge's parse/validate half; every
 * number asserted in the REAL-engine tests is HAND-DERIVED — the makespan-13
 * flow-shop trace below, independent of SimPy's own bookkeeping.
 *
 * Hand trace — tests/fixtures/des-flowshop.json (3 jobs × 2 machines, FIFO,
 * all arrive at 0; tasks sequential per job in array order):
 *   J1: m1 [0,2) → m2 [2,6)      (startAt 0, endAt 6)
 *   J2: m1 [2,5) → m2 waits (J1 holds m2 until 6) → [6,8)   (startAt 2, endAt 8)
 *   J3: m1 [5,6) → m2 waits (J2 queued first at 6 — FIFO) → [8,13) (startAt 5, endAt 13)
 *   makespan = 13
 *   busy: m1 = 2+3+1 = 6 · m2 = 4+2+5 = 11
 *   utilization = busy/makespan: m1 = 6/13 · m2 = 11/13
 *
 * Real-engine tests run ONLY when simpy is genuinely importable in the venv;
 * otherwise they are skipped with an explicit printed reason.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.resolve(here, "..", "..", "..", "tests", "fixtures")
const PYTHON_BIN = process.env.EOS_PYTHON ?? "/home/z/.venv/bin/python3"

const simpyAvailable = spawnSync(PYTHON_BIN, ["-c", "import simpy"], { timeout: 60_000 }).status === 0
if (!simpyAvailable) {
  console.log(
    `[des.test.ts] DES tests SKIPPED: simpy is not importable in ${PYTHON_BIN} (recorded honestly — no results are simulated)`,
  )
}

const TEST_TIMEOUT_MS = 180_000

function sha256Of(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex")
}

/** Synthetic success stdout in the pinned adapter protocol (no engine). */
function syntheticDesStdout(): string {
  return JSON.stringify({
    engineKey: "synthetic-engine",
    engineVersion: "1.2.3",
    adapterScript: "des.py",
    adapterHash: "a".repeat(64),
    policy: "fifo",
    makespan: 13,
    resources: [
      { id: "m1", busy: 6, utilization: 6 / 13 },
      { id: "m2", busy: 11, utilization: 11 / 13 },
    ],
    jobs: [
      { id: "j1", startAt: 0, endAt: 6 },
      { id: "j2", startAt: 2, endAt: 8 },
      { id: "j3", startAt: 5, endAt: 13 },
    ],
  })
}

function expectEngineUnavailable(promise: Promise<unknown>): Promise<EngineUnavailableError> {
  return promise.then(
    () => {
      throw new Error("expected the bridge to throw EngineUnavailableError")
    },
    (err: unknown) => {
      expect(err).toBeInstanceOf(EngineUnavailableError)
      return err as EngineUnavailableError
    },
  )
}

/** Determinism signature: the event-record payload (what the broker assembles
 * into the stored eos-des/1 document); subprocess tails are evidence. */
function desPayloadSignature(r: DesResult): string {
  return JSON.stringify({
    engineKey: r.engineKey,
    engineVersion: r.engineVersion,
    adapterScript: r.adapterScript,
    adapterHash: r.adapterHash,
    policy: r.policy,
    makespan: r.makespan,
    resources: r.resources,
    jobs: r.jobs,
  })
}

// ---------------------------------------------------------------------------
// Pure half of the bridge: protocol parsing + payload validation (synthetic)
// ---------------------------------------------------------------------------

describe("des bridge pure half (synthetic protocol strings — no engine)", () => {
  test("parseDesAdapterStdout accepts a well-formed payload and returns the DesResult", () => {
    const result = parseDesAdapterStdout(syntheticDesStdout(), "des.py")
    expect(result.engineKey).toBe("synthetic-engine")
    expect(result.engineVersion).toBe("1.2.3")
    expect(result.adapterScript).toBe("des.py")
    expect(result.adapterHash).toBe("a".repeat(64))
    expect(result.policy).toBe("fifo")
    expect(result.makespan).toBe(13)
    expect(result.resources).toEqual([
      { id: "m1", busy: 6, utilization: 6 / 13 },
      { id: "m2", busy: 11, utilization: 11 / 13 },
    ])
    expect(result.jobs).toEqual([
      { id: "j1", startAt: 0, endAt: 6 },
      { id: "j2", startAt: 2, endAt: 8 },
      { id: "j3", startAt: 5, endAt: 13 },
    ])
  })

  test('error envelope {"error": …} surfaces verbatim as EngineUnavailableError', () => {
    expect(() =>
      parseDesAdapterStdout(JSON.stringify({ error: 'jobs[0].tasks[1] references unknown resource "crane"' }), "des.py"),
    ).toThrow('jobs[0].tasks[1] references unknown resource "crane"')
  })

  test("payload validation refuses non-fifo policy, non-positive makespan and malformed rows with honest messages", () => {
    for (const [mutate, expected] of [
      [(p: Record<string, unknown>) => (p.policy = "lifo"), 'payload policy must be "fifo"'],
      [(p: Record<string, unknown>) => (p.makespan = 0), "payload makespan must be a positive finite number"],
      [(p: Record<string, unknown>) => delete p.resources, "missing the resources array"],
      [(p: Record<string, unknown>) => (p.resources = []), "missing the resources array"],
      [
        (p: Record<string, unknown>) => (p.resources = [{ id: "m1", busy: -1, utilization: 0 }]),
        "resources[0].busy must be a number >= 0",
      ],
      [
        (p: Record<string, unknown>) => (p.resources = [{ id: "m1", busy: 1, utilization: Number.NaN }]),
        "resources[0].utilization must be a number >= 0",
      ],
      [(p: Record<string, unknown>) => delete p.jobs, "missing the jobs array"],
      [
        (p: Record<string, unknown>) => (p.jobs = [{ id: "j1", startAt: 5, endAt: 3 }]),
        "jobs[0].endAt must be a number >= startAt",
      ],
    ] as const) {
      const payload = JSON.parse(syntheticDesStdout()) as Record<string, unknown>
      mutate(payload)
      let caught: unknown
      try {
        parseDesAdapterStdout(JSON.stringify(payload), "des.py")
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(EngineUnavailableError)
      expect((caught as Error).message).toContain(expected)
    }
  })

  test("export surface: runDesFromFile / EngineUnavailableError exist with the pinned shapes", () => {
    expect(typeof runDesFromFile).toBe("function")
    const err = new EngineUnavailableError("probe")
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe("EngineUnavailableError")
    expect(err.message).toBe("probe")
  })
})

// ---------------------------------------------------------------------------
// Real engine runs (skipIf simpy is absent, with a printed reason)
// ---------------------------------------------------------------------------

describe.skipIf(!simpyAvailable)("runDesFromFile — SimPy FIFO discrete-event (real engine runs)", () => {
  test(
    "des-flowshop.json: makespan 13 (hand trace), per-resource busy 6/11 pinned, utilization = busy/makespan",
    async () => {
      const result = await runDesFromFile(path.join(fixtures, "des-flowshop.json"))

      expect(result.engineKey).toBe("simpy")
      expect(result.engineVersion).toMatch(/^[0-9]/) // real version string, e.g. 4.1.2
      expect(result.adapterScript).toBe("des.py")
      // adapterHash is SELF-reported — verify it independently (node:crypto)
      expect(result.adapterHash).toBe(sha256Of(path.join(here, "des.py")))

      // ── HAND-DERIVED (the trace in the file header — §7.6): makespan 13,
      // m1 busy 6, m2 busy 11, utilizations 6/13 and 11/13.
      expect(result.policy).toBe("fifo")
      expect(result.makespan).toBe(13)

      expect(result.resources.map((r) => r.id)).toEqual(["m1", "m2"])
      const [m1, m2] = result.resources
      expect(m1.busy).toBe(6)
      expect(m2.busy).toBe(11)
      // utilization = busy / makespan — the §5.3 definition, exact in IEEE
      expect(m1.utilization).toBe(6 / 13)
      expect(m2.utilization).toBe(11 / 13)

      // ── HAND-DERIVED job records (the same trace): startAt = the first
      // task's resource GRANT time, endAt = the last task's completion.
      expect(result.jobs).toEqual([
        { id: "j1", startAt: 0, endAt: 6 },
        { id: "j2", startAt: 2, endAt: 8 },
        { id: "j3", startAt: 5, endAt: 13 },
      ])
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "determinism: two real runs → byte-identical event-record payload (no stochastic distributions, §10)",
    async () => {
      const first = await runDesFromFile(path.join(fixtures, "des-flowshop.json"))
      const second = await runDesFromFile(path.join(fixtures, "des-flowshop.json"))
      expect(desPayloadSignature(second)).toBe(desPayloadSignature(first))
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'des-invalid-resource.json (job naming an absent resource) → the honest refusal envelope des.py emits',
    async () => {
      const err = await expectEngineUnavailable(
        runDesFromFile(path.join(fixtures, "des-invalid-resource.json")),
      )
      // des.py's mirrored-§3.3 defense (powerflow.py style): the job names
      // resource "crane" which is not in resources[] → honest envelope, never
      // a crash and never a simulated schedule.
      expect(err.message).toBe('jobs[0].tasks[1] references unknown resource "crane"')
    },
    TEST_TIMEOUT_MS,
  )
})
