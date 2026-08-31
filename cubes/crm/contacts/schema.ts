// The Contact schemas, split out of index.ts to stay under the size cap
// (QWB-47 review: split the file, never raise the cap). Same domain, same decisions —
// see index.ts for the reasoning that surrounds these fields.

import { Schema } from "effect"
import { EntityMeta } from "qwbe-core/entity"

export const Contact = Schema.Struct({
  ...EntityMeta,
  name: Schema.String,
  email: Schema.String,
  /** The external identity of a row that came from (or is destined for) a source system:
   *  "vtiger:<crmid>" for the import (QWB-54, ticket 13). Null for rows created by hand.
   *  Uniqueness lives in the DATABASE: a partial unique index on this field (only live rows,
   *  only non-null values) is ensured by tools/ensure-external-id-index.mjs -- a plugin cube
   *  cannot create it (the kernel's per-cube role holds DML only), so the pack's tool does,
   *  as the database user that owns the tables. */
  externalId: Schema.NullOr(Schema.String),
  /** Optional in practice, so nullable in the schema rather than absent from responses. */
  phone: Schema.NullOr(Schema.String),
  /** Free text on purpose — the Organization lives in its own cube, not folded in here. */
  company: Schema.NullOr(Schema.String),
  /** The one truth of the contact-to-organization relation. Nullable, opaque, caller-set. */
  organizationId: Schema.NullOr(Schema.String),
}).annotations({ identifier: "Contact" })

/** The patch: a contact can move to another organization, or be unlinked (organizationId null). */
export const ContactPatch = Schema.Struct({
  name: Schema.optional(Schema.NonEmptyTrimmedString),
  email: Schema.optional(Schema.String),
  externalId: Schema.optional(Schema.NullOr(Schema.String)),
  phone: Schema.optional(Schema.NullOr(Schema.String)),
  company: Schema.optional(Schema.NullOr(Schema.String)),
  organizationId: Schema.optional(Schema.NullOr(Schema.NonEmptyTrimmedString)),
}).annotations({ identifier: "ContactPatch" })

export const ContactCreate = Schema.Struct({
  name: Schema.String,
  email: Schema.optionalWith(Schema.String, { default: () => "" }),
  externalId: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  phone: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  company: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  organizationId: Schema.optionalWith(Schema.NullOr(Schema.NonEmptyTrimmedString), { default: () => null }),
}).annotations({ identifier: "ContactCreate" })
