"use client"

/**
 * Documents & Deliverables workspace (W1-f lane, Phase 5) — the deliverable
 * register with review states and real document conversion, over the pinned
 * Phase-5 API contracts (docs/00-architecture/phase5-disciplines-contract.md
 * §8/§11).
 *
 * Honesty rules this workspace follows:
 *  - the register lists artifacts of kinds document/report/drawing/pdf plus
 *    any artifact whose file carries a convertible office extension — the
 *    filter is deliberately generous; the route validates for real and its
 *    422s surface VERBATIM in toasts;
 *  - review states come from the EXISTING revision approval machine (draft →
 *    in_review → approved → superseded) — this workspace adds no new states;
 *  - "Convert to PDF" runs the real LibreOffice adapter via the broker route
 *    (POST …/convert-document). Conversion results are stored as derived
 *    artifacts of kind `pdf` linked to their source and appear as register
 *    rows with download links (the same revision download URL the artifact
 *    detail dialog uses);
 *  - the timestamp callout is prominent and honest: PDFs embed creation
 *    timestamps, so re-conversions are NOT idempotent — each run appends a
 *    NEW revision with a different content hash. The register never claims
 *    otherwise.
 */
import { Download, FileCheck2, Files, Info, Loader2, FileText } from "lucide-react"
import { useMemo, useState } from "react"
import { toast } from "sonner"

import {
  convertDocument,
  useApi,
  type ArtifactListItem,
  type DeriveRunResult,
} from "@/components/product/api"
import { ApprovalBadge, KindBadge, StalenessBadge } from "@/components/product/badges"
import { humanBytes, relTime } from "@/components/product/format"
import { EmptyState, ErrorState, InfoNote } from "@/components/product/parts"
import { GuardedButton } from "@/components/product/guarded-button"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// Local constants + helpers
// ---------------------------------------------------------------------------

/** LibreOffice import-filter extensions (contract §5.4 — the route's own list). */
const CONVERTIBLE_EXTS = [
  "odt", "fodt", "docx", "rtf", "txt", "md", "csv", "ods", "fods", "xlsx", "pptx", "odp",
] as const

const DELIVERABLE_KINDS = ["document", "report", "drawing", "pdf"] as const

function extOf(name: string): string {
  const idx = name.lastIndexOf(".")
  return idx > 0 ? name.slice(idx + 1).toLowerCase() : ""
}

/**
 * MIME → convertible extension — the CLIENT mirror of the broker's
 * EXT_BY_MIME (src/engines/adapters/convert-document.ts). Uploads register
 * under extension-LESS names and storage keys never carry extensions, so the
 * recorded revision MIME is the usual convertible signal (the same two-signal
 * resolution the route gate and broker core use — the client table must stay
 * in sync with the server's, like derive-kind.ts mirrors mimeDeriveKind).
 */
const EXT_BY_MIME: Record<string, string> = {
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "application/rtf": "rtf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "application/vnd.oasis.opendocument.presentation": "odp",
}

/** The artifact's convertible-signal extension: from its NAME when it carries
 * one, else from the recorded revision MIME. "" when neither resolves. */
function artifactExtOf(a: { name: string; latestRevision?: { mimeType?: string | null } | null }): string {
  const byName = extOf(a.name)
  if (byName) return byName
  const mime = a.latestRevision?.mimeType
  if (typeof mime === "string") {
    const ext = EXT_BY_MIME[mime]
    if (ext) return ext
  }
  return ""
}

function isConvertibleExt(ext: string): boolean {
  return (CONVERTIBLE_EXTS as readonly string[]).includes(ext)
}

/** Deliverable register membership: pinned kinds OR any convertible extension. */
function isDeliverable(a: ArtifactListItem): boolean {
  if ((DELIVERABLE_KINDS as readonly string[]).includes(a.kind)) return true
  const ext = artifactExtOf(a)
  return ext !== "" && (isConvertibleExt(ext) || ext === "pdf")
}

/** "Convert to PDF" renders on convertible artifacts with a revision, never on PDFs. */
function isConvertible(a: ArtifactListItem): boolean {
  if (!a.latestRevision) return false
  const ext = artifactExtOf(a)
  return ext !== "" && isConvertibleExt(ext)
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

const noop = () => {}

export function DocsWorkspace({
  projectId,
  onMutated,
}: {
  projectId: string
  /** Parent-side cache nudge: conversions create/append artifact revisions the
   *  project-level caches don't observe on their own (useApi is
   *  manual-refresh — the Phase-4 Artifacts-tab lesson, now a standard). */
  onMutated?: () => void
}) {
  const artifacts = useApi<{ artifacts: ArtifactListItem[] }>(`/api/projects/${projectId}/artifacts`)
  const notifyMutated = onMutated ?? noop

  // One conversion in flight at a time — no optimistic updates anywhere.
  const [convertingId, setConvertingId] = useState<string | null>(null)
  /** In-session conversion results keyed by the produced pdf artifact id. */
  const [lastConversions, setLastConversions] = useState<Record<string, DeriveRunResult>>({})

  const rows = useMemo(() => artifacts.data?.artifacts ?? [], [artifacts.data])
  const deliverables = useMemo(() => rows.filter(isDeliverable), [rows])
  const convertibleCount = useMemo(() => deliverables.filter(isConvertible).length, [deliverables])

  const convert = async (artifact: ArtifactListItem) => {
    if (convertingId !== null) return
    setConvertingId(artifact.id)
    try {
      const data = await convertDocument(projectId, artifact.id)
      const pdf = data.pdf
      toast.success(
        `PDF created from "${artifact.name}" — ${pdf.name}${pdf.revisionNumber ? ` r${pdf.revisionNumber}` : ""} (kind pdf, registered as a derived artifact)`,
      )
      setLastConversions((prev) => ({ ...prev, [pdf.artifactId]: pdf }))
      // Cache nudges: the register + Artifacts tab + activity feed all read
      // project-level caches that refresh only on their own triggers.
      void artifacts.refresh()
      notifyMutated()
    } catch (err) {
      // 422s (no import filter, already a PDF, LibreOffice crash) surface
      // verbatim — never paraphrased.
      toast.error(err instanceof Error ? err.message : "Conversion failed")
    } finally {
      setConvertingId(null)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight">
          <Files className="size-4 text-muted-foreground" aria-hidden /> Documents &amp; Deliverables
        </h2>
        <Alert>
          <Info aria-hidden />
          <AlertTitle>Deliverables, review states and honest conversions</AlertTitle>
          <AlertDescription>
            This register lists documents, reports, drawings and converted PDFs. Review states come
            from the existing revision approval machine — nothing is approved here without the
            normal review flow. “Convert to PDF” runs the registered LibreOffice adapter on the
            latest revision and stores the result as a derived <span className="font-mono">pdf</span>{" "}
            artifact linked to its source.
          </AlertDescription>
        </Alert>
      </header>

      <Alert className="border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
        <FileCheck2 aria-hidden />
        <AlertTitle>Conversions embed timestamps</AlertTitle>
        <AlertDescription className="text-amber-900/90 dark:text-amber-300/90">
          PDF files embed their creation time, so converting the same source twice produces two
          different content hashes — re-runs append NEW revisions rather than being idempotent.
          Byte-determinism is honestly not claimed for conversions; every revision is kept for
          provenance.
        </AlertDescription>
      </Alert>

      <section aria-label="Deliverable register" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold tracking-tight">Deliverables ({deliverables.length})</h3>
          <span className="text-xs text-muted-foreground">
            kinds document / report / drawing / pdf (+ convertible office files)
          </span>
          {convertingId !== null ? (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
              <Loader2 className="size-3.5 animate-spin" aria-hidden /> LibreOffice converting…
            </span>
          ) : null}
        </div>

        {artifacts.error ? (
          <ErrorState message={artifacts.error} onRetry={() => void artifacts.refresh()} />
        ) : artifacts.loading ? (
          <div className="rounded-lg border p-4">
            <Skeleton className="mb-2 h-9 w-full" />
            <Skeleton className="mb-2 h-9 w-full" />
            <Skeleton className="h-9 w-2/3" />
          </div>
        ) : deliverables.length === 0 ? (
          <EmptyState
            icon={Files}
            title="No deliverable artifacts yet"
            description="Register documents, reports or drawings in the Artifacts tab — they appear here with their review states. Office files (.docx, .odt, .xlsx, …) can be converted to PDF through the real LibreOffice adapter."
          />
        ) : (
          <div className="eos-scroll max-h-[32rem] overflow-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead className="text-center">Rev</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead>Review state</TableHead>
                  <TableHead>Staleness</TableHead>
                  <TableHead className="text-right">Updated</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {deliverables.map((artifact) => {
                  const rev = artifact.latestRevision
                  const convertible = isConvertible(artifact)
                  const inSession = artifact.id in lastConversions ? lastConversions[artifact.id] : null
                  return (
                    <TableRow key={artifact.id} className={cn(inSession && "bg-accent/40")}>
                      <TableCell className="max-w-[260px] truncate font-medium" title={artifact.id}>
                        {artifact.name}
                      </TableCell>
                      <TableCell>
                        <KindBadge kind={artifact.kind} />
                      </TableCell>
                      <TableCell className="text-center font-mono text-xs">
                        {rev ? `r${rev.revNumber}` : "—"}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {rev ? humanBytes(rev.sizeBytes) : "—"}
                      </TableCell>
                      <TableCell>
                        {rev ? (
                          <ApprovalBadge state={rev.approvalState} />
                        ) : (
                          <span className="text-xs text-muted-foreground">No revisions</span>
                        )}
                      </TableCell>
                      <TableCell>{rev ? <StalenessBadge state={rev.staleness} /> : null}</TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground" title={artifact.updatedAt}>
                        {relTime(artifact.updatedAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        <span className="flex flex-wrap items-center justify-end gap-1.5">
                          {convertible ? (
                            <GuardedButton
                              variant="outline"
                              className="h-9"
                              disabled={convertingId !== null}
                              onClick={() => void convert(artifact)}
                              aria-label={`Convert ${artifact.name} to PDF`}
                            >
                              {convertingId === artifact.id ? (
                                <Loader2 className="animate-spin" aria-hidden />
                              ) : (
                                <FileText aria-hidden />
                              )}
                              {convertingId === artifact.id ? "Converting…" : "Convert to PDF"}
                            </GuardedButton>
                          ) : null}
                          {artifact.kind === "pdf" || extOf(artifact.name) === "pdf" ? (
                            rev ? (
                              <Button asChild variant="outline" className="h-9" title="Download the latest revision">
                                <a
                                  href={`/api/revisions/${rev.id}/download`}
                                  download
                                  aria-label={`Download ${artifact.name} revision r${rev.revNumber}`}
                                >
                                  <Download aria-hidden /> Download
                                </a>
                              </Button>
                            ) : null
                          ) : null}
                        </span>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}

        {!artifacts.error && !artifacts.loading && deliverables.length > 0 && convertibleCount === 0 ? (
          <InfoNote>
            No artifacts in this register carry a convertible office extension — upload or register
            one of {CONVERTIBLE_EXTS.map((e) => `.${e}`).join(", ")} to enable PDF conversion.
          </InfoNote>
        ) : null}

        <InfoNote>
          Review states (draft → in_review → approved) are governed by the same revision approval
          machine as every other artifact — approve or upload revisions from the Artifacts tab. PDF
          rows produced by conversion are derived artifacts: they cite their source through a{" "}
          <span className="font-mono">derived_from</span> link and go stale when the source document
          is revised.
        </InfoNote>
      </section>
    </div>
  )
}
