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
    const [{ cube: crm }, { cube: contacts }, { cube: contracts }, { cube: organizations }] = await Promise.all([
      import("./cubes/crm/index.ts"),
      import("./cubes/crm/contacts/index.ts"),
      import("./cubes/crm/contracts/index.ts"),
      import("./cubes/crm/organizations/index.ts"),
    ])
    assert.equal(crm.manifest.name, "crm")
    assert.equal(crm.manifest.screen, true)
    assert.equal(organizations.manifest.parent, "crm")
    assert.equal(organizations.manifest.name, "organizations")
    assert.equal(organizations.manifest.entity, "Organization")
    assert.deepEqual(contacts.manifest.dataMigration, [
      { fromCube: "contacts", toCube: "crm/contacts", fromPlugin: "crm-pack" },
    ])
    assert.deepEqual(contracts.manifest.dataMigration, [
      { fromCube: "contracts", toCube: "crm/contracts", fromPlugin: "crm-pack" },
    ])
    // One name everywhere (QWB-54, ticket 12): the cube is crm/organizations and its
    // predecessor is declared, not invented (QWB-54, ticket 14) — it IS the old crm/accounts.
    assert.deepEqual(organizations.manifest.dataMigration, [
      { fromCube: "crm/accounts", toCube: "crm/organizations", fromPlugin: "crm-pack" },
    ])
    assert.deepEqual(organizations.manifest.tables, ["organizations"])
    // QWB-54, ticket 13: the importable cubes carry externalId, published as a list filter
    // (that filter IS the import's lookup); uniqueness lives in the DATABASE, guarded by the
    // partial unique index tools/ensure-external-id-index.mjs ensures. contracts is not
    // importable (no mapping, no import writes it), so it declares no external identity.
    assert.equal(organizations.manifest.version, "1.1.0")
    assert.deepEqual(organizations.manifest.searchable, ["name", "industry", "externalId"])
    assert.equal(contacts.manifest.version, "1.3.0")
    assert.deepEqual(contacts.manifest.searchable, ["name", "email", "externalId"])
    assert.equal(contracts.manifest.searchable, undefined)
  })
})
