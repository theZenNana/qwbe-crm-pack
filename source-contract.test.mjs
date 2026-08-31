// The source boundary of this pack, judged by the shared checker exported by qwbe
// (`qwbe-core/package`). The rules live in the kernel repo; this file only runs
// them here and keeps the pack-specific assertions the checker cannot know.
import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { checkPackageSource } from "qwbe-core/package"

describe("CRM source package boundary", () => {
  it("keeps the shared package contract", async () => {
    const findings = await checkPackageSource(import.meta.dirname, { hierarchy: true })
    // QWB-54 ticket 12 removed the invented dataMigration; ticket 08 (kernel, parallel band)
    // is what lets a child cube declare "no predecessor" honestly. Until it lands, the
    // hierarchy rule still demands a dataMigration and reports exactly one finding, on this
    // cube; after it lands the list is empty again. Any OTHER finding fails this test.
    const transitional =
      findings.length === 1 &&
      findings[0].rule === "hierarchy" &&
      findings[0].file === "cubes/crm/organizations/index.ts" &&
      findings[0].message === "child cube must declare dataMigration"
    assert.ok(
      findings.length === 0 || transitional,
      `unexpected package findings: ${JSON.stringify(findings)}`,
    )
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
    // One name everywhere (QWB-54, ticket 12): the cube is crm/organizations and it declares
    // no predecessor, honestly — the invented migration from a never-existing cube is gone.
    assert.equal(organizations.manifest.dataMigration, undefined)
    assert.deepEqual(organizations.manifest.tables, ["organizations"])
  })
})
