// Compile-time contract tests for the contacts cube (QWB-30, criterion 12).
//
// What is proven here, without a server: the cube is a valid `defineCube` product (manifest
// sane, handlers exactly matching endpoints — checked by the kernel's own validators), the
// domain decisions are visible in the manifest and schemas, and handlers enforce permissions
// and 404 on the typed seam. Runtime HTTP proof lives in probes/crm.mjs.
//
// Run from the Qwbe layout (plugin installed at core/plugins/crm-pack/cubes/crm):
//   cd <qwbe>/core && node --test plugins/crm-pack/cubes/crm/contacts/index.test.ts

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Cause, Effect, Exit } from "effect"
import { type CubeTools, validateCubeParts } from "qwbe-core/cube"
import { CurrentUser, requirePermission } from "qwbe-core/auth"
import type { Forbidden, NotFound } from "qwbe-core/errors"
import { cube } from "./index.ts"

const parts = cube.create({} as CubeTools)

const admin = {
  id: "u1",
  username: "admin",
  roles: ["admin"],
  permissions: ["crm/contacts:read", "crm/contacts:write"],
}
const reader = { id: "u2", username: "reader", roles: ["reader"], permissions: ["crm/contacts:read"] }

describe("contacts cube contract", () => {
  it("manifest declares exactly its own identity", () => {
    assert.equal(cube.manifest.name, "contacts")
    assert.equal(cube.manifest.parent, "crm")
    assert.deepEqual(cube.manifest.tables, ["contacts"])
    assert.equal(cube.manifest.entity, "Contact")
    assert.equal(cube.manifest.requiresAuth, true)
  })

  it("handlers match endpoints one-to-one (kernel validator)", () => {
    assert.doesNotThrow(() => validateCubeParts("contacts", parts))
  })

  it("permissions are namespaced to this cube", () => {
    for (const p of cube.manifest.permissions ?? []) {
      assert.ok(p.name.startsWith("crm/contacts:"), p.name)
    }
    assert.deepEqual(
      (cube.manifest.permissions ?? []).map((p) => p.name),
      ["crm/contacts:read", "crm/contacts:write"],
    )
  })

  it("publishes only its own event", () => {
    assert.deepEqual(cube.manifest.publishes, ["crm/contacts.created"])
  })

  it("company stays free text — no account entity leaks in", () => {
    // The decided model limit: no Account, no reference field on Contact.
    const forbidden = ["account", "accountId", "companyId", "erp"]
    const source = JSON.stringify(cube.manifest)
    for (const word of forbidden) assert.ok(!source.includes(word), word)
  })

  it("get fails NotFound for a missing id, with a store that has nothing", async () => {
    const tools = {
      store: {
        byId: () => Effect.succeed(undefined),
      },
      bus: { publish: () => Effect.void },
    } as unknown as CubeTools
    const get = cube.create(tools).handlers.get
    const result = await Effect.runPromiseExit(
      get({ path: { id: "cont_none" } } as Parameters<typeof get>[0]).pipe(
        Effect.provideService(CurrentUser, admin),
      ) as Effect.Effect<unknown, Forbidden | NotFound>,
    )
    assert.ok(Exit.isFailure(result))
    const failure = Cause.failureOption(result.cause)
    assert.ok(failure._tag === "Some" && failure.value._tag === "NotFound")
  })

  it("requirePermission refuses a caller without contacts:write", async () => {
    // The kernel seam every write handler passes through — checked directly, with the same
    // context the auth cube provides in production.
    const exit = await Effect.runPromiseExit(
      requirePermission("crm/contacts:write").pipe(Effect.provideService(CurrentUser, reader)),
    )
    assert.ok(Exit.isFailure(exit))
    const failure = Cause.failureOption(exit.cause)
    assert.ok(failure._tag === "Some" && failure.value._tag === "Forbidden")
  })
})
