// The Organization schemas, split out of index.ts to stay under the size cap
// (QWB-47 review: split the file, never raise the cap). Same domain, same decisions —
// see index.ts for the reasoning that surrounds these fields.
//
// Naming: the vtiger field `account_type` is `accountType` here, NOT `type`. `type` is the
// entity-type meta column that EntityMeta carries ("Organization"); the kernel builds the
// row as {id, type: entity, ...values}, so a domain field named `type` would overwrite it
// and every create would die on the NOT NULL meta column. This is a rename, not a redesign.

import { Schema } from "effect"
import { EntityMeta } from "qwbe-core/entity"

export const Account = Schema.Struct({
  ...EntityMeta,
  /** vtiger `accountname` — the one required field, and the summary title. */
  name: Schema.NonEmptyTrimmedString,
  /** vtiger `account_no`, the human-facing number. */
  accountNo: Schema.NullOr(Schema.String),
  phone: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
  website: Schema.NullOr(Schema.String),
  /** vtiger `account_type` — renamed off `type`, which is the entity meta column. */
  accountType: Schema.NullOr(Schema.String),
  industry: Schema.NullOr(Schema.String),
  rating: Schema.NullOr(Schema.String),
  ownership: Schema.NullOr(Schema.String),
  /** A headcount is a count: zero or more, never negative. */
  employees: Schema.NullOr(Schema.Int.pipe(Schema.nonNegative())),
  /** vtiger `emailoptout`, kept as a real boolean instead of a varchar(3) flag. */
  emailOptOut: Schema.Boolean,
  /** Billing address, the four fields of the vtiger block that carry data. */
  billingStreet: Schema.NullOr(Schema.String),
  billingCity: Schema.NullOr(Schema.String),
  billingCode: Schema.NullOr(Schema.String),
  billingCountry: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
}).annotations({ identifier: "Organization" })

export const AccountCreate = Schema.Struct({
  name: Schema.NonEmptyTrimmedString,
  accountNo: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  phone: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  email: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  website: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  accountType: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
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
export type AccountRow = typeof Account.Type

export const AccountPatch = Schema.Struct({
  name: Schema.optional(Schema.NonEmptyTrimmedString),
  accountNo: Schema.optional(Schema.NullOr(Schema.String)),
  phone: Schema.optional(Schema.NullOr(Schema.String)),
  email: Schema.optional(Schema.NullOr(Schema.String)),
  website: Schema.optional(Schema.NullOr(Schema.String)),
  accountType: Schema.optional(Schema.NullOr(Schema.String)),
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
