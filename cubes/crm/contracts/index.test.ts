// Compile-time contract tests for the contracts cube (QWB-30, criterion 12).
//
// Proven without a server: valid defineCube product, the decided money rules (minor units,
// per-currency totals, never a cross-currency sum), the minimal party relation (an opaque
// nullable id, and the cube does not name `contacts` anywhere in its manifest), permissions
// and 404 on the typed seam. Runtime HTTP proof lives in probes/crm.mjs.
//
// Run from the Qwbe layout (plugin installed at core/plugins/crm-pack/cubes/crm):
//   cd <qwbe>/core && node --test plugins/crm-pack/cubes/crm/contracts/index.test.ts

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Cause, Effect, Exit } from "effect"
import { Schema } from "effect"
import { type CubeTools, validateCubeParts } from "qwbe-core/cube"
import { CurrentUser, requirePermission } from "qwbe-core/auth"
import type { Forbidden, NotFound } from "qwbe-core/errors"
import { ContractCreate, cube } from "./index.ts"

const parts = cube.create({} as CubeTools)

const admin = {
  id: "u1",
  username: "admin",
  roles: ["admin"],
  permissions: ["crm/contracts:read", "crm/contracts:write"],
  sessionId: "s1",
}
const noperm = { id: "u2", username: "nobody", roles: [], permissions: [] as string[], sessionId: "s2" }

describe("contracts cube contract", () => {
  it("rejects malformed party ids, currencies and signing timestamps", () => {
    const decode = Schema.decodeUnknownEither(ContractCreate)
    assert.equal(decode({ title: "x", partyId: "" })._tag, "Left")
    assert.equal(decode({ title: "x", currency: "ron" })._tag, "Left")
    assert.equal(decode({ title: "x", signedAt: "2026-08-12" })._tag, "Left")
    assert.equal(
      decode({ title: "x", partyId: "cont_123", currency: "RON", signedAt: "2026-08-12T10:20:30Z" })._tag,
      "Right",
    )
  })
  it("manifest declares exactly its own identity", () => {
    assert.equal(cube.manifest.name, "contracts")
    assert.equal(cube.manifest.parent, "crm")
    assert.deepEqual(cube.manifest.tables, ["contracts"])
    assert.equal(cube.manifest.entity, "Contract")
    assert.equal(cube.manifest.requiresAuth, true)
  })

  it("handlers match endpoints one-to-one (kernel validator)", () => {
    assert.doesNotThrow(() => validateCubeParts("contracts", parts))
  })

  it("permissions are namespaced to this cube", () => {
    assert.deepEqual(
      (cube.manifest.permissions ?? []).map((p) => p.name),
      ["crm/contracts:read", "crm/contracts:write"],
    )
  })

  it("the minimal relation: partyId is declared, the contacts cube is never named", () => {
    const source = JSON.stringify(cube.manifest)
    assert.ok(!source.includes("contacts"), "manifest must not name the other cube")
    // No link declarations on a cube — those live in spaces, one level up.
    assert.equal("links" in cube.manifest, false)
  })

  it("contracts:value never sums across currencies", async () => {
    const rows = [
      { amount: 150, currency: "RON" },
      { amount: 250, currency: "RON" },
      { amount: 100, currency: "EUR" },
    ]
    const tools = {
      store: {
        page: () => Effect.succeed({ rows, total: rows.length, offset: 0, limit: 50, sortedBy: "createdAt" }),
      },
      bus: { publish: () => Effect.void },
    } as unknown as CubeTools
    const value = (cube.create(tools).commands ?? []).find((c) => c.name === "crm/contracts:value")
    assert.ok(value)
    const out = await Effect.runPromise(value.run([], ["crm/contracts:read"]))
    const lines = out.split("\n").sort()
    assert.deepEqual(lines, ["1.00 EUR", "4.00 RON"], `got: ${out}`)
    assert.ok(!out.includes("5.00"), "no cross-currency total")
  })

  it("contracts:value reports (none) on an empty table", async () => {
    const tools = {
      store: { page: () => Effect.succeed({ rows: [], total: 0, offset: 0, limit: 50, sortedBy: "createdAt" }) },
      bus: { publish: () => Effect.void },
    } as unknown as CubeTools
    const value = (cube.create(tools).commands ?? []).find((c) => c.name === "crm/contracts:value")
    assert.ok(value)
    assert.equal(await Effect.runPromise(value.run([], [])), "(none)")
  })

  it("get fails NotFound for a missing id", async () => {
    const tools = {
      store: { byId: () => Effect.succeed(undefined) },
      bus: { publish: () => Effect.void },
    } as unknown as CubeTools
    const get = cube.create(tools).handlers.get
    const result = await Effect.runPromiseExit(
      get({ path: { id: "ctr_none" } } as Parameters<typeof get>[0]).pipe(
        Effect.provideService(CurrentUser, admin),
      ) as Effect.Effect<unknown, Forbidden | NotFound>,
    )
    assert.ok(Exit.isFailure(result))
    const failure = Cause.failureOption(result.cause)
    assert.ok(failure._tag === "Some" && failure.value._tag === "NotFound")
  })

  it("requirePermission refuses a caller without contracts:read", async () => {
    const exit = await Effect.runPromiseExit(
      requirePermission("crm/contracts:read").pipe(Effect.provideService(CurrentUser, noperm)),
    )
    assert.ok(Exit.isFailure(exit))
    const failure = Cause.failureOption(exit.cause)
    assert.ok(failure._tag === "Some" && failure.value._tag === "Forbidden")
  })
})
