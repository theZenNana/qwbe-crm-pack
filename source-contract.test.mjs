import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { describe, it } from "node:test"

const sources = [
  "cubes/crm/index.ts",
  "cubes/crm/contacts/index.ts",
  "cubes/crm/contacts/index.test.ts",
  "cubes/crm/contracts/index.ts",
  "cubes/crm/contracts/index.test.ts",
]

describe("CRM source package boundary", () => {
  it("declares one CRM parent with contacts and contracts as children", async () => {
    const packageManifest = JSON.parse(readFileSync(new URL("qwbe-package.json", import.meta.url), "utf8"))
    assert.deepEqual(packageManifest.cubes, ["crm", "crm/contacts", "crm/contracts"])
    assert.equal(existsSync(new URL("cubes/crm/index.ts", import.meta.url)), true)

    const [{ cube: crm }, { cube: contacts }, { cube: contracts }] = await Promise.all([
      import("./cubes/crm/index.ts"),
      import("./cubes/crm/contacts/index.ts"),
      import("./cubes/crm/contracts/index.ts"),
    ])
    assert.equal(crm.manifest.name, "crm")
    assert.equal(crm.manifest.screen, true)
    assert.deepEqual(
      [contacts.manifest, contracts.manifest].map(({ name, parent }) => ({ name, parent })),
      [
        { name: "contacts", parent: "crm" },
        { name: "contracts", parent: "crm" },
      ],
    )
    assert.deepEqual(contacts.manifest.dataMigration, [
      { fromCube: "contacts", toCube: "crm/contacts", fromPlugin: "crm-pack" },
    ])
    assert.deepEqual(contracts.manifest.dataMigration, [
      { fromCube: "contracts", toCube: "crm/contracts", fromPlugin: "crm-pack" },
    ])
  })

  it("uses only versioned qwbe-core public subpaths", () => {
    for (const source of sources) {
      const text = readFileSync(new URL(source, import.meta.url), "utf8")
      assert.doesNotMatch(text, /(?:\.\.\/)+src\//, `${source} imports Qwbe source internals`)
      assert.doesNotMatch(text, /qwbe-core\/src\//, `${source} imports qwbe-core internals`)
    }
  })
})
