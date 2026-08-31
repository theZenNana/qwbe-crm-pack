#!/usr/bin/env node
// One-shot backfill for contact rows written before QWB-47 (QWB-54, ticket 07).
//
// Why: contacts stored before the organizations cube existed have NO relation key at all,
// while the Contact schema wants the key present and nullable. The kernel's generic list
// serves rows exactly as stored, so such a row would fail response encoding. The cube used to
// hide this by normalizing every response (`organizationId: c.organizationId ?? null`) -- a
// hand-written handler is exactly what ticket 07 removes -- so instead the absence is fixed
// once, in the data: organizationId becomes NULL where the key is missing. The key's name is
// organizationId since the one-name rename (QWB-54, ticket 12).
//
// Idempotent: `body ? 'organizationId'` is true iff the key exists (null included), so rows
// that carry the key are never touched and a second run changes nothing. Safe against a live
// store: one UPDATE, matched only on rows that lack the key.
//
// Connection (same contract as the qwbe probes, no password default):
//   QWBE_DATABASE_URL=postgres://... node tools/backfill-contact-organizationid.mjs
// or the local-dev parts:
//   QWBE_PG_PASSWORD=qwbe node tools/backfill-contact-organizationid.mjs
// With neither variable set the tool refuses to guess and exits 2.

import pg from "pg"

// schemaName("crm/contacts") -- qwbe core/src/pg/setup.ts turns the cube's slash into "--".
export const SCHEMA = "crm--contacts"
export const TABLE = "contacts"

/** The one statement, for any schema/table (tests use a scratch pair). */
export const backfillSql = (schema = SCHEMA, table = TABLE) =>
  `UPDATE "${schema}"."${table}" SET body = body || '{"organizationId": null}'::jsonb WHERE NOT body ? 'organizationId'`

/** Runs the backfill and returns how many rows gained the key. */
export const backfillOrganizationId = async (pool, schema = SCHEMA, table = TABLE) => {
  const result = await pool.query(backfillSql(schema, table))
  return result.rowCount ?? 0
}

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
    const n = await backfillOrganizationId(pool)
    console.log(`backfill done: ${n} contact row(s) gained organizationId = null`)
  } finally {
    await pool.end()
  }
}
