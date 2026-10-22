import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  EngineUnavailableError,
  parsePowerflowAdapterStdout,
  runPowerflowFromFile,
  type PowerflowResult,
} from "./powerflow"

/**
 * Power-flow bridge tests (W2-f completion, Phase 5 — contract §5.2/§7.4-5).
 *
 * Honesty rules (ADR-0006 — the mesh.test.ts convention): the PURE tests feed
 * SYNTHETIC protocol strings into the bridge's parse/validate half; every
 * number asserted in the REAL-engine tests is a HAND-DERIVED closed form for
 * the lossless two-bus feeder (contract §7.4) — never a value copied from
 * pandapower's output.
 *
 * Closed-form derivation (2-bus lossless, tests/fixtures/powerflow-2bus.json):
 *   baseMva = 100, buses 20 kV → baseZ = 20²/100 = 4 Ω
 *   line: r = 0, x = 0.1 Ω/km × 10 km = 1 Ω → x = 1/4 = 0.25 pu
 *   load: P = 2 MW → p = P/baseMva = 0.02 pu, Q = 0
 *   Series-reactance two-bus model, V₁ = 1∠0 (slack), V₂ = v∠δ (PQ):
 *     P₂ = v·sin(−δ)/x, Q₂ = (v² − v·cos δ)/x   → with Q_load = 0:
 *     cos δ = v and p·x = v·√(1−v²)  →  v⁴ − v² + p²x² = 0
 *     HIGH branch: v = √((1 + √(1−4p²x²))/2)   (the §7.4 pinned formula)
 *     angle: δ = −arccos(v) (degrees: ×180/π)   [load draws lagging current]
 *     |I| = p/v pu; I_base = baseMva/(√3·20 kV) = 2.8867513459 kA
 *     line losses: P = 0 (r = 0); Q = |I|²·x·baseMva
 *   pandapower res_bus sign convention: p_mw/q_mvar are DEMAND-positive
 *   (slack supplying the network reads negative) — verified live 2026-10-22.
 *
 * Real-engine tests run ONLY when pandapower is genuinely importable in the
 * venv; otherwise they are skipped with an explicit printed reason.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.resolve(here, "..", "..", "..", "tests", "fixtures")
const PYTHON_BIN = process.env.EOS_PYTHON ?? "/home/z/.venv/bin/python3"

const pandapowerAvailable =
  spawnSync(PYTHON_BIN, ["-c", "import pandapower"], { timeout: 60_000 }).status === 0
if (!pandapowerAvailable) {
  console.log(
    `[powerflow.test.ts] power-flow tests SKIPPED: pandapower is not importable in ${PYTHON_BIN} (recorded honestly — no results are simulated)`,
  )
}

const TEST_TIMEOUT_MS = 180_000

function sha256Of(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex")
}

/** Synthetic success stdout in the pinned adapter protocol (no engine). */
function syntheticPowerflowStdout(): string {
  return JSON.stringify({
    engineKey: "synthetic-engine",
    engineVersion: "1.2.3",
    adapterScript: "powerflow.py",
    adapterHash: "a".repeat(64),
    converged: true,
    buses: [{ id: "bus-1", vmPu: 1.0, angleDeg: 0.0, pMw: -2.0, qMvar: -0.01 }],
    lines: [{ fromBus: "bus-1", toBus: "bus-2", iKa: 0.05, pLossMw: 0.0, qLossMvar: 0.01 }],
    totals: { lossMw: 0.0, loadMw: 2.0 },
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

/** Determinism signature: the result-frame payload (what the broker assembles
 * into the stored eos-powerflow/1 document); subprocess tails are evidence. */
function powerflowPayloadSignature(r: PowerflowResult): string {
  return JSON.stringify({
    engineKey: r.engineKey,
    engineVersion: r.engineVersion,
    adapterScript: r.adapterScript,
    adapterHash: r.adapterHash,
    converged: r.converged,
    buses: r.buses,
    lines: r.lines,
    totals: r.totals,
  })
}

// The hand-derived closed forms (constants computed from the formulas above).
const P_MW = 2
const BASE_MVA = 100
const VN_KV = 20
const P_PU = P_MW / BASE_MVA
const X_PU = (0.1 * 10) / ((VN_KV * VN_KV) / BASE_MVA)
const V2_CLOSED_FORM = Math.sqrt((1 + Math.sqrt(1 - 4 * P_PU * P_PU * X_PU * X_PU)) / 2)
const ANGLE2_CLOSED_FORM = (-Math.acos(V2_CLOSED_FORM) * 180) / Math.PI
const I_PU = P_PU / V2_CLOSED_FORM
const I_BASE_KA = BASE_MVA / (Math.sqrt(3) * VN_KV)
const I_KA_CLOSED_FORM = I_PU * I_BASE_KA
const Q_LOSS_CLOSED_FORM = I_PU * I_PU * X_PU * BASE_MVA

// ---------------------------------------------------------------------------
// Pure half of the bridge: protocol parsing + payload validation (synthetic)
// ---------------------------------------------------------------------------

describe("powerflow bridge pure half (synthetic protocol strings — no engine)", () => {
  test("parsePowerflowAdapterStdout accepts a well-formed payload and returns the PowerflowResult", () => {
    const result = parsePowerflowAdapterStdout(syntheticPowerflowStdout(), "powerflow.py")
    expect(result.engineKey).toBe("synthetic-engine")
    expect(result.engineVersion).toBe("1.2.3")
    expect(result.adapterScript).toBe("powerflow.py")
    expect(result.adapterHash).toBe("a".repeat(64))
    expect(result.converged).toBe(true)
    expect(result.buses).toEqual([{ id: "bus-1", vmPu: 1.0, angleDeg: 0.0, pMw: -2.0, qMvar: -0.01 }])
    expect(result.lines).toEqual([{ fromBus: "bus-1", toBus: "bus-2", iKa: 0.05, pLossMw: 0.0, qLossMvar: 0.01 }])
    expect(result.totals).toEqual({ lossMw: 0.0, loadMw: 2.0 })
  })

  test('error envelope {"error": …} surfaces verbatim as EngineUnavailableError', () => {
    expect(() =>
      parsePowerflowAdapterStdout(
        JSON.stringify({ error: "power flow did not converge (newton-raphson exhausted)" }),
        "powerflow.py",
      ),
    ).toThrow("power flow did not converge (newton-raphson exhausted)")
  })

  test("non-convergence must NEVER travel as a success payload: converged !== true is refused", () => {
    const payload = JSON.parse(syntheticPowerflowStdout()) as Record<string, unknown>
    payload.converged = false
    let caught: unknown
    try {
      parsePowerflowAdapterStdout(JSON.stringify(payload), "powerflow.py")
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(EngineUnavailableError)
    expect((caught as Error).message).toContain("payload must carry converged: true")
  })

  test("payload validation refuses malformed buses/lines/totals with honest messages", () => {
    for (const [mutate, expected] of [
      [(p: Record<string, unknown>) => delete p.buses, "missing the buses array"],
      [(p: Record<string, unknown>) => (p.buses = []), "missing the buses array"],
      [(p: Record<string, unknown>) => (p.buses = [{ id: "", vmPu: 1, angleDeg: 0, pMw: 0, qMvar: 0 }]), "has no id"],
      [
        (p: Record<string, unknown>) => (p.buses = [{ id: "b", vmPu: Number.NaN, angleDeg: 0, pMw: 0, qMvar: 0 }]),
        "buses[0].vmPu must be a finite number (verbatim result frame)",
      ],
      [(p: Record<string, unknown>) => delete p.lines, "missing the lines array"],
      [
        (p: Record<string, unknown>) => (p.lines = [{ fromBus: "a", toBus: "b", iKa: "0.05", pLossMw: 0, qLossMvar: 0 }]),
        "lines[0].iKa must be a finite number (verbatim result frame)",
      ],
      [(p: Record<string, unknown>) => delete p.totals, "missing totals {lossMw, loadMw}"],
      [(p: Record<string, unknown>) => (p.totals = { lossMw: 0 }), "missing totals {lossMw, loadMw}"],
    ] as const) {
      const payload = JSON.parse(syntheticPowerflowStdout()) as Record<string, unknown>
      mutate(payload)
      let caught: unknown
      try {
        parsePowerflowAdapterStdout(JSON.stringify(payload), "powerflow.py")
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(EngineUnavailableError)
      expect((caught as Error).message).toContain(expected)
    }
  })

  test("export surface: runPowerflowFromFile / EngineUnavailableError exist with the pinned shapes", () => {
    expect(typeof runPowerflowFromFile).toBe("function")
    const err = new EngineUnavailableError("probe")
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe("EngineUnavailableError")
    expect(err.message).toBe("probe")
  })
})

// ---------------------------------------------------------------------------
// Real engine runs (skipIf pandapower is absent, with a printed reason)
// ---------------------------------------------------------------------------

describe.skipIf(!pandapowerAvailable)("runPowerflowFromFile — pandapower Newton-Raphson (real engine runs)", () => {
  test(
    "powerflow-2bus.json: V₂ matches the closed form at rel ≤ 1e-6, angle symmetric, losses ≈ 0 at 1e-9, converged true",
    async () => {
      const result = await runPowerflowFromFile(path.join(fixtures, "powerflow-2bus.json"))

      expect(result.engineKey).toBe("pandapower")
      expect(result.engineVersion).toMatch(/^[0-9]/) // real version string, e.g. 3.5.6
      expect(result.adapterScript).toBe("powerflow.py")
      // adapterHash is SELF-reported — verify it independently (node:crypto)
      expect(result.adapterHash).toBe(sha256Of(path.join(here, "powerflow.py")))

      expect(result.converged).toBe(true)
      expect(result.buses.map((b) => b.id)).toEqual(["bus-1", "bus-2"])
      const [bus1, bus2] = result.buses

      // ── CLOSED FORMS (hand-derived; see the file header) ─────────────────
      // slack bus: the ext-grid set point is honoured exactly by the solver
      expect(Math.abs(bus1.vmPu - 1.0)).toBeLessThanOrEqual(1e-9)
      expect(Math.abs(bus1.angleDeg - 0.0)).toBeLessThanOrEqual(1e-9)
      // V₂ high branch (§7.4): rel ≤ 1e-6 (NR solver tolerance dominates,
      // not IEEE rounding — the pin is honest about that)
      expect(Math.abs(bus2.vmPu - V2_CLOSED_FORM) / V2_CLOSED_FORM).toBeLessThanOrEqual(1e-6)
      // δ₂ = −arccos(V₂) — the load's lagging angle, checked symmetric
      expect(Math.abs(bus2.angleDeg - ANGLE2_CLOSED_FORM)).toBeLessThanOrEqual(1e-6)
      // demand-sign convention: slack supplies −(P + lossP), load bus reads +P
      expect(Math.abs(bus1.pMw - -(P_MW + 0))).toBeLessThanOrEqual(1e-9)
      expect(Math.abs(bus2.pMw - P_MW)).toBeLessThanOrEqual(1e-9)
      expect(Math.abs(bus2.qMvar - 0.0)).toBeLessThanOrEqual(1e-9)
      // slack sources the line's reactive consumption: −qLoss (closed form)
      expect(Math.abs(bus1.qMvar - -Q_LOSS_CLOSED_FORM) / Q_LOSS_CLOSED_FORM).toBeLessThanOrEqual(1e-6)

      // line: |I| = p/v pu → kA via I_base; P loss = 0 (r = 0); Q loss = I²x
      expect(result.lines).toHaveLength(1)
      const line = result.lines[0]
      expect(line.fromBus).toBe("bus-1")
      expect(line.toBus).toBe("bus-2")
      expect(Math.abs(line.iKa - I_KA_CLOSED_FORM) / I_KA_CLOSED_FORM).toBeLessThanOrEqual(1e-6)
      expect(Math.abs(line.pLossMw - 0.0)).toBeLessThanOrEqual(1e-9)
      expect(Math.abs(line.qLossMvar - Q_LOSS_CLOSED_FORM) / Q_LOSS_CLOSED_FORM).toBeLessThanOrEqual(1e-6)

      // totals: loss ≈ 0 pinned at 1e-9 (§7.4), load = 2.0 MW
      expect(Math.abs(result.totals.lossMw - 0.0)).toBeLessThanOrEqual(1e-9)
      expect(Math.abs(result.totals.loadMw - P_MW)).toBeLessThanOrEqual(1e-9)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "determinism: two real runs → byte-identical result-frame payload (every numeric verbatim from the engine)",
    async () => {
      const first = await runPowerflowFromFile(path.join(fixtures, "powerflow-2bus.json"))
      const second = await runPowerflowFromFile(path.join(fixtures, "powerflow-2bus.json"))
      expect(powerflowPayloadSignature(second)).toBe(powerflowPayloadSignature(first))
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "powerflow-islanded.json (load on a bus with no path to the ext grid) → the honest islanded refusal",
    async () => {
      const err = await expectEngineUnavailable(
        runPowerflowFromFile(path.join(fixtures, "powerflow-islanded.json")),
      )
      // powerflow.py refuses to emit NaN results for the island (observed
      // live: pandapower 3.5.6 converges and reports NaN for the isolated bus)
      expect(err.message).toBe(
        "power flow did not produce results for all buses (islanded network - " +
          "buses with no path to the external grid: bus-3) - " +
          "results are not available, and simulated results are not an option",
      )
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "non-JSON file path (site-notes.md) → the bridge's honest parse error, never a fabricated result",
    async () => {
      const err = await expectEngineUnavailable(
        runPowerflowFromFile(path.join(fixtures, "site-notes.md")),
      )
      expect(err.message).toContain("network file is not valid JSON")
    },
    TEST_TIMEOUT_MS,
  )
})
