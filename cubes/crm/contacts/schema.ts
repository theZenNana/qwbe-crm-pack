// The Contact schemas, split out of index.ts to stay under the size cap
// (QWB-47 review: split the file, never raise the cap). Same domain, same decisions —
// see index.ts for the reasoning that surrounds these fields.

import { Schema } from "effect"
import { EntityMeta } from "qwbe-core/entity"
import { PageParams } from "qwbe-core/pagination"

export const Contact = Schema.Struct({
  ...EntityMeta,
  name: Schema.String,
  email: Schema.String,
  /** Optional in practice, so nullable in the schema rather than absent from responses. */
  phone: Schema.NullOr(Schema.String),
  /** Free text on purpose — the Organization lives in its own cube, not folded in here. */
  company: Schema.NullOr(Schema.String),
  /** The one truth of the contact-to-organization relation. Nullable, opaque, caller-set. */
  accountId: Schema.NullOr(Schema.String),
}).annotations({ identifier: "Contact" })

/** The patch: a contact can move to another organization, or be unlinked (accountId null). */
export const ContactPatch = Schema.Struct({
  name: Schema.optional(Schema.NonEmptyTrimmedString),
  email: Schema.optional(Schema.String),
  phone: Schema.optional(Schema.NullOr(Schema.String)),
  company: Schema.optional(Schema.NullOr(Schema.String)),
  accountId: Schema.optional(Schema.NullOr(Schema.NonEmptyTrimmedString)),
}).annotations({ identifier: "ContactPatch" })

export const ContactCreate = Schema.Struct({
  name: Schema.String,
  email: Schema.optionalWith(Schema.String, { default: () => "" }),
  phone: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  company: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  accountId: Schema.optionalWith(Schema.NullOr(Schema.NonEmptyTrimmedString), { default: () => null }),
}).annotations({ identifier: "ContactCreate" })


/** The list filter: `accountId` selects the contacts of one organization. */
export const ContactListParams = Schema.Struct({
  ...PageParams.fields,
  accountId: Schema.optional(Schema.NonEmptyTrimmedString),
})
