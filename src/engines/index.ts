import { access, constants, stat } from "node:fs/promises"
import { execFile } from "node:child_process"
import path from "node:path"
import { promisify } from "node:util"

import registryData from "./registry.json"

const execFileAsync = promisify(execFile)

/**
 * Engine registry & detection (Worker 2 lane, ADR-0005).
 * Detection is honest: "not installed" is a first-class state, never an error.
 * Keep exported signatures stable — src/app consumes this module (W1 contract).
 */

export interface EngineProbeSpec {
  kind: "executable" | "python-module"
  executables?: string[]
  versionArgs?: string[]
  versionRegex?: string | null
  module?: string
  moduleVersionExpr?: string
}

export type EngineState =
  | "planned"
  | "installed"
  | "available"
  | "implemented"
  | "tested"
  | "verified"
  | "production-ready"

export interface EngineRecord {
  key: string
  name: string
  domain: string
  description: string
  upstream: {
    canonical: string
    repo?: string | null
    licenseSpdx?: string | null
    latestStable?: string | null
    verified: boolean
    verifiedAt?: string | null
    verifiedMethod?: string | null
  }
  integration: { mechanisms: string[]; notes?: string }
  probes: EngineProbeSpec[]
  state: EngineState
  limitations: string[]
}

export interface DetectionResult {
  key: string
  state: "installed" | "not_installed"
  version: string | null
  executablePath: string | null
  probeOutput: string | null
  probedAt: string
}

export const engineRegistry: EngineRecord[] = (registryData as { engines: EngineRecord[] }).engines

async function resolveOnPath(exe: string, envPath: string): Promise<string | null> {
  const seen = new Set<string>()
  const dirs = envPath.split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    if (seen.has(dir)) continue
    seen.add(dir)
    const p = path.join(dir, exe)
    try {
      await access(p, constants.X_OK)
      // Guard against PATH entries that are directories named like the executable.
      const s = await stat(p)
      if (!s.isFile()) continue
      return p
    } catch {
      // keep looking
    }
  }
  return null
}

interface ProbeHit {
  hit: boolean
  version: string | null
  executablePath: string | null
  probeOutput: string | null
}

const probeTimeoutMs = 4000

function extractVersion(output: string, versionRegex?: string | null): string | null {
  if (!versionRegex) return null
  let re: RegExp
  try {
    re = new RegExp(versionRegex)
  } catch {
    return null
  }
  const m = output.match(re)
  if (!m) return null
  // Prefer the first capture group; fall back to the whole match for group-less regexes.
  const v = m[1] ?? m[0]
  return v ? v.trim() : null
}

async function probeExecutable(spec: EngineProbeSpec): Promise<ProbeHit> {
  for (const exe of spec.executables ?? []) {
    const exePath = await resolveOnPath(exe, process.env.PATH ?? "")
    if (!exePath) continue
    let version: string | null = null
    let output: string | null = null
    if (spec.versionArgs?.length) {
      try {
        const res = await execFileAsync(exePath, spec.versionArgs, {
          timeout: probeTimeoutMs,
          maxBuffer: 64 * 1024,
        })
        output = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim()
      } catch {
        // Executable exists but the version command failed — presence is still the truth.
        output = null
      }
      if (output) {
        version = extractVersion(output, spec.versionRegex)
      }
    }
    return { hit: true, version, executablePath: exePath, probeOutput: output }
  }
  return { hit: false, version: null, executablePath: null, probeOutput: null }
}

async function probePythonModule(spec: EngineProbeSpec): Promise<ProbeHit> {
  if (!spec.module || !spec.moduleVersionExpr) {
    return { hit: false, version: null, executablePath: null, probeOutput: null }
  }
  const py = process.env.EOS_PYTHON ?? "python3"
  const pythonPath = await resolveOnPath(py, process.env.PATH ?? "")
  if (!pythonPath) {
    return { hit: false, version: null, executablePath: null, probeOutput: null }
  }
  try {
    const res = await execFileAsync(pythonPath, ["-c", spec.moduleVersionExpr], {
      timeout: probeTimeoutMs,
      maxBuffer: 64 * 1024,
    })
    const output = `${res.stdout ?? ""}`.trim()
    return { hit: true, version: output || null, executablePath: pythonPath, probeOutput: output }
  } catch {
    // Import failed (module missing) or interpreter misbehaved — honest miss.
    return { hit: false, version: null, executablePath: null, probeOutput: null }
  }
}

/** Probe every engine in the registry (or a provided subset — used by tests). */
export async function detectEngines(engines: EngineRecord[] = engineRegistry): Promise<DetectionResult[]> {
  const results: DetectionResult[] = []
  for (const engine of engines) {
    let detection: DetectionResult = {
      key: engine.key,
      state: "not_installed",
      version: null,
      executablePath: null,
      probeOutput: null,
      probedAt: new Date().toISOString(),
    }
    for (const probe of engine.probes) {
      const r = probe.kind === "python-module" ? await probePythonModule(probe) : await probeExecutable(probe)
      if (r.hit) {
        detection = {
          ...detection,
          state: "installed",
          version: r.version,
          executablePath: r.executablePath,
          probeOutput: r.probeOutput,
        }
        break
      }
    }
    results.push(detection)
  }
  return results
}
