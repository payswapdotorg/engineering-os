"use client"

/**
 * Takeoff & Estimating dialogs (W1 lane, Phase 3 slice).
 *
 * Honesty rules every dialog here follows:
 *  - client-side validation mirrors the exact core zod messages
 *    (src/core/ledger.ts) so a pre-flight toast and a server 422 read the same;
 *  - server 422 messages surface verbatim in toasts (never paraphrased away);
 *  - no estimate math is performed client-side — the server resolves rates and
 *    computes line totals; the client only sends the pair (quantity, assembly);
 *  - nothing is applied optimistically: success closes the dialog and the
 *    caller refetches.
 */
import { Boxes, DraftingCompass, Info, Plus, Trash2 } from "lucide-react"
import { useEffect, useState } from "react"
import { toast } from "sonner"

import {
  addEstimateLine,
  createAssembly,
  createEstimate,
  createQuantity,
  createRate,
  deriveQuantities,
  runVectorTakeoff,
  type ArtifactListItem,
  type AssemblyComponentInput,
  type AssemblyRow,
  type EstimateRow,
  type QuantityCreateInput,
  type QuantityRow,
  type RateCreateInput,
} from "@/components/product/api"
import { KindBadge } from "@/components/product/badges"
import { GuardedButton } from "@/components/product/guarded-button"
import { EmptyState, ErrorState, InfoNote, RowSkeleton } from "@/components/product/parts"
import { deriveKind } from "@/engines/adapters/derive-kind"
import {
  ESTIMATE_COMPONENT_KINDS,
  QUANTITY_METHODS,
  QUANTITY_TYPES,
  RATE_SOURCES,
  ROUNDING_MODES,
  type EstimateComponentKind,
  type QuantityMethod,
  type QuantityType,
  type RateSource,
  type RoundingMode,
} from "@/core/ledger"
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Mirrored VERBATIM from src/core/ledger.ts zod messages (keep in sync). */
const MSG_SHEET_REF =
  "drawing-measured quantities require a non-empty sheetRef (drawing sheet / measurement region)"
const MSG_ELEMENT_REF =
  "model-derived quantities require a non-empty elementRef (e.g. #IfcWallGuid)"
const MSG_VALUE =
  "value must be a finite number > 0 (0, negative, NaN and Infinity are not valid ledger records)"

/** Editable per-type unit defaults (m³ for volume, m² for area, …). */
const DEFAULT_UNITS: Record<QuantityType, string> = {
  length: "m",
  area: "m²",
  volume: "m³",
  count: "ea",
  mass: "kg",
  time: "h",
  other: "ls",
}

/**
 * Which derivation path an artifact supports — delegated to the canonical
 * multi-signal detector (src/engines/adapters/derive-kind.ts) so the dialog
 * and the derive route can never drift. The server stays authoritative;
 * this filter only decides which rows to list.
 */
function derivableKind(artifact: ArtifactListItem): "step" | "ifc" | null {
  return deriveKind(
    artifact.latestRevision?.storageKey ?? "",
    artifact.name,
    artifact.latestRevision?.mimeType ?? null,
  )
}

/** Artifact list + fetch state, so the dialogs stay honest about WHY a picker is empty. */
export interface ArtifactSourceState {
  rows: ArtifactListItem[]
  loading: boolean
  error: string | null
  onRetry: () => void
}

// ---------------------------------------------------------------------------
// Record quantity (draft ledger row)
// ---------------------------------------------------------------------------

export function RecordQuantityDialog({
  projectId,
  artifacts,
  assemblies,
  open,
  onOpenChange,
  onCreated,
}: {
  projectId: string
  artifacts: ArtifactSourceState
  assemblies: AssemblyRow[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => void
}) {
  const [artifactId, setArtifactId] = useState("")
  const [method, setMethod] = useState<QuantityMethod>("drawing-measured")
  const [sheetRef, setSheetRef] = useState("")
  const [elementRef, setElementRef] = useState("")
  const [quantityType, setQuantityType] = useState<QuantityType>("length")
  const [value, setValue] = useState("")
  const [unit, setUnit] = useState(DEFAULT_UNITS.length)
  const [scale, setScale] = useState("")
  const [quantityMethod, setQuantityMethod] = useState("")
  const [rulesetId, setRulesetId] = useState("default-takeoff")
  const [rulesetVersion, setRulesetVersion] = useState("0.1")
  const [tradeAssemblyId, setTradeAssemblyId] = useState("none")
  const [createdBy, setCreatedBy] = useState("local-operator")
  const [submitting, setSubmitting] = useState(false)

  // Reset between opens (same pattern as RegisterArtifactDialog).
  useEffect(() => {
    if (!open) {
      setArtifactId("")
      setMethod("drawing-measured")
      setSheetRef("")
      setElementRef("")
      setQuantityType("length")
      setValue("")
      setUnit(DEFAULT_UNITS.length)
      setScale("")
      setQuantityMethod("")
      setRulesetId("default-takeoff")
      setRulesetVersion("0.1")
      setTradeAssemblyId("none")
      setCreatedBy("local-operator")
    }
  }, [open])

  // Only revisions are ledger-addressable — an artifact without one cannot be a source.
  const revisionChoices = artifacts.rows.filter((a) => a.latestRevision !== null)

  const onTypeChange = (next: QuantityType) => {
    setQuantityType(next)
    setUnit(DEFAULT_UNITS[next])
  }

  const submit = async () => {
    if (submitting) return
    const artifact = revisionChoices.find((a) => a.id === artifactId)
    if (!artifact?.latestRevision) {
      toast.error("Pick a source artifact revision — a ledger row always points at one immutable revision")
      return
    }
    if (method === "drawing-measured" && sheetRef.trim() === "") {
      toast.error(MSG_SHEET_REF)
      return
    }
    if (method === "model-derived" && elementRef.trim() === "") {
      toast.error(MSG_ELEMENT_REF)
      return
    }
    const parsedValue = Number(value)
    if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
      toast.error(MSG_VALUE)
      return
    }
    if (unit.trim() === "") {
      toast.error("unit must be a non-empty string (e.g. m, m², m³, ea)")
      return
    }
    if (rulesetId.trim() === "" || rulesetVersion.trim() === "") {
      toast.error("rulesetId and rulesetVersion must be non-empty")
      return
    }

    setSubmitting(true)
    try {
      const input: QuantityCreateInput = {
        sourceArtifactRevisionId: artifact.latestRevision.id,
        quantityType,
        value: parsedValue,
        unit: unit.trim(),
        method,
        rulesetId: rulesetId.trim(),
        rulesetVersion: rulesetVersion.trim(),
        createdBy: createdBy.trim().length > 0 ? createdBy.trim() : "local-operator",
      }
      // Only the method-relevant reference fields travel on the wire, mirroring
      // the core schema (the server re-validates through makeQuantityRecord).
      if (method === "drawing-measured") {
        input.sheetRef = sheetRef.trim()
        if (scale.trim().length > 0) input.scale = scale.trim()
      } else {
        input.elementRef = elementRef.trim()
        if (quantityMethod.trim().length > 0) input.quantityMethod = quantityMethod.trim()
      }
      if (tradeAssemblyId !== "none") input.tradeAssemblyId = tradeAssemblyId

      const data = await createQuantity(projectId, input)
      toast.success(
        `Quantity recorded — ${data.quantity.quantityType} ${data.quantity.value} ${data.quantity.unit} (draft, unverified)`,
      )
      onOpenChange(false)
      onCreated()
    } catch (err) {
      // Server 422s (zod/domain messages) surface verbatim.
      toast.error(err instanceof Error ? err.message : "Could not record the quantity")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Record quantity</DialogTitle>
          <DialogDescription>
            Creates a draft, unverified ledger row pinned to an immutable artifact revision. It still
            needs review before it can feed an estimate.
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
            <Label htmlFor="qty-source">Source artifact revision</Label>
            {artifacts.error ? (
              <ErrorState message={artifacts.error} onRetry={artifacts.onRetry} />
            ) : artifacts.loading ? (
              <RowSkeleton cols={2} />
            ) : (
              <Select value={artifactId} onValueChange={setArtifactId} disabled={revisionChoices.length === 0}>
                <SelectTrigger id="qty-source" aria-label="Source artifact revision">
                  <SelectValue placeholder={revisionChoices.length === 0 ? "No artifact revisions yet" : "Pick an artifact (latest revision)"} />
                </SelectTrigger>
                <SelectContent>
                  {revisionChoices.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name} (r{a.latestRevision?.revNumber} · {a.kind})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {revisionChoices.length === 0 && !artifacts.loading && !artifacts.error ? (
              <p className="text-xs text-muted-foreground">
                Register an artifact first — a ledger row always points at one revision.
              </p>
            ) : null}
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Method</legend>
            <RadioGroup
              value={method}
              onValueChange={(v) => setMethod(v as QuantityMethod)}
              className="grid gap-2 sm:grid-cols-2"
            >
              {QUANTITY_METHODS.map((m) => (
                <Label
                  key={m}
                  htmlFor={`qty-method-${m}`}
                  className="flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 font-normal"
                >
                  <RadioGroupItem id={`qty-method-${m}`} value={m} className="mt-0.5" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{m}</span>
                    <span className="block text-xs text-muted-foreground">
                      {m === "drawing-measured"
                        ? "Measured on a sheet — sheetRef required, scale optional"
                        : "Computed from a model element — elementRef required"}
                    </span>
                  </span>
                </Label>
              ))}
            </RadioGroup>
          </fieldset>

          {method === "drawing-measured" ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="qty-sheetref">
                  Sheet reference <span aria-hidden className="text-destructive">*</span>
                </Label>
                <Input
                  id="qty-sheetref"
                  value={sheetRef}
                  onChange={(e) => setSheetRef(e.target.value)}
                  placeholder="e.g. S-201, region A4"
                  maxLength={200}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="qty-scale">Scale record</Label>
                <Input
                  id="qty-scale"
                  value={scale}
                  onChange={(e) => setScale(e.target.value)}
                  placeholder="e.g. 1:100 @ A1, scale bar B (optional)"
                  maxLength={200}
                />
              </div>
            </>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="qty-elementref">
                  Element reference <span aria-hidden className="text-destructive">*</span>
                </Label>
                <Input
                  id="qty-elementref"
                  value={elementRef}
                  onChange={(e) => setElementRef(e.target.value)}
                  placeholder="e.g. #IfcWall_3xGUID"
                  maxLength={200}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="qty-qmethod">Quantity method</Label>
                <Input
                  id="qty-qmethod"
                  value={quantityMethod}
                  onChange={(e) => setQuantityMethod(e.target.value)}
                  placeholder="e.g. cadquery 2.6.1 via step-geometric (optional)"
                  maxLength={200}
                />
              </div>
            </>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="qty-type">Quantity type</Label>
              <Select value={quantityType} onValueChange={(v) => onTypeChange(v as QuantityType)}>
                <SelectTrigger id="qty-type" aria-label="Quantity type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {QUANTITY_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="qty-value">Value</Label>
              <Input
                id="qty-value"
                type="number"
                step="any"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="> 0"
                aria-label="Quantity value (must be > 0)"
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="qty-unit">Unit</Label>
              <Input
                id="qty-unit"
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                placeholder="Defaults by type — editable"
                maxLength={20}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="qty-createdby">Recorded by</Label>
              <Input id="qty-createdby" value={createdBy} onChange={(e) => setCreatedBy(e.target.value)} maxLength={80} />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="qty-ruleset">Ruleset id</Label>
              <Input id="qty-ruleset" value={rulesetId} onChange={(e) => setRulesetId(e.target.value)} maxLength={80} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="qty-ruleset-version">Ruleset version</Label>
              <Input
                id="qty-ruleset-version"
                value={rulesetVersion}
                onChange={(e) => setRulesetVersion(e.target.value)}
                maxLength={20}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="qty-assembly">Trade assembly (optional)</Label>
            <Select value={tradeAssemblyId} onValueChange={setTradeAssemblyId} disabled={assemblies.length === 0}>
              <SelectTrigger id="qty-assembly" aria-label="Trade assembly (optional)">
                <SelectValue placeholder={assemblies.length === 0 ? "None defined yet" : "None (assign later)"} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None (assign later)</SelectItem>
                {assemblies.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name} — {a.trade}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Recording…" : "Record quantity"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Derive quantities from a model artifact (real engine adapter)
// ---------------------------------------------------------------------------

export function DeriveQuantitiesDialog({
  projectId,
  artifacts,
  open,
  onOpenChange,
  onDerived,
}: {
  projectId: string
  artifacts: ArtifactSourceState
  open: boolean
  onOpenChange: (open: boolean) => void
  onDerived: () => void
}) {
  const [busyId, setBusyId] = useState<string | null>(null)

  const modelArtifacts = artifacts.rows
    .filter((a) => a.latestRevision !== null)
    .map((a) => ({ artifact: a, kind: derivableKind(a) }))
    .filter((entry): entry is { artifact: ArtifactListItem; kind: "step" | "ifc" } => entry.kind !== null)

  const derive = async (artifact: ArtifactListItem) => {
    if (busyId !== null) return
    setBusyId(artifact.id)
    try {
      const data = await deriveQuantities(projectId, artifact.id)
      const count = data.quantities.length
      if (count === 0) {
        toast.info(`Adapter derived 0 quantities from "${artifact.name}" — nothing recorded`)
      } else {
        toast.success(`Derived ${count} draft quantity row${count === 1 ? "" : "s"} from "${artifact.name}" (unverified)`)
      }
      onOpenChange(false)
      onDerived()
    } catch (err) {
      // 422s (unsupported extension, engine unavailable) surface verbatim.
      toast.error(err instanceof Error ? err.message : "Derivation failed")
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Derive quantities from model</DialogTitle>
          <DialogDescription>
            Runs the real geometry-engine adapter (no placeholder values) on the latest revision
            file — the engine, version and adapter script hash go into each row&apos;s provenance.
            Derived rows arrive as <strong>draft, verification unverified</strong> and go through
            review like any hand-measured entry.
          </DialogDescription>
        </DialogHeader>

        {artifacts.error ? (
          <ErrorState message={artifacts.error} onRetry={artifacts.onRetry} />
        ) : artifacts.loading ? (
          <RowSkeleton cols={3} />
        ) : modelArtifacts.length === 0 ? (
          <EmptyState
            icon={Boxes}
            title="No derivable model artifacts"
            description="Register a .step, .stp or .ifc artifact (with at least one revision) in this project first — the model kind is detected from the file type."
          />
        ) : (
          <ul className="eos-scroll max-h-72 space-y-2 overflow-y-auto">
            {modelArtifacts.map(({ artifact, kind }) => (
                <li key={artifact.id} className="flex items-center gap-3 rounded-lg border p-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{artifact.name}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <KindBadge kind={artifact.kind} />
                      <Badge variant="outline" className="font-mono text-[11px] uppercase">
                        {kind}
                      </Badge>
                      {artifact.latestRevision ? <span>r{artifact.latestRevision.revNumber}</span> : null}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    className="h-8"
                    disabled={busyId !== null}
                    onClick={() => void derive(artifact)}
                  >
                    {busyId === artifact.id ? "Deriving…" : "Derive quantities"}
                  </Button>
                </li>
              ))}
          </ul>
        )}
        <InfoNote>
          Unsupported files or a missing engine fail with an honest 422 — nothing is ever faked.
        </InfoNote>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// New assembly (trade recipe with dynamic components)
// ---------------------------------------------------------------------------

interface DraftComponent {
  key: string
  /** client-generated per the pinned contract: cmp_<uuid> */
  id: string
  name: string
  kind: EstimateComponentKind
  quantityPerUnit: string
  unit: string
  wastePct: string
  productivityFactor: string
}

function blankComponent(): DraftComponent {
  return {
    key: crypto.randomUUID(),
    id: `cmp_${crypto.randomUUID()}`,
    name: "",
    kind: "material",
    quantityPerUnit: "",
    unit: "",
    wastePct: "",
    productivityFactor: "",
  }
}

export function NewAssemblyDialog({
  projectId,
  open,
  onOpenChange,
  onCreated,
}: {
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => void
}) {
  const [name, setName] = useState("")
  const [trade, setTrade] = useState("")
  const [rows, setRows] = useState<DraftComponent[]>([blankComponent()])
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open) {
      setName("")
      setTrade("")
      setRows([blankComponent()])
    }
  }, [open])

  const updateRow = (key: string, patch: Partial<DraftComponent>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  // Min 1 component is structural, not just a toast.
  const removeRow = (key: string) =>
    setRows((rs) => (rs.length <= 1 ? rs : rs.filter((r) => r.key !== key)))
  const addRow = () => setRows((rs) => [...rs, blankComponent()])

  const submit = async () => {
    if (submitting) return
    if (name.trim() === "" || trade.trim() === "") {
      toast.error("Assembly name and trade are required")
      return
    }
    const components: AssemblyComponentInput[] = []
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]
      const label = `component ${i + 1}${r.name.trim().length > 0 ? ` (${r.name.trim()})` : ""}`
      if (r.name.trim() === "") {
        toast.error(`${label}: name is required`)
        return
      }
      const qpu = Number(r.quantityPerUnit)
      if (!Number.isFinite(qpu) || qpu <= 0) {
        toast.error(`${label}: quantityPerUnit must be a finite number > 0`)
        return
      }
      if (r.unit.trim() === "") {
        toast.error(`${label}: unit is required (e.g. m³, kg, h)`)
        return
      }
      const component: AssemblyComponentInput = {
        id: r.id,
        kind: r.kind,
        name: r.name.trim(),
        quantityPerUnit: qpu,
        unit: r.unit.trim(),
      }
      if (r.wastePct.trim().length > 0) {
        const waste = Number(r.wastePct)
        if (!Number.isFinite(waste) || waste < 0) {
          toast.error(`${label}: wastePct must be a number ≥ 0`)
          return
        }
        component.wastePct = waste
      }
      if (r.productivityFactor.trim().length > 0) {
        const factor = Number(r.productivityFactor)
        if (!Number.isFinite(factor) || factor <= 0) {
          toast.error(`${label}: productivityFactor must be a number > 0`)
          return
        }
        component.productivityFactor = factor
      }
      components.push(component)
    }

    setSubmitting(true)
    try {
      const data = await createAssembly(projectId, { name: name.trim(), trade: trade.trim(), components })
      toast.success(
        `Assembly "${data.assembly.name}" created with ${components.length} component${components.length === 1 ? "" : "s"}`,
      )
      onOpenChange(false)
      onCreated()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create the assembly")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New assembly</DialogTitle>
          <DialogDescription>
            An assembly is the recipe priced per unit of a measured quantity — materials and labor
            components. Estimate lines pair a quantity with one of these.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="asm-name">Name</Label>
              <Input
                id="asm-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. RC25 strip footing"
                maxLength={120}
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="asm-trade">Trade</Label>
              <Input
                id="asm-trade"
                value={trade}
                onChange={(e) => setTrade(e.target.value)}
                placeholder="e.g. concrete works"
                maxLength={80}
              />
            </div>
          </div>

          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">Components ({rows.length})</legend>
            <ul className="space-y-3">
              {rows.map((row, i) => (
                <li key={row.key} className="rounded-lg border p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-xs font-medium text-muted-foreground">
                      Component {i + 1} <span className="font-mono text-[11px]">{row.id}</span>
                    </p>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      aria-label={`Remove component ${i + 1}`}
                      title={rows.length <= 1 ? "An assembly needs at least one component" : "Remove component"}
                      disabled={rows.length <= 1}
                      onClick={() => removeRow(row.key)}
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                    </Button>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    <div className="space-y-1.5">
                      <Label htmlFor={`cmp-name-${row.key}`} className="text-xs">Name</Label>
                      <Input
                        id={`cmp-name-${row.key}`}
                        value={row.name}
                        onChange={(e) => updateRow(row.key, { name: e.target.value })}
                        placeholder="e.g. concrete C25/30"
                        maxLength={120}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`cmp-kind-${row.key}`} className="text-xs">Kind</Label>
                      <Select
                        value={row.kind}
                        onValueChange={(v) => updateRow(row.key, { kind: v as EstimateComponentKind })}
                      >
                        <SelectTrigger id={`cmp-kind-${row.key}`} aria-label={`Component ${i + 1} kind`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ESTIMATE_COMPONENT_KINDS.map((k) => (
                            <SelectItem key={k} value={k}>
                              {k}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`cmp-qpu-${row.key}`} className="text-xs">Qty per unit</Label>
                      <Input
                        id={`cmp-qpu-${row.key}`}
                        type="number"
                        step="any"
                        value={row.quantityPerUnit}
                        onChange={(e) => updateRow(row.key, { quantityPerUnit: e.target.value })}
                        placeholder="> 0"
                        aria-label={`Component ${i + 1} quantity per unit (must be > 0)`}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`cmp-unit-${row.key}`} className="text-xs">Unit</Label>
                      <Input
                        id={`cmp-unit-${row.key}`}
                        value={row.unit}
                        onChange={(e) => updateRow(row.key, { unit: e.target.value })}
                        placeholder="e.g. m³, kg, h"
                        maxLength={20}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`cmp-waste-${row.key}`} className="text-xs">Waste % (opt.)</Label>
                      <Input
                        id={`cmp-waste-${row.key}`}
                        type="number"
                        step="any"
                        value={row.wastePct}
                        onChange={(e) => updateRow(row.key, { wastePct: e.target.value })}
                        placeholder="≥ 0"
                        aria-label={`Component ${i + 1} waste percent (optional, ≥ 0)`}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`cmp-prod-${row.key}`} className="text-xs">Productivity (opt.)</Label>
                      <Input
                        id={`cmp-prod-${row.key}`}
                        type="number"
                        step="any"
                        value={row.productivityFactor}
                        onChange={(e) => updateRow(row.key, { productivityFactor: e.target.value })}
                        placeholder="> 0"
                        aria-label={`Component ${i + 1} productivity factor (optional, > 0)`}
                      />
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            <Button type="button" variant="outline" className="h-9" onClick={addRow}>
              <Plus aria-hidden /> Add component
            </Button>
            <InfoNote>
              Productivity factor: a multiplier on team productivity — the component amount is
              divided by it (&gt; 1 = more productive crew, less input). Waste percent inflates the
              amount by (1 + waste%/100).
            </InfoNote>
          </fieldset>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Creating…" : "Create assembly"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Add rate (engineer-entered price record)
// ---------------------------------------------------------------------------

export function AddRateDialog({
  projectId,
  assemblies,
  assembliesError,
  open,
  onOpenChange,
  onCreated,
}: {
  projectId: string
  assemblies: AssemblyRow[]
  assembliesError: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => void
}) {
  const components = assemblies.flatMap((a) =>
    a.components.map((c) => ({ component: c, assemblyName: a.name })),
  )
  const [componentId, setComponentId] = useState("")
  const [currency, setCurrency] = useState("GHS")
  const [unitPrice, setUnitPrice] = useState("")
  const [source, setSource] = useState<RateSource>("price-book")
  const [effectiveFrom, setEffectiveFrom] = useState("")
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open) {
      setComponentId("")
      setCurrency("GHS")
      setUnitPrice("")
      setSource("price-book")
      setEffectiveFrom("")
    }
  }, [open])

  const submit = async () => {
    if (submitting) return
    if (componentId === "") {
      toast.error("Pick an assembly component to price")
      return
    }
    const price = Number(unitPrice)
    if (!Number.isFinite(price) || price < 0) {
      toast.error("unitPrice must be a number ≥ 0")
      return
    }
    if (currency.trim() === "") {
      toast.error("currency is required (e.g. GHS)")
      return
    }

    const input: RateCreateInput = {
      componentId,
      currency: currency.trim().toUpperCase(),
      unitPrice: price,
      source,
    }
    if (effectiveFrom.length > 0) input.effectiveFrom = effectiveFrom

    setSubmitting(true)
    try {
      const chosen = components.find((c) => c.component.id === componentId)
      const data = await createRate(projectId, input)
      toast.success(
        `Rate recorded for "${chosen?.component.name ?? data.rate.componentId}" — ${data.rate.currency} ${data.rate.unitPrice} (${data.rate.source})`,
      )
      onOpenChange(false)
      onCreated()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not record the rate")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add rate</DialogTitle>
          <DialogDescription>
            Prices an assembly component. Estimate lines resolve the latest rate per component
            (newest first, preferring effectiveFrom in the past).
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
            <Label htmlFor="rate-component">Assembly component</Label>
            <Select value={componentId} onValueChange={setComponentId} disabled={components.length === 0}>
              <SelectTrigger id="rate-component" aria-label="Assembly component">
                <SelectValue
                  placeholder={
                    components.length === 0
                      ? assembliesError
                        ? "Assemblies unavailable"
                        : "No components yet"
                      : "Pick a component"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {components.map(({ component, assemblyName }) => (
                  <SelectItem key={component.id} value={component.id}>
                    {component.name} — {assemblyName} ({component.kind})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {components.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {assembliesError
                  ? "Assemblies could not be loaded — retry from the Assemblies & Rates tab."
                  : "Create an assembly with components first (Assemblies & Rates tab)."}
              </p>
            ) : null}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="rate-currency">Currency</Label>
              <Input id="rate-currency" value={currency} onChange={(e) => setCurrency(e.target.value)} maxLength={8} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="rate-price">Unit price</Label>
              <Input
                id="rate-price"
                type="number"
                step="any"
                value={unitPrice}
                onChange={(e) => setUnitPrice(e.target.value)}
                placeholder="≥ 0"
                aria-label="Unit price (≥ 0)"
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="rate-source">Source</Label>
              <Select value={source} onValueChange={(v) => setSource(v as RateSource)}>
                <SelectTrigger id="rate-source" aria-label="Rate source">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RATE_SOURCES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="rate-from">Effective from (optional)</Label>
              <Input
                id="rate-from"
                type="date"
                value={effectiveFrom}
                onChange={(e) => setEffectiveFrom(e.target.value)}
              />
            </div>
          </div>

          <div className="flex items-start gap-2 rounded-lg border p-3">
            <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <p className="text-xs leading-relaxed text-muted-foreground">
              Rates are engineer-entered records with an explicit source — agents and adapters never
              create rates (they have no price authority).
            </p>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || components.length === 0}>
              {submitting ? "Saving…" : "Add rate"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// New estimate
// ---------------------------------------------------------------------------

export function NewEstimateDialog({
  projectId,
  open,
  onOpenChange,
  onCreated,
}: {
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (estimate: EstimateRow) => void
}) {
  const [name, setName] = useState("")
  const [currency, setCurrency] = useState("GHS")
  const [overheadPct, setOverheadPct] = useState("0")
  const [profitPct, setProfitPct] = useState("0")
  const [taxPct, setTaxPct] = useState("0")
  const [roundingMode, setRoundingMode] = useState<RoundingMode>("half-up")
  const [roundingDecimals, setRoundingDecimals] = useState("2")
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open) {
      setName("")
      setCurrency("GHS")
      setOverheadPct("0")
      setProfitPct("0")
      setTaxPct("0")
      setRoundingMode("half-up")
      setRoundingDecimals("2")
    }
  }, [open])

  const pctOrToast = (raw: string, label: string): number | null => {
    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || parsed < 0) {
      toast.error(`${label} must be a number ≥ 0`)
      return null
    }
    return parsed
  }

  const submit = async () => {
    if (submitting) return
    if (name.trim() === "") {
      toast.error("Estimate name is required")
      return
    }
    if (currency.trim() === "") {
      toast.error("currency is required (e.g. GHS)")
      return
    }
    const overhead = pctOrToast(overheadPct, "overheadPct")
    if (overhead === null) return
    const profit = pctOrToast(profitPct, "profitPct")
    if (profit === null) return
    const tax = pctOrToast(taxPct, "taxPct")
    if (tax === null) return
    const decimals = Number(roundingDecimals)
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 15) {
      toast.error("rounding decimals must be an integer between 0 and 15")
      return
    }

    setSubmitting(true)
    try {
      const data = await createEstimate(projectId, {
        name: name.trim(),
        currency: currency.trim().toUpperCase(),
        overheadPct: overhead,
        profitPct: profit,
        taxPct: tax,
        roundingMode,
        roundingDecimals: decimals,
      })
      toast.success(`Estimate "${data.estimate.name}" created (${data.estimate.currency}, draft)`)
      onOpenChange(false)
      onCreated(data.estimate)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create the estimate")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New estimate</DialogTitle>
          <DialogDescription>
            Totals are computed server-side with deterministic rounding (src/core/ledger.ts) and
            recomputed on every read — never stored stale.
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
            <Label htmlFor="est-name">Name</Label>
            <Input
              id="est-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Preliminary cost plan"
              maxLength={120}
              autoFocus
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="est-currency">Currency</Label>
              <Input id="est-currency" value={currency} onChange={(e) => setCurrency(e.target.value)} maxLength={8} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="est-rounding-decimals">Rounding decimals</Label>
              <Input
                id="est-rounding-decimals"
                type="number"
                min={0}
                max={15}
                step={1}
                value={roundingDecimals}
                onChange={(e) => setRoundingDecimals(e.target.value)}
              />
            </div>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Percentages (applied to subtotal)</legend>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="est-overhead">Overhead %</Label>
                <Input id="est-overhead" type="number" step="any" value={overheadPct} onChange={(e) => setOverheadPct(e.target.value)} aria-label="Overhead percent (≥ 0)" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="est-profit">Profit %</Label>
                <Input id="est-profit" type="number" step="any" value={profitPct} onChange={(e) => setProfitPct(e.target.value)} aria-label="Profit percent (≥ 0)" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="est-tax">Tax %</Label>
                <Input id="est-tax" type="number" step="any" value={taxPct} onChange={(e) => setTaxPct(e.target.value)} aria-label="Tax percent (≥ 0)" />
              </div>
            </div>
          </fieldset>
          <div className="space-y-2">
            <Label htmlFor="est-rounding-mode">Rounding mode</Label>
            <Select value={roundingMode} onValueChange={(v) => setRoundingMode(v as RoundingMode)}>
              <SelectTrigger id="est-rounding-mode" aria-label="Rounding mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROUNDING_MODES.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Creating…" : "Create estimate"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Add estimate line (server computes the total)
// ---------------------------------------------------------------------------

export function AddEstimateLineDialog({
  estimate,
  quantities,
  assemblies,
  open,
  onOpenChange,
  onCreated,
}: {
  estimate: EstimateRow
  quantities: QuantityRow[]
  assemblies: AssemblyRow[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => void
}) {
  // Superseded quantities are historical — they cannot enter new lines.
  const pickable = quantities.filter((q) => q.status !== "superseded")
  const [quantityId, setQuantityId] = useState("")
  const [assemblyId, setAssemblyId] = useState("")
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open) {
      setQuantityId("")
      setAssemblyId("")
    }
  }, [open])

  const submit = async () => {
    if (submitting) return
    if (quantityId === "") {
      toast.error("Pick a quantity (superseded rows cannot be used)")
      return
    }
    if (assemblyId === "") {
      toast.error("Pick an assembly")
      return
    }
    setSubmitting(true)
    try {
      await addEstimateLine(estimate.id, { quantityId, assemblyId })
      toast.success("Line added — total computed server-side")
      onOpenChange(false)
      onCreated()
    } catch (err) {
      // e.g. "missing rate for component cmp_x (concrete)" surfaces verbatim.
      toast.error(err instanceof Error ? err.message : "Could not add the line")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add line to "{estimate.name}"</DialogTitle>
          <DialogDescription>
            The server resolves the latest rate for every assembly component ({estimate.currency}) and
            computes the line total — this dialog performs no math. A missing rate or a currency
            mismatch is rejected with an explicit 422.
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
            <Label htmlFor="line-quantity">Quantity</Label>
            <Select value={quantityId} onValueChange={setQuantityId} disabled={pickable.length === 0}>
              <SelectTrigger id="line-quantity" aria-label="Quantity">
                <SelectValue placeholder={pickable.length === 0 ? "No usable quantities" : "Pick a quantity"} />
              </SelectTrigger>
              <SelectContent>
                {pickable.map((q) => (
                  <SelectItem key={q.id} value={q.id}>
                    {q.quantityType} · {q.value} {q.unit} · {q.status} · {q.method}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {pickable.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Record quantities in the Quantity Ledger first — superseded rows are historical and
                cannot be used.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Status shown per row — approving the estimate later requires every line&apos;s
                quantity to be approved.
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="line-assembly">Assembly</Label>
            <Select value={assemblyId} onValueChange={setAssemblyId} disabled={assemblies.length === 0}>
              <SelectTrigger id="line-assembly" aria-label="Assembly">
                <SelectValue placeholder={assemblies.length === 0 ? "No assemblies yet" : "Pick an assembly"} />
              </SelectTrigger>
              <SelectContent>
                {assemblies.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name} — {a.trade} ({a.components.length} components)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {assemblies.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Create an assembly first (Assemblies &amp; Rates tab).
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || pickable.length === 0 || assemblies.length === 0}>
              {submitting ? "Adding…" : "Add line"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Supersede estimate (terminal audit-preserving action — confirmation only;
// the workspace owns the transition call, its verbatim 422 surfacing and refetch)
// ---------------------------------------------------------------------------

export function SupersedeEstimateDialog({
  estimate,
  open,
  onOpenChange,
  onConfirm,
}: {
  estimate: EstimateRow
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Supersede estimate</DialogTitle>
          <DialogDescription>
            Superseding "{estimate.name}" is terminal. The estimate stays in the ledger for audit,
            and its lines are frozen and can no longer be edited.
            {estimate.status === "approved"
              ? " It also stops being exportable — only approved estimates can be exported as a BOQ."
              : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={onConfirm}>
            Supersede estimate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}


// ---------------------------------------------------------------------------
// Vector takeoff (Slice 15, roadmap-gap-audit item 1) — REAL vector extraction
// ---------------------------------------------------------------------------

/**
 * Candidate source kinds for vector takeoff: PDF sheets (drawn path operators
 * through pdfplumber) and DXF drawings (per-layer geometry through ezdxf).
 * DWG rows are listed with an honest note — the op refuses them with the
 * documented converter guidance (no open CI-pinnable DWG path exists).
 */
function vectorTakeoffSignal(a: ArtifactListItem): "sheet" | "drawing" | "dwg" | null {
  if (a.latestRevision === null) return null
  const name = a.name.toLowerCase()
  const mime = a.latestRevision.mimeType ?? ""
  if (name.endsWith(".dwg") || mime === "image/vnd.dwg") return "dwg"
  if (name.endsWith(".dxf") || mime === "image/vnd.dxf" || mime === "application/dxf") return "drawing"
  if (name.endsWith(".pdf") || mime === "application/pdf") return "sheet"
  return null
}

export function VectorTakeoffDialog({
  projectId,
  artifacts,
  open,
  onOpenChange,
  onExtracted,
}: {
  projectId: string
  artifacts: ArtifactSourceState
  open: boolean
  onOpenChange: (open: boolean) => void
  onExtracted: () => void
}) {
  const [busyId, setBusyId] = useState<string | null>(null)

  const candidates = artifacts.rows
    .map((a) => ({ artifact: a, signal: vectorTakeoffSignal(a) }))
    .filter((entry): entry is { artifact: ArtifactListItem; signal: "sheet" | "drawing" | "dwg" } => entry.signal !== null)

  const run = async (artifact: ArtifactListItem) => {
    if (busyId !== null) return
    setBusyId(artifact.id)
    try {
      const data = await runVectorTakeoff(projectId, artifact.id)
      const t = data.takeoff
      const measures =
        t.layerCount !== undefined
          ? `${t.layerCount} layer${t.layerCount === 1 ? "" : "s"} · ${t.entityCount ?? 0} entities`
          : `p${t.pageNo ?? 1}: ${t.lineCount ?? 0} lines · ${t.rectCount ?? 0} rects · ${t.curveCount ?? 0} curves · ${t.textCount ?? 0} text spans`
      toast.success(
        `Vector takeoff of "${artifact.name}" — ${measures} (saved as "${t.name}" r${t.revisionNumber ?? "?"}, draft analysis)`,
      )
      onOpenChange(false)
      onExtracted()
    } catch (err) {
      // 422s (raster-only page, no calibration, DWG, non-PDF/non-DXF) surface verbatim.
      toast.error(err instanceof Error ? err.message : "Vector takeoff failed")
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <DraftingCompass aria-hidden className="size-4" /> Vector takeoff
          </DialogTitle>
          <DialogDescription>
            Extract real vector geometry — PDF sheets read their drawn path operators (exact
            coordinates, no click noise); DXF drawings read per-layer line work with exact arc and
            circle math. The extraction is saved as a draft analysis artifact linked to its source;
            record quantities from it through the ledger as you review. Raster-only scans and DWG
            files are refused honestly.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {candidates.length === 0 ? (
            <EmptyState
              icon={DraftingCompass}
              title="No vector sources in this project"
              description="Register a PDF sheet or a DXF drawing first. Vector takeoff reads the real drawn geometry — scans without vector content are refused, never simulated."
            />
          ) : (
            <div className="eos-scroll flex max-h-72 flex-col gap-2 overflow-auto">
              {candidates.map(({ artifact, signal }) => (
                <div
                  key={artifact.id}
                  className="flex items-center gap-3 rounded-lg border p-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{artifact.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {signal === "sheet"
                        ? "PDF sheet — scale from the saved calibration (or pass one explicitly)"
                        : signal === "drawing"
                          ? "DXF drawing — declared mm units, per-layer"
                          : "DWG — refused honestly: convert to DXF first (ODA File Converter / LibreDWG)"}
                    </p>
                  </div>
                  <KindBadge kind={artifact.kind} />
                  <GuardedButton
                    size="sm"
                    className="h-8"
                    disabled={busyId !== null || signal === "dwg"}
                    title={
                      signal === "dwg"
                        ? "DWG is not supported for vector takeoff — convert the drawing to DXF first"
                        : "Run the real vector extraction through the broker"
                    }
                    onClick={() => void run(artifact)}
                  >
                    {busyId === artifact.id ? "Extracting…" : "Extract"}
                  </GuardedButton>
                </div>
              ))}
            </div>
          )}
          <InfoNote>
            Sheet scale resolution: an explicit value wins; otherwise the revision&apos;s saved
            Sheet Measure calibration is used; otherwise the op refuses and asks you to calibrate
            first. Click calibrations carry the recorded ~0.35% browser bias — the extraction
            provenance records which scale produced the numbers.
          </InfoNote>
        </div>
      </DialogContent>
    </Dialog>
  )
}
