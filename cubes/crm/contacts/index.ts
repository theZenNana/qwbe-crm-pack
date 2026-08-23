// The CONTACTS cube — one half of the CRM plugin (two cubes, one package).
//
// Domain: a CONTACT is a person the business deals with. `company` is free text, deliberately:
// the historical CRM had no Account entity, and the rebuilt model keeps that limit on purpose —
// inventing a first-class company would be ERP modelling, and it would force every existing row
// through a migration nobody designed. The day a real account entity is wanted, that is a
// design decision of its own, not a silent side effect of a restore.
//
// `contracts` is not named anywhere in this file. It holds a party id on its side; this cube
// does not know it exists. The two land in the same flat level-0 namespace, each with its own
// table, API, schema, permissions and events, and neither imports the other — they share a
// directory on disk and nothing else.
//
// Adapted (QWB-30) from the pre-QWB-19 source preserved at qwbe-packs: the public cube
// contract is now `qwbe-core/cube` (`defineCube`, typed endpoint/handler pairing) instead of a
// bare object literal. Behaviour is unchanged: same fields, same permissions, same event.

import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform"
import { Effect, Schema } from "effect"
import { Authorization, requirePermission } from "qwbe-core/auth"
import { defineCube } from "qwbe-core/cube"
import { EntityMeta, type SummaryRow } from "qwbe-core/entity"
import { Forbidden, NotFound } from "qwbe-core/errors"
import { PageOf } from "qwbe-core/http"
import { PageParams, pageRequest } from "qwbe-core/pagination"

const TABLE = "contacts"
const ENTITY = "Contact"

const Contact = Schema.Struct({
  ...EntityMeta,
  name: Schema.String,
  email: Schema.String,
  /** Optional in practice, so nullable in the schema rather than absent from responses. */
  phone: Schema.NullOr(Schema.String),
  /** Free text on purpose — there is NO account entity in this model. See the header. */
  company: Schema.NullOr(Schema.String),
}).annotations({ identifier: "Contact" })

const ContactCreate = Schema.Struct({
  name: Schema.String,
  email: Schema.optionalWith(Schema.String, { default: () => "" }),
  phone: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  company: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
}).annotations({ identifier: "ContactCreate" })

type ContactRow = typeof Contact.Type

const group = HttpApiGroup.make("contacts")
  .add(HttpApiEndpoint.get("list")`/contacts`.setUrlParams(PageParams).addSuccess(PageOf(Contact)).addError(Forbidden))
  .add(
    HttpApiEndpoint.get("get")`/contacts/${HttpApiSchema.param("id", Schema.String)}`
      .addSuccess(Contact)
      .addError(NotFound)
      .addError(Forbidden),
  )
  .add(HttpApiEndpoint.post("create")`/contacts`.setPayload(ContactCreate).addSuccess(Contact).addError(Forbidden))
  .middleware(Authorization)

// The public face of a contact. A phone number is deliberately NOT in it: a summary is shown to
// anything holding `links:read`, so whatever goes here is effectively public inside the system.
const summary = (c: ContactRow): SummaryRow => ({
  id: c.id,
  title: c.name,
  details: [
    { key: "email", value: c.email },
    { key: "company", value: c.company ?? "—" },
  ],
})

export const cube = defineCube(group, {
  manifest: {
    name: "contacts",
    parent: "crm",
    tables: [TABLE],
    entity: ENTITY,
    sortable: ["name", "company", "createdAt"],
    requiresAuth: true,
    permissions: [
      { name: "crm/contacts:read", roles: ["admin", "reader"] },
      { name: "crm/contacts:write", roles: ["admin"] },
    ],
    publishes: ["crm/contacts.created"],
    dataMigration: [{ fromCube: "contacts", toCube: "crm/contacts", fromPlugin: "crm-pack" }],
  },

  create: ({ store, bus }) => ({
    commands: [
      {
        name: "crm/contacts:count",
        summary: "how many contacts exist",
        permission: "crm/contacts:read",
        run: () => Effect.map(store.count(TABLE), (n) => String(n)),
      },
    ],

    handlers: {
      list: ({ urlParams }) =>
        Effect.gen(function* () {
          yield* requirePermission("crm/contacts:read")
          return yield* store.page<ContactRow>(TABLE, pageRequest(urlParams))
        }),

      get: ({ path }) =>
        Effect.gen(function* () {
          yield* requirePermission("crm/contacts:read")
          const c = yield* store.byId<ContactRow>(TABLE, path.id)
          if (!c) return yield* Effect.fail(new NotFound({ message: `contact ${path.id} does not exist` }))
          return c
        }),

      create: ({ payload }) =>
        Effect.gen(function* () {
          yield* requirePermission("crm/contacts:write")
          const c = (yield* store.insert(TABLE, ENTITY, "cont", payload)) as ContactRow
          yield* bus.publish("crm/contacts.created", { id: c.id, title: c.name })
          return c
        }),
    },

    relational: {
      search: (field, value, page) =>
        Effect.gen(function* () {
          const p = yield* store.page<ContactRow>(TABLE, page, { field, value })
          return { rows: p.rows.map(summary), total: p.total }
        }),

      summaryById: (id) =>
        Effect.gen(function* () {
          const c = yield* store.byId<ContactRow>(TABLE, id)
          return c ? summary(c) : undefined
        }),

      fieldValue: (id, field) =>
        Effect.gen(function* () {
          const c = yield* store.byId<ContactRow>(TABLE, id)
          const v = c ? (c as unknown as Record<string, unknown>)[field] : null
          return typeof v === "string" ? v : null
        }),
    },
  }),
})
