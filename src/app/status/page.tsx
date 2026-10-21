import { readFile } from "node:fs/promises"
import path from "node:path"
import ReactMarkdown from "react-markdown"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ExternalLink, FileWarning, Map as MapIcon } from "lucide-react"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

export const dynamic = "force-dynamic"

const STATUS_DOC_REL = "docs/07-release/implementation-status.md"
const REPO_URL = "https://github.com/payswapdotorg/engineering-os"
const DOC_BASE_DIR = path.posix.dirname(STATUS_DOC_REL)

/**
 * The file's pipe tables need GFM, and remark-gfm is not part of the approved
 * dependency set. Instead of a broken render, markdown blocks and pipe-table
 * blocks are segmented here and tables are rendered as real HTML tables —
 * the content itself is the untouched repository file.
 */
type Block = { type: "md"; lines: string[] } | { type: "table"; rows: string[][] }

function segmentMarkdown(src: string): Block[] {
  const blocks: Block[] = []
  const lines = src.split("\n")
  const isTableRow = (line: string) => line.trim().startsWith("|")
  const isSeparator = (line: string) => /^\|?[\s:|-]+\|?$/.test(line.trim())
  const parseRow = (line: string) =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim())

  let i = 0
  while (i < lines.length) {
    if (isTableRow(lines[i])) {
      const rows: string[][] = []
      while (i < lines.length && isTableRow(lines[i])) {
        if (!isSeparator(lines[i])) rows.push(parseRow(lines[i]))
        i++
      }
      blocks.push({ type: "table", rows })
    } else {
      const mdLines: string[] = []
      while (i < lines.length && !isTableRow(lines[i])) {
        mdLines.push(lines[i])
        i++
      }
      blocks.push({ type: "md", lines: mdLines })
    }
  }
  return blocks.filter(
    (b) => (b.type === "md" ? b.lines.join("").trim().length > 0 : b.rows.length > 0),
  )
}

function renderHref(href: string): string {
  if (/^https?:\/\//.test(href) || href.startsWith("#")) return href
  return `${REPO_URL}/blob/main/${path.posix.normalize(path.posix.join(DOC_BASE_DIR, href))}`
}

const PHASES: Array<{ phase: string; focus: string; exit: string; state: "done" | "in-progress" | "planned" }> = [
  {
    phase: "0",
    focus: "Source-verified audit, architecture, ADRs, capability matrix",
    exit: "Baseline established; ownership map; ADRs for architecture, storage, licensing, engine contract, agent safety",
    state: "done",
  },
  {
    phase: "1",
    focus: "Working product foundation",
    exit: "Installable & launches reliably; persistent projects; real artifact + revision with hash round-trip; engine discovery; visible audit trail",
    state: "in-progress",
  },
  {
    phase: "2",
    focus: "CAD & BIM workflows (FreeCAD, LibreCAD, Bonsai/IfcOpenShell)",
    exit: "Real file import/edit/export with revision comparison; a complete CAD or BIM journey against real files",
    state: "planned",
  },
  {
    phase: "3",
    focus: "Takeoff, estimating, construction controls",
    exit: "Drawing-derived and model-derived quantity workflows, shared ledger, BOQ + schedule links",
    state: "planned",
  },
  {
    phase: "4",
    focus: "Collaboration & agent workflows",
    exit: "Durable tool execution, real adapter calls, approval gates, downstream invalidation, agent workflow with review",
    state: "planned",
  },
  {
    phase: "5",
    focus: "Broader engineering packs (GIS, E/E, structural, CFD, systems, robotics)",
    exit: "Each pack with documented boundary, real execution test, regression suite, useful end-to-end workflow",
    state: "planned",
  },
  {
    phase: "6",
    focus: "Hardening & release readiness",
    exit: "Security/performance/recovery work; repeatable Ubuntu installation + release process",
    state: "planned",
  },
]

function PhaseBadge({ state }: { state: "done" | "in-progress" | "planned" }) {
  if (state === "done")
    return (
      <Badge className="border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
        done
      </Badge>
    )
  if (state === "in-progress")
    return (
      <Badge className="border-amber-300 bg-amber-100 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
        in progress
      </Badge>
    )
  return <Badge variant="secondary">planned</Badge>
}

export default async function StatusPage() {
  let doc: string | null = null
  let readError: string | null = null
  try {
    doc = await readFile(path.join(process.cwd(), STATUS_DOC_REL), "utf-8")
  } catch (err) {
    readError = err instanceof Error ? err.message : String(err)
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Status &amp; Roadmap</h1>
        <p className="text-sm text-muted-foreground">
          What actually works, what is verified, and what is not — by capability, with evidence.
          Progress is tracked by acceptance items, never by screen count.
        </p>
      </header>

      {doc === null ? (
        <Alert variant="destructive" role="alert">
          <FileWarning aria-hidden />
          <AlertTitle>Could not read the status document</AlertTitle>
          <AlertDescription>
            This page renders <span className="font-mono">{STATUS_DOC_REL}</span> live from the
            repository working tree — nothing is cached or paraphrased. Read error:{" "}
            <span className="font-mono text-xs">{readError}</span>. Reload the page to retry, or
            read the document on GitHub.
          </AlertDescription>
        </Alert>
      ) : (
        <Card>
          <CardHeader className="border-b">
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              <MapIcon className="size-4 text-orange-700 dark:text-orange-400" aria-hidden />
              docs/07-release/implementation-status.md
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Source of truth: {STATUS_DOC_REL} — rendered live from the repo.
            </p>
          </CardHeader>
          <CardContent className="pt-4">
            <div className="eos-md flex flex-col gap-2">
              {segmentMarkdown(doc).map((block, i) =>
                block.type === "md" ? (
                  <ReactMarkdown
                    key={i}
                    components={{
                      a: ({ href, children }) => (
                        <a href={renderHref(href ?? "#")} target="_blank" rel="noopener noreferrer">
                          {children}{" "}
                          <ExternalLink className="inline size-3 align-baseline" aria-hidden />
                        </a>
                      ),
                    }}
                  >
                    {block.lines.join("\n")}
                  </ReactMarkdown>
                ) : (
                  <div key={i} className="eos-scroll overflow-x-auto">
                    <table>
                      <thead>
                        <tr>
                          {block.rows[0]?.map((cell, j) => <th key={j}>{cell}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {block.rows.slice(1).map((row, r) => (
                          <tr key={r}>
                            {row.map((cell, c) => (
                              <td key={c}>{cell}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ),
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="border-b">
          <CardTitle className="text-base">Build phases</CardTitle>
          <p className="text-xs text-muted-foreground">
            Phase exit criteria from docs/01-product/release-objectives.md — a phase is done when
            its criteria are demonstrated, not documented.
          </p>
        </CardHeader>
        <CardContent className="pt-4">
          <div className="eos-scroll overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Phase</TableHead>
                  <TableHead>Focus</TableHead>
                  <TableHead>Exit criteria (abridged)</TableHead>
                  <TableHead className="text-right">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {PHASES.map((p) => (
                  <TableRow key={p.phase}>
                    <TableCell className="font-mono">{p.phase}</TableCell>
                    <TableCell className="max-w-[220px]">{p.focus}</TableCell>
                    <TableCell className="max-w-[380px] text-muted-foreground">{p.exit}</TableCell>
                    <TableCell className="text-right">
                      <PhaseBadge state={p.state} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <p className="mt-4 text-sm">
            <a
              className="underline underline-offset-2 hover:text-foreground"
              href={`${REPO_URL}/blob/main/docs/01-product/release-objectives.md`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Full release objectives in the repository
            </a>
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
