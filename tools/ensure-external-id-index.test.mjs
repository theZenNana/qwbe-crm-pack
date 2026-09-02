// Tests for the unique externalId index module (QWB-54, ticket 13).
//
// What is proven, against a throwaway database (same recipe as import.test.mjs: the password
// comes from QWBE_PG_PASSWORD, never a default):
//   1. the index is created, partial on live rows with a non-null externalId;
//   2. a second run reports "exists" and changes nothing (idempotent);
//   3. a missing table is REFUSED, never silently skipped -- an index silently skipped
//      would leave the import without its guarantee;
//   4. the database itself refuses a second row with an externalId already taken.
// Structure only is asserted; no row values beyond the synthetic fixture strings below.

import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import pg from "pg"
import { ensureExternalIdIndex, indexName, schemaOf } from "./ensure-external-id-index.mjs"
import { requireDbUrl } from "./db-url.mjs"

const SCHEMA = "extidx_test"
const TABLE = "rows"

const admin = new pg.Pool({ connectionString: requireDbUrl().toString(), max: 1 })
let pool
const dbName = `qwbe_extidx_${Date.now().toString(36)}`

before(async () => {
  await admin.query(`CREATE DATABASE "${dbName}"`)
  const dbUrl = requireDbUrl()
  dbUrl.pathname = `/${dbName}`
  pool = new pg.Pool({ connectionString: dbUrl.toString(), max: 1 })
  // The schema and table, as the kernel's pg store creates them (core/src/pg/setup.ts) --
  // exactly what ensureCubeSchema + ensureTable would have left behind after one list call.
  await pool.query(`CREATE SCHEMA "${SCHEMA}"`)
  await pool.query(
    `CREATE TABLE "${SCHEMA}"."${TABLE}" (
       id text PRIMARY KEY,
       type text NOT NULL,
       created_at timestamptz NOT NULL DEFAULT now(),
       deleted boolean NOT NULL DEFAULT false,
       version integer NOT NULL DEFAULT 1,
       body jsonb NOT NULL
     )`,
  )
  await pool.query(
    `INSERT INTO "${SCHEMA}"."${TABLE}" (id, type, body) VALUES
       ('one', 'Organization', $1),
       ('two', 'Organization', $2)`,
    [JSON.stringify({ name: "One", externalId: "vtiger:1" }), JSON.stringify({ name: "Two", externalId: null })],
  )
})

after(async () => {
  await pool?.end()
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {})
  await admin.end()
})

describe("the unique externalId index", () => {
  it("is created once, reported as existing on the second run", async () => {
    assert.equal(await ensureExternalIdIndex(pool, SCHEMA, TABLE), "created")
    assert.equal(await ensureExternalIdIndex(pool, SCHEMA, TABLE), "exists")
    const r = await pool.query(`SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = $2`, [
      SCHEMA,
      indexName(TABLE),
    ])
    assert.equal(r.rows.length, 1)
    assert.match(r.rows[0].indexdef, /CREATE UNIQUE INDEX/)
    assert.match(r.rows[0].indexdef, /externalId/)
    assert.match(r.rows[0].indexdef, /deleted = false/)
  })

  it("refuses a missing table instead of silently skipping the guarantee", async () => {
    await assert.rejects(() => ensureExternalIdIndex(pool, SCHEMA, "no_such_table"), /does not exist yet/)
  })

  it("the database refuses a second row with an externalId already taken", async () => {
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO "${SCHEMA}"."${TABLE}" (id, type, body) VALUES ('dup', 'Organization', $1)`,
          [JSON.stringify({ name: "Dup", externalId: "vtiger:1" })],
        ),
      (e) => e.code === "23505",
    )
  })

  it("maps a cube name to its schema by the kernel's own rule", () => {
    assert.equal(schemaOf("crm/organizations"), "crm--organizations")
  })
})
