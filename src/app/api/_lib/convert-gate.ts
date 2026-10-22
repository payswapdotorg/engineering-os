/**
 * LibreOffice conversion gate for POST …/convert-document (W3-f lane).
 * Private folder: Next.js never maps `_*` folders to routes.
 *
 * Contract §5.4 pins the convertible extensions and the TWO verbatim 422
 * `unsupported` messages byte-for-byte; the broker core (W2-f) defends the
 * same gate on the workflow path. This module is the ROUTE-side copy of the
 * OUTCOME only — the decision logic is the single implementation in
 * src/engines/adapters/convert-document.ts (`conversionExtensionKind` +
 * `convertibleSourceName`), so the route and broker gates can never drift
 * (the original duplicated-extension set did exactly that and missed the
 * office MIME fallbacks — fixed 2026-10-22, recorded in the worklog).
 *
 * Detection mirrors the canonical multi-signal style
 * (src/engines/adapters/derive-kind.ts): real storage keys never carry
 * extensions (`<projectId>/<artifactId>/<revisionId>`), uploads usually
 * register under extension-less names, so the recorded revision MIME type is
 * the usual convertible signal.
 */

import {
  conversionExtensionKind,
  convertibleSourceName,
} from "@/engines/adapters/convert-document"

const PDF_MIME = "application/pdf"

/**
 * One of the three gate outcomes. `kind` decides the route response:
 *  - "already-pdf"      → 422 `artifact "<name>" is already a PDF`
 *  - "not-convertible"  → 422 `artifact "<name>" is not convertible to PDF (no
 *                          LibreOffice import filter for this kind)`
 *  - "convertible"      → run the broker op
 */
export type ConversionGate =
  | { kind: "already-pdf" }
  | { kind: "not-convertible" }
  | { kind: "convertible" }

/** Two-signal gate — the adapter module owns the decision logic (single implementation). */
export function conversionGate(artifactName: string, mimeType: string | null): ConversionGate {
  if (mimeType === PDF_MIME || conversionExtensionKind(artifactName) === "pdf") {
    return { kind: "already-pdf" }
  }
  if (convertibleSourceName(artifactName, mimeType) === null) {
    return { kind: "not-convertible" }
  }
  return { kind: "convertible" }
}

/** Pinned §5.4 messages (byte-identical on the route and broker paths). */
export function alreadyPdfMessage(artifactName: string): string {
  return `artifact "${artifactName}" is already a PDF`
}

export function notConvertibleMessage(artifactName: string): string {
  return `artifact "${artifactName}" is not convertible to PDF (no LibreOffice import filter for this kind)`
}
