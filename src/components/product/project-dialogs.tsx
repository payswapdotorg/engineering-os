"use client"

/**
 * Project-level dialogs: edit metadata (PATCH) and add member (local roster).
 */
import { useState } from "react"
import { toast } from "sonner"

import { apiJson, type Member, type ProjectDetail } from "@/components/product/api"
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
import { Textarea } from "@/components/ui/textarea"
import { TEAM_ROLES } from "@/core"

export function EditProjectDialog({
  project,
  open,
  onOpenChange,
  onSaved,
}: {
  project: ProjectDetail["project"] | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const [name, setName] = useState(project?.name ?? "")
  const [description, setDescription] = useState(project?.description ?? "")
  const [status, setStatus] = useState(project?.status ?? "active")
  const [submitting, setSubmitting] = useState(false)
  const [hydratedFor, setHydratedFor] = useState<string | null>(null)

  // Re-hydrate the form whenever a different project opens the dialog.
  if (project && hydratedFor !== project.id && open) {
    setHydratedFor(project.id)
    setName(project.name)
    setDescription(project.description ?? "")
    setStatus(project.status)
  }
  if (!open && hydratedFor !== null) setHydratedFor(null)

  const submit = async () => {
    if (!project || submitting) return
    setSubmitting(true)
    try {
      await apiJson(`/api/projects/${project.id}`, "PATCH", {
        name: name.trim().length > 0 ? name.trim() : undefined,
        description: description.trim().length > 0 ? description.trim() : null,
        status,
      })
      toast.success("Project updated")
      onOpenChange(false)
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update the project")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit project</DialogTitle>
          <DialogDescription>Update the name, description or status. Changes are audited.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="edit-name">Name</Label>
            <Input id="edit-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-description">Description</Label>
            <Textarea
              id="edit-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              maxLength={2000}
              placeholder="Optional"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-status">Status</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger id="edit-status" aria-label="Project status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">active</SelectItem>
                <SelectItem value="archived">archived</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || name.trim().length === 0}>
              {submitting ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function AddMemberDialog({
  projectId,
  open,
  onOpenChange,
  onAdded,
}: {
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdded: () => void
}) {
  const [name, setName] = useState("")
  const [role, setRole] = useState("editor")
  const [submitting, setSubmitting] = useState(false)

  const submit = async () => {
    if (name.trim().length === 0 || submitting) return
    setSubmitting(true)
    try {
      const data = await apiJson<{ member: Member }>(`/api/projects/${projectId}/members`, "POST", {
        name: name.trim(),
        role,
      })
      toast.success(`Member "${data.member.name}" added as ${data.member.role}`)
      onOpenChange(false)
      setName("")
      setRole("editor")
      onAdded()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not add the member")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Add member</DialogTitle>
          <DialogDescription>
            Local roster entry with a role (owner / editor / viewer). Sign-in shipped in Phase 6 —
            roster changes are gated to the project owner or a global admin, enforced server-side.
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
            <Label htmlFor="member-name">Name</Label>
            <Input
              id="member-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Structural Reviewer"
              maxLength={80}
              required
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="member-role">Role</Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger id="member-role" aria-label="Member role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TEAM_ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={name.trim().length === 0 || submitting}>
              {submitting ? "Adding…" : "Add member"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
