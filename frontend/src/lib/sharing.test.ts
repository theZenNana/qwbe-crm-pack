// Unit tests for the sharing adapter (QWB-66).
//
// Pure derivation plus injected-fetch calls only: no DOM, no backend, no live
// server -- the same boundary the relation-batch suite tests across. The
// contract under test is the qwbe permissions cube as verified on 2026-09-06
// (core/src/cubes/permissions/api.ts, permissions-schemas.ts).

import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  ENTITY_ACTIONS,
  actionsForLevel,
  chipsOf,
  createGroupGrant,
  createUserGrant,
  fetchGrantPage,
  grantRevokePath,
  groupsPath,
  grantActionsLabel,
  grantsPagePath,
  grantsPageView,
  grantsRefPath,
  groupGrantPayload,
  isTotalActions,
  lookupGroups,
  lookupUserNames,
  revokeGrant,
  searchUsers,
  userGrantPayload,
  userNamesPath,
  userSearchPath,
  type EntityGrantPage,
} from "./sharing.ts"

// A minimal injected fetch: answers `json` with `status` for the asserted
// path+method, and records every request it saw.
function fetchStub(
  responder: (url: string, init: RequestInit | undefined) => { status: number; body: unknown } | undefined,
): { doFetch: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    const answer = responder(url, init)
    if (!answer) return new Response("nope", { status: 404 })
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
  return { doFetch, calls }
}

const grantRow = (over: Record<string, unknown> = {}) => ({
  id: "g1",
  cube: "crm/organizations",
  entityType: "Organization",
  entityId: "o1",
  subject: { kind: "user" as const, userId: "u1" },
  actions: [...ENTITY_ACTIONS],
  createdBy: "admin",
  createdAt: "2026-09-06T00:00:00Z",
  ...over,
})

describe("paths", () => {
  it("percent-encodes the cube slash as ONE segment, plus type and id", () => {
    assert.equal(
      grantsRefPath("crm/organizations", "Organization", "o/1"),
      "/api/qwbe/permissions/entities/crm%2Forganizations/Organization/o%2F1",
    )
  })

  it("keeps the page query explicit: offset and limit travel, nothing is sliced client-side", () => {
    const path = grantsPagePath("crm/organizations", "Organization", "o1", 60, 50)
    const [base, query] = path!.split("?")
    assert.equal(base, "/api/qwbe/permissions/entities/crm%2Forganizations/Organization/o1/grants")
    assert.deepEqual(new URLSearchParams(query), new URLSearchParams("offset=60&limit=50"))
  })

  it("refuses empty references and non-integer page windows", () => {
    assert.equal(grantsRefPath("crm/organizations", "Organization", ""), null)
    assert.equal(grantsRefPath("  ", "Organization", "o1"), null)
    assert.equal(grantsPagePath("crm/organizations", "Organization", "o1", -1, 50), null)
    assert.equal(grantsPagePath("crm/organizations", "Organization", "o1", 0, 0), null)
    assert.equal(grantsPagePath("crm/organizations", "Organization", "o1", 1.5, 50), null)
  })

  it("searches the directory by q with a small limit", () => {
    assert.equal(userSearchPath("  mih  ", 20), "/api/qwbe/account?q=mih&limit=20")
    assert.equal(userSearchPath("", 20), "/api/qwbe/account?limit=20")
  })

  it("batches name lookups by ids, deduplicated", () => {
    assert.equal(userNamesPath(["u1", "u1", "u2"]), "/api/qwbe/account?ids=u1%2Cu2")
    assert.equal(userNamesPath(["  ", ""]), null)
  })

  it("groups query carries the cube; revoke goes by grant id", () => {
    assert.equal(
      groupsPath("crm/organizations"),
      "/api/qwbe/permissions/groups?cube=crm%2Forganizations",
    )
    assert.equal(grantRevokePath("gr/1"), "/api/qwbe/permissions/grants/gr%2F1")
    assert.equal(grantRevokePath(""), null)
  })
})

describe("payloads", () => {
  it("TOTAL snapshot: the exact six actions travel explicitly", () => {
    assert.deepEqual(userGrantPayload("mihai", [...ENTITY_ACTIONS]), {
      payload: { username: "mihai", actions: [...ENTITY_ACTIONS] },
    })
  })

  it("custom snapshot: explicit nonempty set, order kept, duplicates dropped", () => {
    assert.deepEqual(userGrantPayload(" mihai ", ["edit", "read", "read"]), {
      payload: { username: "mihai", actions: ["edit", "read"] },
    })
    assert.deepEqual(groupGrantPayload(" grp_1 ", ["read"]), {
      payload: { groupId: "grp_1", actions: ["read"] },
    })
  })

  it("refuses empty subjects and empty or unknown actions", () => {
    assert.deepEqual(userGrantPayload("  ", ["read"]), { error: "subject" })
    assert.deepEqual(groupGrantPayload("", ["read"]), { error: "subject" })
    assert.deepEqual(userGrantPayload("mihai", []), { error: "actions" })
    assert.deepEqual(userGrantPayload("mihai", ["fly"]), { error: "actions" })
  })

  it("a custom set never includes share; only the exact TOTAL set does", () => {
    assert.deepEqual(userGrantPayload("mihai", ["read", "share"]), { error: "actions" })
  })

  it("TOTAL is the exact set of six, not a length of six", () => {
    assert.ok(isTotalActions([...ENTITY_ACTIONS]))
    assert.ok(!isTotalActions(["read", "read", "read", "read", "read", "edit"]))
    assert.ok(!isTotalActions(["read", "edit"]))
  })

  it("chip label says TOTAL only for the exact set, else lists the actions", () => {
    assert.equal(grantActionsLabel([...ENTITY_ACTIONS]), "TOTAL")
    assert.equal(grantActionsLabel(["read", "edit"]), "read, edit")
  })

  it("actionsForLevel: TOTAL is the explicit six, read is [read], custom keeps published order and never share", () => {
    assert.deepEqual(actionsForLevel("total", []), [...ENTITY_ACTIONS])
    assert.deepEqual(actionsForLevel("read", ["edit"]), ["read"])
    assert.deepEqual(actionsForLevel("custom", ["transfer", "share", "read", "fly"]), ["read", "transfer"])
    assert.deepEqual(actionsForLevel("custom", []), [])
  })
})

describe("grant page view", () => {
  it("hasMore follows the explicit total, not a silent truncation", () => {
    const page: EntityGrantPage = {
      rows: [grantRow({ id: "g1" }), grantRow({ id: "g2" })],
      total: 3,
      offset: 0,
      limit: 50,
  }
    const view = grantsPageView(page)
    assert.equal(view.hasMore, true)
    assert.equal(view.total, 3)
    assert.equal(grantsPageView({ ...page, total: 2 }).hasMore, false)
  })

  it("a response without total degrades to probe-next, never to 'end of list'", () => {
    const view = grantsPageView({ rows: [grantRow()], offset: 0, limit: 50 })
    assert.equal(view.hasMore, null)
    assert.equal(view.total, undefined)
  })
})

describe("chips", () => {
  it("labels by resolved username and group name, falling back to the raw id", () => {
    const chips = chipsOf(
      [
        grantRow({ id: "g1", subject: { kind: "user", userId: "u1" } }),
        grantRow({ id: "g2", subject: { kind: "group", groupId: "grp1" }, actions: ["read"] }),
        grantRow({ id: "g3", subject: { kind: "user", userId: "u9" }, actions: ["read", "edit"] }),
      ],
      { u1: "mihai" },
      { grp1: "Sales" },
    )
    assert.deepEqual(chips, [
      { grantId: "g1", kind: "user", subjectId: "u1", label: "mihai", actions: "TOTAL", total: true },
      { grantId: "g2", kind: "group", subjectId: "grp1", label: "Sales", actions: "read", total: false },
      { grantId: "g3", kind: "user", subjectId: "u9", label: "u9", actions: "read, edit", total: false },
    ])
  })

  it("duplicate grant rows stay as separate, separately revokable chips", () => {
    const chips = chipsOf(
      [grantRow({ id: "g1", subject: { kind: "user", userId: "u1" } }),
       grantRow({ id: "g2", subject: { kind: "user", userId: "u1" }, actions: ["read"] })],
      { u1: "mihai" },
      {},
    )
    assert.equal(chips.length, 2)
    assert.deepEqual(chips.map((c) => c.grantId), ["g1", "g2"])
  })
})

describe("calls with injected fetch", () => {
  const cube = { cube: "crm/organizations", entityType: "Organization", entityId: "o1" }

  it("fetchGrantPage posts nothing and maps a 403 to qwbe's message", async () => {
    const { doFetch, calls } = fetchStub(() => ({ status: 403, body: { message: "only owner, cube admin or superadmin may share this entity" } }))
    const result = await fetchGrantPage({ ...cube, offset: 0, limit: 50, doFetch })
    assert.deepEqual(result, { ok: false, status: 403, message: "only owner, cube admin or superadmin may share this entity" })
    assert.equal(calls[0]?.url, "/api/qwbe/permissions/entities/crm%2Forganizations/Organization/o1/grants?offset=0&limit=50")
  })

  it("createUserGrant sends the explicit payload to the user route", async () => {
    const { doFetch, calls } = fetchStub((url, init) => {
      assert.equal(url, "/api/qwbe/permissions/entities/crm%2Forganizations/Organization/o1/grants/user")
      assert.equal(init?.method, "POST")
      return { status: 200, body: { id: "g1", subject: { kind: "user", userId: "u1" }, actions: [...ENTITY_ACTIONS] } }
    })
    const result = await createUserGrant({ ...cube, username: "mihai", actions: [...ENTITY_ACTIONS], doFetch })
    assert.equal(result.ok, true)
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { username: "mihai", actions: [...ENTITY_ACTIONS] })
  })

  it("createUserGrant maps 404 unknown username to qwbe's message", async () => {
    const { doFetch } = fetchStub(() => ({ status: 404, body: { message: "username mihai does not exist" } }))
    const result = await createUserGrant({ ...cube, username: "mihai", actions: [...ENTITY_ACTIONS], doFetch })
    assert.deepEqual(result, { ok: false, status: 404, message: "username mihai does not exist" })
  })

  it("createGroupGrant refuses an empty action set before any request", async () => {
    const { doFetch, calls } = fetchStub(() => ({ status: 200, body: {} }))
    const result = await createGroupGrant({ ...cube, groupId: "grp1", actions: [], doFetch })
    assert.equal(result.ok, false)
    assert.equal(calls.length, 0)
  })

  it("createGroupGrant maps 400 cross-cube group to qwbe's message", async () => {
    const { doFetch } = fetchStub(() => ({ status: 400, body: { message: "group belongs to another cube" } }))
    const result = await createGroupGrant({ ...cube, groupId: "grp1", actions: ["read"], doFetch })
    assert.deepEqual(result, { ok: false, status: 400, message: "group belongs to another cube" })
  })

  it("revokeGrant DELETEs by grant id and maps a 404", async () => {
    const { doFetch, calls } = fetchStub((url, init) => {
      assert.equal(url, "/api/qwbe/permissions/grants/g1")
      assert.equal(init?.method, "DELETE")
      return { status: 200, body: { revoked: "g1" } }
    })
    const ok = await revokeGrant("g1", doFetch)
    assert.deepEqual(ok, { ok: true, value: { revoked: "g1" } })
    const gone = await revokeGrant("g1", fetchStub(() => ({ status: 404, body: { message: "grant g1 not found" } })).doFetch)
    assert.deepEqual(gone, { ok: false, status: 404, message: "grant g1 not found" })
    assert.equal(calls.length, 1)
  })

  it("searchUsers answers null on a refusal (directory unavailable), not 'no matches'", async () => {
    const users = await searchUsers({ q: "mih", limit: 20, doFetch: fetchStub(() => ({ status: 403, body: {} })).doFetch })
    assert.equal(users, null)
    const empty = await searchUsers({ q: "zzz", limit: 20, doFetch: fetchStub(() => ({ status: 200, body: { rows: [] } })).doFetch })
    assert.deepEqual(empty, [])
  })

  it("searchUsers keeps id and username, drops unusable rows", async () => {
    const { doFetch } = fetchStub(() => ({
      status: 200,
      body: { rows: [{ id: "u1", username: "mihai", displayName: "Mihai", email: "m@x" }, { id: "u2" }] },
    }))
    const users = await searchUsers({ q: "mih", limit: 20, doFetch })
    assert.deepEqual(users, [{ id: "u1", username: "mihai", displayName: "Mihai" }])
  })

  it("lookupUserNames maps resolved rows and falls back around missing ones", async () => {
    const { doFetch } = fetchStub(() => ({ status: 200, body: { rows: [{ id: "u1", username: "mihai" }] } }))
    const names = await lookupUserNames(["u1", "u2"], doFetch)
    assert.deepEqual(names, { u1: "mihai" })
    assert.deepEqual(await lookupUserNames([], doFetch), {})
  })

  it("lookupGroups returns null on 403 (hide the group form) and names on 200", async () => {
    const denied = await lookupGroups("crm/organizations", fetchStub(() => ({ status: 403, body: { message: "only an entity owner or cube admin may manage groups" } })).doFetch)
    assert.equal(denied, null)
    const ok = await lookupGroups("crm/organizations", fetchStub(() => ({
      status: 200,
      body: [{ id: "grp1", cube: "crm/organizations", name: "Sales", createdBy: "admin", createdAt: "x" }],
    })).doFetch)
    assert.deepEqual(ok, { grp1: "Sales" })
  })
})
