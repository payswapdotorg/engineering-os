"use client"

/**
 * Small shared building blocks: stat cards, empty states, error retry, copy button.
 */
import { AlertCircle, Check, Copy, Plus, RefreshCw } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

export function StatCard({
  label,
  value,
  hint,
  loading,
  icon: Icon,
}: {
  label: string
  value: string | number
  hint?: string
  loading?: boolean
  icon?: React.ComponentType<{ className?: string }>
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          {Icon ? <Icon className="size-4 text-muted-foreground" aria-hidden /> : null}
        </div>
        {loading ? (
          <Skeleton className="mt-2 h-7 w-16" aria-label={`Loading ${label}`} />
        ) : (
          <p className={cn("mt-1 text-2xl font-semibold tracking-tight", typeof value === "number" && "font-mono tabular-nums")}>
            {value}
          </p>
        )}
        {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </Card>
  )
}

export function EmptyState({
  title,
  description,
  actionLabel,
  onAction,
  icon: Icon,
}: {
  title: string
  description: string
  actionLabel?: string
  onAction?: () => void
  icon?: React.ComponentType<{ className?: string }>
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 py-10 text-center">
      {Icon ? <Icon className="size-6 text-muted-foreground" aria-hidden /> : null}
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
      {actionLabel && onAction ? (
        <Button onClick={onAction} size="sm" className="mt-2 h-9">
          <Plus aria-hidden /> {actionLabel}
        </Button>
      ) : null}
    </div>
  )
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Alert variant="destructive" role="alert">
      <AlertCircle aria-hidden />
      <AlertTitle>Something went wrong</AlertTitle>
      <AlertDescription className="flex flex-wrap items-center gap-2">
        <span>{message}</span>
        {onRetry ? (
          <Button size="sm" variant="outline" className="h-8" onClick={onRetry}>
            <RefreshCw aria-hidden /> Retry
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  )
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-7"
      aria-label={label ?? "Copy to clipboard"}
      title={label ?? "Copy to clipboard"}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          toast.success("Copied to clipboard")
          setTimeout(() => setCopied(false), 1500)
        } catch {
          toast.error("Copy failed — clipboard unavailable")
        }
      }}
    >
      {copied ? <Check className="size-3.5 text-emerald-600" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
    </Button>
  )
}

export function InfoNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs leading-relaxed text-muted-foreground">{children}</p>
  )
}

export function RowSkeleton({ cols }: { cols: number }) {
  return (
    <div className="space-y-2" aria-label="Loading">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4">
          {Array.from({ length: cols }).map((_, j) => (
            <Skeleton key={j} className={cn("h-5 flex-1", j === 0 && "max-w-[220px]")} />
          ))}
        </div>
      ))}
    </div>
  )
}
