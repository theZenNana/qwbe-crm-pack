// Unit tests for the qwbe data provider (QWB-53 / QWB-54, merged). qwbe is
// stubbed at the HTTP boundary: every test asserts the exact request the
// provider sends (method, proxy path, query) and how qwbe's own response or
// refusal maps back -- including the field-keyed body.errors ra-core's forms
// read, with qwbe's own message.

import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { fieldErrorsOf, qwbeDataProvider } from "./qwbe-data-provider.ts"

// A stub fetch that records the request and answers from a queue.
function stubFetch(responder: (url: string, init?: RequestInit) => unknown | Response) {
  const requests: { url: string; init?: RequestInit }[] = []
  const doFetch: typeof fetch = async (input, init) => {
    const url = String(input)
    requests.push({ url, init })
    const answer = responder(url, init)
    const response =
      answer instanceof Response ? answer : new Response(JSON.stringify(answer), { status: 200 })
    return response
  }
  return { doFetch, requests }
}

const row = { id: "con_1", name: "Ada" }
const pageOf = (rows: unknown[], total?: number) => ({ rows, offset: 0, limit: 25, total })

describe("qwbeDataProvider", () => {
  it("getList maps ra-core paging and sort onto qwbe's list contract", async () => {
    const { doFetch, requests } = stubFetch(() => pageOf([row], 7))
    const provider = qwbeDataProvider(doFetch)
    const result = await provider.getList("crm/contacts", {
      pagination: { page: 3, perPage: 25 },
      sort: { field: "name", order: "DESC" },
      filter: { organizationId: "org_1" },
    })
    assert.deepEqual(result, { data: [row], total: 7 })
    assert.equal(requests[0].url, "/api/qwbe/contacts?offset=50&limit=25&sortBy=name&descending=true&organizationId=org_1")
  })

  it("getList maps ra-core's default id sort to no sort parameter at all", async () => {
    const { doFetch, requests } = stubFetch(() => pageOf([row]))
    const provider = qwbeDataProvider(doFetch)
    await provider.getList("crm/contacts", {
      pagination: { page: 1, perPage: 25 },
      sort: { field: "id", order: "ASC" },
      filter: {},
    })
    assert.equal(requests[0].url, "/api/qwbe/contacts?offset=0&limit=25")
  })

  it("getOne asks the row endpoint through the proxy", async () => {
    const { doFetch, requests } = stubFetch(() => row)
    const provider = qwbeDataProvider(doFetch)
    assert.deepEqual(await provider.getOne("crm/contacts", { id: "con_1" }), { data: row })
    assert.equal(requests[0].url, "/api/qwbe/contacts/con_1")
    assert.equal(requests[0].init?.method ?? "GET", "GET")
  })

  it("getOne encodes the id as one path segment", async () => {
    const { doFetch, requests } = stubFetch(() => row)
    await qwbeDataProvider(doFetch).getOne("crm/organizations", { id: "a/b" })
    assert.equal(requests[0].url, "/api/qwbe/organizations/a%2Fb")
  })

  it("getMany sends one ids batch, deduplicated, with no limit", async () => {
    const { doFetch, requests } = stubFetch(() => pageOf([row]))
    const provider = qwbeDataProvider(doFetch)
    const result = await provider.getMany("crm/organizations", { ids: ["org_2", "org_1", "org_2"] })
    assert.deepEqual(result, { data: [row] })
    assert.equal(requests[0].url, "/api/qwbe/organizations?ids=org_2%2Corg_1")
  })

  it("getMany with no ids asks nothing", async () => {
    const { doFetch, requests } = stubFetch(() => pageOf([]))
    const provider = qwbeDataProvider(doFetch)
    assert.deepEqual(await provider.getMany("crm/organizations", { ids: [] }), { data: [] })
    assert.equal(requests.length, 0)
  })

  it("update PATCHes exactly the body it is given and maps the stored row back", async () => {
    const saved = { ...row, name: "Grace", custom: { tva: true } }
    const { doFetch, requests } = stubFetch(() => saved)
    const provider = qwbeDataProvider(doFetch)
    const result = await provider.update("crm/contacts", {
      id: "con_1",
      // A custom value travels flat (the kernel folds it into `custom`).
      data: { name: "Grace", tva: true },
      previousData: row,
    })
    assert.deepEqual(result, { data: saved })
    assert.equal(requests.length, 1)
    assert.equal(requests[0].init?.method, "PATCH")
    assert.equal(requests[0].url, "/api/qwbe/contacts/con_1")
    assert.equal(requests[0].init?.body, JSON.stringify({ name: "Grace", tva: true }))
  })

  it("update with an empty body sends no request and keeps the row", async () => {
    const { doFetch, requests } = stubFetch(() => row)
    const provider = qwbeDataProvider(doFetch)
    const result = await provider.update("crm/contacts", { id: "con_1", data: {}, previousData: row })
    assert.deepEqual(result, { data: row })
    assert.equal(requests.length, 0)
  })

  it("a refused PATCH throws qwbe's message with the per-field errors ra-core expects", async () => {
    const { doFetch } = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            message: "OrganizationPatch refused",
            issues: [{ _tag: "Refinement", path: ["name"], message: 'Expected a non empty string, actual ""' }],
          }),
          { status: 400 },
        ),
    )
    const provider = qwbeDataProvider(doFetch)
    await assert.rejects(
      provider.update("crm/contacts", { id: "con_1", data: { name: "" }, previousData: row }),
      (e: unknown) => {
        const err = e as { message: string; status: number; body: { errors: Record<string, string> } }
        assert.equal(err.status, 400)
        assert.equal(err.message, "OrganizationPatch refused")
        assert.deepEqual(err.body.errors, { name: 'Expected a non empty string, actual ""' })
        return true
      },
    )
  })

  it("a non-JSON refusal keeps the text as the message and carries no field errors", async () => {
    const { doFetch } = stubFetch(() => new Response("kernel gone", { status: 503 }))
    const provider = qwbeDataProvider(doFetch)
    await assert.rejects(provider.getOne("crm/contacts", { id: "con_1" }), (e: unknown) => {
      const err = e as { message: string; status: number; body: { errors: Record<string, string> } }
      assert.equal(err.status, 503)
      assert.equal(err.message, "kernel gone")
      assert.deepEqual(err.body.errors, {})
      return true
    })
  })

  it("create POSTs the body to the cube's list path", async () => {
    const { doFetch, requests } = stubFetch(() => row)
    await qwbeDataProvider(doFetch).create("crm/contacts", { data: { name: "Ada" } })
    assert.equal(requests[0].init?.method, "POST")
    assert.equal(requests[0].url, "/api/qwbe/contacts")
  })

  it("delete is refused: qwbe has no DELETE endpoints", async () => {
    const provider = qwbeDataProvider(async () => new Response("{}", { status: 200 }))
    await assert.rejects(provider.delete("crm/contacts", { id: "con_1", previousData: row }), /delete is not supported/)
  })
})

describe("fieldErrorsOf", () => {
  it("keeps the first message per field and skips issues without a field path", () => {
    assert.deepEqual(
      fieldErrorsOf({
        issues: [
          { path: ["name"], message: "first" },
          { path: ["name"], message: "second" },
          { path: [], message: "whole body" },
          { message: "no path" },
        ],
      }),
      { name: "first" },
    )
    assert.deepEqual(fieldErrorsOf("plain text"), {})
  })
})
