// The ACCOUNTS cube — the Organization, third child of the CRM plugin (QWB-47).
//
// Domain: an ACCOUNT (an Organization) is the company a business deals with. This is the entity
// the vtiger users worked in all day (about 60 thousand rows), rebuilt here as a photograph of
// the vtiger standard Accounts fields that actually carry data — not a one-to-one copy. What is
// empty or vtiger-internal stays out: no `notify_owner`, no `modifiedby` mirrors (EntityMeta
// already carries createdAt), no `parentid` (an Account-to-Account hierarchy is explicitly out
// of scope), and no custom fields (those are a separate system, not this ticket).
//
// The relation to contacts has ONE truth: `Contact.accountId`. It lives on the contact, it is
// nullable, and an organization's contact list is derived by filtering contacts on it. This cube
// does not hold a contacts list and does not import the contacts cube — neither names the other.
//
// Money: vtiger's `annualrevenue` is a bare integer with no currency. A number that looks like
// money without saying which money is the exact defect the contracts cube refuses, so the field
// stays out until it can be carried with a currency, in minor units.
//
// Ids: opaque strings with the prefix `acc`, same as every sibling.
// The schemas live in ./schema.ts (size cap: split, not raise).

import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform"
import { Effect, Schema } from "effect"
import { Authorization, requirePermission } from "qwbe-core/auth"
import { defineCube } from "qwbe-core/cube"
import { type SummaryRow } from "qwbe-core/entity"
import { Forbidden, NotFound } from "qwbe-core/errors"
import { PageOf } from "qwbe-core/http"
import { PageParams, pageRequest } from "qwbe-core/pagination"
import { Account, AccountCreate, AccountPatch, type AccountRow } from "./schema.ts"

// The table is "organizations", not "accounts": the platform's builtin `account` cube already
// owns a table called "accounts" (user accounts and credential hashes), and a table has exactly
// one owner, so a kernel that mounts both refuses to boot with DuplicateTableError. The cube name
// and its route stay "accounts" -- only the storage name moves, and "organizations" is what the
// entity is called anyway.
const TABLE = "organizations"
const ENTITY = "Organization"

const group = HttpApiGroup.make("accounts")
  .add(HttpApiEndpoint.get("list")`/accounts`.setUrlParams(PageParams).addSuccess(PageOf(Account)).addError(Forbidden))
  .add(
    HttpApiEndpoint.get("get")`/accounts/${HttpApiSchema.param("id", Schema.String)}`
      .addSuccess(Account)
      .addError(NotFound)
      .addError(Forbidden),
  )
  .add(HttpApiEndpoint.post("create")`/accounts`.setPayload(AccountCreate).addSuccess(Account).addError(Forbidden))
  .add(
    HttpApiEndpoint.patch("update")`/accounts/${HttpApiSchema.param("id", Schema.String)}`
      .setPayload(AccountPatch)
      .addSuccess(Account)
      .addError(NotFound)
      .addError(Forbidden),
  )
  .middleware(Authorization)

// Strips metadata the summary must not carry, and keeps the summary shape identical to the
// sibling cubes: id, one human title, a couple of detail lines.
const summary = (a: AccountRow): SummaryRow => ({
  id: a.id,
  title: a.name,
  details: [
    { key: "industry", value: a.industry ?? "—" },
    { key: "city", value: a.billingCity ?? "—" },
  ],
})

export const cube = defineCube(group, {
  manifest: {
    name: "accounts",
    // Opts the cube into the metadata drift gate (qwbe src/metadata/schema-drift.ts):
    // an undeclared version means a schema change cannot be caught (QWB-54).
    version: "1.0.0",
    parent: "crm",
    tables: [TABLE],
    entity: ENTITY,
    sortable: ["name", "industry", "createdAt"],
    // What relational.search actually serves to the links route: exact match on these.
    searchable: ["name", "industry"],
    requiresAuth: true,
    permissions: [
      { name: "crm/accounts:read", roles: ["admin", "reader"] },
      { name: "crm/accounts:write", roles: ["admin"] },
    ],
    publishes: ["crm/accounts.created"],
    // The contract requires a child cube to declare where its rows come from. The source is
    // named "organizations", like the table: a flat cube called `accounts` would name the
    // platform's own user-account cube as the source of our rows.
    dataMigration: [{ fromCube: "organizations", toCube: "crm/accounts", fromPlugin: "crm-pack" }],
  },

  create: ({ store, bus }) => ({
    commands: [
      {
        name: "crm/accounts:count",
        summary: "how many organizations exist",
        permission: "crm/accounts:read",
        run: () => Effect.map(store.count(TABLE), (n) => String(n)),
      },
    ],

    handlers: {
      list: ({ urlParams }) =>
        Effect.gen(function* () {
          yield* requirePermission("crm/accounts:read")
          return yield* store.page<AccountRow>(TABLE, pageRequest(urlParams))
        }),

      get: ({ path }) =>
        Effect.gen(function* () {
          yield* requirePermission("crm/accounts:read")
          const a = yield* store.byId<AccountRow>(TABLE, path.id)
          if (!a) return yield* Effect.fail(new NotFound({ message: `organization ${path.id} does not exist` }))
          return a
        }),

      create: ({ payload }) =>
        Effect.gen(function* () {
          yield* requirePermission("crm/accounts:write")
          const a = (yield* store.insert(TABLE, ENTITY, "acc", payload)) as AccountRow
          yield* bus.publish("crm/accounts.created", { id: a.id, title: a.name })
          return a
        }),

      update: ({ path, payload }) =>
        Effect.gen(function* () {
          yield* requirePermission("crm/accounts:write")
          const current = yield* store.byId<AccountRow>(TABLE, path.id)
          if (!current) return yield* Effect.fail(new NotFound({ message: `organization ${path.id} does not exist` }))
          // An empty PATCH changes nothing: the row is returned as is, with no version bump
          // and no outbox row — store.update with an empty patch would write anyway.
          if (Object.keys(payload).length === 0) return current
          const a = yield* store.update(TABLE, path.id, payload)
          return a as AccountRow
        }),
    },

    relational: {
      search: (field, value, page) =>
        Effect.gen(function* () {
          const p = yield* store.page<AccountRow>(TABLE, page, { field, value })
          return { rows: p.rows.map(summary), total: p.total }
        }),

      summaryById: (id) =>
        Effect.gen(function* () {
          const a = yield* store.byId<AccountRow>(TABLE, id)
          return a ? summary(a) : undefined
        }),

      fieldValue: (id, field) =>
        Effect.gen(function* () {
          const a = yield* store.byId<AccountRow>(TABLE, id)
          const v = a ? (a as unknown as Record<string, unknown>)[field] : null
          return typeof v === "string" ? v : null
        }),
    },
  }),
})
