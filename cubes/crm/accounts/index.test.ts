// Compile-time contract tests for the accounts cube (QWB-47).
//
// What is proven here, without a server: the cube is a valid `defineCube` product (manifest
// sane, handlers exactly matching endpoints — checked by the kernel's own validators), the
// domain decisions are visible in the manifest and schemas, and handlers enforce permissions
// and 404 on the typed seam. Runtime HTTP proof lives in probes/crm.mjs.
//
// Run from the Qwbe layout (plugin installed at core/plugins/crm-pack/cubes/crm):
//   cd <qwbe>/core && node --test plugins/crm-pack/cubes/crm/accounts/index.test.ts

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Cause, Effect, Exit, Schema } from "effect"
import { type CubeTools, validateCubeParts } from "qwbe-core/cube"
import { CurrentUser, requirePermission } from "qwbe-core/auth"
import { AccountPatch } from "./schema.ts"
import type { Forbidden, NotFound } from "qwbe-core/errors"
import { cube } from "./index.ts"

const parts = cube.create({} as CubeTools)

const admin = {
  id: "u1",
  username: "admin",
  roles: ["admin"],
  permissions: ["crm/accounts:read", "crm/accounts:write"],
}
const reader = { id: "u2", username: "reader", roles: ["reader"], permissions: ["crm/accounts:read"] }

describe("accounts cube contract", () => {
  it("manifest declares exactly its own identity", () => {
    assert.equal(cube.manifest.name, "accounts")
    assert.equal(cube.manifest.parent, "crm")
    assert.deepEqual(cube.manifest.tables, ["accounts"])
    assert.equal(cube.manifest.entity, "Organization")
    assert.equal(cube.manifest.requiresAuth, true)
  })

  it("handlers match endpoints one-to-one (kernel validator)", () => {
    assert.doesNotThrow(() => validateCubeParts("accounts", parts))
  })

  it("permissions are namespaced to this cube", () => {
    for (const p of cube.manifest.permissions ?? []) {
      assert.ok(p.name.startsWith("crm/accounts:"), p.name)
    }
    assert.deepEqual(
      (cube.manifest.permissions ?? []).map((p) => p.name),
      ["crm/accounts:read", "crm/accounts:write"],
    )
  })

  it("publishes only its own event", () => {
    assert.deepEqual(cube.manifest.publishes, ["crm/accounts.created"])
  })

  it("carries the dataMigration the contract expects", () => {
    assert.deepEqual(cube.manifest.dataMigration, [
      { fromCube: "accounts", toCube: "crm/accounts", fromPlugin: "crm-pack" },
    ])
  })

  it("does not import the contacts cube or hold the relation on this side", () => {
    // The relation's truth is Contact.accountId. This cube holds no contact list and names no
    // sibling: no related-list endpoint, no copied field, no cross-cube anything.
    const source = JSON.stringify(cube.manifest)
    for (const word of ["crm/contacts", "contactIds", "contactId"]) assert.ok(!source.includes(word), word)
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
      get({ path: { id: "acc_none" } } as Parameters<typeof get>[0]).pipe(
        Effect.provideService(CurrentUser, admin),
      ) as Effect.Effect<unknown, Forbidden | NotFound>,
    )
    assert.ok(Exit.isFailure(result))
    const failure = Cause.failureOption(result.cause)
    assert.ok(failure._tag === "Some" && failure.value._tag === "NotFound")
  })

  it("update fails NotFound for a missing id", async () => {
    const tools = {
      store: {
        byId: () => Effect.succeed(undefined),
        update: () => Effect.succeed(undefined),
      },
      bus: { publish: () => Effect.void },
    } as unknown as CubeTools
    const update = cube.create(tools).handlers.update
    const result = await Effect.runPromiseExit(
      update({ path: { id: "acc_none" }, payload: { name: "x" } } as Parameters<typeof update>[0]).pipe(
        Effect.provideService(CurrentUser, admin),
      ) as Effect.Effect<unknown, Forbidden | NotFound>,
    )
    assert.ok(Exit.isFailure(result))
    const failure = Cause.failureOption(result.cause)
    assert.ok(failure._tag === "Some" && failure.value._tag === "NotFound")
  })

  it("summaryById returns title and the two detail keys (links route)", async () => {
    // The acceptance point behind /links/{entity}/{id}: the organization summary carries one
    // human title and the two detail lines, or nothing for a missing id.
    const row = {
      id: "acc_1",
      type: "Organization",
      name: "Ada Industries SRL",
      industry: "manufacturing",
      billingCity: "Iasi",
    }
    const tools = {
      store: {
        byId: (_t: string, id: string) => Effect.succeed(id === "acc_1" ? row : undefined),
      },
      bus: { publish: () => Effect.void },
    } as unknown as CubeTools
    const parts = cube.create(tools)
    const summaryById = parts.relational!.summaryById!
    const hit = await Effect.runPromise(summaryById("acc_1"))
    assert.equal(hit?.title, "Ada Industries SRL")
    assert.deepEqual(
      hit?.details.map((d) => d.key),
      ["industry", "city"],
    )
    const miss = await Effect.runPromise(summaryById("acc_none"))
    assert.equal(miss, undefined)
  })

  it("the patch schema refuses the meta fields and bad values", () => {
    // `deleted` is refused: there is no delete endpoint in this ticket, and a patched-away
    // organization would orphan its contacts (the rule for deletion lives in README.md).
    // `name` is the required title, so blank is refused; a negative headcount is refused.
    const decode = Schema.decodeUnknownEither(AccountPatch)
    assert.ok(decode({ deleted: true })._tag === "Left")
    assert.ok(decode({ name: "   " })._tag === "Left")
    assert.ok(decode({ employees: -3 })._tag === "Left")
    assert.ok(decode({ employees: 3 })._tag === "Right")
    assert.ok(decode({})._tag === "Right")
  })

  it("requirePermission refuses a caller without accounts:write", async () => {
    // The kernel seam every write handler passes through — checked directly, with the same
    // context the auth cube provides in production.
    const exit = await Effect.runPromiseExit(
      requirePermission("crm/accounts:write").pipe(Effect.provideService(CurrentUser, reader)),
    )
    assert.ok(Exit.isFailure(exit))
    const failure = Cause.failureOption(exit.cause)
    assert.ok(failure._tag === "Some" && failure.value._tag === "Forbidden")
  })
})
