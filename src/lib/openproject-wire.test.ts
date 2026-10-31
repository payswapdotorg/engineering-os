/**
 * Engineering OS — OpenProject REST v3 wire battery (ADR-0012 Stage 3).
 *
 * The wire is tested against an IN-PROCESS fake v3 server (node:http on an
 * ephemeral port): real HTTP, real fetch, real JSON — the fake pins only the
 * upstream semantics the real instance guarantees (apikey Basic auth, the
 * lockVersion PATCH model, HAL collections, follows relations). Every
 * request is recorded (method, path, auth, RAW body string) so the EXACT
 * payloads are pinned byte-for-byte. No live OpenProject instance exists in
 * this sandbox — the registry row stays honestly 'planned' until the first
 * deployed-instance run (ADR-0012).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import http from "node:http"
import type { AddressInfo } from "node:net"

import type { WorkPackageSyncPlan, RelationSyncPlan } from "@/core/openproject-sync"
import {
  executeRelationWirePlan,
  executeWorkPackageWirePlan,
  openProjectWireConfigFromEnv,
  type OpenProjectWireConfig,
} from "./openproject-wire"

// ---------------------------------------------------------------------------
// The fake v3 server (in-process, stateful, request-recording)
// ---------------------------------------------------------------------------

interface FakeWorkPackage {
  id: number
  subject: string
  startDate: string
  dueDate: string
  lockVersion: number
  projectId: number
}

interface FakeRelation {
  id: number
  type: string
  fromHref: string
  toHref: string
}

interface RecordedRequest {
  method: string
  path: string
  auth: string | undefined
  rawBody: string | undefined
}

interface FakeState {
  projects: Set<number>
  workPackages: Map<number, FakeWorkPackage>
  relations: Map<number, FakeRelation>
  requests: RecordedRequest[]
  nextWorkPackageId: number
  nextRelationId: number
  /** knobs (per-test, reset via reset()) */
  rejectAuth: boolean
  forcePatchStatus: number | null
  conflictMode: "off" | "once" | "always"
  patchedOnce: Set<number>
  forceWorkPackagePostStatus: number | null
  forceRelationPostStatus: number | null
  forceRelationGetStatus: number | null
  hangOnPatch: boolean
}

function fakeInitialState(): FakeState {
  return {
    projects: new Set([42]),
    workPackages: new Map(),
    relations: new Map(),
    requests: [],
    nextWorkPackageId: 100,
    nextRelationId: 500,
    rejectAuth: false,
    forcePatchStatus: null,
    conflictMode: "off",
    patchedOnce: new Set(),
    forceWorkPackagePostStatus: null,
    forceRelationPostStatus: null,
    forceRelationGetStatus: null,
    hangOnPatch: false,
  }
}

function startFakeServer(): Promise<{ server: http.Server; state: FakeState; baseUrl: string }> {
  const state = fakeInitialState()
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => {
      const rawBody = chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : undefined
      state.requests.push({
        method: req.method ?? "",
        path: req.url ?? "",
        auth: req.headers.authorization,
        rawBody,
      })
      const send = (status: number, json: unknown): void => {
        res.writeHead(status, { "Content-Type": "application/json" })
        res.end(JSON.stringify(json))
      }
      if (state.rejectAuth) {
        send(401, { message: "Basic auth failed" })
        return
      }

      const url = new URL(req.url ?? "/", "http://fake.local")
      const path = url.pathname
      const method = req.method ?? ""

      // ── projects ─────────────────────────────────────────────────────────
      const projectMatch = /^\/api\/v3\/projects\/(\d+)$/.exec(path)
      if (projectMatch !== null && method === "GET") {
        const id = Number(projectMatch[1])
        if (state.projects.has(id)) send(200, { id, name: `Project ${id}` })
        else send(404, { message: "The requested resource could not be found." })
        return
      }

      // ── a project's work packages (search + create) ─────────────────────
      const projectWpMatch = /^\/api\/v3\/projects\/(\d+)\/work_packages$/.exec(path)
      if (projectWpMatch !== null) {
        const projectId = Number(projectWpMatch[1])
        if (!state.projects.has(projectId)) {
          send(404, { message: "The requested resource could not be found." })
          return
        }
        if (method === "GET") {
          const filtersParam = url.searchParams.get("filters")
          let subjectFilter: string | null = null
          if (filtersParam !== null) {
            try {
              const filters = JSON.parse(filtersParam) as Array<{ subject?: { operator: string; values: string[] } }>
              const subjectClause = filters.find((f) => f.subject !== undefined)
              if (subjectClause?.subject?.operator === "=") {
                subjectFilter = subjectClause.subject.values[0] ?? null
              }
            } catch {
              subjectFilter = null
            }
          }
          const elements = [...state.workPackages.values()]
            .filter((wp) => wp.projectId === projectId)
            .filter((wp) => (subjectFilter !== null ? wp.subject === subjectFilter : true))
          send(200, { _embedded: { elements }, total: elements.length, count: elements.length })
          return
        }
        if (method === "POST") {
          if (state.forceWorkPackagePostStatus !== null) {
            send(state.forceWorkPackagePostStatus, { message: "forced failure" })
            return
          }
          const body = rawBody !== undefined ? (JSON.parse(rawBody) as Record<string, unknown>) : {}
          const id = state.nextWorkPackageId++
          const wp: FakeWorkPackage = {
            id,
            subject: String(body.subject ?? ""),
            startDate: String(body.startDate ?? ""),
            dueDate: String(body.dueDate ?? ""),
            lockVersion: 0,
            projectId,
          }
          state.workPackages.set(id, wp)
          send(201, { ...wp, _type: "WorkPackage" })
          return
        }
      }

      // ── one work package ────────────────────────────────────────────────
      const wpMatch = /^\/api\/v3\/work_packages\/(\d+)$/.exec(path)
      if (wpMatch !== null) {
        const id = Number(wpMatch[1])
        const wp = state.workPackages.get(id)
        if (method === "GET") {
          if (wp === undefined) send(404, { message: "The requested resource could not be found." })
          else send(200, { ...wp, _type: "WorkPackage" })
          return
        }
        if (method === "PATCH") {
          if (state.hangOnPatch) return // never respond — the timeout pin
          if (wp === undefined) {
            send(404, { message: "The requested resource could not be found." })
            return
          }
          if (state.forcePatchStatus !== null) {
            send(state.forcePatchStatus, { message: "forced failure" })
            return
          }
          const body = rawBody !== undefined ? (JSON.parse(rawBody) as Record<string, unknown>) : {}
          if (state.conflictMode === "always" || (state.conflictMode === "once" && !state.patchedOnce.has(id))) {
            state.patchedOnce.add(id)
            send(409, { message: "The work package you were trying to change has changed." })
            return
          }
          if (body.lockVersion !== wp.lockVersion) {
            send(409, { message: "The work package you were trying to change has changed." })
            return
          }
          wp.subject = String(body.subject ?? wp.subject)
          wp.startDate = String(body.startDate ?? wp.startDate)
          wp.dueDate = String(body.dueDate ?? wp.dueDate)
          wp.lockVersion += 1
          send(200, { ...wp, _type: "WorkPackage" })
          return
        }
      }

      // ── a work package's relations ──────────────────────────────────────
      const relationsMatch = /^\/api\/v3\/work_packages\/(\d+)\/relations$/.exec(path)
      if (relationsMatch !== null) {
        const wpId = Number(relationsMatch[1])
        if (method === "GET") {
          if (state.forceRelationGetStatus !== null) {
            send(state.forceRelationGetStatus, { message: "forced failure" })
            return
          }
          const href = `/api/v3/work_packages/${wpId}`
          const elements = [...state.relations.values()]
            .filter((relation) => relation.fromHref === href || relation.toHref === href)
            .map((relation) => ({
              id: relation.id,
              type: relation.type,
              _links: { from: { href: relation.fromHref }, to: { href: relation.toHref } },
            }))
          send(200, { _embedded: { elements }, total: elements.length, count: elements.length })
          return
        }
        if (method === "POST") {
          if (state.forceRelationPostStatus !== null) {
            send(state.forceRelationPostStatus, { message: "forced failure" })
            return
          }
          const body = rawBody !== undefined ? (JSON.parse(rawBody) as Record<string, unknown>) : {}
          const links = body._links as { from?: { href?: string }; to?: { href?: string } } | undefined
          const id = state.nextRelationId++
          const relation: FakeRelation = {
            id,
            type: String(body.type ?? ""),
            fromHref: String(links?.from?.href ?? ""),
            toHref: String(links?.to?.href ?? ""),
          }
          state.relations.set(id, relation)
          send(201, { id, type: relation.type, _links: { from: { href: relation.fromHref }, to: { href: relation.toHref } } })
          return
        }
      }

      send(404, { message: "The requested resource could not be found." })
    })
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo
      resolve({ server, state, baseUrl: `http://127.0.0.1:${address.port}` })
    })
  })
}

// ---------------------------------------------------------------------------
// Suite fixture
// ---------------------------------------------------------------------------

let fake: Awaited<ReturnType<typeof startFakeServer>>
const CONFIG: OpenProjectWireConfig = { baseUrl: "http://placeholder", apiKey: "test-key" }

beforeAll(async () => {
  fake = await startFakeServer()
  CONFIG.baseUrl = fake.baseUrl
})

afterAll(() => {
  fake.server.close()
})

/** Full reset between tests: knobs AND the instance state (each test seeds its own world). */
function resetFake(): void {
  Object.assign(fake.state, fakeInitialState())
}

beforeEach(() => {
  resetFake()
})

// ---------------------------------------------------------------------------
// Plan fixtures (wire data — constructed directly, exactly what the core emits)
// ---------------------------------------------------------------------------

function createPlan(items: WorkPackageSyncPlan["items"]): WorkPackageSyncPlan {
  return { targetProjectId: 42, anchorDate: "2026-11-02", items, orphans: [] }
}

function relationPlan(items: RelationSyncPlan["items"]): RelationSyncPlan {
  return { items }
}

function seedWorkPackage(id: number, subject: string, lockVersion = 0): void {
  fake.state.workPackages.set(id, {
    id,
    subject,
    startDate: "2026-01-01",
    dueDate: "2026-01-02",
    lockVersion,
    projectId: 42,
  })
}

// ---------------------------------------------------------------------------
// Configuration (env)
// ---------------------------------------------------------------------------

describe("openproject-wire — configuration from env", () => {
  test("unset env → null (the integration is honestly not configured)", () => {
    const savedUrl = process.env.EOS_OPENPROJECT_URL
    const savedKey = process.env.EOS_OPENPROJECT_APIKEY
    delete process.env.EOS_OPENPROJECT_URL
    delete process.env.EOS_OPENPROJECT_APIKEY
    expect(openProjectWireConfigFromEnv()).toBeNull()
    if (savedUrl !== undefined) process.env.EOS_OPENPROJECT_URL = savedUrl
    if (savedKey !== undefined) process.env.EOS_OPENPROJECT_APIKEY = savedKey
  })

  test("both set → the config, with any trailing slash stripped from the base URL", () => {
    const savedUrl = process.env.EOS_OPENPROJECT_URL
    const savedKey = process.env.EOS_OPENPROJECT_APIKEY
    process.env.EOS_OPENPROJECT_URL = "https://openproject.example.org/"
    process.env.EOS_OPENPROJECT_APIKEY = "secret"
    expect(openProjectWireConfigFromEnv()).toEqual({
      baseUrl: "https://openproject.example.org",
      apiKey: "secret",
    })
    if (savedUrl === undefined) delete process.env.EOS_OPENPROJECT_URL
    else process.env.EOS_OPENPROJECT_URL = savedUrl
    if (savedKey === undefined) delete process.env.EOS_OPENPROJECT_APIKEY
    else process.env.EOS_OPENPROJECT_APIKEY = savedKey
  })

  test("only one of the two → null (both are required, never a half-configured wire)", () => {
    const savedUrl = process.env.EOS_OPENPROJECT_URL
    const savedKey = process.env.EOS_OPENPROJECT_APIKEY
    process.env.EOS_OPENPROJECT_URL = "https://openproject.example.org"
    delete process.env.EOS_OPENPROJECT_APIKEY
    expect(openProjectWireConfigFromEnv()).toBeNull()
    if (savedUrl === undefined) delete process.env.EOS_OPENPROJECT_URL
    else process.env.EOS_OPENPROJECT_URL = savedUrl
    if (savedKey !== undefined) process.env.EOS_OPENPROJECT_APIKEY = savedKey
  })
})

// ---------------------------------------------------------------------------
// Creates (adopt-or-create) + the auth convention
// ---------------------------------------------------------------------------

describe("openproject-wire — creates (adopt-or-create idempotency)", () => {
  test("zero matches → the exact search path, then the exact POST path + RAW body; 201 parsed to id/lockVersion", async () => {
    const outcome = await executeWorkPackageWirePlan(CONFIG, createPlan([
      {
        kind: "create-work-package",
        activityId: "a",
        payload: {
          subject: "Excavate",
          startDate: "2026-11-02",
          dueDate: "2026-11-04",
          _links: { type: { href: "/api/v3/types/1" } },
        },
      },
    ]))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.results).toEqual([
      {
        kind: "create-work-package",
        activityId: "a",
        ok: true,
        workPackageId: 100,
        lockVersion: 0,
        adopted: false,
        recreated: false,
      },
    ])
    const expectedSearch =
      "/api/v3/projects/42/work_packages?filters=" +
      encodeURIComponent(JSON.stringify([{ subject: { operator: "=", values: ["Excavate"] } }]))
    expect(fake.state.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /api/v3/projects/42",
      `GET ${expectedSearch}`,
      "POST /api/v3/projects/42/work_packages",
    ])
    expect(fake.state.requests[2].rawBody).toBe(
      '{"subject":"Excavate","startDate":"2026-11-02","dueDate":"2026-11-04","_links":{"type":{"href":"/api/v3/types/1"}}}',
    )
  })

  test("every request carries the exact apikey Basic-auth header", async () => {
    await executeWorkPackageWirePlan(CONFIG, createPlan([
      {
        kind: "create-work-package",
        activityId: "a",
        payload: {
          subject: "Auth pin",
          startDate: "2026-11-02",
          dueDate: "2026-11-03",
          _links: { type: { href: "/api/v3/types/1" } },
        },
      },
    ]))
    const expected = `Basic ${btoa("apikey:test-key")}`
    expect(fake.state.requests.length).toBeGreaterThan(0)
    for (const request of fake.state.requests) {
      expect(request.auth).toBe(expected)
    }
  })

  test("exactly one same-subject match → ADOPTED (no POST — the crash window can never duplicate)", async () => {
    seedWorkPackage(101, "Excavate", 5)
    const outcome = await executeWorkPackageWirePlan(CONFIG, createPlan([
      {
        kind: "create-work-package",
        activityId: "a",
        payload: {
          subject: "Excavate",
          startDate: "2026-11-02",
          dueDate: "2026-11-04",
          _links: { type: { href: "/api/v3/types/1" } },
        },
      },
    ]))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.results).toEqual([
      {
        kind: "create-work-package",
        activityId: "a",
        ok: true,
        workPackageId: 101,
        lockVersion: 5,
        adopted: true,
        recreated: false,
      },
    ])
    expect(fake.state.requests.some((r) => r.method === "POST")).toBe(false)
  })

  test("more than one same-subject match → honest refusal, no POST (never guesses)", async () => {
    seedWorkPackage(101, "Excavate")
    seedWorkPackage(102, "Excavate")
    const outcome = await executeWorkPackageWirePlan(CONFIG, createPlan([
      {
        kind: "create-work-package",
        activityId: "a",
        payload: {
          subject: "Excavate",
          startDate: "2026-11-02",
          dueDate: "2026-11-04",
          _links: { type: { href: "/api/v3/types/1" } },
        },
      },
    ]))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.results[0].ok).toBe(false)
    if (outcome.results[0].ok) return
    expect(outcome.results[0].error).toBe(
      'OpenProject create refused for activity "a": 2 existing work packages already match the subject "Excavate" — refusing to guess; disambiguate on the instance',
    )
    expect(fake.state.requests.some((r) => r.method === "POST")).toBe(false)
  })

  test("a failed create POST surfaces the HTTP status + the instance's own message — never a throw", async () => {
    fake.state.forceWorkPackagePostStatus = 500
    const outcome = await executeWorkPackageWirePlan(CONFIG, createPlan([
      {
        kind: "create-work-package",
        activityId: "a",
        payload: {
          subject: "Excavate",
          startDate: "2026-11-02",
          dueDate: "2026-11-04",
          _links: { type: { href: "/api/v3/types/1" } },
        },
      },
    ]))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.results[0].ok).toBe(false)
    if (outcome.results[0].ok) return
    expect(outcome.results[0].error).toBe('OpenProject create failed for activity "a": HTTP 500: forced failure')
  })
})

// ---------------------------------------------------------------------------
// Updates (lockVersion PATCH model, recreate-on-404, conflict self-heal)
// ---------------------------------------------------------------------------

describe("openproject-wire — updates (the lockVersion PATCH model)", () => {
  test("200 → the exact PATCH path + RAW body {lockVersion, subject, startDate, dueDate}; the fresh lockVersion returned", async () => {
    seedWorkPackage(101, "Excavate (old)", 3)
    const outcome = await executeWorkPackageWirePlan(CONFIG, createPlan([
      {
        kind: "update-work-package",
        activityId: "a",
        workPackageId: 101,
        lockVersion: 3,
        payload: { subject: "Excavate", startDate: "2026-11-02", dueDate: "2026-11-04" },
      },
    ]))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.results).toEqual([
      {
        kind: "update-work-package",
        activityId: "a",
        ok: true,
        workPackageId: 101,
        lockVersion: 4,
        adopted: false,
        recreated: false,
      },
    ])
    expect(fake.state.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /api/v3/projects/42",
      "PATCH /api/v3/work_packages/101",
    ])
    expect(fake.state.requests[1].rawBody).toBe(
      '{"lockVersion":3,"subject":"Excavate","startDate":"2026-11-02","dueDate":"2026-11-04"}',
    )
  })

  test("404 → recreate-on-404: search (0 matches) → POST; the result carries the NEW id + recreated: true", async () => {
    // wp 101 deleted on the instance; nothing matches the subject
    const outcome = await executeWorkPackageWirePlan(CONFIG, createPlan([
      {
        kind: "update-work-package",
        activityId: "a",
        workPackageId: 101,
        lockVersion: 3,
        payload: { subject: "Excavate", startDate: "2026-11-02", dueDate: "2026-11-04" },
      },
    ]))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.results).toEqual([
      {
        kind: "update-work-package",
        activityId: "a",
        ok: true,
        workPackageId: 100,
        lockVersion: 0,
        adopted: false,
        recreated: true,
      },
    ])
    expect(fake.state.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /api/v3/projects/42",
      "PATCH /api/v3/work_packages/101",
      "GET /api/v3/projects/42/work_packages?filters=" +
        encodeURIComponent(JSON.stringify([{ subject: { operator: "=", values: ["Excavate"] } }])),
      "POST /api/v3/projects/42/work_packages",
    ])
    expect(fake.state.requests[3].rawBody).toBe(
      '{"subject":"Excavate","startDate":"2026-11-02","dueDate":"2026-11-04","_links":{"type":{"href":"/api/v3/types/1"}}}',
    )
  })

  test("404 with a single same-subject match → the existing work package is adopted (recreated: true, adopted: true)", async () => {
    seedWorkPackage(150, "Excavate", 9)
    const outcome = await executeWorkPackageWirePlan(CONFIG, createPlan([
      {
        kind: "update-work-package",
        activityId: "a",
        workPackageId: 101,
        lockVersion: 3,
        payload: { subject: "Excavate", startDate: "2026-11-02", dueDate: "2026-11-04" },
      },
    ]))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.results).toEqual([
      {
        kind: "update-work-package",
        activityId: "a",
        ok: true,
        workPackageId: 150,
        lockVersion: 9,
        adopted: true,
        recreated: true,
      },
    ])
  })

  test("a single 409 self-heals: GET the fresh lockVersion, retry the PATCH with it — ok, recreated: false", async () => {
    seedWorkPackage(101, "Excavate", 3)
    fake.state.conflictMode = "once"
    const outcome = await executeWorkPackageWirePlan(CONFIG, createPlan([
      {
        kind: "update-work-package",
        activityId: "a",
        workPackageId: 101,
        lockVersion: 2, // stale: the instance is at 3
        payload: { subject: "Excavate", startDate: "2026-11-02", dueDate: "2026-11-04" },
      },
    ]))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.results[0]).toMatchObject({ ok: true, workPackageId: 101, recreated: false })
    expect(fake.state.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /api/v3/projects/42",
      "PATCH /api/v3/work_packages/101",
      "GET /api/v3/work_packages/101",
      "PATCH /api/v3/work_packages/101",
    ])
    // the retry carried the FRESH lockVersion (3), not the stale one
    expect(fake.state.requests[3].rawBody).toBe(
      '{"lockVersion":3,"subject":"Excavate","startDate":"2026-11-02","dueDate":"2026-11-04"}',
    )
  })

  test("a persisting 409 fails honestly (one refresh + one retry only, never a blind overwrite)", async () => {
    seedWorkPackage(101, "Excavate", 3)
    fake.state.conflictMode = "always"
    const outcome = await executeWorkPackageWirePlan(CONFIG, createPlan([
      {
        kind: "update-work-package",
        activityId: "a",
        workPackageId: 101,
        lockVersion: 1,
        payload: { subject: "Excavate", startDate: "2026-11-02", dueDate: "2026-11-04" },
      },
    ]))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.results[0].ok).toBe(false)
    if (outcome.results[0].ok) return
    expect(outcome.results[0].error).toBe(
      "OpenProject update conflict for work package 101: the mapping's lockVersion is stale even after a refresh (HTTP 409) — review the instance",
    )
    // exactly two PATCHes: the attempt + the single retry
    expect(fake.state.requests.filter((r) => r.method === "PATCH")).toHaveLength(2)
  })

  test("a 500 on PATCH is a per-item failure with the status + message — never a throw", async () => {
    seedWorkPackage(101, "Excavate", 3)
    fake.state.forcePatchStatus = 500
    const outcome = await executeWorkPackageWirePlan(CONFIG, createPlan([
      {
        kind: "update-work-package",
        activityId: "a",
        workPackageId: 101,
        lockVersion: 3,
        payload: { subject: "Excavate", startDate: "2026-11-02", dueDate: "2026-11-04" },
      },
    ]))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.results[0].ok).toBe(false)
    if (outcome.results[0].ok) return
    expect(outcome.results[0].error).toBe('OpenProject update failed for activity "a": HTTP 500: forced failure')
  })
})

// ---------------------------------------------------------------------------
// Target verification (the only whole-phase failure)
// ---------------------------------------------------------------------------

describe("openproject-wire — target verification", () => {
  test("target project 404 → the whole phase refuses verbatim; nothing else was attempted", async () => {
    const outcome = await executeWorkPackageWirePlan(CONFIG, createPlan([]))
    // targetProjectId 42 exists — use a missing one:
    const missing = await executeWorkPackageWirePlan(CONFIG, {
      targetProjectId: 777,
      anchorDate: "2026-11-02",
      items: [
        {
          kind: "create-work-package",
          activityId: "a",
          payload: {
            subject: "Excavate",
            startDate: "2026-11-02",
            dueDate: "2026-11-04",
            _links: { type: { href: "/api/v3/types/1" } },
          },
        },
      ],
      orphans: [],
    })
    expect(outcome.ok).toBe(true) // the empty-plan control
    expect(missing.ok).toBe(false)
    if (missing.ok) return
    expect(missing.error).toBe("OpenProject target project 777 not found on the instance — check parameters.targetProjectId")
    // only the project GET — no work-package request was made
    expect(fake.state.requests.filter((r) => r.path.startsWith("/api/v3/work_packages"))).toHaveLength(0)
  })

  test("HTTP 401 → the apikey error (check EOS_OPENPROJECT_APIKEY)", async () => {
    fake.state.rejectAuth = true
    const outcome = await executeWorkPackageWirePlan(CONFIG, createPlan([]))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toBe("OpenProject rejected the apikey (HTTP 401) — check EOS_OPENPROJECT_APIKEY")
  })

  test("an unreachable instance → the unreachable error naming the base URL (no throw)", async () => {
    const closed: OpenProjectWireConfig = { baseUrl: "http://127.0.0.1:1", apiKey: "test-key" }
    const outcome = await executeWorkPackageWirePlan(closed, createPlan([]))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toContain("OpenProject instance unreachable at http://127.0.0.1:1:")
  })
})

// ---------------------------------------------------------------------------
// Relations (follows direction + precedes duplicate healing)
// ---------------------------------------------------------------------------

describe("openproject-wire — relations (from = successor, to = predecessor)", () => {
  function seedRelation(id: number, type: string, fromHref: string, toHref: string): void {
    fake.state.relations.set(id, { id, type, fromHref, toHref })
  }

  test("no existing edge → GET the successor's relations, then POST the exact follows body", async () => {
    const outcome = await executeRelationWirePlan(CONFIG, relationPlan([
      {
        kind: "ensure-relation",
        successorActivityId: "b",
        predecessorActivityId: "a",
        successorWorkPackageId: 102,
        predecessorWorkPackageId: 101,
      },
    ]))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.results).toEqual([
      {
        kind: "ensure-relation",
        successorActivityId: "b",
        predecessorActivityId: "a",
        ok: true,
        relationId: 500,
        existedAlready: false,
      },
    ])
    expect(fake.state.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /api/v3/work_packages/102/relations",
      "POST /api/v3/work_packages/102/relations",
    ])
    expect(fake.state.requests[1].rawBody).toBe(
      '{"type":"follows","_links":{"from":{"href":"/api/v3/work_packages/102"},"to":{"href":"/api/v3/work_packages/101"}}}',
    )
  })

  test("an existing FOLLOWS edge (from=successor, to=predecessor) is reused — no POST", async () => {
    seedRelation(55, "follows", "/api/v3/work_packages/102", "/api/v3/work_packages/101")
    const outcome = await executeRelationWirePlan(CONFIG, relationPlan([
      {
        kind: "ensure-relation",
        successorActivityId: "b",
        predecessorActivityId: "a",
        successorWorkPackageId: 102,
        predecessorWorkPackageId: 101,
      },
    ]))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.results).toEqual([
      {
        kind: "ensure-relation",
        successorActivityId: "b",
        predecessorActivityId: "a",
        ok: true,
        relationId: 55,
        existedAlready: true,
      },
    ])
    expect(fake.state.requests.some((r) => r.method === "POST")).toBe(false)
  })

  test("an existing PRECEDES edge (from=predecessor, to=successor) is reused — the duplicate healer, no POST", async () => {
    seedRelation(56, "precedes", "/api/v3/work_packages/101", "/api/v3/work_packages/102")
    const outcome = await executeRelationWirePlan(CONFIG, relationPlan([
      {
        kind: "ensure-relation",
        successorActivityId: "b",
        predecessorActivityId: "a",
        successorWorkPackageId: 102,
        predecessorWorkPackageId: 101,
      },
    ]))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.results).toEqual([
      {
        kind: "ensure-relation",
        successorActivityId: "b",
        predecessorActivityId: "a",
        ok: true,
        relationId: 56,
        existedAlready: true,
      },
    ])
    expect(fake.state.requests.some((r) => r.method === "POST")).toBe(false)
  })

  test("a relation POST 422 → per-item failure with the status + message — never a throw", async () => {
    fake.state.forceRelationPostStatus = 422
    const outcome = await executeRelationWirePlan(CONFIG, relationPlan([
      {
        kind: "ensure-relation",
        successorActivityId: "b",
        predecessorActivityId: "a",
        successorWorkPackageId: 102,
        predecessorWorkPackageId: 101,
      },
    ]))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.results[0].ok).toBe(false)
    if (outcome.results[0].ok) return
    expect(outcome.results[0].error).toBe(
      "OpenProject relation create failed for b → a: HTTP 422: forced failure",
    )
  })

  test("a relation search 500 → per-item failure (the collect-never-throw surface)", async () => {
    fake.state.forceRelationGetStatus = 500
    const outcome = await executeRelationWirePlan(CONFIG, relationPlan([
      {
        kind: "ensure-relation",
        successorActivityId: "b",
        predecessorActivityId: "a",
        successorWorkPackageId: 102,
        predecessorWorkPackageId: 101,
      },
    ]))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.results[0].ok).toBe(false)
    if (outcome.results[0].ok) return
    expect(outcome.results[0].error).toBe(
      "OpenProject relation search failed for b → a: HTTP 500: forced failure",
    )
  })
})

// ---------------------------------------------------------------------------
// Collect-never-throw, alignment, timeouts, empty plans
// ---------------------------------------------------------------------------

describe("openproject-wire — collect-never-throw / alignment / timeout", () => {
  test("a mixed plan: every item is attempted and answered in order, one failure never stops the rest", async () => {
    seedWorkPackage(101, "Excavate", 3)
    fake.state.forcePatchStatus = 500
    const outcome = await executeWorkPackageWirePlan(CONFIG, createPlan([
      {
        kind: "create-work-package",
        activityId: "a",
        payload: {
          subject: "New one",
          startDate: "2026-11-02",
          dueDate: "2026-11-03",
          _links: { type: { href: "/api/v3/types/1" } },
        },
      },
      {
        kind: "update-work-package",
        activityId: "b",
        workPackageId: 101,
        lockVersion: 3,
        payload: { subject: "Excavate", startDate: "2026-11-02", dueDate: "2026-11-04" },
      },
      {
        kind: "create-work-package",
        activityId: "c",
        payload: {
          subject: "New two",
          startDate: "2026-11-02",
          dueDate: "2026-11-03",
          _links: { type: { href: "/api/v3/types/1" } },
        },
      },
    ]))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.results.map((r) => r.activityId)).toEqual(["a", "b", "c"])
    expect(outcome.results.map((r) => r.ok)).toEqual([true, false, true])
    expect(fake.state.requests.filter((r) => r.method === "POST")).toHaveLength(2) // both creates ran
  })

  test("the per-request timeout surfaces as an honest per-item failure (never a hang)", async () => {
    seedWorkPackage(101, "Excavate", 3)
    fake.state.hangOnPatch = true
    const outcome = await executeWorkPackageWirePlan(
      { ...CONFIG, requestTimeoutMs: 60 },
      createPlan([
        {
          kind: "update-work-package",
          activityId: "a",
          workPackageId: 101,
          lockVersion: 3,
          payload: { subject: "Excavate", startDate: "2026-11-02", dueDate: "2026-11-04" },
        },
      ]),
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.results[0].ok).toBe(false)
    if (outcome.results[0].ok) return
    expect(outcome.results[0].error).toContain('OpenProject update failed for activity "a"')
  })

  test("an empty relation plan makes ZERO requests and returns an empty ok", async () => {
    const outcome = await executeRelationWirePlan(CONFIG, relationPlan([]))
    expect(outcome).toEqual({ ok: true, results: [] })
    expect(fake.state.requests).toHaveLength(0)
  })

  test("an unreachable instance mid-relation-phase is a per-item failure (the relation phase has no verify gate)", async () => {
    const closed: OpenProjectWireConfig = { baseUrl: "http://127.0.0.1:1", apiKey: "test-key" }
    const outcome = await executeRelationWirePlan(closed, relationPlan([
      {
        kind: "ensure-relation",
        successorActivityId: "b",
        predecessorActivityId: "a",
        successorWorkPackageId: 102,
        predecessorWorkPackageId: 101,
      },
    ]))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.results[0].ok).toBe(false)
    if (outcome.results[0].ok) return
    expect(outcome.results[0].error).toContain("OpenProject relation search failed for b → a")
  })
})
