// Unit tests for the metadata-driven list logic (QWB-49). qwbe is stubbed at the
// function boundary: everything here is pure derivation from metadata shapes, so
// no live backend is needed. The tests encode the design rule: a field added to
// the metadata appears in the UI without touching any component.

import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  canEdit,
  columnsFromFields,
  cubeApiPath,
  errorMessage,
  hrefForRelation,
  listApiPath,
  listQueryString,
  metadataApiPath,
  routeOf,
  type FieldMetadata,
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
    // link field, not a client-side slice.
    assert.equal(parsed.get("accountId"), "acc-1")
  })

  it("builds the full list path from the cube name", () => {
    assert.equal(
      listApiPath("crm/contacts", { offset: 0, limit: 25, sortBy: "name", filters: { accountId: "acc-9" } }),
      "/api/qwbe/crm/contacts?offset=0&limit=25&sortBy=name&accountId=acc-9",
    )
  })

  it("drops an empty filter value instead of sending it", () => {
    assert.equal(listQueryString({ filters: { accountId: "" } }), "")
  })
})

describe("metadata paths", () => {
  it("percent-encodes a child cube name for the metadata endpoint", () => {
    assert.equal(metadataApiPath("crm/accounts"), "/api/qwbe/catalog/crm%2Faccounts/metadata")
  })

  it("reaches rows through the proxy under the cube path", () => {
    assert.equal(cubeApiPath("crm/contacts", "/ct-1"), "/api/qwbe/crm/contacts/ct-1")
  })
})

describe("columns derived from metadata", () => {
  it("maps every published field to a column", () => {
    const columns = columnsFromFields([field({ name: "name" }), field({ name: "industry", sortable: false })])
    assert.deepEqual(
      columns.map((c) => [c.field.name, c.sortable, c.editable]),
      [
        ["name", true, true],
        ["industry", false, true],
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
})

describe("inline editing", () => {
  it("an editable field allows editing", () => {
    assert.equal(canEdit(field({ editable: true })), true)
  })

  it("a non-editable field refuses editing", () => {
    assert.equal(canEdit(field({ editable: false })), false)
  })
})

describe("qwbe error messages", () => {
  it("surfaces the per-field issue message from a validation failure", () => {
    const body = {
      issues: [{ _tag: "Refinement", path: ["name"], message: 'Expected a non empty string, actual ""' }],
      message: "OrganizationPatch ...",
    }
    assert.equal(errorMessage(body), 'Expected a non empty string, actual ""')
  })

  it("falls back to the qwbe message and then to a default", () => {
    assert.equal(errorMessage({ message: "organization 404" }), "organization 404")
    assert.equal(errorMessage("plain refusal"), "plain refusal")
    assert.equal(errorMessage({}), "the change was refused")
  })
})

describe("relation links", () => {
  it("resolves a relation target to the detail route of the target cube", () => {
    assert.equal(
      hrefForRelation("crm/accounts", "acc-1"),
      "/accounts/acc-1",
    )
  })

  it("handles a root-level cube name", () => {
    assert.equal(hrefForRelation("contacts", "ct-1"), "/contacts/ct-1")
  })

  it("derives the list route of a cube", () => {
    assert.equal(routeOf("crm/contacts"), "/contacts")
  })
})
