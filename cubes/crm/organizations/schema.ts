// The Organization schemas, split out of index.ts to stay under the size cap
// (split the file, never raise the cap). Same domain, same decisions —
// see index.ts for the reasoning that surrounds these fields.
//
// Naming: one name everywhere — the entity is Organization and so are
// the schema identifiers. The two carried-over number/type fields keep the same rename rule:
// `organizationNo` and `organizationType`, never `type` alone. `type` is the entity-type meta
// column that EntityMeta carries ("Organization"); the kernel builds the row as
// {id, type: entity, ...values}, so a domain field named `type` would overwrite it and every
// create would die on the NOT NULL meta column. The exact source columns of the vtiger import
// live in the import mapping, which is where source-system names belong.

import { Schema } from "effect"
import { EntityMeta } from "qwbe-core/entity"

export const Organization = Schema.Struct({
  ...EntityMeta,
  /** The one required field, and the summary title. */
  name: Schema.NonEmptyTrimmedString,
  /** The external identity of a row that came from (or is destined for) a source system:
   *  "vtiger:<crmid>" for the import. Null for rows created by hand.
   *  Uniqueness lives in the DATABASE: a partial unique index on this field (only live rows,
   *  only non-null values) is ensured by tools/ensure-external-id-index.mjs -- a plugin cube
   *  cannot create it (the kernel's per-cube role holds DML only), so the pack's tool does,
   *  as the database user that owns the tables. */
  externalId: Schema.NullOr(Schema.String),
  /** The human-facing number; the source column is named in the vtiger import mapping. */
  organizationNo: Schema.NullOr(Schema.String),
  phone: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
  website: Schema.NullOr(Schema.String),
  /** Renamed off `type`, which is the entity meta column (see the header). */
  organizationType: Schema.NullOr(Schema.String),
  industry: Schema.NullOr(Schema.String),
  rating: Schema.NullOr(Schema.String),
  ownership: Schema.NullOr(Schema.String),
  /** A headcount is a count: zero or more, never negative. */
  employees: Schema.NullOr(Schema.Int.pipe(Schema.nonNegative())),
  /** The vtiger opt-out flag, kept as a real boolean instead of a varchar(3) flag. */
  emailOptOut: Schema.Boolean,
  /** Billing address, the four fields of the vtiger block that carry data. */
  billingStreet: Schema.NullOr(Schema.String),
  billingCity: Schema.NullOr(Schema.String),
  billingCode: Schema.NullOr(Schema.String),
  billingCountry: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
}).annotations({ identifier: "Organization" })

export const OrganizationCreate = Schema.Struct({
  name: Schema.NonEmptyTrimmedString,
  externalId: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  organizationNo: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  phone: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  email: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  website: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  organizationType: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  industry: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  rating: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  ownership: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  employees: Schema.optionalWith(Schema.NullOr(Schema.Int.pipe(Schema.nonNegative())), { default: () => null }),
  emailOptOut: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  billingStreet: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  billingCity: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  billingCode: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  billingCountry: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  description: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
}).annotations({ identifier: "OrganizationCreate" })

// Every domain field is optional on a patch; `id`, `createdAt` and the entity meta `type`
// are not. There is no delete endpoint in this ticket, so `deleted` is refused here too:
// patching it to true would orphan contacts whose organization then 404s. The rule for the
// future deletion ticket lives in README.md.
export type OrganizationRow = typeof Organization.Type

export const OrganizationPatch = Schema.Struct({
  name: Schema.optional(Schema.NonEmptyTrimmedString),
  externalId: Schema.optional(Schema.NullOr(Schema.String)),
  organizationNo: Schema.optional(Schema.NullOr(Schema.String)),
  phone: Schema.optional(Schema.NullOr(Schema.String)),
  email: Schema.optional(Schema.NullOr(Schema.String)),
  website: Schema.optional(Schema.NullOr(Schema.String)),
  organizationType: Schema.optional(Schema.NullOr(Schema.String)),
  industry: Schema.optional(Schema.NullOr(Schema.String)),
  rating: Schema.optional(Schema.NullOr(Schema.String)),
  ownership: Schema.optional(Schema.NullOr(Schema.String)),
  employees: Schema.optional(Schema.NullOr(Schema.Int.pipe(Schema.nonNegative()))),
  emailOptOut: Schema.optional(Schema.Boolean),
  billingStreet: Schema.optional(Schema.NullOr(Schema.String)),
  billingCity: Schema.optional(Schema.NullOr(Schema.String)),
  billingCode: Schema.optional(Schema.NullOr(Schema.String)),
  billingCountry: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  // Accepts nothing: any value present fails the decode. Absence is fine.
  deleted: Schema.optional(Schema.Never),
}).annotations({ identifier: "OrganizationPatch" })
