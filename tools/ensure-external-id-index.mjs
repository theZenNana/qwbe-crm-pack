#!/usr/bin/env node
// The unique index on a cube's external identity (QWB-54, ticket 13).
//
// WHY this module exists: the import is idempotent through `externalId` ("vtiger:<crmid>")
// carried ON each row, and uniqueness must live in the DATABASE, not in the application and
// not in a file a crash can lose. A plugin cube cannot create the index itself: the kernel's
// per-cube role holds DML only (SELECT/INSERT/UPDATE/DELETE -- core/src/pg/setup.ts), and
// Postgres refuses CREATE INDEX to anyone but the table's owner ("must be owner of table").
// The kernel offers no index declaration either. So the pack brings a small tool that connects
// to the same database as the kernel, as its owner user, and creates the one partial unique
// index per importable table. The vtiger-map tool runs it before its first write; it can also
// be run standalone for both importable cubes.
//
// The index is PARTIAL: only live rows (deleted = false) with a non-null externalId enter it.
// Rows created by hand (no source system) have no externalId and never conflict; a soft-deleted
// row does not block its identity from being imported again.
//
// Connection (same contract as the backfill tool, no password default):
//   QWBE_DATABASE_URL=postgres://... node tools/ensure-external-id-index.mjs
// or the local-dev parts:
//   QWBE_PG_PASSWORD=qwbe node tools/ensure-external-id-index.mjs
// With neither variable set the tool refuses to guess and exits 2.
//
// The table must already exist: the kernel creates it on first use, so one list request
// (GET /organizations?limit=1) is enough -- the import tool does exactly that before calling
// this module. Structure only is ever printed: schema, table, index name, created/exists.

import pg from "pg"

/** The cube's schema name, by the kernel's own rule (core/src/pg/setup.ts schemaName). */
export const schemaOf = (cube) => cube.replace(/\//g, "--")

/** Deterministic index name per table: re-runs are no-ops, and the name is what shows up
 *  in a duplicate-key error, so it must not depend on the run that happened to create it. */
export const indexName = (table) => `${table}_external_id_key`

const qi = (identifier) => `"` + identifier.replace(/"/g, `""`) + `"`

/** The one statement, for any schema/table (tests use a scratch pair). */
export const externalIdIndexSql = (schema, table) =>
  `CREATE UNIQUE INDEX IF NOT EXISTS ${qi(indexName(table))} ON ${qi(schema)}.${qi(table)} ` +
  `((body->>'externalId')) WHERE deleted = false AND body->>'externalId' IS NOT NULL`

/**
 * Ensure the partial unique index on (body->>'externalId'). Returns "created" or "exists".
 * Refuses (throws) when the table does not exist yet, with the one command that fixes it --
 * an index silently skipped here would leave the import without its guarantee.
 */
export const ensureExternalIdIndex = async (pool, schema, table) => {
  const exists = await pool.query(`SELECT to_regclass($1) AS t`, [`${qi(schema)}.${qi(table)}`])
  if (!exists.rows[0].t) {
    throw new Error(
      `table ${schema}.${table} does not exist yet -- the kernel creates it on first use; ` +
        `one list request (GET /${table}?limit=1) is enough, or run the import tool, which ensures the index itself`,
    )
  }
  const before = await pool.query(`SELECT 1 FROM pg_indexes WHERE schemaname = $1 AND indexname = $2`, [
    schema,
    indexName(table),
  ])
  await pool.query(externalIdIndexSql(schema, table))
  return before.rowCount > 0 ? "exists" : "created"
}

/** The two importable cubes of this pack: every target of tools/vtiger-map.mjs. */
export const IMPORTABLE = [
  { cube: "crm/organizations", schema: "crm--organizations", table: "organizations" },
  { cube: "crm/contacts", schema: "crm--contacts", table: "contacts" },
]

/** Connection URL from the environment; null when neither spelling is set. Never a default. */
export const dbUrl = () => {
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
  const url = dbUrl()
  if (!url) {
    console.error(
      "refusing to guess the database: set QWBE_DATABASE_URL, or QWBE_PG_PASSWORD (plus optional QWBE_PG_HOST/PORT/USER)",
    )
    process.exit(2)
  }
  const pool = new pg.Pool({ connectionString: url, max: 1 })
  let failed = false
  for (const target of IMPORTABLE) {
    try {
      const state = await ensureExternalIdIndex(pool, target.schema, target.table)
      console.log(`${target.cube}: index ${indexName(target.table)} ${state}`)
    } catch (err) {
      failed = true
      console.error(`${target.cube}: ${err.message}`)
    }
  }
  await pool.end()
  if (failed) process.exit(1)
}
