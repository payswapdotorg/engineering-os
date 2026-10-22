"use client"

/**
 * GuardedButton — the ONE permission-aware mutating-action button (Phase-6
 * contract §1.6, W1-g lane).
 *
 * Rules this component enforces (so no workspace re-implements them):
 *  - `canMutate = role !== "viewer"`: every mutating control is VISIBLE but
 *    DISABLED for the viewer role, with the tooltip "viewer role is read-only".
 *    Controls are never hidden — a viewer sees what the product does.
 *  - An explicit `disabledReason` forces the same visible-disabled treatment
 *    for other permission rules (e.g. the team-member owner/admin gate) and
 *    takes precedence over the generic viewer tooltip only for NON-viewers —
 *    for a viewer the read-only reason wins, matching the server's gate order
 *    (viewer 403 outranks the domain gates, contract §1.3).
 *  - When allowed, the button behaves exactly like ui/button (busy states,
 *    variants, sizes, icons all pass through untouched).
 *
 * A11y: the disabled button is wrapped in a focusable span so keyboard users
 * can reach the control and read WHY it is disabled (Radix Tooltip shows on
 * focus; disabled buttons themselves would swallow pointer events in some
 * browsers).
 */
import type * as React from "react"

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useSessionUser } from "@/components/product/session-user"
import { cn } from "@/lib/utils"

/** Verbatim from the contract §1.3 viewer 403 message. */
export const VIEWER_DISABLED_REASON = "viewer role is read-only"

/** Verbatim from the contract §1.3 team-member 403 message. */
export const TEAM_MANAGE_DISABLED_REASON = "only the project owner or an admin can manage team members"

export type GuardedButtonProps = React.ComponentProps<typeof Button> & {
  /**
   * When non-null the button renders disabled with this exact tooltip text
   * (use the verbatim server-refusal copy so UI and API agree word for word).
   */
  disabledReason?: string | null
}

export function GuardedButton({
  disabledReason = null,
  disabled,
  className,
  children,
  ...rest
}: GuardedButtonProps) {
  const user = useSessionUser()

  const viewerBlocked = user !== "loading" && user !== null && user.role === "viewer"
  const reason: string | null = viewerBlocked
    ? VIEWER_DISABLED_REASON
    : disabledReason !== null && disabledReason.trim().length > 0
      ? disabledReason
      : null

  if (reason === null) {
    return (
      <Button disabled={disabled} className={className} {...rest}>
        {children}
      </Button>
    )
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className={cn("inline-flex max-w-full rounded-md outline-none focus-visible:ring-ring/50 focus-visible:ring-[3px]")}
        >
          <Button disabled aria-label={undefined} className={className} {...rest}>
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  )
}
