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

import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform"
import { Effect, Schema } from "effect"
import { Authorization, requirePermission } from "qwbe-core/auth"
import { defineCube } from "qwbe-core/cube"
import { EntityMeta, type SummaryRow } from "qwbe-core/entity"
import { Forbidden, NotFound } from "qwbe-core/errors"
import { PageOf } from "qwbe-core/http"
import { PageParams, pageRequest } from "qwbe-core/pagination"

const TABLE = "accounts"
const ENTITY = "Organization"

const Account = Schema.Struct({
  ...EntityMeta,
  /** vtiger `accountname` — the one required field at the source. */
  name: Schema.String,
  /** vtiger `account_no`, the human-facing number. */
  accountNo: Schema.NullOr(Schema.String),
  phone: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
  website: Schema.NullOr(Schema.String),
  /** vtiger `account_type`. */
  type: Schema.NullOr(Schema.String),
  industry: Schema.NullOr(Schema.String),
  rating: Schema.NullOr(Schema.String),
  ownership: Schema.NullOr(Schema.String),
  employees: Schema.NullOr(Schema.Int),
  /** vtiger `emailoptout`, kept as a real boolean instead of a varchar(3) flag. */
  emailOptOut: Schema.Boolean,
  /** Billing address, the four fields of the vtiger block that carry data. */
  billingStreet: Schema.NullOr(Schema.String),
  billingCity: Schema.NullOr(Schema.String),
  billingCode: Schema.NullOr(Schema.String),
  billingCountry: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
}).annotations({ identifier: "Organization" })

const AccountCreate = Schema.Struct({
  name: Schema.String,
  accountNo: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  phone: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  email: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  website: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  type: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  industry: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  rating: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  ownership: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  employees: Schema.optionalWith(Schema.NullOr(Schema.Int), { default: () => null }),
  emailOptOut: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  billingStreet: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  billingCity: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  billingCode: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  billingCountry: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  description: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
}).annotations({ identifier: "OrganizationCreate" })

/** Every domain field is optional on a patch; `id`, `createdAt` and `type` are not patchable. */
const AccountPatch = Schema.Struct({
  name: Schema.optional(Schema.String),
  accountNo: Schema.optional(Schema.NullOr(Schema.String)),
  phone: Schema.optional(Schema.NullOr(Schema.String)),
  email: Schema.optional(Schema.NullOr(Schema.String)),
  website: Schema.optional(Schema.NullOr(Schema.String)),
  type: Schema.optional(Schema.NullOr(Schema.String)),
  industry: Schema.optional(Schema.NullOr(Schema.String)),
  rating: Schema.optional(Schema.NullOr(Schema.String)),
  ownership: Schema.optional(Schema.NullOr(Schema.String)),
  employees: Schema.optional(Schema.NullOr(Schema.Int)),
  emailOptOut: Schema.optional(Schema.Boolean),
  billingStreet: Schema.optional(Schema.NullOr(Schema.String)),
  billingCity: Schema.optional(Schema.NullOr(Schema.String)),
  billingCode: Schema.optional(Schema.NullOr(Schema.String)),
  billingCountry: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
}).annotations({ identifier: "OrganizationPatch" })

type AccountRow = typeof Account.Type

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
    parent: "crm",
    tables: [TABLE],
    entity: ENTITY,
    sortable: ["name", "industry", "createdAt"],
    requiresAuth: true,
    permissions: [
      { name: "crm/accounts:read", roles: ["admin", "reader"] },
      { name: "crm/accounts:write", roles: ["admin"] },
    ],
    publishes: ["crm/accounts.created"],
    dataMigration: [{ fromCube: "accounts", toCube: "crm/accounts", fromPlugin: "crm-pack" }],
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
          const patch = Object.keys(payload).length === 0 ? undefined : (payload as Partial<AccountRow>)
          const a = yield* store.update(TABLE, path.id, patch ?? {})
          if (!a) return yield* Effect.fail(new NotFound({ message: `organization ${path.id} does not exist` }))
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
