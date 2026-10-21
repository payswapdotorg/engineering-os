import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

export default function Home() {
  return (
    <main className="min-h-screen flex flex-col bg-background text-foreground">
      <section className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-2xl space-y-6">
          <div className="flex items-center gap-3">
            <div
              aria-hidden
              className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold text-lg tracking-tight"
            >
              EO
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Engineering OS</h1>
              <p className="text-sm text-muted-foreground">
                Unified, open-source-first engineering workspace
              </p>
            </div>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                Bootstrap in progress
                <Badge variant="secondary">Phase 1</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <p>
                The product shell (Project Home, Models &amp; Drawings, Engines, Activity, Team)
                is being built in this phase. This page is an honest placeholder — no capability
                is claimed until it is acceptance-verified.
              </p>
              <p>
                Status and evidence:{" "}
                <a
                  className="underline underline-offset-2 hover:text-foreground"
                  href="https://github.com/payswapdotorg/engineering-os/blob/main/docs/07-release/implementation-status.md"
                >
                  docs/07-release/implementation-status.md
                </a>{" "}
                in the repository.
              </p>
            </CardContent>
          </Card>
        </div>
      </section>
      <footer className="mt-auto border-t py-3 text-center text-xs text-muted-foreground">
        Engineering OS · Phase 1 bootstrap · Apache-2.0
      </footer>
    </main>
  )
}
