// Unit tests for the batched relation resolution (QWB-54, ticket 11).
//
// Pure derivation only, no DOM, no backend -- the same boundary the cube.test.ts
// suite tests across. The property under test is the ticket's objective: a
// whole page of relation cells is described by ONE request per target cube,
// not one request per cell.

import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  batchListApiPath,
  relationRefsOf,
  relationSearchApiPath,
  titlesOfPage,
} from "./relation-batch.ts"
import { listApiPath, type FieldMetadata, type Row } from "./cube.ts"

const relationField = (over: Partial<FieldMetadata> = {}): FieldMetadata => ({
  name: "accountId",
  label: "Organization",
  type: "string",
  required: false,
  editable: true,
  sortable: false,
  searchable: false,
  nullable: true,
  enum: null,
  relation: { target: "crm/accounts", entity: "Account", summary: null },
  custom: false,
  ...over,
})

const textField = (over: Partial<FieldMetadata> = {}): FieldMetadata => ({
  name: "name",
  label: "Name",
  type: "string",
  required: true,
  editable: true,
  sortable: true,
  searchable: false,
  nullable: false,
  enum: null,
  relation: null,
  custom: false,
  ...over,
})

describe("relationRefsOf", () => {
  it("collects one ref per relation value on the page, deduplicated", () => {
    const rows: Row[] = [
      { id: "c1", accountId: "a1" },
      { id: "c2", accountId: "a2" },
      { id: "c3", accountId: "a1" }, // same target again: dedup, not a second cell fetch
    ]
    const refs = relationRefsOf(rows, [relationField()])
    assert.deepEqual(refs, [
      { target: "crm/accounts", id: "a1" },
      { target: "crm/accounts", id: "a2" },
    ])
  })

  it("skips absent, null and empty values -- an unset relation is not a cell to resolve", () => {
    const rows: Row[] = [
      { id: "c1" },
      { id: "c2", accountId: null },
      { id: "c3", accountId: "" },
      { id: "c4", accountId: "a1" },
    ]
    assert.deepEqual(relationRefsOf(rows, [relationField()]), [{ target: "crm/accounts", id: "a1" }])
  })

  it("reads a custom relation value from the row's custom sub-object, like the cell does", () => {
    const rows: Row[] = [{ id: "c1", custom: { partnerId: "p9" } }]
    const refs = relationRefsOf(rows, [
      relationField({ name: "partnerId", label: "Partner", custom: true }),
    ])
    assert.deepEqual(refs, [{ target: "crm/accounts", id: "p9" }])
  })

  it("ignores non-relation fields entirely", () => {
    const rows: Row[] = [{ id: "c1", name: "n1", accountId: "a1" }]
    assert.deepEqual(relationRefsOf(rows, [textField()]), [])
  })

  it("groups by target: two relation fields to two cubes produce refs for both", () => {
    const rows: Row[] = [{ id: "c1", accountId: "a1", otherId: "o1" }]
    const refs = relationRefsOf(rows, [
      relationField(),
      relationField({ name: "otherId", relation: { target: "crm/contracts", entity: "Contract", summary: null } }),
    ])
    assert.deepEqual(refs, [
      { target: "crm/accounts", id: "a1" },
      { target: "crm/contracts", id: "o1" },
    ])
  })
})

describe("batchListApiPath", () => {
  it("describes ONE request carrying the whole page's ids", () => {
    const ids = Array.from({ length: 25 }, (_, i) => `acc-${i + 1}`)
    const path = batchListApiPath("crm/accounts", ids)
    const [before, query] = path.split("?")
    assert.equal(before, "/api/qwbe/accounts") // the leaf the cube serves at, not "crm/accounts"
    const got = new URLSearchParams(query).get("ids")?.split(",")
    assert.equal(got?.length, 25) // one request, 25 ids -- the old list made 25 requests
    assert.deepEqual(got, ids)
  })

  it("sends no limit: qwbe sizes an ids batch by the ids themselves", () => {
    const params = new URLSearchParams(batchListApiPath("crm/accounts", ["a1"]).split("?")[1])
    assert.equal(params.get("limit"), null)
    assert.equal(params.get("ids"), "a1")
  })

  it("deduplicates and percent-encodes opaque ids", () => {
    const path = batchListApiPath("crm/accounts", ["a1", "a1", "a/b"])
    // On the wire both separators and the slash are encoded (one query
    // value); the parsed view decodes back to the ids sent.
    assert.ok(path.includes("ids=a1%2Ca%2Fb"))
    const got = new URLSearchParams(path.split("?")[1]).get("ids")?.split(",")
    assert.deepEqual(got, ["a1", "a/b"])
  })
})

describe("relationSearchApiPath", () => {
  it("searches by q with a small limit", () => {
    const params = new URLSearchParams(relationSearchApiPath("crm/accounts", "Acme", 20).split("?")[1])
    assert.equal(params.get("q"), "Acme")
    assert.equal(params.get("limit"), "20")
  })

  it("an empty (or blank) text asks for the first rows only -- no q, no search", () => {
    for (const text of ["", "   "]) {
      const params = new URLSearchParams(relationSearchApiPath("crm/accounts", text, 20).split("?")[1])
      assert.equal(params.get("q"), null)
      assert.equal(params.get("limit"), "20")
    }
  })

  it("trims the text", () => {
    const params = new URLSearchParams(relationSearchApiPath("crm/accounts", "  Acme  ", 20).split("?")[1])
    assert.equal(params.get("q"), "Acme")
  })
})

describe("titlesOfPage", () => {
  const meta = {
    cube: "crm/accounts",
    entity: "Account",
    version: "1.0.0",
    schemaHash: "x",
    fields: [textField({ name: "name" })],
  }

  it("maps each returned row's id to its metadata title", () => {
    const titles = titlesOfPage(meta, [
      { id: "a1", name: "Alpha" },
      { id: "a2", name: "Beta" },
    ])
    assert.deepEqual(titles, { a1: "Alpha", a2: "Beta" })
  })

  it("a row the response did not return is simply absent, and a title-less row maps to its id", () => {
    const titles = titlesOfPage(meta, [{ id: "a1" }])
    assert.deepEqual(titles, { a1: "a1" })
  })
})

describe("list query guard", () => {
  it("a field named like the batch or search keys never rides as a filter", () => {
    const path = listApiPath("crm/accounts", { filters: { ids: "x", q: "y", name: "Alpha" } })
    const params = new URLSearchParams(path.split("?")[1])
    assert.equal(params.get("ids"), null)
    assert.equal(params.get("q"), null)
    assert.equal(params.get("name"), "Alpha")
  })
})
