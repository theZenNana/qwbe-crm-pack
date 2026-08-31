// The CONTACTS cube — one half of the CRM plugin (two cubes and a sibling, one package).
//
// Domain: a CONTACT is a person the business deals with. `company` stays free text. Since
// QWB-47 there IS an Organization entity (`crm/accounts`), and the relation to it has one
// truth: `accountId` on the contact. It is nullable, opaque, and set by the caller — an
// organization's contact list is derived by filtering this cube's list on `accountId`, not by
// a related-list endpoint, and it is patchable: a contact can move to another organization or
// be unlinked. This cube does not import the accounts cube; the manifest DECLARES the relation
// target (`relations.accountId`) so the metadata endpoint can resolve ids to names — metadata,
// not an import, and no coupling of code. The id is checked for shape here only: refusing a
// well-formed id that does not exist needs a kernel-enforced relation, which does not exist
// yet (see README.md).
//
// `contracts` is not named anywhere in this file either. It holds a party id on its side; this
// cube does not know it exists. The cubes land in the same flat level-0 namespace, each with
// its own table, API, schema, permissions and events, and none imports another — they share a
// directory on disk and nothing else.
//
// Adapted (QWB-30) from the pre-QWB-19 source preserved at qwbe-packs: the public cube
// contract is now `qwbe-core/cube` (`defineCube`, typed endpoint/handler pairing) instead of a
// bare object literal. Behaviour is unchanged: same fields, same permissions, same event.

import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform"
import { Effect, Schema } from "effect"
import { Authorization, requirePermission } from "qwbe-core/auth"
import { defineCube } from "qwbe-core/cube"
import { type SummaryRow } from "qwbe-core/entity"
import { Forbidden, NotFound } from "qwbe-core/errors"
import { PageOf } from "qwbe-core/http"
import { pageRequest } from "qwbe-core/pagination"
import { Contact, ContactCreate, ContactListParams, ContactPatch } from "./schema.ts"

const TABLE = "contacts"
const ENTITY = "Contact"

type ContactRow = typeof Contact.Type

// The list takes one extra filter beyond paging and sorting: `accountId`. That filter IS the
// derived contact list of an organization — no second endpoint, no related list.
const group = HttpApiGroup.make("contacts")
  .add(
    HttpApiEndpoint.get("list")
      `/contacts`
      .setUrlParams(ContactListParams)
      .addSuccess(PageOf(Contact))
      .addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.get("get")`/contacts/${HttpApiSchema.param("id", Schema.String)}`
      .addSuccess(Contact)
      .addError(NotFound)
      .addError(Forbidden),
  )
  .add(HttpApiEndpoint.post("create")`/contacts`.setPayload(ContactCreate).addSuccess(Contact).addError(Forbidden))
  .add(
    HttpApiEndpoint.patch("update")`/contacts/${HttpApiSchema.param("id", Schema.String)}`
      .setPayload(ContactPatch)
      .addSuccess(Contact)
      .addError(NotFound)
      .addError(Forbidden),
  )
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
    // Opts the cube into the metadata drift gate (qwbe src/metadata/schema-drift.ts):
    // an undeclared version means a schema change cannot be caught (QWB-54).
    version: "1.0.0",
    parent: "crm",
    tables: [TABLE],
    entity: ENTITY,
    sortable: ["name", "company", "createdAt"],
    // Declared, not resolved: the metadata endpoint publishes the target (and summaryById
    // resolution through it). A declared target is metadata, not an import — no code couples
    // the cubes.
    relations: { accountId: { target: "crm/accounts" } },
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
          const { accountId, ...page } = urlParams
          // Rows written before QWB-47 have no accountId key at all; the schema wants the key
          // present and nullable, so every row is normalised on the way out. No backfill: the
          // absence of the key and null mean the same thing.
          const normalise = (c: ContactRow): ContactRow => ({ ...c, accountId: c.accountId ?? null })
          const p = accountId
            ? yield* store.page<ContactRow>(TABLE, pageRequest(page), { field: "accountId", value: accountId })
            : yield* store.page<ContactRow>(TABLE, pageRequest(page))
          return { ...p, rows: p.rows.map(normalise) }
        }),

      get: ({ path }) =>
        Effect.gen(function* () {
          yield* requirePermission("crm/contacts:read")
          const c = yield* store.byId<ContactRow>(TABLE, path.id)
          if (!c) return yield* Effect.fail(new NotFound({ message: `contact ${path.id} does not exist` }))
          return { ...c, accountId: c.accountId ?? null }
        }),

      create: ({ payload }) =>
        Effect.gen(function* () {
          yield* requirePermission("crm/contacts:write")
          const c = (yield* store.insert(TABLE, ENTITY, "cont", payload)) as ContactRow
          yield* bus.publish("crm/contacts.created", { id: c.id, title: c.name })
          return { ...c, accountId: c.accountId ?? null }
        }),

      update: ({ path, payload }) =>
        Effect.gen(function* () {
          yield* requirePermission("crm/contacts:write")
          const current = yield* store.byId<ContactRow>(TABLE, path.id)
          if (!current) return yield* Effect.fail(new NotFound({ message: `contact ${path.id} does not exist` }))
          // An empty PATCH changes nothing: no version bump, no outbox row.
          if (Object.keys(payload).length === 0) return { ...current, accountId: current.accountId ?? null }
          const c = (yield* store.update(TABLE, path.id, payload)) as ContactRow
          return { ...c, accountId: c.accountId ?? null }
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
