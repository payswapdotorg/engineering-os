"use client"

/**
 * Administration workspace (Slice 17 — limitation #19's product half, the
 * roadmap-gap-audit §7.2 "admin/settings surface").
 *
 * ADMIN-ONLY surface, but the gate is DEFENSIVE here: the real gate is the
 * API (401/403 envelopes) and the nav item only renders for admins. A
 * non-admin who navigates to /admin directly gets the honest "administrators
 * only" card, and every action still answers with the API's own refusal —
 * the UI never pretends a denial is a success.
 *
 * Two cards, no dead knobs:
 *  - Deployment: the signup toggle's TRUE state (read through /api/admin/
 *    settings) + exactly how to change it (env at boot — by design there is
 *    no runtime switch to flip, and the card says so rather than faking one).
 *  - Accounts: the global directory with inline role management — every
 *    refusal the pure core can return (demo persona, last admin, no-op,
 *    unknown role) surfaces verbatim from the API response.
 */
import { BadgeCheck, Info, ShieldCheck, UserCog } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

import {
  apiJson,
  useApi,
  type AdminSettingsData,
  type AdminUserRow,
  type AdminUsersData,
  ApiError,
} from "@/components/product/api"
import { useSessionUser } from "@/components/product/session-user"
import { ErrorState } from "@/components/product/parts"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

const ROLES: AdminUserRow["role"][] = ["admin", "engineer", "viewer"]

function RoleCell({ user, onChanged }: { user: AdminUserRow; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)

  const change = async (role: AdminUserRow["role"]) => {
    if (busy || role === user.role) return
    setBusy(true)
    try {
      await apiJson<{ user: AdminUserRow }>(`/api/admin/users/${user.id}`, "PATCH", { role })
      toast.success(`${user.name} is now ${role}`)
      onChanged()
    } catch (err) {
      // Refusals surface VERBATIM (demo persona, last admin, no-op…).
      toast.error(err instanceof ApiError ? err.message : "role change failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <select
      value={user.role}
      disabled={busy}
      aria-label={`Global role for ${user.name}`}
      onChange={(e) => void change(e.target.value as AdminUserRow["role"])}
      className="h-8 rounded-md border bg-background px-2 text-sm text-foreground disabled:opacity-50"
    >
      {ROLES.map((role) => (
        <option key={role} value={role}>
          {role}
        </option>
      ))}
    </select>
  )
}

export function AdminWorkspace() {
  const session = useSessionUser()
  const isAdmin = session !== "loading" && session !== null && session.role === "admin"
  const users = useApi<AdminUsersData>(isAdmin ? "/api/admin/users" : null)
  const settings = useApi<AdminSettingsData>(isAdmin ? "/api/admin/settings" : null)

  if (session !== "loading" && session !== null && !isAdmin) {
    return (
      <div className="mx-auto max-w-2xl py-16">
        <ErrorState message="The Administration surface manages global accounts. Sign in with an administrator account to use it." />
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <header className="flex items-start gap-3">
        <ShieldCheck className="mt-1 size-6 shrink-0 text-orange-700 dark:text-orange-400" aria-hidden />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Administration</h1>
          <p className="text-sm text-muted-foreground">
            Deployment-level settings and global account roles. Every change is audited (user.roleChanged).
          </p>
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <BadgeCheck className="size-4" aria-hidden /> Deployment
          </CardTitle>
          <CardDescription>The settings this deployment exposes — each one names how it is changed.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {settings.loading && settings.data === null ? (
            <Skeleton className="h-16 w-full" />
          ) : settings.error !== null ? (
            <ErrorState message={settings.error} />
          ) : settings.data !== null ? (
            <div className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">Account signup</span>
                {settings.data.signup.open ? (
                  <Badge className="border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                    open
                  </Badge>
                ) : (
                  <Badge className="border-transparent bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                    closed
                  </Badge>
                )}
              </div>
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {settings.data.signup.howToChange}
              </p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <UserCog className="size-4" aria-hidden /> Accounts & global roles
          </CardTitle>
          <CardDescription>
            Demo personas keep their provisioned role; the last admin can never be demoted; a changed role takes
            effect at the affected user&rsquo;s next sign-in.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {users.loading && users.data === null ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-2/3" />
            </div>
          ) : users.error !== null ? (
            <ErrorState message={users.error} />
          ) : users.data !== null ? (
            <div className="max-h-96 overflow-y-auto rounded-lg border">
              <Table>
                <TableHeader className="sticky top-0 bg-background">
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Global role</TableHead>
                    <TableHead className="hidden sm:table-cell">Since</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users.data.users.map((user) => (
                    <TableRow key={user.id}>
                      <TableCell className="font-medium">
                        {user.name}
                        {user.isDemo ? (
                          <Badge className="ml-2 border-dashed text-[10px] uppercase" variant="outline">
                            demo
                          </Badge>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{user.email}</TableCell>
                      <TableCell>
                        <RoleCell user={user} onChanged={() => void users.refresh()} />
                      </TableCell>
                      <TableCell className="hidden text-sm text-muted-foreground sm:table-cell">
                        {new Date(user.createdAt).toLocaleDateString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}
