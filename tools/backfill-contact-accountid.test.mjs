// Test for the one-shot accountId backfill (QWB-54, ticket 07).
//
// What is proven, against a throwaway database (same recipe as import.test.mjs: the
// password comes from QWBE_PG_PASSWORD, never a default):
//   1. only rows WITHOUT the accountId key gain `accountId = null`;
//   2. rows that carry the key -- null or a value -- are untouched;
//   3. a second run changes nothing (idempotent), including the reported count.
//
// Requires a reachable Postgres (QWBE_PG_HOST/PORT/USER/PASSWORD, port 5433 by default).

import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import pg from "pg"
import { backfillAccountId } from "./backfill-contact-accountid.mjs"

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
  // One row from before QWB-47 (no key), one with null, one linked.
  await pool.query(
    `INSERT INTO "${SCHEMA}"."${TABLE}" (id, type, body) VALUES
       ('old', 'Contact', '{"id":"old","type":"Contact","name":"Old Row"}'),
       ('null', 'Contact', '{"id":"null","type":"Contact","name":"Null Row","accountId":null}'),
       ('linked', 'Contact', '{"id":"linked","type":"Contact","name":"Linked Row","accountId":"acc_1"}')`,
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

describe("the one-shot accountId backfill", () => {
  it("fills the key with null only where it is missing", async () => {
    const n = await backfillAccountId(pool, SCHEMA, TABLE)
    assert.equal(n, 1)
    assert.deepEqual(await bodyOf("old"), { id: "old", type: "Contact", name: "Old Row", accountId: null })
    assert.deepEqual(await bodyOf("null"), { id: "null", type: "Contact", name: "Null Row", accountId: null })
    assert.deepEqual(await bodyOf("linked"), { id: "linked", type: "Contact", name: "Linked Row", accountId: "acc_1" })
  })

  it("is idempotent: a second run reports zero and changes nothing", async () => {
    const n = await backfillAccountId(pool, SCHEMA, TABLE)
    assert.equal(n, 0)
    assert.equal((await bodyOf("old")).accountId, null)
    assert.equal((await bodyOf("linked")).accountId, "acc_1")
  })
})
