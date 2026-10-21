/**
 * Engineering OS — canonical multi-signal detection for quantity derivation.
 *
 * ONE implementation shared by the derive-quantities API route (server) and
 * the Derive-from-model dialog (client) so the two can never drift: an
 * artifact revision is derivable when ANY signal carries the extension/mime —
 * storage key, original artifact name, or stored MIME type. Detection order
 * mirrors reliability: real keys in this content store never carry
 * extensions (`<projectId>/<artifactId>/<revisionId>`), so the extension-
 * bearing artifact name is the usual first hit; the MIME map follows the
 * repo-wide convention in src/lib/artifact-meta.ts (.step/.stp →
 * application/step, .ifc → application/x-step — IFC is ISO 10303-21, the
 * same MIME family as STEP).
 *
 * Pure module: no node imports, safe for client bundles.
 */

export type DeriveKind = "ifc" | "step"

/** Extension-based detection on any single string (key or file name). */
export function extensionDeriveKind(storageKeyOrName: string): DeriveKind | null {
  const lower = storageKeyOrName.toLowerCase()
  if (lower.endsWith(".ifc")) return "ifc"
  if (lower.endsWith(".step") || lower.endsWith(".stp")) return "step"
  return null
}

/** MIME fallback per src/lib/artifact-meta.ts convention. */
export function mimeDeriveKind(mimeType: string | null | undefined): DeriveKind | null {
  if (mimeType === "application/step") return "step"
  if (mimeType === "application/x-step") return "ifc"
  return null
}

/**
 * Full detection across all three signals. Null means "the bridge says this
 * revision is not derivable" — callers must surface that honestly (422
 * `unsupported`), never guess a kind.
 */
export function deriveKind(
  storageKey: string,
  artifactName: string,
  mimeType: string | null | undefined,
): DeriveKind | null {
  return (
    extensionDeriveKind(storageKey) ??
    extensionDeriveKind(artifactName) ??
    mimeDeriveKind(mimeType)
  )
}
