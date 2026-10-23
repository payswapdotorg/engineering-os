/**
 * Engineering OS — LLM planner wire (Slice 11, agent-planning-contract §4).
 *
 * SERVER-ONLY: this is the ONE module in the repository that imports
 * `z-ai-web-dev-sdk` (ADR-0008 §4 "one wire, server-side") — no route, core
 * or component may import the SDK directly. The wire NEVER parses or
 * validates the model's content: extraction, the response envelope schema
 * and the canonical definition chain all live in the pure core
 * (src/core/planner.ts, ADR-0002). This module transports text, nothing else.
 *
 * Contract §4 semantics, all pinned:
 *  - the ZAI instance is created lazily ONCE per process and reused across
 *    requests (never re-created per request);
 *  - every completion runs with `thinking: { type: "disabled" }`;
 *  - `planWithLlm` makes at most 2 attempts (1 retry on ANY thrown error),
 *    each attempt under a 60s ceiling via Promise.race;
 *  - empty/whitespace-only responses are failures (honest message), never
 *    successes with a blank text;
 *  - SDK errors are wrapped with the honest one-line message
 *    `AI planner call failed: <original>` — the original message stays
 *    visible, nothing is ever swallowed;
 *  - the final failure is rethrown carrying `durationMs`/`attempts` as own
 *    properties so the plans route can persist honest llm-stage evidence
 *    (the §4 export surface stays verbatim — no extra exports).
 */

import ZAI from "z-ai-web-dev-sdk"

/** Contract §4 verbatim — the result of one planner round trip. */
export interface LlmCallResult {
  text: string
  durationMs: number
  attempts: number
}

const MAX_ATTEMPTS = 2
const ATTEMPT_CEILING_MS = 60_000

/**
 * Module-level cached ZAI instance: `ZAI.create()` runs once per process and
 * the promise is reused forever after (even a rejected one — the cache is
 * never re-created, so failures stay honest and stable, not flapping).
 */
let zaiPromise: Promise<ZAI> | null = null

function getZai(): Promise<ZAI> {
  if (zaiPromise === null) {
    zaiPromise = ZAI.create()
  }
  return zaiPromise
}

/**
 * A wire-level failure with a PINNED honest message (60s timeout, empty
 * response). Rethrown verbatim — every other error is wrapped so the SDK's
 * original message stays visible.
 */
class WireError extends Error {}

/** Honest one-line wrap for any raw SDK error (ADR-0008: never swallowed). */
function wrapSdkError(err: unknown): Error {
  return new Error(`AI planner call failed: ${err instanceof Error ? err.message : String(err)}`)
}

/**
 * One attempt: the completion call (thinking disabled) raced against a 60s
 * timer. Empty/whitespace-only content is a failure with the pinned message —
 * the wire never hands the route a blank success.
 */
async function attemptOnce(
  zai: ZAI,
  messages: Array<{ role: "assistant" | "user"; content: string }>,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new WireError("AI planner timed out after 60s")), ATTEMPT_CEILING_MS)
  })
  try {
    const completion = await Promise.race([
      zai.chat.completions.create({ messages, thinking: { type: "disabled" } }),
      timeout,
    ])
    const content = completion?.choices?.[0]?.message?.content
    const text = typeof content === "string" ? content : ""
    if (text.trim() === "") {
      throw new WireError("AI planner returned an empty response")
    }
    return text
  } catch (err) {
    throw err instanceof WireError ? err : wrapSdkError(err)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * One planner call (contract §4 verbatim): up to 2 attempts, 60s ceiling per
 * attempt, thinking disabled. `durationMs` is measured across ALL attempts;
 * `attempts` is the attempt count that produced the result (1 or 2).
 *
 * On the final failure the error is rethrown with `durationMs`/`attempts`
 * attached as own properties — the plans route reads them defensively to
 * persist `{durationMs, attempts}` evidence for the `llm` failure stage
 * (no rawResponse: there is none).
 */
export async function planWithLlm(
  messages: Array<{ role: "assistant" | "user"; content: string }>,
): Promise<LlmCallResult> {
  const startedAt = Date.now()
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const zai = await getZai()
      const text = await attemptOnce(zai, messages)
      return { text, durationMs: Date.now() - startedAt, attempts: attempt }
    } catch (err) {
      // ANY thrown error retries; the final one is rethrown below.
      lastError = err instanceof Error ? err : wrapSdkError(err)
    }
  }

  const failure = (lastError ?? new Error("AI planner call failed: unknown error")) as Error & {
    durationMs?: number
    attempts?: number
  }
  failure.durationMs = Date.now() - startedAt
  failure.attempts = MAX_ATTEMPTS
  throw failure
}

/**
 * Availability probe for e2e Part B ONLY (contract §4): one minimal real
 * completion (assistant "Reply with the single word: ok", user "ping"),
 * cached for 60s at module level. true iff non-empty text; ANY throw is
 * false (catch-all). The routes NEVER call this — they record honest
 * failures instead of probing around them.
 */
const PROBE_TTL_MS = 60_000
let probeCache: { value: boolean; at: number } | null = null

export async function probePlannerLlm(): Promise<boolean> {
  if (probeCache !== null && Date.now() - probeCache.at < PROBE_TTL_MS) {
    return probeCache.value
  }

  let value = false
  try {
    const zai = await getZai()
    await attemptOnce(zai, [
      { role: "assistant", content: "Reply with the single word: ok" },
      { role: "user", content: "ping" },
    ])
    value = true
  } catch {
    value = false // catch-all: config, network, timeout and empty are all "unavailable"
  }

  probeCache = { value, at: Date.now() }
  return value
}
