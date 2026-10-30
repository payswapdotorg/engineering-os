import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  EngineUnavailableError,
  parseRtlAdapterStdout,
  runRtlSynthesisFromFile,
  validateRtlParameters,
  type RtlResult,
} from "./chip"

/**
 * Chip bridge tests (Slice 30 — contract §17.5/§17.6).
 *
 * Honesty rules (ADR-0006 — the cfd.test.ts convention): the PURE tests feed
 * SYNTHETIC protocol strings into the bridge's parse/validate half; every
 * number asserted in the REAL-engine tests is a HAND-DERIVED closed form for
 * the enable-counter fixtures (tests/fixtures/rtl-counter-*.json) — never a
 * value copied from amaranth or yosys output.
 *
 * Closed-form derivations (the enable counter: clk, en, count[W] —
 * count <= en ? count + 1 : count):
 *   FF1: a W-bit register carries EXACTLY W storage elements (one per bit).
 *   XOR: W−1 (each upper bit XORs its carry-in); NOT: exactly 1 (constant).
 *   AND (empirical, yosys carry-chain sharing): W=4 → 2, W=8 → 8
 *        (the 2W − 2·log2 W − 2 shape at power-of-two widths).
 *   TRAJECTORY (the frozen 25-cycle stimulus: 18 en, 1 dis, 6 en):
 *     after E enabled cycles count = E mod 2^W — at W=4 the final cycle 25
 *     reads 24 mod 16 = 8 (the WRAP); the disabled cycle 19 HOLDS at
 *     18 mod 16 = 2; at W=8 the final count is 24 (no wrap: 24 < 256).
 *   NETLIST sha256 (W=4): 549bbd3f… — the src-stripped netlist is
 *   cross-host byte-identical (§17.1: three different source paths probed).
 *
 * Real-engine tests run ONLY when amaranth is importable AND the
 * yowasp-yosys entry point is runnable in the venv; otherwise they are
 * skipped with an explicit printed reason.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.resolve(here, "..", "..", "..", "tests", "fixtures")
const PYTHON_BIN = process.env.EOS_PYTHON ?? "/home/z/.venv/bin/python3"

const amaranthAvailable =
  spawnSync(PYTHON_BIN, ["-c", "import amaranth"], { timeout: 60_000 }).status === 0
const yowaspAvailable =
  spawnSync(path.join(path.dirname(PYTHON_BIN), "yowasp-yosys"), ["-V"], { timeout: 120_000 }).status === 0
if (!(amaranthAvailable && yowaspAvailable)) {
  console.log(
    `[chip.test.ts] rtl tests SKIPPED: amaranth importable=${amaranthAvailable}, yowasp-yosys runnable=${yowaspAvailable} (recorded honestly — no results are simulated)`,
  )
}

const TEST_TIMEOUT_MS = 180_000

function sha256Of(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex")
}

/** The frozen 25-step W=4 trajectory (hand-derived modular arithmetic). */
function expectedCountAt(cycle: number, width: number): number {
  // cycles 1..18 enabled, 19 disabled, 20..25 enabled
  const enabled = cycle <= 18 ? cycle : cycle === 19 ? 18 : 18 + (cycle - 19)
  return enabled % 2 ** width
}

/** Synthetic success stdout in the pinned adapter protocol (no engine). */
function syntheticRtlStdout(): string {
  return JSON.stringify({
    engineKey: "synthetic-engine",
    engineVersion: "1.2.3",
    adapterScript: "rtl_synthesize.py",
    adapterHash: "b".repeat(64),
    analysis: "rtl_synthesis",
    device: { kind: "enable_counter", widthBits: 4 },
    rtlil: { sha256: "a".repeat(64), charCount: 1291 },
    netlist: {
      sha256: "549bbd3fc1205712bd044282ca09da9360f2149e5c319f70f38015daf3548dd4",
      charCount: 6582,
      totalCells: 10,
      flipFlopCount: 4,
      cellHistogram: { $_AND_: 2, $_NOT_: 1, $_SDFFE_PP0P_: 4, $_XOR_: 3 },
    },
    synthesis: {
      engineKey: "yowasp-yosys",
      engineVersion: "0.70.0.0.post1259",
      script: "hierarchy -top top; proc; opt; memory; techmap; opt; attrmap -remove src; attrmap -modattr -remove src",
    },
    simulation: {
      engine: "amaranth.sim (pysim)",
      pattern: "18 enabled, 1 disabled, 6 enabled (25 cycles)",
      steps: Array.from({ length: 25 }, (_, i) => ({
        cycle: i + 1,
        enabled: i + 1 === 19 ? 0 : 1,
        count: expectedCountAt(i + 1, 4),
      })),
    },
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

/** The result minus the run-specific tails (determinism comparator). */
function rtlPayloadSignature(result: RtlResult): string {
  const { stdoutTail: _s, stderrTail: _e, ...payload } = result
  return JSON.stringify(payload)
}

// ---------------------------------------------------------------------------
// Pure half (synthetic protocol strings — no engine)
// ---------------------------------------------------------------------------

describe("chip bridge pure half (synthetic protocol strings — no engine)", () => {
  test("parseRtlAdapterStdout accepts a well-formed payload and returns the RtlResult", () => {
    const result = parseRtlAdapterStdout(syntheticRtlStdout(), "rtl_synthesize.py")
    expect(result.engineKey).toBe("synthetic-engine")
    expect(result.engineVersion).toBe("1.2.3")
    expect(result.adapterScript).toBe("rtl_synthesize.py")
    expect(result.adapterHash).toBe("b".repeat(64))
    expect(result.analysis).toBe("rtl_synthesis")
    expect(result.device.kind).toBe("enable_counter")
    expect(result.device.widthBits).toBe(4)
    expect(result.netlist.totalCells).toBe(10)
    expect(result.netlist.flipFlopCount).toBe(4)
    expect(result.netlist.cellHistogram).toEqual({ $_AND_: 2, $_NOT_: 1, $_SDFFE_PP0P_: 4, $_XOR_: 3 })
    expect(result.synthesis.engineKey).toBe("yowasp-yosys")
    expect(result.synthesis.script).toContain("attrmap -modattr -remove src")
    expect(result.simulation.steps).toHaveLength(25)
    // the hand-derived W=4 trajectory: wrap at the end, hold at cycle 19
    expect(result.simulation.steps[18]).toEqual({ cycle: 19, enabled: 0, count: 2 })
    expect(result.simulation.steps[24]).toEqual({ cycle: 25, enabled: 1, count: 8 })
  })

  test('error envelope {"error": …} surfaces verbatim as EngineUnavailableError', () => {
    const stdout = JSON.stringify({
      error: "the synthesized netlist carries 3 flip-flops for a 4-bit register (expected exactly 4) - the netlist does not implement the device, and a wrong netlist is not an option",
    })
    expect(() => parseRtlAdapterStdout(stdout, "rtl_synthesize.py")).toThrow(EngineUnavailableError)
    try {
      parseRtlAdapterStdout(stdout, "rtl_synthesize.py")
    } catch (err) {
      expect((err as EngineUnavailableError).message).toContain(
        "the synthesized netlist carries 3 flip-flops",
      )
    }
  })

  test("payload validation refuses malformed shapes with honest messages", () => {
    const wellFormed = JSON.parse(syntheticRtlStdout()) as Record<string, unknown>

    const wrongAnalysis = { ...wellFormed, analysis: "rtl_simulation" }
    expect(() => parseRtlAdapterStdout(JSON.stringify(wrongAnalysis), "rtl_synthesize.py")).toThrow(
      'must carry analysis: "rtl_synthesis"',
    )

    const wrongDevice = { ...wellFormed, device: { kind: "alu", widthBits: 4 } }
    expect(() => parseRtlAdapterStdout(JSON.stringify(wrongDevice), "rtl_synthesize.py")).toThrow(
      'must carry device {kind: "enable_counter", widthBits}',
    )

    const widthOutOfRange = { ...wellFormed, device: { kind: "enable_counter", widthBits: 65 } }
    expect(() => parseRtlAdapterStdout(JSON.stringify(widthOutOfRange), "rtl_synthesize.py")).toThrow(
      "device.widthBits must be an integer between 1 and 64",
    )

    const badHistogramCount = {
      ...wellFormed,
      netlist: { ...(wellFormed.netlist as object), cellHistogram: { $_AND_: 0 } },
    }
    expect(() => parseRtlAdapterStdout(JSON.stringify(badHistogramCount), "rtl_synthesize.py")).toThrow(
      'netlist.cellHistogram["$_AND_"] must be a positive integer',
    )

    const wrongSynthesisEngine = {
      ...wellFormed,
      synthesis: { engineKey: "some-other-yosys", engineVersion: "1", script: "x" },
    }
    expect(() => parseRtlAdapterStdout(JSON.stringify(wrongSynthesisEngine), "rtl_synthesize.py")).toThrow(
      'synthesis {engineKey: "yowasp-yosys", engineVersion, script}',
    )

    const twentyFourSteps = {
      ...wellFormed,
      simulation: {
        ...(wellFormed.simulation as object),
        steps: (wellFormed.simulation as { steps: unknown[] }).steps.slice(0, 24),
      },
    }
    expect(() => parseRtlAdapterStdout(JSON.stringify(twentyFourSteps), "rtl_synthesize.py")).toThrow(
      "simulation {engine, pattern, steps[25]}",
    )

    const nonIntegerCount = {
      ...wellFormed,
      simulation: {
        ...(wellFormed.simulation as object),
        steps: [
          ...((wellFormed.simulation as { steps: unknown[] }).steps.slice(0, 24) as unknown[]),
          { cycle: 25, enabled: 1, count: 8.5 },
        ],
      },
    }
    expect(() => parseRtlAdapterStdout(JSON.stringify(nonIntegerCount), "rtl_synthesize.py")).toThrow(
      "simulation.steps[24].count must be an integer",
    )
  })

  test("validateRtlParameters: {} accepted; ANY parameter refused (the frozen script)", () => {
    expect(validateRtlParameters({})).toEqual({})
    expect(() => validateRtlParameters({ meshRefinement: 4 })).toThrow(
      "synthesize_rtl takes no parameters (the synthesis script is frozen)",
    )
    expect(() => validateRtlParameters({ anything: true })).toThrow(
      "synthesize_rtl takes no parameters (the synthesis script is frozen)",
    )
  })

  test("export surface: runRtlSynthesisFromFile / EngineUnavailableError exist with the pinned shapes", () => {
    expect(typeof runRtlSynthesisFromFile).toBe("function")
    expect(typeof EngineUnavailableError).toBe("function")
  })
})

// ---------------------------------------------------------------------------
// Real-engine half (amaranth + yowasp-yosys; skipped honestly when absent)
// ---------------------------------------------------------------------------

describe.skipIf(!(amaranthAvailable && yowaspAvailable))(
  "runRtlSynthesisFromFile — amaranth + yowasp-yosys RTL synthesis (real engine runs)",
  () => {
    test(
      "rtl-counter-4bit.json: FF == 4 (the closed form), the exact Slice-28 histogram, the wrap/hold trajectory, the cross-host netlist sha",
      async () => {
        const result = await runRtlSynthesisFromFile(path.join(fixtures, "rtl-counter-4bit.json"), {})

        expect(result.engineKey).toBe("amaranth")
        expect(result.engineVersion).toBe("0.5.10")
        expect(result.adapterScript).toBe("rtl_synthesize.py")
        // adapterHash is SELF-reported — verify it independently (node:crypto)
        expect(result.adapterHash).toBe(sha256Of(path.join(here, "rtl_synthesize.py")))

        expect(result.analysis).toBe("rtl_synthesis")
        expect(result.device.kind).toBe("enable_counter")
        expect(result.device.widthBits).toBe(4)

        // ── CLOSED FORMS (hand-derived; see the file header) ─────────────────
        expect(result.netlist.flipFlopCount).toBe(4)
        expect(result.netlist.totalCells).toBe(10)
        expect(result.netlist.cellHistogram).toEqual({
          $_AND_: 2,
          $_NOT_: 1,
          $_SDFFE_PP0P_: 4,
          $_XOR_: 3,
        })
        expect(result.synthesis.engineKey).toBe("yowasp-yosys")
        expect(result.synthesis.engineVersion).toBe("0.70.0.0.post1259")
        // the src-stripped netlist: cross-host byte-identical (§17.1)
        expect(result.netlist.sha256).toBe(
          "549bbd3fc1205712bd044282ca09da9360f2149e5c319f70f38015daf3548dd4",
        )

        // the 25-step trajectory == modular arithmetic, every step
        expect(result.simulation.steps).toHaveLength(25)
        for (const step of result.simulation.steps) {
          expect(step.count).toBe(expectedCountAt(step.cycle, 4))
        }
        expect(result.simulation.steps[18].enabled).toBe(0) // the disabled cycle
      },
      TEST_TIMEOUT_MS,
    )

    test(
      "rtl-counter-8bit.json: FF == 8, the non-wrapping regime (final count 24 < 256), histogram exact",
      async () => {
        const result = await runRtlSynthesisFromFile(path.join(fixtures, "rtl-counter-8bit.json"), {})
        expect(result.device.widthBits).toBe(8)
        expect(result.netlist.flipFlopCount).toBe(8)
        expect(result.netlist.totalCells).toBe(24)
        expect(result.netlist.cellHistogram).toEqual({
          $_AND_: 8,
          $_NOT_: 1,
          $_SDFFE_PP0P_: 8,
          $_XOR_: 7,
        })
        for (const step of result.simulation.steps) {
          expect(step.count).toBe(expectedCountAt(step.cycle, 8))
        }
        expect(result.simulation.steps[24].count).toBe(24) // no wrap at W=8
      },
      TEST_TIMEOUT_MS,
    )

    test(
      "determinism: two real runs → byte-identical result payload (pinned engines, frozen script)",
      async () => {
        const first = await runRtlSynthesisFromFile(path.join(fixtures, "rtl-counter-4bit.json"), {})
        const second = await runRtlSynthesisFromFile(path.join(fixtures, "rtl-counter-4bit.json"), {})
        expect(rtlPayloadSignature(second)).toBe(rtlPayloadSignature(first))
      },
      TEST_TIMEOUT_MS,
    )

    test(
      "rtl-invalid-kind.json (device.kind alu) → the §17.2 v1-class refusal verbatim",
      async () => {
        const err = await expectEngineUnavailable(
          runRtlSynthesisFromFile(path.join(fixtures, "rtl-invalid-kind.json"), {}),
        )
        expect(err.message).toContain('rtl model device.kind must be "enable_counter"')
      },
      TEST_TIMEOUT_MS,
    )

    test(
      "rtl-bad-width.json (widthBits 65) → the §17.2 range refusal verbatim",
      async () => {
        const err = await expectEngineUnavailable(
          runRtlSynthesisFromFile(path.join(fixtures, "rtl-bad-width.json"), {}),
        )
        expect(err.message).toContain("rtl model device.widthBits must be an integer between 1 and 64")
      },
      TEST_TIMEOUT_MS,
    )

    test(
      "a non-empty parameter set → the frozen-script refusal (never silently ignored)",
      async () => {
        const err = await expectEngineUnavailable(
          runRtlSynthesisFromFile(path.join(fixtures, "rtl-counter-4bit.json"), { meshRefinement: 4 }),
        )
        expect(err.message).toBe("synthesize_rtl takes no parameters (the synthesis script is frozen)")
      },
      TEST_TIMEOUT_MS,
    )

    test(
      "non-JSON file path (site-notes.md) → the bridge's honest parse error, never a fabricated result",
      async () => {
        const err = await expectEngineUnavailable(
          runRtlSynthesisFromFile(path.join(fixtures, "site-notes.md"), {}),
        )
        expect(err.message).toContain("rtl model file is not valid JSON")
      },
      TEST_TIMEOUT_MS,
    )
  },
)
