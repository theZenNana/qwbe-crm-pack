// The CONTRACTS cube — the other half of the CRM plugin.
//
// Domain: a CONTRACT is a deal signed with a PARTY. `partyId` is a nullable identifier and
// nothing else: no import, no name of the cube that holds the other end, no copied field. That
// is the minimal relation of this version — stated outright, and tested: if the party's cube is
// switched off or never installed, this cube keeps starting and keeps serving, with an id that
// resolves to nothing. Joining the two is declared one level up, in a space, by a third party.
//
// Money: `amount` is an integer in MINOR UNITS (bani, cents) so no rounding happens on the way
// in, and totals are never computed across currencies — adding RON to EUR produces a number
// that looks authoritative and means nothing. The summary and the `contracts:value` command
// render per-currency, never a single grand total.
//
// What this cube is NOT: there is no ERP here. No account entity, no invoice, no settings —
// the historical ERP package is a different package and stays out of the CRM restore.
//
// Adapted (QWB-30) from the pre-QWB-19 source preserved at qwbe-packs onto `defineCube` and
// the current public contract; behaviour unchanged.

import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform"
import { Effect, Schema } from "effect"
import { Authorization, requirePermission } from "qwbe-core/auth"
import { defineCube } from "qwbe-core/cube"
import { EntityMeta, type SummaryRow } from "qwbe-core/entity"
import { Forbidden, NotFound } from "qwbe-core/errors"
import { PageOf } from "qwbe-core/http"
import { PageParams, pageRequest } from "qwbe-core/pagination"

const TABLE = "contracts"
const ENTITY = "Contract"

const CurrencyCode = Schema.String.pipe(
  Schema.pattern(/^[A-Z]{3}$/, { message: () => "currency must be a three-letter uppercase ISO 4217 code" }),
)
const SignedAt = Schema.String.pipe(
  Schema.pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/, {
    message: () => "signedAt must be an ISO 8601 timestamp with timezone",
  }),
)
const PartyId = Schema.NonEmptyTrimmedString

const Contract = Schema.Struct({
  ...EntityMeta,
  title: Schema.String,
  /** Minor units (bani, cents). Stored as an integer so no rounding happens on the way in. */
  amount: Schema.Int,
  currency: CurrencyCode,
  signedAt: Schema.NullOr(SignedAt),
  /** The other side of the deal. Just an id — nothing copied from the cube that holds it. */
  partyId: Schema.NullOr(PartyId),
}).annotations({ identifier: "Contract" })

export const ContractCreate = Schema.Struct({
  title: Schema.String,
  amount: Schema.optionalWith(Schema.Int, { default: () => 0 }),
  currency: Schema.optionalWith(CurrencyCode, { default: () => "RON" }),
  signedAt: Schema.optionalWith(Schema.NullOr(SignedAt), { default: () => null }),
  partyId: Schema.optionalWith(Schema.NullOr(PartyId), { default: () => null }),
}).annotations({ identifier: "ContractCreate" })

type ContractRow = typeof Contract.Type

const group = HttpApiGroup.make("contracts")
  .add(
    HttpApiEndpoint.get("list")`/contracts`.setUrlParams(PageParams).addSuccess(PageOf(Contract)).addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.get("get")`/contracts/${HttpApiSchema.param("id", Schema.String)}`
      .addSuccess(Contract)
      .addError(NotFound)
      .addError(Forbidden),
  )
  .add(HttpApiEndpoint.post("create")`/contracts`.setPayload(ContractCreate).addSuccess(Contract).addError(Forbidden))
  .middleware(Authorization)

const money = (c: ContractRow): string => `${(c.amount / 100).toFixed(2)} ${c.currency}`

const summary = (c: ContractRow): SummaryRow => ({
  id: c.id,
  title: c.title,
  details: [
    { key: "amount", value: money(c) },
    { key: "signed", value: c.signedAt ?? "unsigned" },
  ],
})

export const cube = defineCube(group, {
  manifest: {
    name: "contracts",
    // Opts the cube into the metadata drift gate (qwbe src/metadata/schema-drift.ts):
    // an undeclared version means a schema change cannot be caught (QWB-54).
    version: "1.0.0",
    parent: "crm",
    tables: [TABLE],
    entity: ENTITY,
    sortable: ["title", "amount", "signedAt", "createdAt"],
    requiresAuth: true,
    permissions: [
      { name: "crm/contracts:read", roles: ["admin", "reader"] },
      { name: "crm/contracts:write", roles: ["admin"] },
    ],
    publishes: ["crm/contracts.created"],
    dataMigration: [{ fromCube: "contracts", toCube: "crm/contracts", fromPlugin: "crm-pack" }],
  },

  create: ({ store, bus }) => ({
    commands: [
      {
        name: "crm/contracts:count",
        summary: "how many contracts exist",
        permission: "crm/contracts:read",
        run: () => Effect.map(store.count(TABLE), (n) => String(n)),
      },
      {
        name: "crm/contracts:value",
        summary: "total value of the newest contracts — `contracts:value [howMany]`",
        permission: "crm/contracts:read",
        maxArgs: 1,
        run: (args) =>
          Effect.gen(function* () {
            // A page, not the whole table: the same cap the HTTP list is subject to. A command
            // that quietly reads everything would be the back door around contract pagination.
            const howMany = Math.min(50, Math.max(1, Number(args[0] ?? 10) || 10))
            const p = yield* store.page<ContractRow>(TABLE, {
              offset: 0,
              limit: howMany,
              sortBy: "createdAt",
              descending: true,
            })
            if (p.rows.length === 0) return "(none)"
            // Currencies are not summed together — adding RON to EUR produces a number that
            // looks authoritative and means nothing.
            const perCurrency = new Map<string, number>()
            for (const c of p.rows) perCurrency.set(c.currency, (perCurrency.get(c.currency) ?? 0) + c.amount)
            return [...perCurrency].map(([currency, total]) => `${(total / 100).toFixed(2)} ${currency}`).join("\n")
          }),
      },
    ],

    handlers: {
      list: ({ urlParams }) =>
        Effect.gen(function* () {
          yield* requirePermission("crm/contracts:read")
          return yield* store.page<ContractRow>(TABLE, pageRequest(urlParams))
        }),

      get: ({ path }) =>
        Effect.gen(function* () {
          yield* requirePermission("crm/contracts:read")
          const c = yield* store.byId<ContractRow>(TABLE, path.id)
          if (!c) return yield* Effect.fail(new NotFound({ message: `contract ${path.id} does not exist` }))
          return c
        }),

      create: ({ payload }) =>
        Effect.gen(function* () {
          yield* requirePermission("crm/contracts:write")
          const c = (yield* store.insert(TABLE, ENTITY, "ctr", payload)) as ContractRow
          yield* bus.publish("crm/contracts.created", { id: c.id, title: c.title })
          return c
        }),
    },

    relational: {
      search: (field, value, page) =>
        Effect.gen(function* () {
          const p = yield* store.page<ContractRow>(TABLE, page, { field, value })
          return { rows: p.rows.map(summary), total: p.total }
        }),

      summaryById: (id) =>
        Effect.gen(function* () {
          const c = yield* store.byId<ContractRow>(TABLE, id)
          return c ? summary(c) : undefined
        }),

      fieldValue: (id, field) =>
        Effect.gen(function* () {
          const c = yield* store.byId<ContractRow>(TABLE, id)
          const v = c ? (c as unknown as Record<string, unknown>)[field] : null
          return typeof v === "string" ? v : null
        }),
    },
  }),
})
