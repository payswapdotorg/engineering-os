/**
 * Engineering OS — quantity ledger & estimating domain model (Worker 3 lane).
 *
 * Implements docs/03-data/quantity-ledger-schema.md as pure TypeScript types,
 * zod validation and deterministic estimating arithmetic. No DB, no network,
 * no filesystem (ADR-0002). No LLM arithmetic either (ADR-0006): every number
 * this module produces is computed by deterministic, re-runnable code — the
 * same inputs always produce the same outputs, including the failure paths
 * (invalid input throws `LedgerError`; nothing ever silently becomes NaN).
 *
 * The two quantity methods are kept strictly distinct (drawing-measured vs
 * model-derived, never silently merged) by `quantityRecordSchema` and by
 * `makeQuantityRecord`.
 */

import { z } from "zod"

// ---------------------------------------------------------------------------
// Quantity ledger — vocabulary
// ---------------------------------------------------------------------------

export const QUANTITY_TYPES = [
  "length",
  "area",
  "volume",
  "count",
  "mass",
  "time",
  "other",
] as const
export type QuantityType = (typeof QUANTITY_TYPES)[number]

export const QUANTITY_METHODS = ["drawing-measured", "model-derived"] as const
export type QuantityMethod = (typeof QUANTITY_METHODS)[number]

export const QUANTITY_STATUSES = ["draft", "in_review", "approved", "superseded"] as const
export type QuantityStatus = (typeof QUANTITY_STATUSES)[number]

export const VERIFICATION_STATUSES = ["unverified", "passed", "failed"] as const
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number]

// ---------------------------------------------------------------------------
// Quantity ledger — record shape
// ---------------------------------------------------------------------------

export interface QuantityRecordVerification {
  status: VerificationStatus
  /** who/what ran the verification (person id, agent id, harness name) */
  checker?: string
  /** pointer to the validation run / benchmark comparison that was performed */
  evidence?: string
}

export interface QuantityRecordApproval {
  approvedBy: string
  approvedAt: string
}

export interface QuantityRecordProvenance {
  createdAt: string
  createdBy: string
  /** ids (e.g. prior quantity/line revisions) recorded on each recompute */
  recomputeHistory: string[]
}

export interface QuantityRecord {
  id: string
  projectId: string
  /** ledger rows always point at a revision, never at a mutable artifact */
  sourceArtifactRevisionId: string
  /** drawing sheet / measurement region — required for drawing-measured */
  sheetRef?: string
  /** IFC element reference (e.g. `#IfcWallGuid`) — required for model-derived */
  elementRef?: string
  quantityType: QuantityType
  value: number
  unit: string
  method: QuantityMethod
  /** calibrated-scale record for drawings (e.g. "1:100 @ A1, scale bar B") */
  scale?: string
  /** quantity-extraction method for models (e.g. "IfcOpenShell base-quantity") */
  quantityMethod?: string
  rulesetId: string
  rulesetVersion: string
  status: QuantityStatus
  tradeAssemblyId?: string
  verification: QuantityRecordVerification
  reviewer?: string
  approval?: QuantityRecordApproval
  provenance: QuantityRecordProvenance
}

// ---------------------------------------------------------------------------
// LedgerError — deterministic domain failure
// ---------------------------------------------------------------------------

/**
 * Thrown by every ledger/estimating function on out-of-domain input. Estimating
 * math fails loudly and deterministically — it never emits NaN/Infinity and
 * never guesses a substitute value.
 */
export class LedgerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LedgerError"
  }
}

// ---------------------------------------------------------------------------
// Quantity ledger — zod schema
// ---------------------------------------------------------------------------

const nonEmpty = z.string().min(1)

/**
 * Validation rules beyond the field shapes (each returns a clear message):
 *  - `method === "drawing-measured"` requires a non-empty `sheetRef`
 *    (whitespace-only is empty); `model-derived` requires a non-empty
 *    `elementRef`
 *  - `value` must be a finite number > 0 — a ledger record of 0, negative,
 *    NaN or Infinity is invalid (a zero take-off is an absence of record)
 *  - `unit`, `rulesetId`, `rulesetVersion` are non-empty strings
 *  - `status === "approved"` requires an `approval` record
 *    (approvedBy + approvedAt) — approval is never implied
 */
export const quantityRecordSchema: z.ZodType<QuantityRecord> = z
  .object({
    id: nonEmpty,
    projectId: nonEmpty,
    sourceArtifactRevisionId: nonEmpty,
    sheetRef: z.string().optional(),
    elementRef: z.string().optional(),
    quantityType: z.enum(QUANTITY_TYPES),
    value: z.number(),
    unit: nonEmpty,
    method: z.enum(QUANTITY_METHODS),
    scale: z.string().optional(),
    quantityMethod: z.string().optional(),
    rulesetId: nonEmpty,
    rulesetVersion: nonEmpty,
    status: z.enum(QUANTITY_STATUSES),
    tradeAssemblyId: z.string().optional(),
    verification: z.object({
      status: z.enum(VERIFICATION_STATUSES),
      checker: z.string().optional(),
      evidence: z.string().optional(),
    }),
    reviewer: z.string().optional(),
    approval: z
      .object({
        approvedBy: nonEmpty,
        approvedAt: nonEmpty,
      })
      .optional(),
    provenance: z.object({
      createdAt: nonEmpty,
      createdBy: nonEmpty,
      recomputeHistory: z.array(z.string()),
    }),
  })
  .superRefine((rec, ctx) => {
    if (rec.method === "drawing-measured" && (rec.sheetRef ?? "").trim() === "") {
      ctx.addIssue({
        code: "custom",
        path: ["sheetRef"],
        message:
          "drawing-measured quantities require a non-empty sheetRef (drawing sheet / measurement region)",
      })
    }
    if (rec.method === "model-derived" && (rec.elementRef ?? "").trim() === "") {
      ctx.addIssue({
        code: "custom",
        path: ["elementRef"],
        message:
          "model-derived quantities require a non-empty elementRef (e.g. #IfcWallGuid)",
      })
    }
    if (!Number.isFinite(rec.value) || rec.value <= 0) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message:
          "value must be a finite number > 0 (0, negative, NaN and Infinity are not valid ledger records)",
      })
    }
    if (rec.status === "approved" && rec.approval === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["approval"],
        message: 'status "approved" requires an approval record (approvedBy + approvedAt)',
      })
    }
  })

// ---------------------------------------------------------------------------
// Quantity ledger — record factory
// ---------------------------------------------------------------------------

/**
 * Input accepted by `makeQuantityRecord`: the measurement identity is required;
 * everything workflow-related defaults to a fresh draft. `createdBy` is
 * required because the ledger never invents identity; `createdAt` defaults to
 * now (ISO-8601 UTC) and `recomputeHistory` starts empty.
 */
export interface QuantityRecordInput {
  id: string
  projectId: string
  sourceArtifactRevisionId: string
  sheetRef?: string
  elementRef?: string
  quantityType: QuantityType
  value: number
  unit: string
  method: QuantityMethod
  scale?: string
  quantityMethod?: string
  rulesetId: string
  rulesetVersion: string
  tradeAssemblyId?: string
  status?: QuantityStatus
  verification?: QuantityRecordVerification
  reviewer?: string
  approval?: QuantityRecordApproval
  /** identity recorded in provenance.createdBy */
  createdBy: string
  /** ISO-8601 timestamp; defaults to the current time */
  createdAt?: string
  /** seeds provenance.recomputeHistory (defaults to []) */
  recomputeHistory?: string[]
}

/**
 * Build a `QuantityRecord` with sensible defaults (status "draft",
 * verification "unverified", provenance now/creator/empty history) and
 * validate it through `quantityRecordSchema`. Throws `LedgerError` (with the
 * zod issues formatted as a readable message) when the result is invalid.
 */
export function makeQuantityRecord(input: QuantityRecordInput): QuantityRecord {
  const candidate: QuantityRecord = {
    id: input.id,
    projectId: input.projectId,
    sourceArtifactRevisionId: input.sourceArtifactRevisionId,
    sheetRef: input.sheetRef,
    elementRef: input.elementRef,
    quantityType: input.quantityType,
    value: input.value,
    unit: input.unit,
    method: input.method,
    scale: input.scale,
    quantityMethod: input.quantityMethod,
    rulesetId: input.rulesetId,
    rulesetVersion: input.rulesetVersion,
    status: input.status ?? "draft",
    tradeAssemblyId: input.tradeAssemblyId,
    verification: input.verification ?? { status: "unverified" },
    reviewer: input.reviewer,
    approval: input.approval,
    provenance: {
      createdAt: input.createdAt ?? new Date().toISOString(),
      createdBy: input.createdBy,
      recomputeHistory: input.recomputeHistory ?? [],
    },
  }

  const parsed = quantityRecordSchema.safeParse(candidate)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => {
        const at = issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""
        return `${at}${issue.message}`
      })
      .join("; ")
    throw new LedgerError(`invalid QuantityRecord: ${issues}`)
  }
  return parsed.data
}

// ---------------------------------------------------------------------------
// Estimating — vocabulary & shapes
// ---------------------------------------------------------------------------

export const ESTIMATE_COMPONENT_KINDS = ["material", "labor"] as const
export type EstimateComponentKind = (typeof ESTIMATE_COMPONENT_KINDS)[number]

export const RATE_SOURCES = ["price-book", "contract", "quote"] as const
export type RateSource = (typeof RATE_SOURCES)[number]

export const ROUNDING_MODES = ["half-up", "half-even", "floor", "ceil"] as const
export type RoundingMode = (typeof ROUNDING_MODES)[number]

export interface EstimateComponent {
  id: string
  kind: EstimateComponentKind
  /** amount of this component per unit of the measured quantity (> 0) */
  quantityPerUnit: number
  unit: string
  /** waste/loss allowance in percent (≥ 0), applied as × (1 + wastePct/100) */
  wastePct?: number
  /**
   * Productivity factor — SEMANTICS (deliberate, documented decision):
   * a MULTIPLIER on team productivity, "units of output per labor-hour team
   * equivalent", where > 1 means a MORE productive crew that needs LESS input.
   * The component amount is DIVIDED by it:
   *
   *     amount = value × quantityPerUnit × (1 + wastePct/100) / productivityFactor
   *     (i.e. laborHours = baseHours / productivityFactor)
   *
   * Default 1 (no adjustment). Must be finite > 0. Intended for `kind:
   * "labor"` components; it is applied wherever present so a future
   * machine-efficiency factor on a material component behaves the same way.
   */
  productivityFactor?: number
}

export interface Assembly {
  id: string
  name: string
  components: EstimateComponent[]
}

export interface Rate {
  id: string
  currency: string
  unitPrice: number
  effectiveFrom?: string
  /** engineer-approved provenance of the price — never an agent guess */
  source: RateSource
}

export interface RoundingRule {
  mode: RoundingMode
  decimals: number
}

export interface EstimateLine {
  id: string
  quantityId: string
  assemblyId: string
  rateId: string
  currency: string
  lineTotal: number
}

// ---------------------------------------------------------------------------
// Estimating — explicit, deterministic rounding
// ---------------------------------------------------------------------------

interface DecimalParts {
  negative: boolean
  /** integer part, unsigned, no leading zeros ("0" for |value| < 1) */
  int: string
  /** fraction part, no trailing zeros ("" when |value| is an integer) */
  frac: string
}

/** Expand exponential notation ("1.5e-7", "-2e+21") into plain decimal form. */
function expandExponential(s: string): string {
  const ePos = s.search(/[eE]/)
  const mantissa = s.slice(0, ePos)
  const exponent = Number.parseInt(s.slice(ePos + 1), 10)
  const negative = mantissa.startsWith("-")
  const digits = mantissa.replace("-", "").replace(".", "")
  // where the decimal point falls inside `digits`
  const point = digits.length + exponent
  let out: string
  if (point <= 0) {
    out = `0.${"0".repeat(-point)}${digits}`
  } else if (point >= digits.length) {
    out = digits + "0".repeat(point - digits.length)
  } else {
    out = `${digits.slice(0, point)}.${digits.slice(point)}`
  }
  return negative ? `-${out}` : out
}

/**
 * Decompose a finite number into its SHORTEST round-trip decimal parts —
 * exactly what `String(value)` prints (≤ 17 significant digits, expanded when
 * String chooses exponential notation).
 *
 * Rounding decisions in `roundTo` are made on this decimal form rather than on
 * scaled IEEE-754 arithmetic, because binary artifacts would otherwise corrupt
 * decimal-intuitive half-way cases: `2.345 * 100 === 234.50000000000003` but
 * `2.675 * 100 === 267.49999999999997` — naive `Math.round(2.675 * 100) / 100`
 * yields 2.67 although the decimal 2.675 must round half-up to 2.68. Parsing
 * the shortest representation ("2.675") restores the decimal meaning the
 * engineer entered. This is deterministic: the shortest representation of a
 * given double is unique.
 */
function decimalParts(value: number): DecimalParts {
  let s = String(value)
  if (s.includes("e") || s.includes("E")) s = expandExponential(s)
  const negative = s.startsWith("-")
  const unsigned = negative ? s.slice(1) : s
  const dot = unsigned.indexOf(".")
  const int = dot === -1 ? unsigned : unsigned.slice(0, dot)
  const frac = dot === -1 ? "" : unsigned.slice(dot + 1)
  return { negative, int: int === "" ? "0" : int, frac }
}

/**
 * Round `value` to `rule.decimals` decimal places (0–15) using `rule.mode`.
 *
 * SEMANTICS (documented, deterministic):
 *  - "half-up": ties and beyond round AWAY FROM ZERO — 2.345 → 2.35,
 *    -2.345 → -2.35 (the usual estimating convention)
 *  - "half-even": exact ties round to the even last digit (banker's
 *    rounding); anything beyond a tie rounds away from zero
 *  - "floor": toward negative infinity — roundTo(-2.341, {floor,2}) = -2.35
 *  - "ceil":  toward positive infinity — roundTo(2.341, {ceil,2})  = 2.35
 *  - a value already at or below the target precision is returned unchanged
 *  - the decision is made on the shortest decimal representation (see
 *    `decimalParts`), so 1.005 → 1.01 and 2.675 → 2.68 under half-up
 *  - results are exact within double precision: the final value is rebuilt as
 *    `signedInteger / 10^decimals` with plain IEEE-754 arithmetic
 *  - non-finite input throws `LedgerError` (never NaN, never silent)
 */
export function roundTo(value: number, rule: RoundingRule): number {
  if (!Number.isFinite(value)) {
    throw new LedgerError(`roundTo: expected a finite number, got ${String(value)}`)
  }
  if (!Number.isInteger(rule.decimals) || rule.decimals < 0 || rule.decimals > 15) {
    throw new LedgerError(
      `roundTo: decimals must be an integer between 0 and 15, got ${String(rule.decimals)}`,
    )
  }
  if (!(ROUNDING_MODES as readonly string[]).includes(rule.mode)) {
    throw new LedgerError(`roundTo: unknown rounding mode ${JSON.stringify(rule.mode)}`)
  }

  const { negative, int, frac } = decimalParts(value)
  if (frac.length <= rule.decimals) return value

  const keep = frac.slice(0, rule.decimals)
  const rest = frac.slice(rule.decimals)
  const firstRest = rest.charCodeAt(0) - 48
  const restHasNonZero = /[1-9]/.test(rest)

  let bump: boolean
  switch (rule.mode) {
    case "half-up":
      bump = firstRest >= 5
      break
    case "half-even": {
      if (firstRest > 5) bump = true
      else if (firstRest < 5) bump = false
      else {
        // firstRest === 5: anything beyond the tie (a non-zero digit after it)
        // rounds away from zero; an exact tie goes to the even neighbour, so
        // the last kept digit decides (2.5→2, 3.5→4, 0.125→0.12, 0.135→0.14)
        const beyondTie = /[1-9]/.test(rest.slice(1))
        const lastKept = (int + keep).slice(-1)
        bump = beyondTie || Number(lastKept) % 2 === 1
      }
      break
    }
    case "floor":
      bump = negative && restHasNonZero
      break
    case "ceil":
      bump = !negative && restHasNonZero
      break
  }

  const factor = 10 ** rule.decimals
  const scaled = Number(int + keep) + (bump ? 1 : 0)
  const result = scaled / factor
  const signed = negative ? -result : result
  // normalize -0 (e.g. roundTo(-0.04, {half-up,1})) so callers never see it
  return signed === 0 ? 0 : signed
}

// ---------------------------------------------------------------------------
// Estimating — deterministic line arithmetic
// ---------------------------------------------------------------------------

function requireFinite(name: string, v: number, where: string): void {
  if (!Number.isFinite(v)) {
    throw new LedgerError(`${where}: ${name} must be a finite number, got ${String(v)}`)
  }
}

/**
 * Compute the total of one estimate line. DETERMINISTIC AND RE-RUNNABLE: the
 * same quantity, assembly, rates and rounding rule always yield the same
 * number (ADR-0006 — no LLM arithmetic, no ambient state, no clock).
 *
 * DOCUMENTED SEMANTICS:
 *
 * 1. Component amounts, in `assembly.components` array order:
 *
 *        amount = qty.value × quantityPerUnit × (1 + wastePct/100)
 *                                        / (productivityFactor ?? 1)
 *
 *    The productivity factor is a team-productivity multiplier where >1 means
 *    "more output per labor-hour" → LESS input needed, hence the division
 *    (laborHours = baseHours / productivityFactor). See the field doc on
 *    `EstimateComponent.productivityFactor`.
 *
 * 2. Component cost = roundTo(amount × rate.unitPrice, rounding) — the rate
 *    is looked up in `rates` BY COMPONENT ID; a missing rate throws
 *    `LedgerError` (deterministic failure, never a guessed price, never NaN).
 *
 * 3. Line total = roundTo(Σ component costs, rounding) — each component is
 *    rounded to the line precision FIRST, then the sum is rounded again.
 *    This is the documented rounding order: it matches how priced BOQ lines
 *    are added up and keeps per-component figures consistent with the line.
 *    (If the order were sum-then-round-once, two lines of 0.005 would total
 *    0.01 instead of the 0.02 produced here.)
 *
 * Domain validation (all failures throw `LedgerError` with a clear message):
 *  - `qty.value` must be a finite number > 0 (a zero/negative quantity is not
 *    a ledger record)
 *  - every component needs a non-empty id, finite quantityPerUnit > 0,
 *    wastePct (when present) ≥ 0 and productivityFactor (when present) > 0
 *  - every used rate needs a finite unitPrice ≥ 0 and a non-empty currency,
 *    and all used rates must share one currency (EUR + USD is a modeling
 *    error, not a number)
 */
export function estimateLineTotal(
  qty: { value: number },
  assembly: Assembly,
  rates: Record<string, Rate>,
  rounding: RoundingRule,
): number {
  const where = "estimateLineTotal"
  if (qty === null || qty === undefined || !Number.isFinite(qty.value) || qty.value <= 0) {
    throw new LedgerError(
      `${where}: quantity value must be a finite number > 0, got ${
        qty ? String(qty.value) : "missing quantity"
      }`,
    )
  }
  if (
    assembly === null ||
    assembly === undefined ||
    !Array.isArray(assembly.components) ||
    assembly.components.length === 0
  ) {
    throw new LedgerError(
      `${where}: assembly ${assembly?.id ?? "?"} must have at least one component`,
    )
  }

  let lineCurrency: string | undefined
  let total = 0

  for (const component of assembly.components) {
    if (component === null || component === undefined) {
      throw new LedgerError(`${where}: assembly ${assembly.id} contains a null component`)
    }
    if (typeof component.id !== "string" || component.id === "") {
      throw new LedgerError(`${where}: assembly ${assembly.id} contains a component without id`)
    }
    requireFinite("quantityPerUnit", component.quantityPerUnit, `${where} (component ${component.id})`)
    if (component.quantityPerUnit <= 0) {
      throw new LedgerError(
        `${where}: component ${component.id} quantityPerUnit must be > 0, got ${String(component.quantityPerUnit)}`,
      )
    }
    if (component.wastePct !== undefined) {
      requireFinite("wastePct", component.wastePct, `${where} (component ${component.id})`)
      if (component.wastePct < 0) {
        throw new LedgerError(
          `${where}: component ${component.id} wastePct must be ≥ 0, got ${String(component.wastePct)}`,
        )
      }
    }
    if (component.productivityFactor !== undefined) {
      requireFinite(
        "productivityFactor",
        component.productivityFactor,
        `${where} (component ${component.id})`,
      )
      if (component.productivityFactor <= 0) {
        throw new LedgerError(
          `${where}: component ${component.id} productivityFactor must be > 0, got ${String(component.productivityFactor)}`,
        )
      }
    }

    const rate = rates[component.id]
    if (rate === null || rate === undefined) {
      throw new LedgerError(
        `${where}: missing rate for component "${component.id}" (${component.kind}) — rates are keyed by component id`,
      )
    }
    requireFinite("rate.unitPrice", rate.unitPrice, `${where} (component ${component.id})`)
    if (rate.unitPrice < 0) {
      throw new LedgerError(
        `${where}: rate ${rate.id} unitPrice must be ≥ 0, got ${String(rate.unitPrice)}`,
      )
    }
    if (typeof rate.currency !== "string" || rate.currency === "") {
      throw new LedgerError(`${where}: rate ${rate.id} must declare a non-empty currency`)
    }
    if (lineCurrency === undefined) lineCurrency = rate.currency
    else if (rate.currency !== lineCurrency) {
      throw new LedgerError(
        `${where}: mixed currencies in one line (${lineCurrency} vs ${rate.currency} for component ${component.id})`,
      )
    }

    // Plain IEEE-754 arithmetic with one explicit rounding step per component.
    const wasteMultiplier = 1 + (component.wastePct ?? 0) / 100
    const productivityDivisor = component.productivityFactor ?? 1
    const amount = (qty.value * component.quantityPerUnit * wasteMultiplier) / productivityDivisor
    const componentCost = roundTo(amount * rate.unitPrice, rounding)
    total += componentCost
  }

  return roundTo(total, rounding)
}
