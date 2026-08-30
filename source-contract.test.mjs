// The source boundary of this pack, judged by the shared checker exported by qwbe
// (`qwbe-core/package`). The rules live in the kernel repo; this file only runs
// them here and keeps the pack-specific assertions the checker cannot know.
import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { checkPackageSource } from "qwbe-core/package"

describe("CRM source package boundary", () => {
  it("keeps the shared package contract", async () => {
    const findings = await checkPackageSource(import.meta.dirname, { hierarchy: true })
    assert.deepEqual(findings, [])
  })

  it("declares one CRM parent with contacts and contracts as children", async () => {
    const [{ cube: crm }, { cube: contacts }, { cube: contracts }, { cube: accounts }] = await Promise.all([
      import("./cubes/crm/index.ts"),
      import("./cubes/crm/contacts/index.ts"),
      import("./cubes/crm/contracts/index.ts"),
      import("./cubes/crm/accounts/index.ts"),
    ])
    assert.equal(crm.manifest.name, "crm")
    assert.equal(crm.manifest.screen, true)
    assert.equal(accounts.manifest.parent, "crm")
    assert.equal(accounts.manifest.entity, "Organization")
    assert.deepEqual(contacts.manifest.dataMigration, [
      { fromCube: "contacts", toCube: "crm/contacts", fromPlugin: "crm-pack" },
    ])
    assert.deepEqual(contracts.manifest.dataMigration, [
      { fromCube: "contracts", toCube: "crm/contracts", fromPlugin: "crm-pack" },
    ])
    assert.deepEqual(accounts.manifest.dataMigration, [
      { fromCube: "organizations", toCube: "crm/accounts", fromPlugin: "crm-pack" },
    ])
    assert.deepEqual(accounts.manifest.tables, ["organizations"])
  })
})
