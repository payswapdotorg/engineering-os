"use client"

/**
 * Artifact workspace dialogs: register (rev 1) + full detail view
 * (revisions, relations, approvals, uploads with staleness cascade feedback).
 */
import { CircleAlert, Download, FileUp, Info, Link2, ShieldCheck, Upload } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import {
  apiJson,
  apiUpload,
  useApi,
  type ArtifactDetail,
  type ArtifactListItem,
  type RevisionUploadResult,
} from "@/components/product/api"
import { ApprovalBadge, KindBadge, RelationBadge, StalenessBadge } from "@/components/product/badges"
import { formatDate, humanBytes, relTime, shortHash, RELATION_HELP } from "@/components/product/format"
import { CopyButton, EmptyState, ErrorState, RowSkeleton } from "@/components/product/parts"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { ARTIFACT_KINDS, detectArtifactKind } from "@/lib/artifact-meta"
import { RELATION_TYPES } from "@/core"

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

function filenameBase(name: string): string {
  const idx = name.lastIndexOf(".")
  return idx > 0 ? name.slice(0, idx) : name
}

// ---------------------------------------------------------------------------
// Register artifact (creates the artifact + revision 1)
// ---------------------------------------------------------------------------

export function RegisterArtifactDialog({
  projectId,
  open,
  onOpenChange,
  onRegistered,
}: {
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onRegistered: () => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [name, setName] = useState("")
  const [kind, setKind] = useState<string>("")
  const [note, setNote] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) {
      setFile(null)
      setName("")
      setKind("")
      setNote("")
      if (fileRef.current) fileRef.current.value = ""
    }
  }, [open])

  const pickFile = (f: File | null) => {
    setFile(f)
    if (f) {
      if (name.trim().length === 0) setName(filenameBase(f.name))
      if (kind.length === 0 || kind === "other") setKind(detectArtifactKind(f.name).kind)
    }
  }

  const submit = async () => {
    if (!file || submitting) return
    if (file.size > MAX_UPLOAD_BYTES) {
      const mb = (file.size / (1024 * 1024)).toFixed(1)
      toast.error(`File is ${mb} MB — uploads above 100 MB are rejected in Phase 1`)
      return
    }
    setSubmitting(true)
    try {
      const form = new FormData()
      form.set("file", file)
      form.set("name", name.trim().length > 0 ? name.trim() : filenameBase(file.name))
      if (kind) form.set("kind", kind)
      if (note.trim().length > 0) form.set("note", note.trim())
      const data = await apiUpload<{ artifact: ArtifactListItem }>(`/api/projects/${projectId}/artifacts`, form)
      toast.success(`Artifact "${data.artifact.name}" registered (r1 · ${humanBytes(data.artifact.latestRevision?.sizeBytes ?? 0)})`)
      onOpenChange(false)
      onRegistered()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not register the artifact")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Register artifact</DialogTitle>
          <DialogDescription>
            The exact file bytes are stored in the local content-addressed store and anchored by
            their SHA-256 hash as revision 1.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="artifact-file">File</Label>
            <Input
              ref={fileRef}
              id="artifact-file"
              type="file"
              required
              aria-label="Artifact file"
              onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
            />
            <p className="text-xs text-muted-foreground">Max 100 MB per upload (Phase 1).</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="artifact-name">Name</Label>
            <Input
              id="artifact-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Defaults to the file name"
              maxLength={120}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="artifact-kind">Kind</Label>
            <Select value={kind} onValueChange={setKind}>
              <SelectTrigger id="artifact-kind" aria-label="Artifact kind">
                <SelectValue placeholder="Detected from file name" />
              </SelectTrigger>
              <SelectContent>
                {ARTIFACT_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {k}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="artifact-note">Note</Label>
            <Input
              id="artifact-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Issued for coordination (optional)"
              maxLength={500}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!file || submitting}>
              {submitting ? "Registering…" : "Register artifact"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Artifact detail
// ---------------------------------------------------------------------------

function RevisionRow({ rev }: { rev: ArtifactDetail["artifact"]["revisions"][number] }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b py-2.5 last:border-0">
      <Badge variant="outline" className="font-mono">r{rev.revNumber}</Badge>
      <ApprovalBadge state={rev.approvalState} />
      <StalenessBadge state={rev.staleness} subtle />
      <span className="font-mono text-xs text-muted-foreground" title={rev.contentHash}>
        {shortHash(rev.contentHash)}
      </span>
      <span className="font-mono text-xs text-muted-foreground">{humanBytes(rev.sizeBytes)}</span>
      <span className="text-xs text-muted-foreground">by {rev.uploadedBy}</span>
      {rev.note ? <span className="text-xs italic text-muted-foreground">“{rev.note}”</span> : null}
      <span className="text-xs text-muted-foreground" title={rev.createdAt}>
        {formatDate(rev.createdAt)}
      </span>
      <span className="ml-auto flex items-center gap-1">
        <span className="mr-1 hidden font-mono text-xs text-muted-foreground sm:inline">
          {rev.mimeType ?? "application/octet-stream"}
        </span>
        <Button asChild variant="outline" size="sm" className="h-8">
          <a href={`/api/revisions/${rev.id}/download`} download aria-label={`Download revision r${rev.revNumber}`}>
            <Download aria-hidden /> Download
          </a>
        </Button>
      </span>
    </li>
  )
}

export function ArtifactDetailDialog({
  artifactId,
  siblings,
  open,
  onOpenChange,
  onChanged,
}: {
  artifactId: string
  siblings: ArtifactListItem[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onChanged: () => void
}) {
  const detail = useApi<ArtifactDetail>(open ? `/api/artifacts/${artifactId}` : null)
  const [uploading, setUploading] = useState(false)
  const [staleMarked, setStaleMarked] = useState<Array<{ name: string; relation: string }>>([])
  const [relationTarget, setRelationTarget] = useState("")
  const [relationType, setRelationType] = useState("")
  const [approveOpen, setApproveOpen] = useState(false)
  const [approving, setApproving] = useState(false)
  const uploadFileRef = useRef<HTMLInputElement>(null)
  const [uploadNote, setUploadNote] = useState("")

  useEffect(() => {
    if (!open) {
      setStaleMarked([])
      setRelationTarget("")
      setRelationType("")
      setUploadNote("")
      if (uploadFileRef.current) uploadFileRef.current.value = ""
    }
  }, [open])

  const artifact = detail.data?.artifact
  const latest = artifact?.latestRevision ?? null

  const refreshAll = () => {
    void detail.refresh()
    onChanged()
  }

  const uploadRevision = async () => {
    const file = uploadFileRef.current?.files?.[0]
    if (!file || uploading) return
    if (file.size > MAX_UPLOAD_BYTES) {
      const mb = (file.size / (1024 * 1024)).toFixed(1)
      toast.error(`File is ${mb} MB — uploads above 100 MB are rejected in Phase 1`)
      return
    }
    setUploading(true)
    try {
      const form = new FormData()
      form.set("file", file)
      if (uploadNote.trim().length > 0) form.set("note", uploadNote.trim())
      const data = await apiUpload<RevisionUploadResult>(`/api/artifacts/${artifactId}/revisions`, form)
      toast.success(`Revision r${data.revision.revNumber} uploaded (hash preserved: ${shortHash(data.revision.contentHash)})`)
      if (uploadFileRef.current) uploadFileRef.current.value = ""
      setUploadNote("")
      if (data.staleMarked.length > 0) {
        setStaleMarked(data.staleMarked.map((s) => ({ name: s.name, relation: s.relation })))
        toast.warning(
          `Staleness cascade: ${data.staleMarked.length} linked artifact${data.staleMarked.length === 1 ? "" : "s"} marked stale (${data.staleMarked.map((s) => s.name).join(", ")})`,
        )
      } else {
        setStaleMarked([])
      }
      refreshAll()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not upload the revision")
    } finally {
      setUploading(false)
    }
  }

  const addRelation = async () => {
    if (!relationTarget || !relationType) return
    try {
      await apiJson(`/api/artifacts/${artifactId}/links`, "POST", {
        toArtifactId: relationTarget,
        relationType: relationType,
      })
      const targetName = siblings.find((s) => s.id === relationTarget)?.name ?? "artifact"
      toast.success(`Relation "${relationType}" → ${targetName} created`)
      setRelationTarget("")
      setRelationType("")
      refreshAll()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create the relation")
    }
  }

  const approveLatest = async () => {
    if (approving) return
    setApproving(true)
    try {
      const res = await apiJson<{ approved: boolean; revNumber: number; supersededRev: number | null }>(
        `/api/artifacts/${artifactId}/approve`,
        "POST",
        {},
      )
      toast.success(
        res.supersededRev
          ? `Revision r${res.revNumber} approved — r${res.supersededRev} superseded`
          : `Revision r${res.revNumber} approved`,
      )
      refreshAll()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not approve the revision")
    } finally {
      setApproving(false)
      setApproveOpen(false)
    }
  }

  const approveDisabledReason =
    !latest
      ? "No revisions yet"
      : latest.approvalState === "approved"
        ? "Already approved — supersede by approving a newer revision"
        : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2 pr-6">
            <FileUp className="size-5 text-orange-700 dark:text-orange-400" aria-hidden />
            <span className="truncate">{artifact?.name ?? "Artifact"}</span>
            {artifact ? <KindBadge kind={artifact.kind} /> : null}
          </DialogTitle>
          <DialogDescription>
            Hash-anchored revision history, typed relations and approvals. Nothing is overwritten —
            new revisions are additive and downstream staleness is surfaced, never auto-recomputed.
          </DialogDescription>
        </DialogHeader>

        {detail.error ? (
          <ErrorState message={detail.error} onRetry={() => void detail.refresh()} />
        ) : !artifact ? (
          <div className="py-6">
            <RowSkeleton cols={3} />
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            {/* Metadata */}
            <section aria-label="Artifact metadata" className="rounded-lg border p-4">
              <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
                <div className="flex items-center gap-2">
                  <dt className="text-xs text-muted-foreground">ID</dt>
                  <dd className="flex min-w-0 items-center gap-1">
                    <span className="truncate font-mono text-xs">{artifact.id}</span>
                    <CopyButton text={artifact.id} label="Copy artifact id" />
                  </dd>
                </div>
                <div className="flex items-center gap-2">
                  <dt className="text-xs text-muted-foreground">Latest hash</dt>
                  <dd className="flex min-w-0 items-center gap-1">
                    <span className="truncate font-mono text-xs" title={latest?.contentHash}>
                      {latest ? shortHash(latest.contentHash) : "—"}
                    </span>
                    {latest ? <CopyButton text={latest.contentHash} label="Copy sha256" /> : null}
                  </dd>
                </div>
                <div className="flex items-center gap-2">
                  <dt className="text-xs text-muted-foreground">Size</dt>
                  <dd className="font-mono text-xs">{latest ? humanBytes(latest.sizeBytes) : "—"}</dd>
                </div>
                <div className="flex items-center gap-2">
                  <dt className="text-xs text-muted-foreground">MIME</dt>
                  <dd className="truncate font-mono text-xs">{latest?.mimeType ?? "—"}</dd>
                </div>
                <div className="flex items-center gap-2">
                  <dt className="text-xs text-muted-foreground">Revisions</dt>
                  <dd className="font-mono text-xs">{artifact._count?.revisions ?? artifact.revisions.length}</dd>
                </div>
                <div className="flex items-center gap-2">
                  <dt className="text-xs text-muted-foreground">Updated</dt>
                  <dd className="text-xs" title={artifact.updatedAt}>
                    {relTime(artifact.updatedAt)}
                  </dd>
                </div>
              </dl>
            </section>

            {/* Staleness cascade feedback */}
            {staleMarked.length > 0 ? (
              <Alert>
                <CircleAlert aria-hidden />
                <AlertTitle>Staleness cascade</AlertTitle>
                <AlertDescription>
                  This change marked {staleMarked.length} linked artifact
                  {staleMarked.length === 1 ? "" : "s"} <strong>stale</strong>:{" "}
                  {staleMarked.map((s) => `${s.name} (${s.relation})`).join(", ")}. Recomputation is an
                  explicit reviewed workflow — downstream outputs are never silently overwritten.
                </AlertDescription>
              </Alert>
            ) : null}

            {/* Revision history */}
            <section aria-label="Revision history">
              <h3 className="mb-2 text-sm font-semibold">Revisions</h3>
              {artifact.revisions.length === 0 ? (
                <EmptyState title="No revisions" description="This artifact has no stored content." />
              ) : (
                <ul className="eos-scroll max-h-64 overflow-y-auto rounded-lg border px-4">
                  {artifact.revisions.map((rev) => (
                    <RevisionRow key={rev.id} rev={rev} />
                  ))}
                </ul>
              )}
            </section>

            <Separator />

            {/* Upload new revision */}
            <section aria-label="Upload new revision">
              <h3 className="mb-2 text-sm font-semibold">Upload new revision</h3>
              <form
                className="flex flex-wrap items-end gap-3"
                onSubmit={(e) => {
                  e.preventDefault()
                  void uploadRevision()
                }}
              >
                <div className="min-w-[220px] flex-1 space-y-2">
                  <Label htmlFor="revision-file">File</Label>
                  <Input id="revision-file" ref={uploadFileRef} type="file" required aria-label="Revision file" />
                </div>
                <div className="min-w-[200px] flex-1 space-y-2">
                  <Label htmlFor="revision-note">Note</Label>
                  <Input
                    id="revision-note"
                    value={uploadNote}
                    onChange={(e) => setUploadNote(e.target.value)}
                    placeholder="What changed? (optional)"
                    maxLength={500}
                  />
                </div>
                <Button type="submit" disabled={uploading}>
                  <Upload aria-hidden /> {uploading ? "Uploading…" : "Upload"}
                </Button>
              </form>
            </section>

            <Separator />

            {/* Add relation */}
            <section aria-label="Add relation">
              <h3 className="mb-2 text-sm font-semibold">Add relation</h3>
              <form
                className="flex flex-wrap items-end gap-3"
                onSubmit={(e) => {
                  e.preventDefault()
                  void addRelation()
                }}
              >
                <div className="min-w-[220px] flex-1 space-y-2">
                  <Label htmlFor="relation-target">Target artifact</Label>
                  <Select value={relationTarget} onValueChange={setRelationTarget}>
                    <SelectTrigger id="relation-target" aria-label="Target artifact">
                      <SelectValue placeholder="Pick an artifact in this project" />
                    </SelectTrigger>
                    <SelectContent>
                      {siblings
                        .filter((s) => s.id !== artifact.id)
                        .map((s) => (
                          <SelectItem key={s.id} value={s.id}>
                            {s.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="min-w-[220px] flex-1 space-y-2">
                  <Label htmlFor="relation-type">Relation</Label>
                  <Select value={relationType} onValueChange={setRelationType}>
                    <SelectTrigger id="relation-type" aria-label="Relation type">
                      <SelectValue placeholder="Pick a relation" />
                    </SelectTrigger>
                    <SelectContent>
                      {RELATION_TYPES.map((r) => (
                        <SelectItem key={r} value={r}>
                          <span className="font-mono text-xs">{r}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button type="submit" disabled={!relationTarget || !relationType}>
                  <Link2 aria-hidden /> Link
                </Button>
              </form>
              {relationType ? (
                <p
                  className={`mt-2 flex items-start gap-2 text-xs ${RELATION_HELP[relationType]?.impact ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}`}
                >
                  <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  {RELATION_HELP[relationType]?.text}
                </p>
              ) : null}
            </section>

            <Separator />

            {/* Approve latest */}
            <section aria-label="Approval" className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold">Approve latest revision</h3>
                <p className="text-xs text-muted-foreground">
                  {latest
                    ? `Approving r${latest.revNumber} records a human approval and supersedes any previously approved revision of this artifact.`
                    : "No revisions to approve yet."}
                </p>
              </div>
              {approveDisabledReason ? (
                <Button disabled className="h-9" title={approveDisabledReason}>
                  <ShieldCheck aria-hidden /> Approve
                </Button>
              ) : (
                <Button className="h-9" variant="outline" onClick={() => setApproveOpen(true)}>
                  <ShieldCheck aria-hidden /> Approve r{latest?.revNumber}
                </Button>
              )}
            </section>

            {/* Relations */}
            <section aria-label="Relations">
              <h3 className="mb-2 text-sm font-semibold">Relations</h3>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="rounded-lg border p-3">
                  <p className="mb-2 text-xs font-medium text-muted-foreground">
                    Derives / depends on (links from this artifact)
                  </p>
                  {artifact.linksFrom.length === 0 ? (
                    <p className="px-1 py-3 text-xs text-muted-foreground">No outgoing relations.</p>
                  ) : (
                    <ul className="space-y-2">
                      {artifact.linksFrom.map((link) => (
                        <li key={link.id} className="flex flex-wrap items-center gap-2 text-sm">
                          <span className="truncate">{link.toArtifact?.name ?? link.toArtifactId}</span>
                          <RelationBadge relation={link.relationType} impactHint={RELATION_HELP[link.relationType]?.impact} />
                          <span className="ml-auto text-xs text-muted-foreground" title={link.createdAt}>
                            {relTime(link.createdAt)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="rounded-lg border p-3">
                  <p className="mb-2 text-xs font-medium text-muted-foreground">
                    Affected by changes to (links to this artifact)
                  </p>
                  {artifact.linksTo.length === 0 ? (
                    <p className="px-1 py-3 text-xs text-muted-foreground">No incoming relations.</p>
                  ) : (
                    <ul className="space-y-2">
                      {artifact.linksTo.map((link) => (
                        <li key={link.id} className="flex flex-wrap items-center gap-2 text-sm">
                          <span className="truncate">{link.fromArtifact?.name ?? link.fromArtifactId}</span>
                          <RelationBadge relation={link.relationType} impactHint={RELATION_HELP[link.relationType]?.impact} />
                          <span className="ml-auto text-xs text-muted-foreground" title={link.createdAt}>
                            {relTime(link.createdAt)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </section>
          </div>
        )}

        <AlertDialog open={approveOpen} onOpenChange={setApproveOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Approve revision r{latest?.revNumber}?</AlertDialogTitle>
              <AlertDialogDescription>
                {latest
                  ? `This marks r${latest.revNumber} of "${artifact?.name}" as approved in the append-only audit trail. A previously approved revision of this artifact, if any, will be superseded.`
                  : "No revision selected."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <Button onClick={() => void approveLatest()} disabled={approving}>
                {approving ? "Approving…" : "Approve"}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  )
}
