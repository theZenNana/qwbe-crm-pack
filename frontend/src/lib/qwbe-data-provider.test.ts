// The admin-kit pilot's data provider (QWB-53), against a stubbed fetch: the
// two verbs hit the proxy paths the rest of the app uses, update PATCHes only
// the edited keys, and a refusal becomes the field-keyed body.errors that
// ra-core puts under the inputs -- with qwbe's own message.

import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { FieldMetadata, Row } from "./cube.ts"
import { fieldErrorsOf, qwbeDataProvider } from "./qwbe-data-provider.ts"

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
  custom: false,
  ...over,
})

const fields = [
  field({ name: "id", editable: false }),
  field({ name: "name", required: true }),
  field({ name: "tva", type: "boolean", custom: true }),
]

const calls: Array<{ url: string; init?: RequestInit }> = []
const stub =
  (respond: (url: string, init?: RequestInit) => Response) =>
  (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return respond(String(url), init)
  }) as unknown as typeof fetch

const row: Row = { id: "org-1", name: "Acme", custom: { tva: false } }

describe("qwbeDataProvider", () => {
  it("getOne reads the row through the proxy", async () => {
    calls.length = 0
    const dp = qwbeDataProvider("crm/organizations", fields, stub(() => Response.json(row)))
    const { data } = await dp.getOne("organizations", { id: "org-1" })
    assert.deepEqual(data, row)
    assert.equal(calls[0].url, "/api/qwbe/organizations/org-1")
    assert.equal(calls[0].init?.method ?? "GET", "GET")
  })

  it("update PATCHes only the edited keys, a custom one flat, and returns the saved row", async () => {
    calls.length = 0
    const saved = { ...row, name: "Acme SRL", custom: { tva: true } }
    const dp = qwbeDataProvider("crm/organizations", fields, stub(() => Response.json(saved)))
    const { data } = await dp.update("organizations", {
      id: "org-1",
      previousData: row,
      data: { ...row, id: "tampered", name: "Acme SRL", custom: { tva: true } },
    })
    assert.deepEqual(data, saved)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, "/api/qwbe/organizations/org-1")
    assert.equal(calls[0].init?.method, "PATCH")
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { name: "Acme SRL", tva: true })
  })

  it("update with nothing changed sends no request", async () => {
    calls.length = 0
    const dp = qwbeDataProvider("crm/organizations", fields, stub(() => Response.json(row)))
    const { data } = await dp.update("organizations", { id: "org-1", previousData: row, data: { ...row } })
    assert.deepEqual(data, row)
    assert.equal(calls.length, 0)
  })

  it("a refused PATCH throws qwbe's message with the per-field errors ra-core expects", async () => {
    const dp = qwbeDataProvider(
      "crm/organizations",
      fields,
      stub(() =>
        Response.json(
          {
            issues: [{ _tag: "Refinement", path: ["name"], message: 'Expected a non empty string, actual ""' }],
            message: "OrganizationPatch refused",
          },
          { status: 400 },
        ),
      ),
    )
    await assert.rejects(
      dp.update("organizations", { id: "org-1", previousData: row, data: { ...row, name: "" } }),
      (e: unknown) => {
        const err = e as { message: string; status: number; body: { errors: Record<string, string> } }
        assert.equal(err.status, 400)
        assert.equal(err.message, "OrganizationPatch refused")
        assert.deepEqual(err.body.errors, { name: 'Expected a non empty string, actual ""' })
        return true
      },
    )
  })

  it("a refusal without issues carries no field errors, only the message", async () => {
    const dp = qwbeDataProvider(
      "crm/organizations",
      fields,
      stub(() => new Response("forbidden", { status: 403 })),
    )
    await assert.rejects(dp.getOne("organizations", { id: "org-1" }), (e: unknown) => {
      const err = e as { message: string; status: number; body: { errors: Record<string, string> } }
      assert.equal(err.status, 403)
      assert.equal(err.message, "forbidden")
      assert.deepEqual(err.body.errors, {})
      return true
    })
  })

  it("the verbs the pilot does not need refuse loudly instead of guessing a path", async () => {
    const dp = qwbeDataProvider("crm/organizations", fields, stub(() => Response.json(row)))
    await assert.rejects(dp.delete("organizations", { id: "org-1" }), /delete is not supported/)
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
