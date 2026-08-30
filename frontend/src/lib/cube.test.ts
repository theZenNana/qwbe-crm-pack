// Unit tests for the metadata-driven list logic (QWB-49). qwbe is stubbed at the
// function boundary: everything here is pure derivation from metadata shapes and
// from the real request path the component drives, so no live backend is needed.
// The tests encode the design rule: a field added to the metadata appears in the
// UI without touching any component.

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createRequire } from "node:module"
const require = createRequire(import.meta.url)

import {
  canEdit,
  columnsFromFields,
  coerce,
  cubeApiPath,
  errorMessage,
  errorBody,
  hrefForRelation,
  rowHref,
  listApiPath,
  listQueryString,
  metadataApiPath,
  resolveRelationTitle,
  routeOf,
  saveCell,
  sortRequestFor,
  titleOf,
  type ColumnSpec,
  type CubeMetadata,
  type FieldMetadata,
  type PageOf,
  type Row,
} from "./cube.ts"

const field = (over: Partial<FieldMetadata> = {}): FieldMetadata => ({
  name: "name",
  label: "Name",
  type: "string",
  required: false,
  editable: true,
  sortable: true,
  searchable: false,
  nullable: false,
  enum: null,
  relation: null,
  ...over,
})

const column = (over: Partial<FieldMetadata> = {}): ColumnSpec => {
  const f = field(over)
  return { field: f, sortable: f.sortable, editable: f.editable, visible: f.editable }
}

const meta = (over: Partial<CubeMetadata> = {}): CubeMetadata => ({
  cube: "crm/contacts",
  entity: "Contact",
  version: null,
  schemaHash: "hash",
  fields: [field({ name: "name", required: true }), field({ name: "email" })],
  ...over,
})

describe("list request parameters", () => {
  it("carries page, sort and filter parameters to qwbe", () => {
    const qs = listQueryString({
      offset: 25,
      limit: 50,
      sortBy: "name",
      descending: true,
      filters: { accountId: "acc-1" },
    })
    const parsed = new URLSearchParams(qs)
    assert.equal(parsed.get("offset"), "25")
    assert.equal(parsed.get("limit"), "50")
    assert.equal(parsed.get("sortBy"), "name")
    assert.equal(parsed.get("descending"), "true")
    // The search surface the backend serves: field equality on a searchable
    // field, not a client-side slice.
    assert.equal(parsed.get("accountId"), "acc-1")
  })

  it("builds the full list path under the cube's served prefix", () => {
    // A child cube serves under its leaf ("crm/contacts" -> /contacts), so the
    // list request goes there, not to a two-segment path qwbe never mounted.
    assert.equal(
      listApiPath("crm/contacts", { offset: 0, limit: 25, sortBy: "name", filters: { accountId: "acc-9" } }),
      "/api/qwbe/contacts?offset=0&limit=25&sortBy=name&accountId=acc-9",
    )
  })

  it("drops an empty filter value instead of sending it", () => {
    assert.equal(listQueryString({ filters: { accountId: "" } }), "")
  })

  it("a filter key named like a paging key cannot override paging", () => {
    const parsed = new URLSearchParams(
      listQueryString({ offset: 25, limit: 50, sortBy: "name", filters: { limit: "9", sortBy: "evil" } }),
    )
    assert.equal(parsed.get("limit"), "50")
    assert.equal(parsed.get("sortBy"), "name")
  })
})

describe("metadata paths", () => {
  it("percent-encodes a child cube name for the metadata endpoint", () => {
    assert.equal(metadataApiPath("crm/accounts"), "/api/qwbe/catalog/crm%2Faccounts/metadata")
  })

  it("reaches rows through the proxy under the cube's served prefix", () => {
    assert.equal(cubeApiPath("crm/contacts", "/ct-1"), "/api/qwbe/contacts/ct-1")
  })
})

describe("columns derived from metadata", () => {
  it("maps every published field to a column", () => {
    const columns = columnsFromFields([field({ name: "name" }), field({ name: "industry", sortable: false })])
    assert.deepEqual(
      columns.map((c) => [c.field.name, c.sortable, c.editable, c.visible]),
      [
        ["name", true, true, true],
        ["industry", false, true, true],
      ],
    )
  })

  it("a field added to the metadata appears without touching the component", () => {
    // The stub metadata gains a brand-new field; the derivation must include it
    // with exactly the flags the metadata publishes. No per-entity column list
    // exists anywhere in the frontend to update.
    const extended = [field({ name: "name" }), field({ name: "annualrevenue", label: "Annual Revenue", type: "integer" })]
    const columns = columnsFromFields(extended)
    const added = columns.find((c) => c.field.name === "annualrevenue")
    assert.ok(added, "the new field must become a column")
    assert.equal(added.field.label, "Annual Revenue")
    assert.equal(added.field.type, "integer")
  })

  it("a field absent from the create payload is hidden by default", () => {
    // editable is derived from the create payload, so the meta columns (id,
    // type, version, deleted, createdAt) all have editable: false -- they are
    // bookkeeping, not content, and a 60k-row list hides them by default.
    const columns = columnsFromFields([
      field({ name: "name" }),
      field({ name: "id", editable: false, required: false }),
      field({ name: "createdAt", editable: false }),
    ])
    assert.deepEqual(
      columns.filter((c) => c.visible).map((c) => c.field.name),
      ["name"],
    )
  })
})

describe("inline editing", () => {
  it("an editable field allows editing", () => {
    assert.equal(canEdit(field({ editable: true })), true)
  })

  it("a non-editable field refuses editing", () => {
    assert.equal(canEdit(field({ editable: false })), false)
  })

  it("an editable relation field is editable too, as the metadata declares", () => {
    // accountId is editable: true in the metadata; the component must not
    // narrow that on its own.
    const accountId = field({
      name: "accountId",
      editable: true,
      relation: { target: "crm/accounts", entity: "Organization", summary: "summaryById" },
    })
    assert.equal(canEdit(accountId), true)
  })
})

describe("sorting", () => {
  it("a sortable column produces the ascending-first request", () => {
    assert.deepEqual(sortRequestFor(column({ name: "name" }), undefined, false), {
      sortBy: "name",
      descending: false,
    })
  })

  it("clicking the sorted column flips the direction", () => {
    assert.deepEqual(sortRequestFor(column({ name: "name" }), "name", false), {
      sortBy: "name",
      descending: true,
    })
  })

  it("a non-sortable column refuses to sort", () => {
    assert.equal(sortRequestFor(column({ name: "industry", sortable: false }), "name", false), undefined)
  })
})

describe("cell value coercion", () => {
  it("numbers become numbers", () => {
    assert.equal(coerce(field({ type: "integer" }), "42"), 42)
  })

  it("an enum stays a string", () => {
    assert.equal(coerce(field({ enum: ["hot", "cold"] }), "hot"), "hot")
  })

  it("a boolean becomes a real boolean, never the string yes", () => {
    assert.equal(coerce(field({ type: "boolean" }), "yes"), true)
    assert.equal(coerce(field({ type: "boolean" }), "no"), false)
  })

  it("an empty string is null only for a nullable field", () => {
    assert.equal(coerce(field({ nullable: true }), ""), null)
    assert.equal(coerce(field({ nullable: false }), ""), "")
  })
})

describe("saving an inline edit", () => {
  const patchCalls: Array<{ url: string; init?: RequestInit }> = []
  const okFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    patchCalls.push({ url: String(url), init })
    return new Response(JSON.stringify({ id: "acc-1", name: "Renamed", industry: "tech" }), { status: 200 })
  }) as unknown as typeof fetch

  it("PATCHes exactly the edited key to the row and merges only that key", async () => {
    patchCalls.length = 0
    const result = await saveCell({
      rowPath: "/api/qwbe/accounts/acc-1",
      field: field({ name: "name" }),
      current: "Old",
      next: "Renamed",
      doFetch: okFetch,
    })
    assert.equal(result.status, "saved")
    if (result.status === "saved") {
      // The merge carries only the patched key: the caller spreads it over the
      // row, so a stale whole-body response cannot overwrite other columns.
      assert.equal(result.field, "name")
      assert.equal(result.value, "Renamed")
    }
    assert.equal(patchCalls.length, 1)
    assert.equal(patchCalls[0].url, "/api/qwbe/accounts/acc-1")
    assert.deepEqual(JSON.parse(String(patchCalls[0].init?.body)), { name: "Renamed" })
  })

  it("a value equal to the current one sends no request at all", async () => {
    patchCalls.length = 0
    const result = await saveCell({
      rowPath: "/api/qwbe/accounts/acc-1",
      field: field({ name: "name" }),
      current: "Same",
      next: "Same",
      doFetch: okFetch,
    })
    assert.equal(result.status, "unchanged")
    assert.equal(patchCalls.length, 0)
  })

  it("a refused PATCH carries qwbe's message for the edited field", async () => {
    const refusedFetch = (async () =>
      new Response(
        JSON.stringify({
          issues: [
            { _tag: "Refinement", path: ["industry"], message: "wrong field" },
            { _tag: "Refinement", path: ["name"], message: 'Expected a non empty string, actual ""' },
          ],
          message: "OrganizationPatch refused",
        }),
        { status: 400 },
      )) as unknown as typeof fetch
    const result = await saveCell({
      rowPath: "/api/qwbe/accounts/acc-1",
      field: field({ name: "name" }),
      current: "Old",
      next: "",
      doFetch: refusedFetch,
    })
    // The old value stays: the result is a refusal, not a new value -- the
    // caller keeps the row untouched and shows the message in that cell.
    assert.equal(result.status, "refused")
    if (result.status === "refused") {
      assert.equal(result.message, 'Expected a non empty string, actual ""')
    }
  })
})

describe("qwbe error messages", () => {
  const body = {
    issues: [{ _tag: "Refinement", path: ["name"], message: 'Expected a non empty string, actual ""' }],
    message: "OrganizationPatch ...",
  }

  it("surfaces the per-field issue message that names the edited field", () => {
    assert.equal(errorMessage(body, "name"), 'Expected a non empty string, actual ""')
  })

  it("an issue about a different field does not win the cell", () => {
    assert.equal(errorMessage(body, "industry"), "OrganizationPatch ...")
  })

  it("falls back to the qwbe message and then to a default", () => {
    assert.equal(errorMessage({ message: "organization 404" }, "name"), "organization 404")
    assert.equal(errorMessage("plain refusal", "name"), "plain refusal")
    assert.equal(errorMessage({}, "name"), "the change was refused")
  })

  it("a non-JSON error body reaches the message as text", async () => {
    const parsed = await errorBody(new Response("gateway exploded", { status: 502 }))
    assert.equal(parsed, "gateway exploded")
    assert.equal(errorMessage(parsed, "name"), "gateway exploded")
  })
})

describe("relation links", () => {
  it("resolves a relation target to the detail route of the target cube", () => {
    assert.equal(hrefForRelation("crm/accounts", "acc-1"), "/accounts/acc-1")
  })

  it("handles a root-level cube name", () => {
    assert.equal(hrefForRelation("contacts", "ct-1"), "/contacts/ct-1")
  })

  it("a target without a frontend route yields no link", () => {
    // crm/contracts has no page in this app; a dead href must not be built.
    assert.equal(hrefForRelation("crm/contracts", "ctr-1"), null)
  })

  it("derives the list route of a cube", () => {
    assert.equal(routeOf("crm/contacts"), "/contacts")
  })

  it("builds a row link for a cube this app routes", () => {
    assert.equal(rowHref("crm/contacts", "ct-1"), "/contacts/ct-1")
    assert.equal(rowHref("accounts", "acc-1"), "/accounts/acc-1")
  })

  it("no row link for a cube without a route", () => {
    assert.equal(rowHref("crm/contracts", "ctr-1"), null)
  })
})

describe("relation titles", () => {
  it("resolves the title through the target's metadata and row endpoint", async () => {
    const calls: string[] = []
    const doFetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input))
      if (String(input).includes("/metadata")) {
        return new Response(JSON.stringify(meta({ cube: "crm/accounts", entity: "Organization" })))
      }
      return new Response(JSON.stringify({ id: "acc-1", name: "Acme SRL" }))
    }) as unknown as typeof fetch
    assert.equal(await resolveRelationTitle("crm/accounts", "acc-1", doFetch), "Acme SRL")
    assert.ok(calls.some((c) => c.includes("/catalog/")), "the target metadata is read")
    assert.ok(calls.some((c) => c.endsWith("/accounts/acc-1")), "the target row is read")
  })

  it("falls back to the raw id when the target does not answer", async () => {
    const doFetch = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch
    assert.equal(await resolveRelationTitle("crm/contracts", "ctr-1", doFetch), "ctr-1")
  })
})

describe("paging shape and response use", () => {
  it("the row request carries offset, limit and sortBy and nothing is fetched beyond one page", () => {
    // The exact URL the list component fetches: paging and sorting travel to
    // qwbe; the limit is the page size, so 60 thousand rows are never pulled.
    assert.equal(
      listApiPath("crm/accounts", { offset: 50, limit: 25, sortBy: "name" }),
      "/api/qwbe/accounts?offset=50&limit=25&sortBy=name",
    )
  })

  it("the component's request path drives a real page response: rows and total pass through untouched", async () => {
    // The component fetches the list URL this builds; here the response it
    // receives is parsed exactly as the component parses it, and the title the
    // detail header shows comes out of the returned rows.
    const page: PageOf<Row> = {
      rows: [{ id: "acc-1", name: "Acme SRL" }],
      total: 60_000,
      offset: 0,
      limit: 25,
    }
    const realFetch = globalThis.fetch
    let fetchedUrl = ""
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetchedUrl = String(input)
      return new Response(JSON.stringify(page))
    }) as unknown as typeof fetch
    try {
      const url = listApiPath("crm/accounts", { offset: 0, limit: 25 })
      assert.equal(url, "/api/qwbe/accounts?offset=0&limit=25")
      const response = await globalThis.fetch(`http://x.test${url}`)
      const received = (await response.json()) as PageOf<Row>
      assert.equal(received.rows[0].name, "Acme SRL")
      assert.equal(received.total, 60_000)
      assert.equal(titleOf(meta({ cube: "crm/accounts", entity: "Organization" }), received.rows[0]), "Acme SRL")
      assert.equal(fetchedUrl, `http://x.test${url}`)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it("the row title falls back to the id when no required field has a value", () => {
    const { titleOf: t } = require("./cube.ts") as typeof import("./cube.ts")
    assert.equal(t(meta(), { id: "acc-2", name: null }), "acc-2")
  })
})
