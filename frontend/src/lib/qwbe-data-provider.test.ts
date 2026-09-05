// Unit tests for the qwbe data provider (QWB-54). qwbe is stubbed at the HTTP
// boundary: every test asserts the exact request the provider sends (method,
// proxy path, query) and how qwbe's own response or refusal maps back.

import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { qwbeDataProvider } from "./qwbe-data-provider.ts"

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

  it("update PATCHes the row and maps the stored row back", async () => {
    const saved = { ...row, name: "Grace" }
    const { doFetch, requests } = stubFetch(() => saved)
    const provider = qwbeDataProvider(doFetch)
    const result = await provider.update("crm/contacts", {
      id: "con_1",
      data: { name: "Grace" },
      previousData: row,
    })
    assert.deepEqual(result, { data: saved })
    assert.equal(requests[0].init?.method, "PATCH")
    assert.equal(requests[0].url, "/api/qwbe/contacts/con_1")
    assert.equal(requests[0].init?.body, JSON.stringify({ name: "Grace" }))
  })

  it("a qwbe refusal carries qwbe's own message", async () => {
    const { doFetch } = stubFetch(
      () =>
        new Response(
          JSON.stringify({ message: "validation failed", issues: [{ path: ["name"], message: "name is required" }] }),
          { status: 400 },
        ),
    )
    const provider = qwbeDataProvider(doFetch)
    await assert.rejects(
      provider.update("crm/contacts", {
        id: "con_1",
        data: { name: "" },
        previousData: { id: "con_1", name: "Ada" },
      }),
      // Without a field context the provider surfaces qwbe's top-level message.
      (error: Error) => error.message === "validation failed",
    )
  })

  it("a non-JSON refusal does not lose the text", async () => {
    const { doFetch } = stubFetch(() => new Response("kernel gone", { status: 503 }))
    const provider = qwbeDataProvider(doFetch)
    await assert.rejects(
      provider.getOne("crm/contacts", { id: "con_1" }),
      (error: Error) => error.message === "kernel gone",
    )
  })

  it("delete is refused: qwbe has no DELETE endpoints", async () => {
    const provider = qwbeDataProvider(async () => new Response("{}", { status: 200 }))
    await assert.rejects(provider.delete("crm/contacts", { id: "con_1", previousData: row }))
  })
})
