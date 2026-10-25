import { describe, expect, test } from "bun:test"

import {
  EngineUnavailableError,
  parseParametricBuildStdout,
  parseParametricSchemaStdout,
  resolveParametricParams,
} from "./parametric_rebuild"

/**
 * Parametric-rebuild bridge tests (Lane 16-P, Slice 15 — cadquery).
 *
 * Honesty rules (ADR-0006 — the sheet_takeoff.test.ts convention): these are
 * the PURE tests only — they feed SYNTHETIC protocol strings into the
 * bridge's parse/validate half and pin the parameter-policy mirror; NO
 * engine is ever spawned here (the real-engine runs live in the validation
 * harness, `bun run validate:engines`, which drives the committed fixture
 * through the real bridge with hand-derived analytic pins).
 *
 * `resolveParametricParams` is the TS-side MIRROR of the python adapter's
 * validate_params; the refusal messages asserted here are the adapter's
 * pinned verbatim shapes (verified against the live adapter on the
 * cadquery 2.6.1 venv during this lane). The schema literal below is
 * hand-copied from tests/fixtures/parametric-bracket.py — the committed
 * parametric model fixture.
 */

// hand-copied from tests/fixtures/parametric-bracket.py (PARAM_SCHEMA)
const BRACKET_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    width: { type: "number", minimum: 20, maximum: 300, default: 80, unit: "mm", label: "Overall width (X)" },
    depth: { type: "number", minimum: 20, maximum: 200, default: 50, unit: "mm", label: "Base depth (Y)" },
    thickness: { type: "number", minimum: 2, maximum: 40, default: 8, unit: "mm", label: "Plate thickness" },
    height: { type: "number", minimum: 20, maximum: 300, default: 60, unit: "mm", label: "Overall height (Z)" },
    holeDia: { type: "number", minimum: 0, maximum: 60, default: 10, unit: "mm", label: "Lifting hole diameter" },
  },
  required: ["width", "depth", "thickness", "height", "holeDia"],
  additionalProperties: false,
}

// hand-copied from tests/fixtures/parametric-bracket.py (DEFAULT_PARAMS)
const BRACKET_DEFAULTS: Record<string, number> = {
  width: 80,
  depth: 50,
  thickness: 8,
  height: 60,
  holeDia: 10,
}

function resolve(raw: Record<string, unknown>) {
  return resolveParametricParams(BRACKET_SCHEMA, raw)
}

// ---------------------------------------------------------------------------
// resolveParametricParams — the mirror validation (pure)
// ---------------------------------------------------------------------------

describe("resolveParametricParams (pure — no engine)", () => {
  test("empty edits merge to the model's authored defaults", () => {
    const r = resolve({})
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual(BRACKET_DEFAULTS)
  })

  test("partial edits merge over defaults (the 16-R3 partial-fill case)", () => {
    const r = resolve({ width: 100, holeDia: 12 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toEqual({ width: 100, depth: 50, thickness: 8, height: 60, holeDia: 12 })
    }
  })

  test("full override passes the edited values through verbatim (the RUN B parameter set)", () => {
    const edited = { width: 120, depth: 60, thickness: 10, height: 80, holeDia: 16 }
    const r = resolve(edited)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual(edited)
  })

  test("unknown key → the adapter's verbatim refusal shape (sorted list)", () => {
    const r = resolve({ bogus: 1 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toBe("unknown parameter(s) rejected: ['bogus']")
    const r2 = resolve({ zeta: 1, alpha: 2 })
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.message).toBe("unknown parameter(s) rejected: ['alpha', 'zeta']")
  })

  test("below minimum → the adapter's verbatim range refusal", () => {
    const r = resolve({ width: 10 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toBe("parameter 'width' = 10 below minimum 20")
  })

  test("above maximum → the adapter's verbatim range refusal", () => {
    const r = resolve({ width: 400 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toBe("parameter 'width' = 400 above maximum 300")
    const r2 = resolve({ holeDia: 99 })
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.message).toBe("parameter 'holeDia' = 99 above maximum 60")
  })

  test("wrong types → the adapter's verbatim type refusal (python json-world type names)", () => {
    for (const [bad, typeName] of [
      ["80", "str"],
      [true, "bool"],
      [null, "NoneType"],
      [{}, "dict"],
      [[], "list"],
    ] as const) {
      const r = resolve({ width: bad as unknown as number })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.message).toBe(`parameter 'width' must be a number, got ${typeName}`)
    }
  })

  test("non-finite numbers are refused (NaN/Infinity never pass a range check)", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const r = resolve({ width: bad })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.message).toContain("parameter 'width' must be a finite number, got")
    }
  })

  test("violations are reported in schema property order (the first violated key wins)", () => {
    const r = resolve({ width: 10, depth: 5 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toBe("parameter 'width' = 10 below minimum 20")
  })

  test("a required parameter without a default must be provided", () => {
    const schema: Record<string, unknown> = {
      type: "object",
      properties: { width: { type: "number", minimum: 20, maximum: 300 } },
      required: ["width"],
      additionalProperties: false,
    }
    const r = resolveParametricParams(schema, {})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toBe("missing required parameter: width")
  })

  test("malformed schemas are refused honestly (never partially trusted)", () => {
    const notObject = resolveParametricParams({ type: "string" } as Record<string, unknown>, {})
    expect(notObject.ok).toBe(false)
    if (!notObject.ok) expect(notObject.message).toContain('must be an object schema')
    const noProps = resolveParametricParams({ type: "object" }, {})
    expect(noProps.ok).toBe(false)
    if (!noProps.ok) expect(noProps.message).toContain("declares no properties")
    const badSpec = resolveParametricParams(
      { type: "object", properties: { width: "number" } } as Record<string, unknown>,
      {},
    )
    expect(badSpec.ok).toBe(false)
    if (!badSpec.ok) expect(badSpec.message).toContain("property 'width' must be a number spec")
  })

  test("non-object parameter values are refused with the adapter's shape", () => {
    const r = resolveParametricParams(BRACKET_SCHEMA, null as unknown as Record<string, unknown>)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toBe("parameter values must be a JSON object")
  })
})

// ---------------------------------------------------------------------------
// Adapter stdout protocol parsing (pure — synthetic protocol strings)
// ---------------------------------------------------------------------------

/** Synthetic schema-mode stdout in the pinned adapter protocol (no engine). */
function syntheticSchemaStdout(): string {
  return JSON.stringify({
    engineKey: "cadquery",
    engineVersion: "9.9.9",
    adapterScript: "parametric_rebuild.py",
    adapterHash: "d".repeat(64),
    modelScriptHash: "e".repeat(64),
    schema: BRACKET_SCHEMA,
    defaults: BRACKET_DEFAULTS,
  })
}

/** Synthetic build-mode stdout in the pinned adapter protocol (no engine). */
function syntheticBuildStdout(): string {
  return JSON.stringify({
    engineKey: "cadquery",
    engineVersion: "9.9.9",
    adapterScript: "parametric_rebuild.py",
    adapterHash: "d".repeat(64),
    modelScriptHash: "e".repeat(64),
    paramsUsed: BRACKET_DEFAULTS,
    volumeMm3: 64651.68146928197,
    areaMm2: 19326.247779607707,
    bboxMm: [80, 50, 60],
    centerOfMassMm: [40, 35.6, 19.2],
    checks: { volumeRelErr: 1.1254e-15, passed: true },
  })
}

describe("parametric adapter stdout protocol parsing (pure — synthetic strings)", () => {
  test("parseParametricSchemaStdout accepts a well-formed payload and returns the ParametricSchemaResult", () => {
    const result = parseParametricSchemaStdout(syntheticSchemaStdout(), "parametric_rebuild.py")
    expect(result.engineKey).toBe("cadquery")
    expect(result.engineVersion).toBe("9.9.9")
    expect(result.adapterScript).toBe("parametric_rebuild.py")
    expect(result.adapterHash).toBe("d".repeat(64))
    expect(result.modelScriptHash).toBe("e".repeat(64))
    expect(result.schema).toEqual(BRACKET_SCHEMA)
    expect(result.defaults).toEqual(BRACKET_DEFAULTS)
  })

  test('error envelope {"error": …} surfaces verbatim as EngineUnavailableError', () => {
    expect(() =>
      parseParametricSchemaStdout(
        JSON.stringify({ error: "hole does not fit inside the vertical leg — raise height or shrink holeDia" }),
        "parametric_rebuild.py",
      ),
    ).toThrow("hole does not fit inside the vertical leg")
    expect(() =>
      parseParametricBuildStdout(JSON.stringify({ error: "parameter 'width' = 10 below minimum 20" }), "parametric_rebuild.py"),
    ).toThrow("parameter 'width' = 10 below minimum 20")
  })

  test("non-JSON stdout is refused honestly", () => {
    expect(() => parseParametricSchemaStdout("OCCT chatter, not JSON", "parametric_rebuild.py")).toThrow(
      "stdout is not valid JSON",
    )
  })

  test("schema payload validation refuses missing/malformed fields (incl. wrong engineKey)", () => {
    for (const [mutate, expected] of [
      [(p: Record<string, unknown>) => delete p.schema, "missing the model schema"],
      [(p: Record<string, unknown>) => (p.schema = { type: "string" }), "missing the model schema"],
      [(p: Record<string, unknown>) => delete p.defaults, "missing defaults"],
      [(p: Record<string, unknown>) => (p.defaults = { width: "80" }), "missing defaults"],
      [(p: Record<string, unknown>) => (p.defaults = {}), "missing defaults"],
      [(p: Record<string, unknown>) => delete p.modelScriptHash, "missing modelScriptHash"],
      [(p: Record<string, unknown>) => (p.adapterHash = "nothex"), "malformed adapterHash"],
      [(p: Record<string, unknown>) => (p.engineKey = "freecad"), 'expected "cadquery"'],
    ] as const) {
      const payload = JSON.parse(syntheticSchemaStdout()) as Record<string, unknown>
      mutate(payload)
      let caught: unknown
      try {
        parseParametricSchemaStdout(JSON.stringify(payload), "parametric_rebuild.py")
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(EngineUnavailableError)
      expect((caught as Error).message).toContain(expected)
    }
  })

  test("parseParametricBuildStdout accepts a well-formed payload and returns the build result (sans stepBytes)", () => {
    const result = parseParametricBuildStdout(syntheticBuildStdout(), "parametric_rebuild.py")
    expect(result.engineKey).toBe("cadquery")
    expect(result.paramsUsed).toEqual(BRACKET_DEFAULTS)
    expect(result.volumeMm3).toBe(64651.68146928197)
    expect(result.areaMm2).toBe(19326.247779607707)
    expect(result.bboxMm).toEqual([80, 50, 60])
    expect(result.centerOfMassMm).toEqual([40, 35.6, 19.2])
    expect(result.checks).toEqual({ volumeRelErr: 1.1254e-15, passed: true })
  })

  test("build payload validation refuses missing/malformed fields — a failed ground-truth gate never parses", () => {
    for (const [mutate, expected] of [
      [(p: Record<string, unknown>) => delete p.paramsUsed, "missing paramsUsed"],
      [(p: Record<string, unknown>) => (p.paramsUsed = { width: "80" }), "missing paramsUsed"],
      [(p: Record<string, unknown>) => delete p.volumeMm3, "missing volumeMm3"],
      [(p: Record<string, unknown>) => (p.volumeMm3 = -1), "missing volumeMm3"],
      [(p: Record<string, unknown>) => delete p.areaMm2, "missing areaMm2"],
      [(p: Record<string, unknown>) => (p.bboxMm = [80, 50]), "missing bboxMm"],
      [(p: Record<string, unknown>) => (p.bboxMm = [80, 50, 0]), "missing bboxMm"],
      [(p: Record<string, unknown>) => (p.centerOfMassMm = [40, 35.6]), "missing centerOfMassMm"],
      [(p: Record<string, unknown>) => delete p.checks, "missing checks"],
      [(p: Record<string, unknown>) => (p.checks = { volumeRelErr: 0.8, passed: true }), "dishonest envelope"],
      [(p: Record<string, unknown>) => (p.checks = { volumeRelErr: 1e-15, passed: false }), "missing checks"],
      [(p: Record<string, unknown>) => (p.engineKey = "blender"), 'expected "cadquery"'],
    ] as const) {
      const payload = JSON.parse(syntheticBuildStdout()) as Record<string, unknown>
      mutate(payload)
      let caught: unknown
      try {
        parseParametricBuildStdout(JSON.stringify(payload), "parametric_rebuild.py")
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(EngineUnavailableError)
      expect((caught as Error).message).toContain(expected)
    }
  })
})

// ---------------------------------------------------------------------------
// Exported surface (the frozen 16-P bridge contract the TL's broker imports)
// ---------------------------------------------------------------------------

describe("parametric rebuild bridge export surface (frozen contract shape)", () => {
  test("the frozen exports exist with the pinned shapes", async () => {
    const mod = await import("./parametric_rebuild")
    expect(typeof mod.parametricSchemaFromStorage).toBe("function")
    expect(typeof mod.parametricRebuildFromStorage).toBe("function")
    expect(typeof mod.resolveParametricParams).toBe("function")
    expect(typeof mod.parseParametricSchemaStdout).toBe("function")
    expect(typeof mod.parseParametricBuildStdout).toBe("function")
    expect(typeof mod.validateParametricSchemaPayload).toBe("function")
    expect(typeof mod.validateParametricBuildPayload).toBe("function")
    const err = new EngineUnavailableError("probe")
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe("EngineUnavailableError")
    expect(err.message).toBe("probe")
  })
})
