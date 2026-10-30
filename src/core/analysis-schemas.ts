/**
 * Engineering OS — discipline input schemas, Phase 5 (W3-f lane).
 *
 * Zod validation for the three frozen input formats of the extended-disciplines
 * contract (docs/00-architecture/phase5-disciplines-contract.md §3):
 *   - eos-schedule/1          (project schedule — created via POST …/schedules,
 *                              analyzed by the `analyze_schedule` platform core)
 *   - eos-powerflow-network/1 (network — run by the `run_powerflow` op)
 *   - eos-des-scenario/1      (scenario — run by the `run_des` op)
 *
 * The python adapters (W2-f) accept exactly this JSON; the wire is validated
 * HERE first (create/derive routes) and defended again at arm's length (never a
 * crash). All semantics are pure (ADR-0002): no DB, no engines, no clock —
 * `bun test` pins every message below byte-for-byte.
 *
 * Error style (ledger convention, mirroring parseWorkflowDefinition): ONE
 * joinable verbatim message per parse, `"<prefix>: path: msg; …"` with root-level
 * issues carrying no path. The three §3.1 semantic errors are PINNED VERBATIM:
 *   - `activity id "<id>" is used more than once`
 *   - `activity "<id>" references unknown predecessor "<pid>"`
 *   - `activity chain contains a cycle involving "<id>"`
 * and the sibling collections reuse the same "… is used more than once" form.
 *
 * Cross-collection messages (network/scenario) mirror the schedule's reference
 * style: `line "<id>" references unknown fromBus "<busId>"`, `load "<id>"
 * references unknown busId "<busId>"`, `externalGrid references unknown busId
 * "<busId>"`, `job "<id>" references unknown resource "<rid>"`.
 */

import { z } from "zod"

import { analyzeCpm, type CpmActivity } from "./cpm"

// ---------------------------------------------------------------------------
// Shared field builders (message style mirrors the existing estimate routes)
// ---------------------------------------------------------------------------

const ID_RE = /^[a-z0-9-]{1,32}$/

function idField(label: string) {
  return z
    .string()
    .regex(ID_RE, `${label} must match ^[a-z0-9-]{1,32}$ (lowercase letters, digits, dashes)`)
}

function nameField() {
  return z
    .string()
    .trim()
    .min(1, "name is required")
    .max(200, "name must be at most 200 characters")
}

function finiteNumber(label: string) {
  return z.number({ message: `${label} must be a number` })
}

function positiveNumber(label: string) {
  return finiteNumber(label).refine((v) => Number.isFinite(v) && v > 0, {
    message: `${label} must be a finite number > 0`,
  })
}

function nonNegativeNumber(label: string) {
  return finiteNumber(label).refine((v) => Number.isFinite(v) && v >= 0, {
    message: `${label} must be a finite number ≥ 0`,
  })
}

/** Range-checked integer with one message for the whole range (retry-style). */
function boundedInteger(label: string, min: number, max: number) {
  const message = `${label} must be an integer between ${min} and ${max}`
  return finiteNumber(label)
    .int(message)
    .min(min, message)
    .max(max, message)
}

export type ParseSchemaResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string }

/** Ledger-style joiner: path-prefixed issues, root issues unprefixed. */
function joinZodIssues(prefix: string, error: z.ZodError): string {
  const joined = error.issues
    .map((issue) => {
      const at = issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""
      return `${at}${issue.message}`
    })
    .join("; ")
  return `${prefix}: ${joined}`
}

// ---------------------------------------------------------------------------
// §3.1 Schedule (eos-schedule/1)
// ---------------------------------------------------------------------------

export const scheduleSchema = z
  .strictObject(
    {
      format: z.literal("eos-schedule/1", { message: 'format must be "eos-schedule/1"' }),
      name: nameField(),
      activities: z
        .array(
          z.strictObject({
            id: idField("activity id"),
            name: nameField(),
            durationDays: boundedInteger("durationDays", 0, 10000),
            predecessorIds: z
              .array(
                z
                  .string()
                  .regex(ID_RE, "predecessor ids must match ^[a-z0-9-]{1,32}$ (lowercase letters, digits, dashes)"),
              )
              .default([]),
          }),
        )
        .min(1, "at least one activity is required")
        .max(64, "at most 64 activities are allowed"),
    },
    { message: "schedule must be a JSON object" },
  )
  .superRefine((schedule, ctx) => {
    // Duplicate ids — reported at the SECOND (or later) occurrence, mirroring
    // the workflow-definition duplicate-step path convention.
    const seen = new Set<string>()
    let duplicated = false
    schedule.activities.forEach((activity, index) => {
      if (seen.has(activity.id)) {
        duplicated = true
        ctx.addIssue({
          code: "custom",
          path: ["activities", index, "id"],
          message: `activity id "${activity.id}" is used more than once`,
        })
      } else {
        seen.add(activity.id)
      }
    })

    // Unknown predecessors (path: the referencing activity entry).
    let unknown = false
    schedule.activities.forEach((activity, index) => {
      for (const predecessor of activity.predecessorIds) {
        if (!seen.has(predecessor)) {
          unknown = true
          ctx.addIssue({
            code: "custom",
            path: ["activities", index],
            message: `activity "${activity.id}" references unknown predecessor "${predecessor}"`,
          })
        }
      }
    })

    // Cycles — a graph-level property, reported at the root with the pinned
    // message. The cycle semantics live in ONE place (the pure CPM core);
    // probing it here is safe because every field-level rule above has already
    // passed, so the only reachable probe failure is the cycle error.
    if (!duplicated && !unknown) {
      const probe = analyzeCpm(schedule.activities as CpmActivity[])
      if (!probe.ok) {
        ctx.addIssue({ code: "custom", path: [], message: probe.error })
      }
    }
  })

export type ScheduleInput = z.infer<typeof scheduleSchema>

/** Parse an unknown value as an eos-schedule/1 document (verbatim 422 material). */
export function parseSchedule(input: unknown): ParseSchemaResult<ScheduleInput> {
  const parsed = scheduleSchema.safeParse(input)
  if (parsed.success) return { ok: true, value: parsed.data }
  return { ok: false, error: joinZodIssues("invalid schedule", parsed.error) }
}

/**
 * Canonical eos-schedule/1 bytes: every nested object re-wrapped in the pinned
 * key order (format → name → activities; activity: id → name → durationDays →
 * predecessorIds), defaults materialized — the stored revision bytes depend
 * ONLY on the parsed value, never on the sender's key order or spacing
 * (byte-deterministic by construction, Contract-A style).
 */
export function canonicalScheduleJson(value: ScheduleInput): string {
  return JSON.stringify({
    format: value.format,
    name: value.name,
    activities: value.activities.map((activity) => ({
      id: activity.id,
      name: activity.name,
      durationDays: activity.durationDays,
      predecessorIds: [...activity.predecessorIds],
    })),
  })
}

// ---------------------------------------------------------------------------
// §3.2 Power-flow network (eos-powerflow-network/1)
// ---------------------------------------------------------------------------

export const powerflowNetworkSchema = z
  .strictObject(
    {
      format: z.literal("eos-powerflow-network/1", {
        message: 'format must be "eos-powerflow-network/1"',
      }),
      name: nameField(),
      baseMva: positiveNumber("baseMva").default(100),
      buses: z
        .array(
          z.strictObject({
            id: idField("bus id"),
            nominalVk: positiveNumber("nominalVk"),
          }),
        )
        .min(1, "at least one bus is required")
        .max(16, "at most 16 buses are allowed"),
      lines: z
        .array(
          z.strictObject({
            id: idField("line id"),
            fromBus: z.string().min(1, "fromBus must be a bus id"),
            toBus: z.string().min(1, "toBus must be a bus id"),
            lengthKm: positiveNumber("lengthKm"),
            rOhmPerKm: nonNegativeNumber("rOhmPerKm"),
            xOhmPerKm: positiveNumber("xOhmPerKm"),
            maxCurrentKa: positiveNumber("maxCurrentKa").default(1),
          }),
        )
        .max(48, "at most 48 lines are allowed")
        .default([]),
      externalGrid: z.strictObject({
        busId: z.string().min(1, "externalGrid.busId must be a bus id"),
        vmPu: finiteNumber("vmPu").default(1),
      }),
      loads: z
        .array(
          z.strictObject({
            id: idField("load id"),
            busId: z.string().min(1, "busId must be a bus id"),
            pMw: nonNegativeNumber("pMw"),
            qMvar: nonNegativeNumber("qMvar"),
          }),
        )
        .max(48, "at most 48 loads are allowed")
        .default([]),
    },
    { message: "power flow network must be a JSON object" },
  )
  .superRefine((network, ctx) => {
    // Duplicate ids inside each collection (same form as the schedule rule).
    const dupIn = <T>(items: T[], key: (item: T) => string, label: string, at: string) => {
      const seen = new Set<string>()
      items.forEach((item, index) => {
        const id = key(item)
        if (seen.has(id)) {
          ctx.addIssue({
            code: "custom",
            path: [at, index, "id"],
            message: `${label} id "${id}" is used more than once`,
          })
        } else {
          seen.add(id)
        }
      })
      return seen
    }

    const busIds = dupIn(network.buses, (b) => b.id, "bus", "buses")
    const lineIds = dupIn(network.lines, (l) => l.id, "line", "lines")
    const loadIds = dupIn(network.loads, (l) => l.id, "load", "loads")
    void lineIds
    void loadIds

    // Cross references: lines/loads/externalGrid must point at known buses.
    network.lines.forEach((line, index) => {
      if (!busIds.has(line.fromBus)) {
        ctx.addIssue({
          code: "custom",
          path: ["lines", index],
          message: `line "${line.id}" references unknown fromBus "${line.fromBus}"`,
        })
      }
      if (!busIds.has(line.toBus)) {
        ctx.addIssue({
          code: "custom",
          path: ["lines", index],
          message: `line "${line.id}" references unknown toBus "${line.toBus}"`,
        })
      }
    })
    network.loads.forEach((load, index) => {
      if (!busIds.has(load.busId)) {
        ctx.addIssue({
          code: "custom",
          path: ["loads", index],
          message: `load "${load.id}" references unknown busId "${load.busId}"`,
        })
      }
    })
    if (!busIds.has(network.externalGrid.busId)) {
      ctx.addIssue({
        code: "custom",
        path: ["externalGrid"],
        message: `externalGrid references unknown busId "${network.externalGrid.busId}"`,
      })
    }
  })

export type PowerflowNetworkInput = z.infer<typeof powerflowNetworkSchema>

/** Parse an unknown value as an eos-powerflow-network/1 document. */
export function parsePowerflowNetwork(input: unknown): ParseSchemaResult<PowerflowNetworkInput> {
  const parsed = powerflowNetworkSchema.safeParse(input)
  if (parsed.success) return { ok: true, value: parsed.data }
  return { ok: false, error: joinZodIssues("invalid power flow network", parsed.error) }
}

// ---------------------------------------------------------------------------
// §3.3 DES scenario (eos-des-scenario/1)
// ---------------------------------------------------------------------------

export const desScenarioSchema = z
  .strictObject(
    {
      format: z.literal("eos-des-scenario/1", { message: 'format must be "eos-des-scenario/1"' }),
      name: nameField(),
      timeUnit: z
        .enum(["hour", "day", "minute"], { message: "timeUnit must be one of: hour, day, minute" })
        .default("day"),
      resources: z
        .array(
          z.strictObject({
            id: idField("resource id"),
            capacity: boundedInteger("capacity", 1, 8).default(1),
          }),
        )
        .min(1, "at least one resource is required")
        .max(32, "at most 32 resources are allowed"),
      jobs: z
        .array(
          z.strictObject({
            id: idField("job id"),
            arriveAt: nonNegativeNumber("arriveAt").default(0),
            tasks: z
              .array(
                z.strictObject({
                  resourceId: z.string().min(1, "resourceId must be a resource id"),
                  duration: positiveNumber("duration"),
                }),
              )
              .min(1, "at least one task is required")
              .max(8, "at most 8 tasks are allowed"),
          }),
        )
        .min(1, "at least one job is required")
        .max(256, "at most 256 jobs are allowed"),
    },
    { message: "DES scenario must be a JSON object" },
  )
  .superRefine((scenario, ctx) => {
    const seen = new Set<string>()
    scenario.resources.forEach((resource, index) => {
      if (seen.has(resource.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["resources", index, "id"],
          message: `resource id "${resource.id}" is used more than once`,
        })
      } else {
        seen.add(resource.id)
      }
    })

    const jobSeen = new Set<string>()
    scenario.jobs.forEach((job, index) => {
      if (jobSeen.has(job.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["jobs", index, "id"],
          message: `job id "${job.id}" is used more than once`,
        })
      } else {
        jobSeen.add(job.id)
      }
      for (const task of job.tasks) {
        if (!seen.has(task.resourceId)) {
          ctx.addIssue({
            code: "custom",
            path: ["jobs", index],
            message: `job "${job.id}" references unknown resource "${task.resourceId}"`,
          })
        }
      }
    })
  })

export type DesScenarioInput = z.infer<typeof desScenarioSchema>

/** Parse an unknown value as an eos-des-scenario/1 document. */
export function parseDesScenario(input: unknown): ParseSchemaResult<DesScenarioInput> {
  const parsed = desScenarioSchema.safeParse(input)
  if (parsed.success) return { ok: true, value: parsed.data }
  return { ok: false, error: joinZodIssues("invalid DES scenario", parsed.error) }
}

// ---------------------------------------------------------------------------
// §14.2 FEA model (eos-fea-model/1 — Slice 22, plane-stress solving)
// ---------------------------------------------------------------------------

const FEA_EDGES = ["left", "right", "bottom", "top"] as const


export const feaModelSchema = z
  .strictObject(
    {
      format: z.literal("eos-fea-model/1", {
        message: 'format must be "eos-fea-model/1"',
      }),
      name: nameField(),
      thicknessMm: positiveNumber("thicknessMm"),
      domain: z.strictObject(
        {
          widthMm: positiveNumber("domain.widthMm"),
          heightMm: positiveNumber("domain.heightMm"),
        },
        { message: "domain must be a JSON object" },
      ),
      material: z.strictObject(
        {
          elasticModulusMpa: positiveNumber("material.elasticModulusMpa"),
          poissonRatio: finiteNumber("material.poissonRatio").refine(
            (v) => Number.isFinite(v) && v >= 0 && v <= 0.49,
            { message: "material.poissonRatio must be a finite number between 0 and 0.49" },
          ),
        },
        { message: "material must be a JSON object" },
      ),
      supports: z
        .array(
          z.strictObject(
            {
              edge: z.enum(FEA_EDGES, {
                message: 'supports.edge must be one of: left, right, bottom, top',
              }),
              ux: z.boolean({ message: "supports.ux must be a boolean" }),
              uy: z.boolean({ message: "supports.uy must be a boolean" }),
            },
            { message: "each support must be a JSON object" },
          ),
        )
        .min(1, "at least one support is required")
        .max(4, "at most 4 supports are allowed (one per edge)"),
      loads: z
        .array(
          z.strictObject(
            {
              edge: z.enum(FEA_EDGES, {
                message: 'loads.edge must be one of: left, right, bottom, top',
              }),
              tractionMPa: finiteNumber("loads.tractionMPa").optional(),
              shearMPa: finiteNumber("loads.shearMPa").optional(),
            },
            { message: "each load must be a JSON object" },
          ),
        )
        .min(1, "at least one load is required")
        .max(8, "at most 8 loads are allowed"),
    },
    { message: "FEA model must be a JSON object" },
  )
  .superRefine((model, ctx) => {
    // Duplicate edges inside each collection + the all-free support refusal.
    const seenSupport = new Set<string>()
    model.supports.forEach((s, index) => {
      if (seenSupport.has(s.edge)) {
        ctx.addIssue({
          code: "custom",
          path: ["supports", index],
          message: `support edge "${s.edge}" is declared more than once`,
        })
      } else {
        seenSupport.add(s.edge)
      }
      if (!s.ux && !s.uy) {
        ctx.addIssue({
          code: "custom",
          path: ["supports", index],
          message: `support on edge "${s.edge}" fixes no degree of freedom (set ux and/or uy)`,
        })
      }
    })
    const seenLoad = new Set<string>()
    model.loads.forEach((l, index) => {
      if (seenLoad.has(l.edge)) {
        ctx.addIssue({
          code: "custom",
          path: ["loads", index],
          message: `load edge "${l.edge}" is declared more than once`,
        })
      } else {
        seenLoad.add(l.edge)
      }
      const traction = l.tractionMPa ?? 0
      const shear = l.shearMPa ?? 0
      if (traction === 0 && shear === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["loads", index],
          message:
            `load on edge "${l.edge}" has no effect (set a non-zero tractionMPa and/or shearMPa)`,
        })
      }
    })
  })

export type FeaModelInput = z.infer<typeof feaModelSchema>

/** Parse an unknown value as an eos-fea-model/1 document. */
export function parseFeaModel(input: unknown): ParseSchemaResult<FeaModelInput> {
  const parsed = feaModelSchema.safeParse(input)
  if (parsed.success) return { ok: true, value: parsed.data }
  return { ok: false, error: joinZodIssues("invalid FEA model", parsed.error) }
}

// ---------------------------------------------------------------------------
// Stored-content parse helpers (the derive routes read artifact bytes)
// ---------------------------------------------------------------------------

function parseJsonText(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false, error: "content is not valid JSON" }
  }
}

/**
 * Parse stored artifact text as an eos-schedule/1 document. Non-JSON bytes
 * surface as `invalid schedule: content is not valid JSON` (honest dead end —
 * never a guess, never a crash).
 */
export function parseScheduleJsonText(text: string): ParseSchemaResult<ScheduleInput> {
  const raw = parseJsonText(text)
  if (!raw.ok) return { ok: false, error: `invalid schedule: ${raw.error}` }
  return parseSchedule(raw.value)
}

/** Parse stored artifact text as an eos-powerflow-network/1 document. */
export function parsePowerflowNetworkJsonText(text: string): ParseSchemaResult<PowerflowNetworkInput> {
  const raw = parseJsonText(text)
  if (!raw.ok) return { ok: false, error: `invalid power flow network: ${raw.error}` }
  return parsePowerflowNetwork(raw.value)
}

/** Parse stored artifact text as an eos-des-scenario/1 document. */
export function parseDesScenarioJsonText(text: string): ParseSchemaResult<DesScenarioInput> {
  const raw = parseJsonText(text)
  if (!raw.ok) return { ok: false, error: `invalid DES scenario: ${raw.error}` }
  return parseDesScenario(raw.value)
}

/** Parse stored artifact text as an eos-fea-model/1 document (Slice 22). */
export function parseFeaModelJsonText(text: string): ParseSchemaResult<FeaModelInput> {
  const raw = parseJsonText(text)
  if (!raw.ok) return { ok: false, error: `invalid FEA model: ${raw.error}` }
  return parseFeaModel(raw.value)
}

// ---------------------------------------------------------------------------
// §15.2 SWMM model (eos-swmm-model/1 — Slice 23, drainage simulation)
// ---------------------------------------------------------------------------

const nodeIdPattern = /^[A-Za-z0-9_.-]{1,32}$/


export const swmmModelSchema = z
  .strictObject(
    {
      format: z.literal("eos-swmm-model/1", {
        message: 'format must be "eos-swmm-model/1"',
      }),
      name: nameField(),
      simulation: z.strictObject(
        {
          durationMin: z
            .number({ message: "simulation.durationMin must be a number" })
            .int("simulation.durationMin must be an integer")
            .min(1, "simulation.durationMin must be at least 1 minute")
            .max(1440, "simulation.durationMin must be at most 1440 minutes (24 h)"),
        },
        { message: "simulation must be a JSON object" },
      ),
      rainfall: z.strictObject(
        {
          intensityMMperHr: positiveNumber("rainfall.intensityMMperHr"),
          durationMin: z
            .number({ message: "rainfall.durationMin must be a number" })
            .int("rainfall.durationMin must be an integer")
            .min(5, "rainfall.durationMin must be at least 5 minutes (the gage cadence)")
            .max(720, "rainfall.durationMin must be at most 720 minutes")
            .refine((v) => v % 5 === 0, {
              message: "rainfall.durationMin must be a multiple of 5 (the gage cadence)",
            }),
        },
        { message: "rainfall must be a JSON object" },
      ),
      subcatchments: z
        .array(
          z.strictObject(
            {
              id: z
                .string({ message: "subcatchments.id must be a string" })
                .regex(nodeIdPattern, {
                  message:
                    "subcatchments.id must be 1..32 characters (letters, digits, dot, underscore, dash)",
                }),
              outletNodeId: z
                .string({ message: "subcatchments.outletNodeId must be a string" })
                .regex(nodeIdPattern, {
                  message:
                    "subcatchments.outletNodeId must be 1..32 characters (letters, digits, dot, underscore, dash)",
                }),
              areaHA: positiveNumber("subcatchments.areaHA").refine(
                (v) => v <= 1000,
                { message: "subcatchments.areaHA must be at most 1000 ha" },
              ),
              widthM: positiveNumber("subcatchments.widthM").refine((v) => v <= 10000, {
                message: "subcatchments.widthM must be at most 10000 m",
              }),
              slopePct: positiveNumber("subcatchments.slopePct").refine((v) => v <= 100, {
                message: "subcatchments.slopePct must be at most 100",
              }),
              manningNImperv: positiveNumber("subcatchments.manningNImperv").refine(
                (v) => v <= 1,
                { message: "subcatchments.manningNImperv must be at most 1" },
              ),
              depressionStorageMM: finiteNumber("subcatchments.depressionStorageMM").refine(
                (v) => v >= 0 && v <= 500,
                {
                  message:
                    "subcatchments.depressionStorageMM must be a finite number between 0 and 500 mm",
                },
              ),
            },
            { message: "each subcatchment must be a JSON object" },
          ),
        )
        .min(1, "at least one subcatchment is required")
        .max(50, "at most 50 subcatchments are allowed"),
      nodes: z
        .array(
          z.discriminatedUnion("kind", [
            z.strictObject(
              {
                kind: z.literal("junction", { message: 'nodes.kind must be "junction" or "outfall"' }),
                id: z
                  .string({ message: "nodes.id must be a string" })
                  .regex(nodeIdPattern, {
                    message:
                      "nodes.id must be 1..32 characters (letters, digits, dot, underscore, dash)",
                  }),
                invertElevM: finiteNumber("nodes.invertElevM"),
                maxDepthM: positiveNumber("nodes.maxDepthM"),
              },
              { message: "each junction must be a JSON object" },
            ),
            z.strictObject(
              {
                kind: z.literal("outfall", { message: 'nodes.kind must be "junction" or "outfall"' }),
                id: z
                  .string({ message: "nodes.id must be a string" })
                  .regex(nodeIdPattern, {
                    message:
                      "nodes.id must be 1..32 characters (letters, digits, dot, underscore, dash)",
                  }),
                invertElevM: finiteNumber("nodes.invertElevM"),
              },
              { message: "each outfall must be a JSON object" },
            ),
          ]),
        )
        .min(1, "at least one node is required")
        .max(200, "at most 200 nodes are allowed"),
      conduits: z
        .array(
          z.strictObject(
            {
              id: z
                .string({ message: "conduits.id must be a string" })
                .regex(nodeIdPattern, {
                  message:
                    "conduits.id must be 1..32 characters (letters, digits, dot, underscore, dash)",
                }),
              fromNodeId: z
                .string({ message: "conduits.fromNodeId must be a string" })
                .regex(nodeIdPattern, {
                  message:
                    "conduits.fromNodeId must be 1..32 characters (letters, digits, dot, underscore, dash)",
                }),
              toNodeId: z
                .string({ message: "conduits.toNodeId must be a string" })
                .regex(nodeIdPattern, {
                  message:
                    "conduits.toNodeId must be 1..32 characters (letters, digits, dot, underscore, dash)",
                }),
              lengthM: positiveNumber("conduits.lengthM").refine((v) => v <= 100000, {
                message: "conduits.lengthM must be at most 100000 m",
              }),
              manningN: positiveNumber("conduits.manningN").refine((v) => v <= 1, {
                message: "conduits.manningN must be at most 1",
              }),
              slopePct: positiveNumber("conduits.slopePct").refine((v) => v <= 100, {
                message: "conduits.slopePct must be at most 100",
              }),
              heightM: positiveNumber("conduits.heightM").refine((v) => v <= 20, {
                message: "conduits.heightM must be at most 20 m",
              }),
              widthM: positiveNumber("conduits.widthM").refine((v) => v <= 50, {
                message: "conduits.widthM must be at most 50 m",
              }),
            },
            { message: "each conduit must be a JSON object" },
          ),
        )
        .max(250, "at most 250 conduits are allowed"),
    },
    { message: "SWMM model must be a JSON object" },
  )
  .superRefine((model, ctx) => {
    // Duplicate ids across every collection (subcatchments, nodes, conduits).
    const seenSubcatchment = new Set<string>()
    model.subcatchments.forEach((s, index) => {
      if (seenSubcatchment.has(s.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["subcatchments", index],
          message: `subcatchment id "${s.id}" is declared more than once`,
        })
      } else {
        seenSubcatchment.add(s.id)
      }
    })
    const nodeIds = new Set<string>()
    model.nodes.forEach((n, index) => {
      if (nodeIds.has(n.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["nodes", index],
          message: `node id "${n.id}" is declared more than once`,
        })
      } else {
        nodeIds.add(n.id)
      }
    })
    const seenConduit = new Set<string>()
    model.conduits.forEach((c, index) => {
      if (seenConduit.has(c.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["conduits", index],
          message: `conduit id "${c.id}" is declared more than once`,
        })
      } else {
        seenConduit.add(c.id)
      }
      if (!nodeIds.has(c.fromNodeId)) {
        ctx.addIssue({
          code: "custom",
          path: ["conduits", index],
          message: `conduit "${c.id}" references unknown fromNode "${c.fromNodeId}"`,
        })
      }
      if (!nodeIds.has(c.toNodeId)) {
        ctx.addIssue({
          code: "custom",
          path: ["conduits", index],
          message: `conduit "${c.id}" references unknown toNode "${c.toNodeId}"`,
        })
      }
    })
    model.subcatchments.forEach((s, index) => {
      if (!nodeIds.has(s.outletNodeId)) {
        ctx.addIssue({
          code: "custom",
          path: ["subcatchments", index],
          message: `subcatchment "${s.id}" outlets into unknown node "${s.outletNodeId}"`,
        })
      }
    })
    // The rigid-mode analog: a network with no outfall cannot drain.
    if (!model.nodes.some((n) => n.kind === "outfall")) {
      ctx.addIssue({
        code: "custom",
        path: ["nodes"],
        message:
          "the network has no outfall - runoff cannot leave the model, and simulated results are not an option",
      })
    }
    // Simulation window must outlast the storm (post-rain drainage).
    if (model.simulation.durationMin <= model.rainfall.durationMin) {
      ctx.addIssue({
        code: "custom",
        path: ["simulation", "durationMin"],
        message:
          "simulation.durationMin must exceed rainfall.durationMin (the network needs post-rain drainage time to reach a volume balance)",
      })
    }
  })

export type SwmmModelInput = z.infer<typeof swmmModelSchema>

/** Parse an unknown value as an eos-swmm-model/1 document. */
export function parseSwmmModel(input: unknown): ParseSchemaResult<SwmmModelInput> {
  const parsed = swmmModelSchema.safeParse(input)
  if (parsed.success) return { ok: true, value: parsed.data }
  return { ok: false, error: joinZodIssues("invalid SWMM model", parsed.error) }
}

/** Parse stored artifact text as an eos-swmm-model/1 document (Slice 23). */
export function parseSwmmModelJsonText(text: string): ParseSchemaResult<SwmmModelInput> {
  const raw = parseJsonText(text)
  if (!raw.ok) return { ok: false, error: `invalid SWMM model: ${raw.error}` }
  return parseSwmmModel(raw.value)
}

// ---------------------------------------------------------------------------
// §16.2 Transport model (eos-cfd-transport-model/1 — Slice 29, steady scalar
// transport via SfePy; the CFD lane the Slice-28 license-first probe opened)
// ---------------------------------------------------------------------------

export const transportModelSchema = z.strictObject(
  {
    format: z.literal("eos-cfd-transport-model/1", {
      message: 'format must be "eos-cfd-transport-model/1"',
    }),
    name: nameField(),
    domain: z.strictObject(
      {
        lengthM: positiveNumber("domain.lengthM").refine((v) => v <= 10000, {
          message: "domain.lengthM must be at most 10000 m",
        }),
        heightM: positiveNumber("domain.heightM").refine((v) => v <= 10000, {
          message: "domain.heightM must be at most 10000 m",
        }),
      },
      { message: "domain must be a JSON object" },
    ),
    diffusivityM2PerS: positiveNumber("diffusivityM2PerS").refine((v) => v <= 10, {
      message: "diffusivityM2PerS must be at most 10 m²/s",
    }),
    velocityMPerS: positiveNumber("velocityMPerS").refine((v) => v <= 100, {
      message: "velocityMPerS must be at most 100 m/s",
    }),
    inletConcentration: finiteNumber("inletConcentration"),
    outletConcentration: finiteNumber("outletConcentration"),
  },
  { message: "transport model must be a JSON object" },
)

export type TransportModelInput = z.infer<typeof transportModelSchema>

/** Parse an unknown value as an eos-cfd-transport-model/1 document. */
export function parseTransportModel(input: unknown): ParseSchemaResult<TransportModelInput> {
  const parsed = transportModelSchema.safeParse(input)
  if (parsed.success) return { ok: true, value: parsed.data }
  return { ok: false, error: joinZodIssues("invalid transport model", parsed.error) }
}

/** Parse stored artifact text as an eos-cfd-transport-model/1 document (Slice 29). */
export function parseTransportModelJsonText(text: string): ParseSchemaResult<TransportModelInput> {
  const raw = parseJsonText(text)
  if (!raw.ok) return { ok: false, error: `invalid transport model: ${raw.error}` }
  return parseTransportModel(raw.value)
}
