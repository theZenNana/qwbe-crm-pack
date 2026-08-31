// Test for the one-shot backfill of schema keys older rows lack (QWB-54, tickets 07, 13;
// the key's name is organizationId since the ticket-12 rename).
//
// What is proven, against a throwaway database (same recipe as import.test.mjs: the
// password comes from QWBE_PG_PASSWORD, never a default):
//   1. only rows WITHOUT the organizationId key gain `organizationId = null`;
//   2. rows that carry the key -- null or a value -- are untouched;
//   3. a second run changes nothing (idempotent), including the reported count.
//
// Requires a reachable Postgres (QWBE_PG_HOST/PORT/USER/PASSWORD, port 5433 by default).

import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import pg from "pg"
import { backfillExternalId, backfillOrganizationId } from "./backfill-contact-organizationid.mjs"

const url = () => {
  if (!process.env.QWBE_PG_PASSWORD) throw new Error("set QWBE_PG_PASSWORD in the environment (no password default)")
  const u = new URL("postgres://localhost/postgres")
  u.hostname = process.env.QWBE_PG_HOST ?? "localhost"
  u.port = process.env.QWBE_PG_PORT ?? "5433"
  u.username = process.env.QWBE_PG_USER ?? "postgres"
  u.password = process.env.QWBE_PG_PASSWORD
  return u
}

const SCHEMA = "backfill_test"
const TABLE = "rows"

const admin = new pg.Pool({ connectionString: url().toString(), max: 1 })
let pool
const dbName = `qwbe_backfill_${Date.now().toString(36)}`

before(async () => {
  await admin.query(`CREATE DATABASE "${dbName}"`)
  const dbUrl = new URL(url().toString())
  dbUrl.pathname = `/${dbName}`
  pool = new pg.Pool({ connectionString: dbUrl.toString(), max: 1 })
  await pool.query(`CREATE SCHEMA "${SCHEMA}"`)
  // The rows table, as the kernel's pg store creates it (core/src/pg/setup.ts).
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
  // Rows from before the keys existed (no organizationId, no externalId), rows with the
  // key null, one linked, and one that already carries its external identity.
  await pool.query(
    `INSERT INTO "${SCHEMA}"."${TABLE}" (id, type, body) VALUES
       ('old', 'Contact', '{"id":"old","type":"Contact","name":"Old Row"}'),
       ('null', 'Contact', '{"id":"null","type":"Contact","name":"Null Row","organizationId":null}'),
       ('linked', 'Contact', '{"id":"linked","type":"Contact","name":"Linked Row","organizationId":"org_1"}'),
       ('ext', 'Contact', '{"id":"ext","type":"Contact","name":"External Row","externalId":"vtiger:55"}')`,
  )
})

after(async () => {
  await pool?.end()
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {})
  await admin.end()
})

const bodyOf = async (id) => {
  const r = await pool.query(`SELECT body FROM "${SCHEMA}"."${TABLE}" WHERE id = $1`, [id])
  return r.rows[0].body
}

describe("the one-shot organizationId backfill", () => {
  it("fills the key with null only where it is missing", async () => {
    const n = await backfillOrganizationId(pool, SCHEMA, TABLE)
    assert.equal(n, 2) // old and ext lacked the key
    assert.deepEqual(await bodyOf("old"), { id: "old", type: "Contact", name: "Old Row", organizationId: null })
    assert.deepEqual(await bodyOf("null"), { id: "null", type: "Contact", name: "Null Row", organizationId: null })
    assert.deepEqual(await bodyOf("linked"), { id: "linked", type: "Contact", name: "Linked Row", organizationId: "org_1" })
  })

  it("is idempotent: a second run reports zero and changes nothing", async () => {
    const n = await backfillOrganizationId(pool, SCHEMA, TABLE)
    assert.equal(n, 0)
    assert.equal((await bodyOf("old")).organizationId, null)
    assert.equal((await bodyOf("linked")).organizationId, "org_1")
  })
})

describe("the one-shot externalId backfill (QWB-54, ticket 13)", () => {
  it("gives every row the key, null where no source system put one there", async () => {
    const n = await backfillExternalId(pool, SCHEMA, TABLE)
    assert.equal(n, 3) // old, null, linked lacked the key; 'ext' already carries one
    assert.equal((await bodyOf("old")).externalId, null)
    assert.equal((await bodyOf("ext")).externalId, "vtiger:55")
  })

  it("is idempotent: a second run reports zero and changes nothing", async () => {
    assert.equal(await backfillExternalId(pool, SCHEMA, TABLE), 0)
    assert.equal((await bodyOf("ext")).externalId, "vtiger:55")
  })
})
