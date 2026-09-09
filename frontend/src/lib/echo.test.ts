// Unit tests for the echo adapter: paths, the trust-boundary parser, the pure
// display helpers and the injected-fetch calls. No DOM, no backend. Contract:
// qwbe core/src/cubes/echo/index.ts + feed.ts as read on 2026-09-07.

import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  COMMENT_MAX,
  actorLabel,
  addComment,
  appendRows,
  commentActions,
  commentPath,
  commentState,
  commentsPath,
  deleteComment,
  describeChanges,
  editComment,
  feedPath,
  fetchActivityCubes,
  fetchFeed,
  fetchModerator,
  formatAt,
  isTargetRefusal,
  moderatorProbePath,
  opLabel,
  parseActivityCubes,
  parseFeedPage,
  withComment,
  type FeedComment,
  type FeedRow,
} from "./echo.ts"

function fetchStub(
  responder: (url: string, init: RequestInit | undefined) => { status: number; body: unknown } | undefined,
): { doFetch: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    const answer = responder(url, init)
    if (!answer) return new Response("nope", { status: 404 })
    const body = typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body)
    return new Response(body, { status: answer.status, headers: { "content-type": "application/json" } })
  }) as typeof fetch
  return { doFetch, calls }
}

const comment: FeedComment = {
  id: "c1",
  cube: "crm/contacts",
  entityType: "Contact",
  rowId: "r1",
  actorId: "u1",
  actorUsername: "ana",
  body: "hello",
  createdAt: "2026-09-07T10:00:00.000Z",
  editedAt: null,
  deletedAt: null,
  deletedBy: null,
}

const row = (id: number, extra: Partial<FeedRow> = {}): FeedRow => ({
  id,
  at: "2026-09-07T10:00:00.000Z",
  cube: "crm/contacts",
  entityType: "Contact",
  rowId: "r1",
  op: "update",
  version: 2,
  actorId: "u1",
  actorUsername: "ana",
  changes: { name: { from: "a", to: "b" } },
  commentId: null,
  comment: null,
  ...extra,
})

describe("paths", () => {
  it("encodes a slash cube as a query parameter, never a path segment", () => {
    assert.equal(feedPath({ cube: "crm/contacts", entityId: "r 1" }), "/api/qwbe/echo/feed?cube=crm%2Fcontacts&entityId=r+1")
    assert.equal(feedPath({}), "/api/qwbe/echo/feed")
    assert.equal(feedPath({ cube: "crm/contacts", before: 40, limit: 20 }), "/api/qwbe/echo/feed?cube=crm%2Fcontacts&before=40&limit=20")
    assert.equal(commentsPath("crm/contacts", "r1"), "/api/qwbe/echo/comments?cube=crm%2Fcontacts&entityId=r1")
    assert.equal(commentPath("c/1"), "/api/qwbe/echo/comments/c%2F1")
    assert.equal(moderatorProbePath("crm/contacts"), "/api/qwbe/permissions/cube-admins?cube=crm%2Fcontacts")
  })

  it("refuses entityId without cube and non-positive cursors", () => {
    assert.equal(feedPath({ entityId: "r1" }), null)
    assert.equal(feedPath({ before: 0 }), null)
    assert.equal(feedPath({ limit: 1.5 }), null)
    assert.equal(feedPath({ before: Number.NaN }), null)
    assert.equal(commentsPath("", "r1"), null)
    assert.equal(commentsPath("crm/contacts", "  "), null)
    assert.equal(commentPath(""), null)
  })
})

describe("parseFeedPage", () => {
  it("accepts the kernel shape, including an empty page with a live cursor", () => {
    const page = parseFeedPage({ rows: [], nextBefore: 17 })
    assert.deepEqual(page, { rows: [], nextBefore: 17 })
    const full = parseFeedPage({ rows: [row(3, { commentId: "c1", comment, op: "comment", changes: null })], nextBefore: null })
    assert.equal(full?.rows[0]?.comment?.body, "hello")
  })

  it("rejects anything off-shape instead of painting it", () => {
    assert.equal(parseFeedPage(null), null)
    assert.equal(parseFeedPage({ rows: "x", nextBefore: null }), null)
    assert.equal(parseFeedPage({ rows: [], nextBefore: "7" }), null)
    assert.equal(parseFeedPage({ rows: [{ id: "1" }], nextBefore: null }), null)
    assert.equal(parseFeedPage({ rows: [row(1, { comment: { id: 1 } as unknown as FeedComment })], nextBefore: null }), null)
  })
})

describe("display helpers", () => {
  it("describes changes as plain text from/to lines", () => {
    assert.deepEqual(describeChanges({ name: { from: "a", to: "b" }, "custom.vip": { to: true }, tags: { from: ["x"] } }), [
      { field: "name", from: "a", to: "b" },
      { field: "custom.vip", from: null, to: "true" },
      { field: "tags", from: '["x"]', to: null },
    ])
    assert.deepEqual(describeChanges(null), [])
    assert.deepEqual(describeChanges({ odd: "<b>x</b>" }), [{ field: "odd", from: null, to: "<b>x</b>" }])
  })

  it("names the actor truthfully: username, else id, else system", () => {
    assert.equal(actorLabel({ actorId: "u1", actorUsername: "ana" }), "ana")
    assert.equal(actorLabel({ actorId: "u1", actorUsername: null }), "u1")
    assert.equal(actorLabel({ actorId: null, actorUsername: null }), "system")
    assert.equal(opLabel("create"), "created")
    assert.equal(opLabel("weird"), "weird")
  })

  it("reports the comment state and formats dates gracefully", () => {
    assert.equal(commentState(comment), "current")
    assert.equal(commentState({ ...comment, editedAt: "2026-09-07T11:00:00Z" }), "edited")
    assert.equal(commentState({ ...comment, editedAt: "x", deletedAt: "2026-09-07T12:00:00Z" }), "deleted")
    assert.equal(formatAt("not a date"), "not a date")
    assert.notEqual(formatAt("2026-09-07T10:00:00.000Z"), "2026-09-07T10:00:00.000Z")
  })

  it("offers edit to the author only and delete to author or moderator, never on a deleted comment", () => {
    assert.deepEqual(commentActions(comment, "u1", false), { edit: true, delete: true })
    assert.deepEqual(commentActions(comment, "u2", false), { edit: false, delete: false })
    assert.deepEqual(commentActions(comment, "u2", true), { edit: false, delete: true })
    assert.deepEqual(commentActions(comment, "u2", undefined), { edit: false, delete: false })
    assert.deepEqual(commentActions(comment, null, true), { edit: false, delete: true })
    assert.deepEqual(commentActions({ ...comment, deletedAt: "2026-09-07T12:00:00Z" }, "u1", true), { edit: false, delete: false })
    assert.deepEqual(commentActions({ ...comment, actorId: null }, null, false), { edit: false, delete: false })
  })

  it("appends without duplicates and swaps only the matching comment", () => {
    const rows = appendRows([row(3), row(2)], [row(2), row(1)])
    assert.deepEqual(rows.map((r) => r.id), [3, 2, 1])
    const edited = { ...comment, body: "changed", editedAt: "2026-09-07T11:00:00Z" }
    const out = withComment([row(3, { commentId: "c1", comment }), row(2, { commentId: "c9", comment: { ...comment, id: "c9" } })], edited)
    assert.equal(out[0]?.comment?.body, "changed")
    assert.equal(out[1]?.comment?.body, "hello")
  })
})

describe("calls", () => {
  it("fetchFeed returns the page and keeps a 403 as a refusal with the server message", async () => {
    const ok = fetchStub(() => ({ status: 200, body: { rows: [row(1)], nextBefore: 1 } }))
    const page = await fetchFeed({ cube: "crm/contacts", entityId: "r1" }, ok.doFetch)
    assert.equal(page.ok, true)
    assert.equal(ok.calls[0]?.url, "/api/qwbe/echo/feed?cube=crm%2Fcontacts&entityId=r1")
    const denied = fetchStub(() => ({ status: 403, body: { message: "this entity is not shared with you" } }))
    const r = await fetchFeed({ cube: "crm/contacts", entityId: "r1" }, denied.doFetch)
    assert.deepEqual(r, { ok: false, status: 403, message: "this entity is not shared with you" })
  })

  it("fetchFeed never turns a bad body, a bad query or a network failure into an empty feed", async () => {
    const junk = fetchStub(() => ({ status: 200, body: "<html>" }))
    const r = await fetchFeed({}, junk.doFetch)
    assert.deepEqual(r, { ok: false, status: 200, message: "invalid feed response" })
    const bad = await fetchFeed({ entityId: "r1" }, junk.doFetch)
    assert.equal(bad.ok, false)
    assert.equal(junk.calls.length, 1)
    const down = (async () => {
      throw new TypeError("fetch failed")
    }) as typeof fetch
    assert.deepEqual(await fetchFeed({}, down), { ok: false, status: 0, message: "network error" })
  })

  it("addComment trims, refuses empty and oversized bodies before the round trip, posts JSON", async () => {
    const stub = fetchStub((_url, init) => ({
      status: 200,
      body: row(9, { op: "comment", commentId: "c1", comment: { ...comment, body: JSON.parse(String(init?.body)).body }, changes: null }),
    }))
    const r = await addComment({ cube: "crm/contacts", entityId: "r1", body: "  hi  ", doFetch: stub.doFetch })
    assert.equal(r.ok && r.value.comment?.body, "hi")
    assert.equal(stub.calls[0]?.url, "/api/qwbe/echo/comments?cube=crm%2Fcontacts&entityId=r1")
    assert.equal(stub.calls[0]?.init?.method, "POST")
    assert.equal(stub.calls[0]?.init?.body, JSON.stringify({ body: "hi" }))
    const empty = await addComment({ cube: "crm/contacts", entityId: "r1", body: "   ", doFetch: stub.doFetch })
    assert.deepEqual(empty, { ok: false, status: 400, message: "the comment cannot be empty" })
    const long = await addComment({ cube: "crm/contacts", entityId: "r1", body: "x".repeat(COMMENT_MAX + 1), doFetch: stub.doFetch })
    assert.equal(long.ok, false)
    assert.equal(stub.calls.length, 1)
  })

  it("editComment PATCHes by id; deleteComment DELETEs and hands back the deleted comment", async () => {
    const stub = fetchStub((url, init) =>
      init?.method === "PATCH"
        ? { status: 200, body: { ...comment, body: "new", editedAt: "2026-09-07T11:00:00Z" } }
        : init?.method === "DELETE"
          ? { status: 200, body: { ...comment, body: "", deletedAt: "2026-09-07T12:00:00Z", deletedBy: "u9" } }
          : undefined,
    )
    const e = await editComment({ id: "c1", body: "new", doFetch: stub.doFetch })
    assert.equal(e.ok && e.value.editedAt, "2026-09-07T11:00:00Z")
    assert.equal(stub.calls[0]?.url, "/api/qwbe/echo/comments/c1")
    const d = await deleteComment("c1", stub.doFetch)
    assert.equal(d.ok && d.value.body, "")
    assert.equal(d.ok && d.value.deletedBy, "u9")
    const refused = fetchStub(() => ({ status: 403, body: { message: "only the author may edit a comment" } }))
    assert.deepEqual(await editComment({ id: "c1", body: "x", doFetch: refused.doFetch }), {
      ok: false,
      status: 403,
      message: "only the author may edit a comment",
    })
  })

  it("fetchModerator: 200 = moderator, 403 = not, anything else is a failure", async () => {
    assert.deepEqual(await fetchModerator("crm/contacts", fetchStub(() => ({ status: 200, body: [] })).doFetch), { ok: true, value: true })
    assert.deepEqual(await fetchModerator("crm/contacts", fetchStub(() => ({ status: 403, body: { message: "no" } })).doFetch), {
      ok: true,
      value: false,
    })
    const r = await fetchModerator("crm/contacts", fetchStub(() => ({ status: 500, body: "boom" })).doFetch)
    assert.equal(r.ok, false)
  })

  it("isTargetRefusal: only the target gate's sentences trigger a reload", () => {
    assert.equal(isTargetRefusal("this entity is not shared with you"), true)
    assert.equal(isTargetRefusal("crm/contacts does not capture activity"), true)
    assert.equal(isTargetRefusal("only the author may edit a comment"), false)
    assert.equal(isTargetRefusal("only the author or a moderator may delete a comment"), false)
  })

  it("fetchActivityCubes: enabled cubes with an entity, sorted; 403 and junk are failures", async () => {
    const catalogue = [
      { name: "crm/contacts", enabled: true, entity: "Contact" },
      { name: "auth", enabled: true, entity: null },
      { name: "crm/contracts", enabled: false, entity: "Contract" },
      { name: "crm/organizations", enabled: true, entity: "Organization" },
    ]
    const stub = fetchStub(() => ({ status: 200, body: catalogue }))
    assert.deepEqual(await fetchActivityCubes(stub.doFetch), {
      ok: true,
      value: [
        { name: "crm/contacts", entity: "Contact" },
        { name: "crm/organizations", entity: "Organization" },
      ],
    })
    assert.equal(stub.calls[0]?.url, "/api/qwbe/settings/cubes")
    assert.deepEqual(await fetchActivityCubes(fetchStub(() => ({ status: 403, body: { message: "no" } })).doFetch), {
      ok: false,
      status: 403,
      message: "no",
    })
    assert.equal(parseActivityCubes([{ name: "x", enabled: "yes", entity: null }]), null)
    assert.equal(parseActivityCubes({ rows: [] }), null)
    const junk = await fetchActivityCubes(fetchStub(() => ({ status: 200, body: { rows: [] } })).doFetch)
    assert.deepEqual(junk, { ok: false, status: 200, message: "invalid cube catalogue" })
  })
})
