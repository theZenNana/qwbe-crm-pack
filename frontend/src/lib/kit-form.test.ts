// Unit tests for the kit renderer logic (QWB-54): field grouping from
// metadata, custom-field flattening, edit initial values and the update
// payload. qwbe is stubbed at the function boundary -- pure derivation, no
// live backend and no DOM.

import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  changedPayloadOf,
  displayRowOf,
  groupedFieldsOf,
  initialValuesOf,
  updatePayloadOf,
  type FieldGroup,
} from "./kit-form.ts"
import type { FieldMetadata } from "./cube.ts"

const field = (over: Partial<FieldMetadata> = {}): FieldMetadata => ({
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

describe("groupedFieldsOf", () => {
  const meta = {
    fields: [
      field(),
      field({ name: "email", label: "Email", required: false }),
      field({ name: "organizationId", label: "Organization", required: false, relation: { target: "crm/organizations", entity: "Organization", summary: null } }),
      field({ name: "tva", label: "TVA", type: "boolean", custom: true, nullable: true }),
      field({ name: "id", label: "Id", required: false, editable: false, sortable: true }),
    ],
  }

  it("resolves named groups from the metadata, in caller order", () => {
    const groups: FieldGroup[] = [
      { title: "Identity", fields: ["name", "email"] },
      { title: "Organization", fields: ["organizationId"] },
    ]
    assert.deepEqual(
      groupedFieldsOf(groups, meta).map((g) => ({
        title: g.title,
        names: g.fields.map((f) => f.name),
      })),
      [
        { title: "Identity", names: ["name", "email"] },
        { title: "Organization", names: ["organizationId"] },
      ],
    )
  })

  it("drops a name the metadata does not publish as editable, and an empty group", () => {
    const groups: FieldGroup[] = [
      { title: "Dead", fields: ["id", "nope"] },
      { title: "Identity", fields: ["name"] },
    ]
    assert.deepEqual(
      groupedFieldsOf(groups, meta).map((g) => g.title),
      ["Identity"],
    )
  })

  it("a custom group renders every editable runtime custom field", () => {
    const groups: FieldGroup[] = [{ title: "Custom fields", custom: true }]
    assert.deepEqual(
      groupedFieldsOf(groups, meta).flatMap((g) => g.fields.map((f) => f.name)),
      ["tva"],
    )
  })
})

describe("displayRowOf", () => {
  const meta = {
    fields: [
      field(),
      field({ name: "tva", label: "TVA", type: "boolean", custom: true, nullable: true }),
    ],
  }

  it("moves published custom values to the top level", () => {
    const flat = displayRowOf(meta, { id: "con_1", name: "Ada", custom: { tva: true } })
    assert.equal(flat.tva, true)
    assert.equal(flat.name, "Ada")
  })

  it("an orphan or future custom key never reaches the flattened row", () => {
    const flat = displayRowOf(meta, {
      id: "con_1",
      name: "Ada",
      custom: { deleted_def: "x", not_published_yet: 1 },
    })
    assert.equal("deleted_def" in flat, false)
    assert.equal("not_published_yet" in flat, false)
  })
})

describe("initialValuesOf", () => {
  it("strings for text and enum fields, empty string for missing values", () => {
    const fields = [
      field(),
      field({ name: "stage", label: "Stage", required: false, nullable: true, enum: ["lead", "won"] }),
      field({ name: "company", label: "Company", required: false, nullable: true }),
    ]
    assert.deepEqual(
      initialValuesOf(fields, { id: "con_1", name: "Ada", stage: "lead", company: null }),
      { name: "Ada", stage: "lead", company: "" },
    )
  })

  it("a real boolean for the checkbox kind", () => {
    const fields = [field({ name: "tva", label: "TVA", type: "boolean", custom: true, nullable: true })]
    assert.deepEqual(initialValuesOf(fields, { tva: true }), { tva: true })
    assert.deepEqual(initialValuesOf(fields, {}), { tva: false })
  })
})

describe("updatePayloadOf", () => {
  const fields = [
    field(),
    field({ name: "phone", label: "Phone", required: false, nullable: true }),
    field({ name: "company", label: "Company", required: false, nullable: false }),
    field({ name: "tva", label: "TVA", type: "boolean", custom: true, nullable: true }),
  ]

  it("coerces with the same rules as the inline editor", () => {
    const { payload, missing } = updatePayloadOf(fields, {
      name: "Ada",
      phone: "",
      company: "Acme",
      tva: true,
    })
    assert.deepEqual(payload, { name: "Ada", company: "Acme", phone: null, tva: true })
    assert.deepEqual(missing, [])
  })

  it("a cleared nullable field becomes null", () => {
    const { payload } = updatePayloadOf(fields, { name: "Ada", phone: " ", company: "", tva: false })
    assert.equal(payload.phone, null)
  })

  it("a cleared non-nullable optional field is skipped, not sent as empty", () => {
    const { payload } = updatePayloadOf(fields, { name: "Ada", company: "", tva: false })
    assert.equal("company" in payload, false)
  })

  it("a cleared required field is refused client-side by its label", () => {
    const { payload, missing } = updatePayloadOf(fields, { name: "", phone: "555", company: "", tva: false })
    assert.deepEqual(missing, ["Name"])
    assert.deepEqual(payload, { phone: "555", tva: false })
  })

  it("an enum value travels as its string, an integer as a number", () => {
    const enumFields = [
      field({ name: "stage", label: "Stage", required: false, nullable: true, enum: ["lead", "won"] }),
      field({ name: "age", label: "Age", type: "integer", required: false, nullable: true }),
    ]
    const { payload } = updatePayloadOf(enumFields, { stage: "won", age: "42" })
    assert.deepEqual(payload, { stage: "won", age: 42 })
  })
})

describe("changedPayloadOf", () => {
  const fields = [
    field(),
    field({ name: "phone", label: "Phone", required: false, nullable: true }),
    field({ name: "company", label: "Company", required: false, nullable: false }),
    field({ name: "tva", label: "TVA", type: "boolean", custom: true, nullable: true }),
  ]
  const initial = initialValuesOf(fields, { name: "Ada", phone: "555", company: "Acme", tva: false })

  it("sends only the fields whose value changed, coerced by type", () => {
    const { payload, missing } = changedPayloadOf(fields, initial, {
      ...initial,
      phone: "",
      tva: true,
    })
    assert.deepEqual(payload, { phone: null, tva: true })
    assert.deepEqual(missing, [])
  })

  it("sends nothing when nothing changed, including whitespace-only edits", () => {
    const { payload, missing } = changedPayloadOf(fields, initial, { ...initial, name: " Ada " })
    assert.deepEqual(payload, {})
    assert.deepEqual(missing, [])
  })

  it("a cleared required field is refused only when the user cleared it", () => {
    assert.deepEqual(changedPayloadOf(fields, initial, { ...initial, name: "" }).missing, ["Name"])
    const emptyStart = initialValuesOf(fields, { name: "", phone: null, company: "", tva: false })
    assert.deepEqual(changedPayloadOf(fields, emptyStart, { ...emptyStart, phone: "1" }), {
      payload: { phone: "1" },
      missing: [],
    })
  })
})
