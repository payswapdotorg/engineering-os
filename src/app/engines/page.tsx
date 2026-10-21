"use client";

/**
 * Engines & Discovery — the source-verified registry (ADR-0005) plus real
 * detection results. Zero engines installed on this host is a normal, honest
 * state: detection reports it as-is.
 */
import { ExternalLink, Info, Radar, RefreshCw } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

import { apiJson, useApi, type EnginesData, type ProbeRunResult } from "@/components/product/api"
import { StateBadge } from "@/components/product/badges"
import { ErrorState } from "@/components/product/parts"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { relTime } from "@/components/product/format"

function DetectionCell({ probe }: { probe: EnginesData["probes"][string] | undefined }) {
  if (!probe) {
    return <span className="text-xs italic text-muted-foreground">Not probed yet</span>
  }
  if (probe.state === "installed") {
    return (
      <span className="flex flex-wrap items-center gap-1.5">
        <Badge className="border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
          installed
        </Badge>
        {probe.version ? <span className="font-mono text-xs">{probe.version}</span> : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-help text-xs text-muted-foreground underline decoration-dotted underline-offset-2">
              {relTime(probe.probedAt)}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm">
            <p className="font-mono text-xs">{probe.executablePath ?? "path unavailable"}</p>
            {probe.probeOutput ? <pre className="mt-1 max-h-40 overflow-auto font-mono text-xs">{probe.probeOutput}</pre> : null}
          </TooltipContent>
        </Tooltip>
      </span>
    )
  }
  return (
    <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      Not installed
      <span className="text-muted-foreground/70" title={probe.probedAt}>
        · probed {relTime(probe.probedAt)}
      </span>
    </span>
  )
}

export default function EnginesPage() {
  const engines = useApi<EnginesData>("/api/engines")
  const [probing, setProbing] = useState(false)

  const runDiscovery = async () => {
    if (probing) return
    setProbing(true)
    try {
      const data = await apiJson<ProbeRunResult>("/api/engines/probe", "POST")
      toast.info(`Probed ${data.total} engines · ${data.installed} installed`)
      void engines.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Discovery failed")
    } finally {
      setProbing(false)
    }
  }

  const registry = engines.data?.registry ?? []
  const probes = engines.data?.probes ?? {}

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Engines &amp; Discovery</h1>
          <p className="text-sm text-muted-foreground">
            Source-verified open-source engine inventory (ADR-0005) with real PATH / python-module
            probes — an uninstalled engine is reported honestly, never faked.
          </p>
        </div>
        <Button className="h-10" onClick={() => void runDiscovery()} disabled={probing}>
          {probing ? <RefreshCw className="animate-spin" aria-hidden /> : <Radar aria-hidden />}
          {probing ? "Probing…" : "Run discovery"}
        </Button>
      </header>

      {engines.error ? (
        <ErrorState message={engines.error} onRetry={() => void engines.refresh()} />
      ) : engines.loading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      ) : (
        <div className="eos-scroll overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Engine</TableHead>
                <TableHead>Upstream</TableHead>
                <TableHead>License</TableHead>
                <TableHead>Latest stable</TableHead>
                <TableHead>Detection</TableHead>
                <TableHead>Registry state</TableHead>
                <TableHead>Limitations</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {registry.map((engine) => (
                <TableRow key={engine.key}>
                  <TableCell>
                    <div className="flex flex-col gap-0.5">
                      <span className="font-medium">{engine.name}</span>
                      <span className="flex items-center gap-1.5">
                        <Badge variant="outline" className="text-muted-foreground">{engine.domain}</Badge>
                        {!engine.upstream.verified ? (
                          <span className="text-[10px] text-muted-foreground/70">upstream unverified</span>
                        ) : null}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <a
                      href={engine.upstream.canonical}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs underline underline-offset-2 hover:text-foreground"
                      aria-label={`Upstream repository for ${engine.name}`}
                    >
                      repo <ExternalLink className="size-3" aria-hidden />
                    </a>
                  </TableCell>
                  <TableCell>
                    {engine.upstream.licenseSpdx ? (
                      <Badge variant="outline" className="font-mono text-[11px]">{engine.upstream.licenseSpdx}</Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className="font-mono text-xs">{engine.upstream.latestStable ?? "—"}</span>
                  </TableCell>
                  <TableCell>
                    <DetectionCell probe={probes[engine.key]} />
                  </TableCell>
                  <TableCell>
                    <StateBadge state={engine.state} />
                  </TableCell>
                  <TableCell>
                    {engine.limitations.length === 0 ? (
                      <span className="text-xs text-muted-foreground">—</span>
                    ) : (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button variant="ghost" size="icon" className="size-7" aria-label={`Limitations of ${engine.name}`}>
                            <Info className="size-4" aria-hidden />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-sm">
                          <ul className="list-disc pl-4">
                            {engine.limitations.map((l, i) => (
                              <li key={i} className="text-xs">{l}</li>
                            ))}
                          </ul>
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Card>
        <CardContent className="p-4">
          <p className="text-sm text-muted-foreground">
            No engines are installed on this host. The registry is a source-verified plan
            (ADR-0005); adapters execute from Phase 2. “Run discovery” probes your actual PATH and
            python environment and stores the result — it never fabricates an install.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
