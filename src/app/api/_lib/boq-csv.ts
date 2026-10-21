/**
 * Pure Bill-of-Quantities CSV builder (Worker 3 lane, Phase-3 hardening).
 *
 * Zero DB access, zero clock access: every byte of output is derived from the
 * caller's input, so `buildBoqCsv` is fully unit-testable and deterministic
 * (only `input.generatedAt` — produced once by the export route — varies).
 *
 * Pinned layout (worklog "Contract B — estimate supersede + BOQ export"),
 * byte-for-byte: LF line endings, EVERY field quoted, UTF-8, no BOM. Numbers
 * render via `String()` (the stored double's natural form — no forced
 * decimals; e.g. 10 stays "10", 2614.8 stays "2614.8"). Embedded double-quotes
 * are escaped per CSV convention (doubled); commas inside fields need no
 * special handling because every field is already quoted.
 */

/** One BOQ row per estimate line (createdAt order; joins resolved by the route). */
export interface BoqLineInput {
  seq: number
  description: string
  /**
   * `null` = the quantity join no longer resolves (row kept for audit; the
   * route never fabricates a 0 in its place). Renders as "unknown".
   */
  quantityValue: number | null
  quantityUnit: string | null
  assemblyName: string
  /** Stored server-computed line total (never recomputed here). */
  lineTotal: number
}

/** Totals as serializeEstimate computes them (reused, never re-implemented). */
export interface BoqTotalsInput {
  subtotal: number
  overhead: number
  profit: number
  tax: number
  grandTotal: number
}

export interface BoqCsvInput {
  projectName: string
  estimateName: string
  currency: string
  /** Rendered plainly in the totals rows: `Overhead (10%)`, never `10.0%`. */
  overheadPct: number
  profitPct: number
  taxPct: number
  totals: BoqTotalsInput
  roundingMode: string
  roundingDecimals: number
  /** ISO-8601 UTC — the ONLY non-deterministic slot; produced once by the route. */
  generatedAt: string
  lines: BoqLineInput[]
}

/** Quote one CSV field (every field is quoted; embedded `"` is doubled). */
function q(field: string): string {
  return `"${field.replace(/"/g, '""')}"`
}

/** Row = comma-joined quoted fields. */
function row(...fields: string[]): string {
  return fields.map(q).join(",")
}

/**
 * Build the pinned BOQ CSV. The "Status" row is always "approved" — the export
 * route gates on it, so the builder is never handed another status (the pinned
 * layout hard-codes that row).
 */
export function buildBoqCsv(input: BoqCsvInput): string {
  const currency = input.currency
  const rows: string[] = []

  // --- meta block -----------------------------------------------------------
  rows.push(row("Engineering OS — Bill of Quantities"))
  rows.push(row("Project", input.projectName))
  rows.push(row("Estimate", input.estimateName))
  rows.push(row("Status", "approved"))
  rows.push(row("Currency", currency))
  rows.push(row("Generated", input.generatedAt))
  rows.push(row(""))

  // --- items table ----------------------------------------------------------
  rows.push(row("Item", "Description", "Quantity", "Unit", "Line total", currency))
  for (const line of input.lines) {
    const quantity =
      line.quantityValue === null ? "unknown" : String(line.quantityValue)
    const unit = line.quantityUnit ?? "unknown"
    rows.push(
      row(
        String(line.seq),
        line.description,
        quantity,
        unit,
        String(line.lineTotal),
        currency,
      ),
    )
  }
  rows.push(row(""))

  // --- totals block (recomputed at export time; deterministic) --------------
  rows.push(row("Subtotal", String(input.totals.subtotal)))
  rows.push(
    row(
      `Overhead (${String(input.overheadPct)}%)`,
      String(input.totals.overhead),
    ),
  )
  rows.push(row(`Profit (${String(input.profitPct)}%)`, String(input.totals.profit)))
  rows.push(row(`Tax (${String(input.taxPct)}%)`, String(input.totals.tax)))
  rows.push(row("Grand total", String(input.totals.grandTotal)))
  rows.push(
    row(
      "Note",
      `Totals recomputed at export time via ${input.roundingMode}@${String(
        input.roundingDecimals,
      )}; deterministic`,
    ),
  )

  return rows.join("\n") + "\n"
}
