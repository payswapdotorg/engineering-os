/**
 * Stable, prefixed identifiers — e.g. prj_…, art_…, rev_…, lnk_…, evt_…, mem_…, wfl_…
 * (docs/03-data/artifact-graph-schema.md §4)
 */
export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`
}
