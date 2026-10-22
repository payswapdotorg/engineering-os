"use client"

/**
 * Header user menu (Phase-6 contract §1.6, W1-g lane) — avatar initials, name
 * + role badge, dropdown with a "Signed in as …" header and Sign out.
 * Sign out uses signOut({ callbackUrl: "/" }) so the full app re-renders from a
 * clean GET — the client-router pattern this shell already uses for navigation.
 */
import { ChevronDown, LogOut, UserX } from "lucide-react"
import { signOut } from "next-auth/react"
import { toast } from "sonner"

import { apiJson } from "@/components/product/api"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { initialsOf } from "@/components/product/format"
import type { SessionUser } from "@/components/product/session-user"
import { cn } from "@/lib/utils"

/** Role badge — existing palette only (orange accent / emerald / muted). */
function RoleBadge({ role }: { role: SessionUser["role"] }) {
  switch (role) {
    case "admin":
      return (
        <Badge className="border-orange-300 bg-orange-100 text-orange-800 dark:border-orange-700 dark:bg-orange-950 dark:text-orange-300">
          admin
        </Badge>
      )
    case "engineer":
      return (
        <Badge className="border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
          engineer
        </Badge>
      )
    case "viewer":
    default:
      return <Badge variant="outline" className="text-muted-foreground">viewer</Badge>
  }
}

/** Admin-only removal of the demo roster (contract §1.8) — honest +
 * reversible: re-provisioning restores it; the signed-in user is never
 * deleted by their own action. */
async function removeDemoAccounts() {
  try {
    const result = await apiJson<{ removed: number; remaining: number }>(
      "/api/auth/demo-accounts",
      "DELETE",
    )
    if (result.removed > 0) {
      toast.success(`removed ${result.removed} demo account${result.removed === 1 ? "" : "s"}`)
    }
    if (result.remaining > 0) {
      toast.info(
        `a signed-in demo user cannot remove itself — ${result.remaining} still present`,
      )
    }
    if (result.removed === 0 && result.remaining === 0) {
      toast.info("no demo accounts were present")
    }
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "removing demo accounts failed")
  }
}

export function UserMenu({ user }: { user: SessionUser }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="ml-1 h-9 gap-1.5 rounded-full px-1 pr-2 sm:px-1.5"
          aria-label="Open user menu"
        >
          <Avatar className="size-7">
            <AvatarFallback className="bg-orange-700 text-[11px] font-semibold text-orange-50 dark:bg-orange-600 dark:text-orange-950">
              {initialsOf(user.name)}
            </AvatarFallback>
          </Avatar>
          <span className={cn("hidden min-w-0 flex-col items-start leading-none md:flex")}>
            <span className="max-w-[140px] truncate text-sm font-medium">{user.name}</span>
            <span className="mt-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              {user.role}
            </span>
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="flex flex-col gap-1">
          <span className="text-xs font-normal text-muted-foreground">Signed in as</span>
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium">{user.name}</span>
            <RoleBadge role={user.role} />
          </span>
          <span className="truncate text-xs font-normal text-muted-foreground" title={user.email}>
            {user.email}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {user.role === "admin" ? (
          <DropdownMenuItem onSelect={() => void removeDemoAccounts()}>
            <UserX aria-hidden /> Remove demo accounts
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => {
            void signOut({ callbackUrl: "/" })
          }}
        >
          <LogOut aria-hidden /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
