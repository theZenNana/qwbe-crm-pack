#!/usr/bin/env node
// One-shot backfill for rows written before a schema key existed.
//
// Why: the kernel's generic list serves rows exactly as stored, and a row missing a key the
// schema declares (present, nullable) fails response encoding, so the absence is fixed once,
// in the data.
//
// Three kinds of fix today:
//   - `organizationId` on contacts: rows stored before the organizations cube existed (the
//     key's name is organizationId since the one-name rename).
//   - `externalId` on contacts and organizations: the external identity of the vtiger import.
//     Rows created by hand have no source system; they gain the key
//     with a null value, and the partial unique index ignores nulls.
//   - the field RENAME inside organizations: rows migrated from the old
//     crm/accounts cube carry the old field names `accountNo`/`accountType`; the renamed
//     schema serves `organizationNo`/`organizationType` and a row missing them fails
//     response encoding. Each old key moves to its new name in the same jsonb body.
//
// Idempotent: `body ? 'key'` is true iff the key exists (null included), so rows that carry
// the key are never touched and a second run changes nothing. Safe against a live store: one
// UPDATE per (schema, table, key), matched only on rows that lack the key.
//
// Targets, all four steps: crm--contacts.contacts (organizationId, externalId),
// crm--organizations.organizations (externalId, plus the accountNo/accountType rename).
//
// Connection (same contract as the qwbe probes, no password default):
//   QWBE_DATABASE_URL=postgres://... node tools/backfill-contact-organizationid.mjs
// or the local-dev parts:
//   QWBE_PG_PASSWORD=qwbe node tools/backfill-contact-organizationid.mjs
// With neither variable set the tool refuses to guess and exits 2.

import pg from "pg"

/** The one statement, for any schema/table/key (tests use a scratch pair). */
export const fillKeySql = (schema, table, key) =>
  `UPDATE "${schema}"."${table}" SET body = body || '${JSON.stringify({ [key]: null })}'::jsonb WHERE NOT body ? '${key}'`

/** Runs one backfill and returns how many rows gained the key. */
export const backfillMissingKey = async (pool, schema, table, key) => {
  const result = await pool.query(fillKeySql(schema, table, key))
  return result.rowCount ?? 0
}

/**
 * The rename statement: moves each old key into its new name inside the
 * same jsonb body, deleting the old keys. The whole expression reads the OLD row, so the new
 * keys are built from values that are still there; `body ? '<old>'` makes it idempotent -- a
 * renamed row no longer carries the old key, so a second run changes nothing.
 */
export const renameAccountKeysSql = (schema, table) =>
  `UPDATE "${schema}"."${table}" SET body = (body - 'accountNo' - 'accountType') || ` +
    `jsonb_build_object('organizationNo', body->'accountNo', 'organizationType', body->'accountType') ` +
    `WHERE body ? 'accountNo'`

/** Renames accountNo/accountType to their organization* names; returns the rows moved. */
export const renameOrganizationKeys = (pool, schema = "crm--organizations", table = "organizations") =>
  pool.query(renameAccountKeysSql(schema, table)).then((r) => r.rowCount ?? 0)

const TARGETS = [
  { schema: "crm--contacts", table: "contacts", key: "organizationId" },
  { schema: "crm--contacts", table: "contacts", key: "externalId" },
  { schema: "crm--organizations", table: "organizations", key: "externalId" },
]

const connectionUrl = () => {
  if (process.env.QWBE_DATABASE_URL) return process.env.QWBE_DATABASE_URL
  if (process.env.QWBE_PG_PASSWORD) {
    const u = new URL("postgres://localhost/postgres")
    u.hostname = process.env.QWBE_PG_HOST ?? "localhost"
    u.port = process.env.QWBE_PG_PORT ?? "5433"
    u.username = process.env.QWBE_PG_USER ?? "postgres"
    u.password = process.env.QWBE_PG_PASSWORD
    return u.toString()
  }
  return null
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (isMain) {
  const url = connectionUrl()
  if (!url) {
    console.error("refusing to guess the database: set QWBE_DATABASE_URL, or QWBE_PG_PASSWORD (plus optional QWBE_PG_HOST/PORT/USER)")
    process.exit(2)
  }
  const pool = new pg.Pool({ connectionString: url, max: 1 })
  try {
    for (const t of TARGETS) {
      const n = await backfillMissingKey(pool, t.schema, t.table, t.key)
      console.log(`backfill done: ${n} ${t.table} row(s) gained ${t.key} = null`)
    }
    const renamed = await renameOrganizationKeys(pool)
    console.log(`backfill done: ${renamed} organizations row(s) renamed accountNo/accountType`)
  } finally {
    await pool.end()
  }
}
