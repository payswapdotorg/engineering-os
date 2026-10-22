"use client"

/**
 * Auth surface (Phase-6 contract §1.6, W1-g lane) — replaces the whole shell
 * while there is no session. Full-screen, centered, product-styled; the
 * sticky-footer standard still applies (min-h-screen column + mt-auto footer).
 *
 * What it renders:
 *  - session "loading" is handled by the shell gate (skeletons, no flash);
 *  - first run (GET /api/auth/setup → {needed:true}) → SETUP form: name, email,
 *    password (min 8). Client validation mirrors the server's 422 checks and
 *    the server's own verbatim 422 messages surface under the form. On 201 the
 *    form auto-signs-in through the REAL next-auth credentials flow
 *    (signIn("credentials", { redirect:false })) — the session then appears via
 *    the SessionProvider and the shell gate takes over. No assumed sessions.
 *  - existing users (needed:false) → SIGN-IN form; CredentialsSignin maps to
 *    the friendly honest copy "wrong email or password" — never a raw error
 *    object. Success triggers router.refresh() so getServerSession-driven
 *    server state re-renders.
 *  - setup endpoint unreachable (backend lane still warming up / absent) →
 *    the surface degrades gracefully: the sign-in form renders with an honest
 *    unavailable note, the poll keeps retrying every ~2s, and the neutral
 *    "first run?" affordance re-checks on demand.
 *
 * Dev credentials are NEVER baked in here — they live in docs/scripts only.
 */
import { Loader2, LogIn, ShieldCheck } from "lucide-react"
import { useRouter } from "next/navigation"
import { useEffect, useRef, useState } from "react"
import { signIn } from "next-auth/react"
import { toast } from "sonner"

import { useApi, type StatusData } from "@/components/product/api"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"

/** Which form the surface shows while unauthenticated. */
type AuthMode = "checking" | "setup" | "signin" | "unavailable"

/**
 * GET /api/auth/setup → {needed: boolean} (public, contract §1.2). Envelope
 * tolerant: the route helpers wrap successes in {data: …}, the contract
 * shorthand writes {needed: …} — both are read; anything else is "unknown".
 */
async function fetchSetupNeeded(): Promise<boolean | null> {
  try {
    const res = await fetch("/api/auth/setup", { cache: "no-store" })
    if (!res.ok) return null
    const body: unknown = await res.json()
    const root = body as { needed?: unknown; data?: { needed?: unknown } } | null
    if (root && (root.needed === true || root.needed === false)) return root.needed
    const inner = root?.data
    if (inner && (inner.needed === true || inner.needed === false)) return inner.needed
    return null
  } catch {
    return null
  }
}

/** Pull the verbatim {error:{message}} text out of a refusal response. */
async function refusalMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body: unknown = await res.json()
    const err = body && typeof body === "object" && "error" in body
      ? (body as { error?: { message?: unknown } }).error
      : undefined
    if (err && typeof err.message === "string" && err.message.length > 0) return err.message
  } catch {
    // fall through to the honest fallback
  }
  return fallback
}

function AuthBrand() {
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <span className="flex items-center gap-2.5">
        <span
          aria-hidden
          className="flex size-9 items-center justify-center rounded-md bg-orange-700 text-sm font-bold tracking-tight text-orange-50 dark:bg-orange-600 dark:text-orange-950"
        >
          EO
        </span>
        <span className="text-lg font-semibold tracking-tight">Engineering OS</span>
      </span>
      <p className="max-w-xs text-sm text-muted-foreground">
        Unified, open-source-first engineering workspace — projects, artifacts, engines, workflows.
      </p>
    </div>
  )
}

/** Shared field error text (client validation + verbatim server refusals). */
function FieldError({ id, message }: { id: string; message: string }) {
  return (
    <p id={id} role="alert" className="text-xs leading-relaxed text-destructive">
      {message}
    </p>
  )
}

// ---------------------------------------------------------------------------
// Setup (first run — zero users exist)
// ---------------------------------------------------------------------------

function SetupForm({ onCreated }: { onCreated: () => void }) {
  const router = useRouter()
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; email?: string; password?: string }>({})
  const [serverError, setServerError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  /** Mirrors the server's own 422 checks (contract §1.2): non-empty name,
   *  non-empty email, password ≥ 8 characters. Server messages still surface
   *  verbatim whenever one slips past. */
  const validate = () => {
    const errors: { name?: string; email?: string; password?: string } = {}
    if (name.trim().length === 0) errors.name = "name is required"
    if (email.trim().length === 0 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      errors.email = "a valid email is required"
    }
    if (password.length < 8) errors.password = "password must be at least 8 characters"
    return errors
  }

  const submit = async () => {
    if (submitting) return
    const errors = validate()
    setFieldErrors(errors)
    if (Object.keys(errors).length > 0) return
    setSubmitting(true)
    setServerError(null)
    try {
      const res = await fetch("/api/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), email: email.trim(), password }),
      })
      if (!res.ok) {
        // 422s surface VERBATIM under the form (e.g. the first-run-only refusal).
        setServerError(await refusalMessage(res, `Setup failed (${res.status})`))
        return
      }
      // Created — sign in through the real credentials flow; the session then
      // arrives via the SessionProvider and the shell gate flips on its own.
      const result = await signIn("credentials", { redirect: false, email: email.trim(), password })
      if (result && !result.ok) {
        // Honest recovery path: the account exists now; let the human sign in.
        toast.info("Operator account created — sign in below")
        onCreated()
        return
      }
      router.refresh()
    } catch (err) {
      setServerError(err instanceof Error ? err.message : "Setup failed — please try again")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form
      className="space-y-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="setup-name">Name</Label>
        <Input
          id="setup-name"
          name="name"
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Local Operator"
          maxLength={80}
          required
          autoFocus
          aria-invalid={fieldErrors.name !== undefined}
          aria-describedby={fieldErrors.name !== undefined ? "setup-name-error" : undefined}
        />
        {fieldErrors.name !== undefined ? <FieldError id="setup-name-error" message={fieldErrors.name} /> : null}
      </div>
      <div className="space-y-2">
        <Label htmlFor="setup-email">Email</Label>
        <Input
          id="setup-email"
          name="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="operator@example.com"
          maxLength={254}
          required
          aria-invalid={fieldErrors.email !== undefined}
          aria-describedby={fieldErrors.email !== undefined ? "setup-email-error" : undefined}
        />
        {fieldErrors.email !== undefined ? <FieldError id="setup-email-error" message={fieldErrors.email} /> : null}
      </div>
      <div className="space-y-2">
        <Label htmlFor="setup-password">Password</Label>
        <Input
          id="setup-password"
          name="password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="At least 8 characters"
          minLength={8}
          required
          aria-invalid={fieldErrors.password !== undefined}
          aria-describedby={fieldErrors.password !== undefined ? "setup-password-error" : undefined}
        />
        {fieldErrors.password !== undefined ? (
          <FieldError id="setup-password-error" message={fieldErrors.password} />
        ) : null}
      </div>
      {serverError !== null ? (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {serverError}
        </p>
      ) : null}
      <Button type="submit" className="h-10 w-full" disabled={submitting}>
        {submitting ? <Loader2 className="animate-spin" aria-hidden /> : <ShieldCheck aria-hidden />}
        {submitting ? "Creating operator…" : "Create operator account"}
      </Button>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Setup is first-run only: it is available while no user exists. After the first account is
        created, everyone signs in.
      </p>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Sign-in (an operator account exists — or status unknown, honest note shown)
// ---------------------------------------------------------------------------

function SignInForm({ recheck }: { recheck: () => void }) {
  const router = useRouter()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const submit = async () => {
    if (submitting) return
    const errors: { email?: string; password?: string } = {}
    if (email.trim().length === 0) errors.email = "email is required"
    if (password.length === 0) errors.password = "password is required"
    setFieldErrors(errors)
    if (Object.keys(errors).length > 0) return
    setSubmitting(true)
    setFormError(null)
    try {
      const result = await signIn("credentials", { redirect: false, email: email.trim(), password })
      if (result && !result.ok) {
        // Friendly honest copy for bad credentials — never the raw error object.
        if (result.error === "CredentialsSignin") {
          setFormError("wrong email or password")
        } else if (typeof result.error === "string" && result.error.length > 0) {
          setFormError(`sign-in failed (${result.error})`)
        } else {
          setFormError("sign-in failed — the authentication service may be unavailable")
        }
        return
      }
      // Success: refresh so getServerSession-driven server state re-renders;
      // the SessionProvider update flips the shell gate by itself.
      router.refresh()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "sign-in failed — please try again")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form
      className="space-y-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="signin-email">Email</Label>
        <Input
          id="signin-email"
          name="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="operator@example.com"
          maxLength={254}
          required
          autoFocus
          aria-invalid={fieldErrors.email !== undefined}
          aria-describedby={fieldErrors.email !== undefined ? "signin-email-error" : undefined}
        />
        {fieldErrors.email !== undefined ? <FieldError id="signin-email-error" message={fieldErrors.email} /> : null}
      </div>
      <div className="space-y-2">
        <Label htmlFor="signin-password">Password</Label>
        <Input
          id="signin-password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          aria-invalid={fieldErrors.password !== undefined}
          aria-describedby={fieldErrors.password !== undefined ? "signin-password-error" : undefined}
        />
        {fieldErrors.password !== undefined ? (
          <FieldError id="signin-password-error" message={fieldErrors.password} />
        ) : null}
      </div>
      {formError !== null ? (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {formError}
        </p>
      ) : null}
      <Button type="submit" className="h-10 w-full" disabled={submitting}>
        {submitting ? <Loader2 className="animate-spin" aria-hidden /> : <LogIn aria-hidden />}
        {submitting ? "Signing in…" : "Sign in"}
      </Button>
      <p className="text-center text-xs text-muted-foreground">
        First run?{" "}
        <button
          type="button"
          className="font-medium underline underline-offset-2 hover:text-foreground"
          onClick={recheck}
        >
          Create the operator account
        </button>
      </p>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

export function AuthSurface() {
  const [mode, setMode] = useState<AuthMode>("checking")
  // Remembers that the "first run?" affordance asked for a re-check, so a
  // definitive not-needed answer can reply honestly instead of silently
  // re-rendering the same form.
  const recheckRequested = useRef(false)

  // /api/status stays public (contract §1.3) — the footer keeps its honest
  // local facts on the auth page too.
  const status = useApi<StatusData>("/api/status")

  useEffect(() => {
    // Resolved modes stop polling; "checking"/"unavailable" keep trying every
    // ~2s (the dev server may still be compiling, the auth lane still landing).
    if (mode === "setup" || mode === "signin") return
    let cancelled = false
    const tick = async () => {
      const needed = await fetchSetupNeeded()
      if (cancelled) return
      if (needed === true) {
        setMode("setup")
      } else if (needed === false) {
        if (recheckRequested.current) {
          recheckRequested.current = false
          toast.info("an operator account already exists (setup is first-run only)")
        }
        setMode("signin")
      } else {
        setMode((prev) => (prev === "checking" || prev === "unavailable" ? "unavailable" : prev))
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), 2000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [mode])

  const recheckSetup = () => {
    recheckRequested.current = true
    setMode("checking")
  }

  const footerFacts =
    status.data === null
      ? status.loading
        ? "loading local status…"
        : "status unavailable"
      : `local · ${status.data.dbProvider} · engines: ${status.data.engines.installed} of ${status.data.engines.total} installed`

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <main className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="flex w-full max-w-sm flex-col gap-6">
          <AuthBrand />
          <Card>
            <CardContent className="flex flex-col gap-4 p-6">
              {mode === "checking" ? (
                // The existing skeleton standard — no form flash while the
                // first-run check resolves.
                <div className="space-y-4" role="status" aria-label="Checking first-run setup status">
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-16" />
                    <Skeleton className="h-10 w-full" />
                  </div>
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-12" />
                    <Skeleton className="h-10 w-full" />
                  </div>
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-20" />
                    <Skeleton className="h-10 w-full" />
                  </div>
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : mode === "setup" ? (
                <>
                  <div>
                    <h1 className="text-lg font-semibold tracking-tight">Create the operator account</h1>
                    <p className="mt-1 text-sm text-muted-foreground">
                      First run — no users exist yet. This account is the local operator of this
                      workspace.
                    </p>
                  </div>
                  <SetupForm
                    onCreated={() => {
                      // Account exists now; sign in with the real form.
                      setMode("signin")
                    }}
                  />
                </>
              ) : (
                <>
                  <div>
                    <h1 className="text-lg font-semibold tracking-tight">Sign in</h1>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {mode === "unavailable"
                        ? "The setup service is not answering yet — the sign-in form stays available and the check keeps retrying."
                        : "Sign in to open your local engineering workspace."}
                    </p>
                  </div>
                  <SignInForm recheck={recheckSetup} />
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </main>
      <footer className="mt-auto border-t bg-background px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 text-xs text-muted-foreground">
        <p className="mx-auto max-w-6xl">
          Engineering OS{status.data ? <span className="font-mono"> v{status.data.version}</span> : null} · {footerFacts}
        </p>
      </footer>
    </div>
  )
}
