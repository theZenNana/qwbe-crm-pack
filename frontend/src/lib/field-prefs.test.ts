// Unit tests for the custom-field UI preferences (QWB-54, F2). The storage is
// a stub -- the module must not touch a DOM -- and the properties under test
// are the trust boundary (garbage in localStorage never reaches a component)
// and the hide/default toggles' shape (new object identity, empty = removed).

import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { EMPTY_PREFS, prefsKey, readPrefs, withDefault, withHidden, writePrefs } from "./field-prefs.ts"

// A minimal Storage stub over a Map, enough for getItem/setItem.
const storageStub = (initial: Record<string, string> = {}) => {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => void map.set(key, value),
  } as Storage
}

describe("field-prefs", () => {
  it("returns the empty preference when nothing is stored", () => {
    assert.deepEqual(readPrefs("crm/organizations", storageStub()), { hidden: [], defaults: {} })
  })

  it("round-trips a written preference", () => {
    const storage = storageStub()
    writePrefs("crm/organizations", { hidden: ["cui"], defaults: { form: "SRL" } }, storage)
    assert.deepEqual(readPrefs("crm/organizations", storage), { hidden: ["cui"], defaults: { form: "SRL" } })
  })

  it("keys preferences per cube", () => {
    const storage = storageStub()
    writePrefs("crm/organizations", { hidden: ["cui"], defaults: {} }, storage)
    assert.deepEqual(readPrefs("crm/contacts", storage), { hidden: [], defaults: {} })
    assert.equal(prefsKey("crm/contacts"), "crm.customFields.crm/contacts")
  })

  it("falls back to empty on corrupt JSON, and filters a wrong shape", () => {
    const corrupt = storageStub({ [prefsKey("crm/contacts")]: "{not json" })
    const wrongShape = storageStub({
      [prefsKey("crm/contacts")]: JSON.stringify({ hidden: [42, "", "ok"], defaults: { a: 7, b: "keep", c: "" } }),
    })
    assert.deepEqual(readPrefs("crm/contacts", corrupt), EMPTY_PREFS)
    assert.deepEqual(readPrefs("crm/contacts", wrongShape), { hidden: ["ok"], defaults: { b: "keep" } })
  })

  it("withHidden adds and removes by name, always a fresh object", () => {
    const base = { hidden: ["cui"], defaults: {} }
    const added = withHidden(base, "tva", true)
    assert.deepEqual(added, { hidden: ["cui", "tva"], defaults: {} })
    assert.deepEqual(withHidden(added, "tva", false), base)
    assert.notEqual(added, base)
  })

  it("withDefault stores a value and removes the key on empty", () => {
    const base = { hidden: [], defaults: {} }
    const withValue = withDefault(base, "form", "SRL")
    assert.deepEqual(withValue.defaults, { form: "SRL" })
    assert.deepEqual(withDefault(withValue, "form", ""), base)
    assert.notEqual(withValue, base)
  })
})
