import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

import { detectEngines, engineRegistry, type EngineProbeSpec, type EngineRecord } from "./index"

/**
 * Detection tests (Worker 2 lane, ADR-0005 rule 3: "not installed" is a first-class state).
 * No network and no real engines: detection is exercised against a fixture registry and
 * fake executables written into a temp directory prepended to PATH.
 */

const tmpDir = mkdtempSync(path.join(tmpdir(), "eos-engine-probe-"))
const originalPath = process.env.PATH ?? ""

function makeFixtureExecutable(name: string, body: string): string {
  const p = path.join(tmpDir, name)
  writeFileSync(p, `#!/bin/sh\n${body}\n`)
  chmodSync(p, 0o755)
  return p
}

function fixtureEngine(key: string, probes: EngineProbeSpec[]): EngineRecord {
  return {
    key,
    name: key,
    domain: "cad",
    description: `fixture engine for ${key} (test only — not a real upstream)`,
    upstream: {
      canonical: "https://example.invalid",
      repo: null,
      licenseSpdx: "NOASSERTION (test fixture)",
      latestStable: null,
      verified: false,
      verifiedAt: null,
      verifiedMethod: "test fixture",
    },
    integration: { mechanisms: ["cli"], notes: "test fixture" },
    probes,
    state: "planned",
    limitations: [],
  }
}

beforeAll(() => {
  // Prepend the fixture dir to PATH so probeExecutable can find the fake executables.
  process.env.PATH = tmpDir + path.delimiter + originalPath
})

afterAll(() => {
  process.env.PATH = originalPath
})

const pythonAvailable = spawnSync("python3", ["--version"], { timeout: 4000 }).status === 0

describe("detectEngines (fixture registry, no real engines)", () => {
  test("executable probe: fake binary on augmented PATH reports installed with parsed version", async () => {
    const fixturePath = makeFixtureExecutable("freecad-fixture", 'echo "FreeCAD 9.9.9"')
    const engine = fixtureEngine("freecad-fixture-engine", [
      {
        kind: "executable",
        executables: ["freecad-fixture"],
        versionArgs: ["--version"],
        versionRegex: "FreeCAD\\s+([0-9][0-9A-Za-z.+-]*)",
      },
    ])

    const [result] = await detectEngines([engine])

    expect(result).toBeDefined()
    expect(result.key).toBe("freecad-fixture-engine")
    expect(result.state).toBe("installed")
    expect(result.version).toBe("9.9.9")
    expect(result.executablePath).toBe(fixturePath)
    expect(result.probeOutput).toContain("FreeCAD 9.9.9")
  })

  test("executable probe: missing binary with improbable name reports not_installed (never an error)", async () => {
    const engine = fixtureEngine("eos-absent-engine", [
      {
        kind: "executable",
        executables: ["eos-no-such-engine-xyz"],
        versionArgs: ["--version"],
        versionRegex: "([0-9][0-9.]*)",
      },
    ])

    const [result] = await detectEngines([engine])

    expect(result.state).toBe("not_installed")
    expect(result.version).toBeNull()
    expect(result.executablePath).toBeNull()
    expect(result.probeOutput).toBeNull()
  })

  test.skipIf(!pythonAvailable)(
    "python-module probe: import of a guaranteed-absent module reports not_installed",
    async () => {
      const engine = fixtureEngine("eos-absent-python-module", [
        {
          kind: "python-module",
          module: "eos_no_such_module_xyz",
          moduleVersionExpr: "import eos_no_such_module_xyz; print(eos_no_such_module_xyz.__version__)",
        },
      ])

      const [result] = await detectEngines([engine])

      expect(result.state).toBe("not_installed")
      expect(result.version).toBeNull()
      expect(result.executablePath).toBeNull()
    },
  )

  test("presence-only probe (no versionArgs): installed with version null", async () => {
    const fixturePath = makeFixtureExecutable("eos-presence-fixture", 'echo "opaque banner, no version"')
    const engine = fixtureEngine("eos-presence-engine", [
      {
        kind: "executable",
        executables: ["eos-presence-fixture"],
        versionArgs: [],
        versionRegex: null,
      },
    ])

    const [result] = await detectEngines([engine])

    // Presence-only probes must never execute the binary or claim a version.
    expect(result.state).toBe("installed")
    expect(result.version).toBeNull()
    expect(result.probeOutput).toBeNull()
    expect(result.executablePath).toBe(fixturePath)
  })

  test("fixture PATH hygiene: fixtures resolve from the temp dir, not the ambient system", async () => {
    // The temp dir is first on PATH — a fixture engine name that also exists as a real
    // system tool must still resolve deterministically from the fixture dir.
    makeFixtureExecutable("eos-shadow-fixture", 'echo "shadow 1.0.0"')
    const engine = fixtureEngine("eos-shadow-engine", [
      {
        kind: "executable",
        executables: ["eos-shadow-fixture"],
        versionArgs: ["--version"],
        versionRegex: "shadow\\s+([0-9][0-9.]*)",
      },
    ])

    const [result] = await detectEngines([engine])

    expect(result.state).toBe("installed")
    expect(result.version).toBe("1.0.0")
    expect(result.executablePath).toBe(path.join(tmpDir, "eos-shadow-fixture"))
  })

  test("python-module probe: ABSOLUTE-path EOS_PYTHON resolves directly (Phase-6 regression)", async () => {
    // Found live 2026-10-22: resolveOnPath() joins PATH dirs with the exe name, so
    // an absolute EOS_PYTHON (a common venv setup) silently downgraded every
    // python-module engine to not_installed. The probe must use an absolute
    // executable path directly.
    const fixturePath = makeFixtureExecutable(
      "eos-fake-python",
      'echo "fakevenv 7.7.7"',
    )
    const engine = fixtureEngine("eos-absolute-python-engine", [
      {
        kind: "python-module",
        module: "anything",
        moduleVersionExpr: "print(1)",
      },
    ])

    const prevPython = process.env.EOS_PYTHON
    process.env.EOS_PYTHON = fixturePath
    try {
      const [result] = await detectEngines([engine])
      expect(result.state).toBe("installed")
      expect(result.version).toBe("fakevenv 7.7.7")
      expect(result.executablePath).toBe(fixturePath)
    } finally {
      if (prevPython === undefined) delete process.env.EOS_PYTHON
      else process.env.EOS_PYTHON = prevPython
    }
  })

  test("python-module probe: absolute EOS_PYTHON pointing at a NON-executable file reports not_installed", async () => {
    const notExecutable = path.join(tmpDir, "eos-not-executable")
    writeFileSync(notExecutable, "not executable")
    chmodSync(notExecutable, 0o644)

    const engine = fixtureEngine("eos-absolute-python-nonexec-engine", [
      {
        kind: "python-module",
        module: "anything",
        moduleVersionExpr: "print(1)",
      },
    ])

    const prevPython = process.env.EOS_PYTHON
    process.env.EOS_PYTHON = notExecutable
    try {
      const [result] = await detectEngines([engine])
      expect(result.state).toBe("not_installed")
      expect(result.executablePath).toBeNull()
    } finally {
      if (prevPython === undefined) delete process.env.EOS_PYTHON
      else process.env.EOS_PYTHON = prevPython
    }
  })
})

describe("the REAL registry's python-module probes (probe-expr class guard)", () => {
  // Found live 2026-10-29 on the tenth-recovery host: the pyswmm + scikit-fem
  // entries (Slices 23/22) shipped "moduleVersionExpr": "([0-9][0-9.]*)" — the
  // executable-probe versionRegex style pasted into the python-module field.
  // probePythonModule passes the expr VERBATIM to `python -c`; a bare regex is
  // a Python SyntaxError, so the probe honestly reported BOTH engines as
  // not_installed while they were solving live in the same session (the mirror
  // of the 2026-10-22 pandapower-timeout lesson: an INSTALLED engine must
  // never downgrade). This guard pins the CLASS, not the two rows: every
  // python-module probe in the registry must be a real import-and-print
  // program naming the module it claims to probe.
  test("every python-module probe expr is an import-and-print Python program naming its module", () => {
    const pyProbes = engineRegistry.flatMap((e) =>
      e.probes
        .filter((p): p is EngineProbeSpec & { kind: "python-module" } => p.kind === "python-module")
        .map((p) => ({ engine: e.key, module: p.module ?? "", expr: p.moduleVersionExpr ?? "" })),
    )
    // The known set (8 at the time of the guard: cadquery, ifcopenshell,
    // pdfplumber, ezdxf, pandapower, simpy, skfem/scikit-fem, pyswmm): a
    // dropped python-module probe must fail loudly here, not silently shrink
    // coverage.
    expect(pyProbes.length).toBeGreaterThanOrEqual(8)
    for (const { engine, module, expr } of pyProbes) {
      expect(
        expr.startsWith("import "),
        `${engine}: moduleVersionExpr must start with an import (got ${JSON.stringify(expr)})`,
      ).toBe(true)
      expect(
        expr.includes(module),
        `${engine}: moduleVersionExpr must import the probed module "${module}"`,
      ).toBe(true)
      expect(
        expr.includes("print("),
        `${engine}: moduleVersionExpr must print the version (got ${JSON.stringify(expr)})`,
      ).toBe(true)
      // The executable-probe style must NEVER ride in this field: a version
      // REGEX is a Python SyntaxError under `python -c` — the exact defect.
      expect(
        expr.includes("[0-9]"),
        `${engine}: moduleVersionExpr looks like a version REGEX, not a Python program`,
      ).toBe(false)
    }
  })
})
