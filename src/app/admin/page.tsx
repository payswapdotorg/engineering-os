"use client"

/**
 * /admin — the Administration surface (Slice 17, limitation #19's product
 * half). Route-level gate: the page renders inside the authenticated shell;
 * the workspace itself shows the honest "administrators only" state for
 * non-admins, and every API beneath enforces the gate independently.
 */
import { AdminWorkspace } from "@/components/product/admin-workspace"

export default function AdminPage() {
  return <AdminWorkspace />
}
