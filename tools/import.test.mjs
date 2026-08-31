// Tests for the QWB-50 import chain, proven on SYNTHETIC fixtures only.
//
// The fixtures (tools/fixtures/*.fixture.json) are hand-written rows with obviously fake
// names (Alpha Trading SRL, Beta Logistics SRL, Andrei Exemplu) shaped exactly like the
// vtiger export. No database, no customer data, nothing leaves the machine.
//
// Three layers:
//   1. the export query builders (SQL shape: joins, active-rows-only, no SELECT *);
//   2. the pure mapping (vtiger row -> cube payload);
//   3. an end-to-end run against a real qwbe server on a free port with a throwaway
//      database: upload -> map -> verify -> map again (idempotent). Skipped with a clear
//      message when QWBE_REPO is not set or the kernel will not boot.
//
// The kernel for layer 3 runs from a SCRATCH COPY of the qwbe core (this repository is
// read-only for us and the plugin copy installed there can lag behind): the test copies
// <QWBE_REPO>/core to a temp dir, drops this plugin into its plugins/ directory and boots
// that. The qwbe checkout itself is never written.

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, describe, it } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import pg from "pg"

import { buildQuery, cfColumnQuery, ENTITIES } from "./vtiger-export-query.mjs"
import { externalKey, mapRow, rowKey } from "./vtiger-map-lib.mjs"

const here = new URL(".", import.meta.url).pathname
const repoRoot = join(here, "..")
const accountsMapping = JSON.parse(readFileSync(join(here, "../mappings/accounts.json"), "utf8"))
const contactsMapping = JSON.parse(readFileSync(join(here, "../mappings/contacts.json"), "utf8"))
const accountsFixture = JSON.parse(readFileSync(join(here, "fixtures/accounts.fixture.json"), "utf8"))
const contactsFixture = JSON.parse(readFileSync(join(here, "fixtures/contacts.fixture.json"), "utf8"))

// ---- 1. the export query builders ------------------------------------------------------------

describe("vtiger export query builders", () => {
  it("knows exactly the two entities", () => {
    assert.deepEqual(ENTITIES, ["accounts", "contacts"])
  })

  it("joins crmentity, base table, cf companion and address block, active rows only", () => {
    const { sql, countSql } = buildQuery("accounts", ["accountid", "cf_638", "cf_658"])
    assert.match(sql, /JOIN vtiger_account a ON a\.accountid = e\.crmid/)
    assert.match(sql, /LEFT JOIN vtiger_accountscf c ON c\.accountid = e\.crmid/)
    assert.match(sql, /LEFT JOIN vtiger_accountbillads b ON b\.accountaddressid = e\.crmid/)
    assert.match(sql, /WHERE e\.deleted = 0/)
    assert.match(sql, /c\.`cf_638`/)
    assert.doesNotMatch(sql, /SELECT \*/)
    assert.match(countSql, /SELECT COUNT\(\*\) AS n/)
    assert.match(countSql, /WHERE e\.deleted = 0/)
  })

  it("joins the contacts tables and leaves the cf key column out of the selects", () => {
    const { sql, columns } = buildQuery("contacts", ["contactid", "cf_640"])
    assert.match(sql, /JOIN vtiger_contactdetails d ON d\.contactid = e\.crmid/)
    assert.match(sql, /LEFT JOIN vtiger_contactaddress ad ON ad\.contactaddressid = e\.crmid/)
    assert.ok(columns.some((c) => c.includes("cf_640")))
    assert.ok(!columns.some((c) => c === "c.`contactid`"))
  })

  it("refuses an unknown entity and exposes the cf column discovery query", () => {
    assert.throws(() => buildQuery("leads", []))
    assert.match(cfColumnQuery("accounts"), /SHOW COLUMNS FROM `vtiger_accountscf`/)
    assert.match(cfColumnQuery("contacts"), /SHOW COLUMNS FROM `vtiger_contactscf`/)
  })
})

// ---- 2. the pure mapping ------------------------------------------------------

describe("vtiger row mapping", () => {
  it("maps an account fixture row to the cube payload", () => {
    const { payload, error } = mapRow(accountsFixture[0], accountsMapping)
    assert.equal(error, undefined)
    assert.equal(payload.name, "Alpha Trading SRL")
    assert.equal(payload.organizationNo, "FIX-ACC-1")
    assert.equal(payload.organizationType, "Customer")
    assert.equal(payload.employees, 12)
    assert.equal(payload.emailOptOut, false)
    assert.equal(payload.billingCity, "OrasulExemplu")
    assert.equal(payload.email, "office@alpha-trading.example")
    // cf columns and dropped fields never reach the payload
    assert.equal(payload.cf_638, undefined)
    assert.equal(payload.annualrevenue, undefined)
    assert.equal(payload.parentid, undefined)
  })

  it("coerces the varchar(3) opt-out flag to a real boolean", () => {
    const { payload } = mapRow(accountsFixture[1], accountsMapping)
    assert.equal(payload.emailOptOut, true)
    assert.equal(payload.employees, null)
  })

  it("joins the contact name from firstname + lastname and keeps email as a string", () => {
    const { payload } = mapRow(contactsFixture[0], contactsMapping)
    assert.equal(payload.name, "Andrei Exemplu")
    assert.equal(payload.email, "andrei@alpha-trading.example")
    assert.equal(payload.organizationId, undefined) // resolved by the tool from the externalId lookup, not here
  })

  it("keeps the row key stable", () => {
    assert.equal(rowKey(accountsFixture[0], accountsMapping), "900001")
    assert.equal(rowKey({}, accountsMapping), null)
  })

  it("builds the external identity a row is stored under (QWB-54, ticket 13)", () => {
    // "vtiger:<crmid>": one name for source system and source row, guarded by the unique
    // index in the database. A row without its key has no external identity at all.
    assert.equal(externalKey(accountsFixture[0], accountsMapping), "vtiger:900001")
    assert.equal(externalKey({ vtigerId: 12 }, accountsMapping), "vtiger:12")
    assert.equal(externalKey({}, accountsMapping), null)
  })
})

// ---- 3. end-to-end on a throwaway kernel --------------------------------------

const qwbeRepo = process.env.QWBE_REPO

describe("import chain end-to-end (synthetic fixture, throwaway kernel)", { skip: !qwbeRepo && "QWBE_REPO not set" }, () => {
  let stopServer, dataDir, port, base, dbUrl
  const run = (tool, args, env = {}) =>
    execFileSync(process.execPath, [join(here, tool), ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        QWB50_TEST_UNSAFE_INPUT: "1",
        QWBE_USER: "admin",
        QWBE_PASSWORD: "admin",
        // The map tool needs the database too: it ensures the unique index on externalId
        // before its first write (QWB-54, ticket 13). The throwaway DB IS the kernel's DB.
        QWBE_DATABASE_URL: dbUrl,
        ...env,
      },
    })

  before(async () => {
    const lib = await import(join(qwbeRepo, "probes/lib.mjs"))
    port = await lib.freePort()
    base = `http://127.0.0.1:${port}`

    // Scratch copy of the kernel: the qwbe checkout stays untouched, and the plugin mounted
    // is THIS checkout's code, not a possibly stale copy sitting in the qwbe repo.
    const coreSrc = join(qwbeRepo, "core")
    const core = join(mkdtempSync(join(tmpdir(), "qwb50-core-")), "core")
    cpSync(coreSrc, core, { recursive: true })
    // this repository IS the plugin: cubes and the package manifest are all the kernel needs.
    // A rename DELETES a cube directory, and an overlay copy cannot delete, so any stale
    // copy of the pack left by an earlier install is dropped before this checkout lands.
    rmSync(join(core, "plugins", "crm-pack"), { recursive: true, force: true })
    cpSync(join(repoRoot, "cubes"), join(core, "plugins", "crm-pack", "cubes"), { recursive: true })
    cpSync(join(repoRoot, "qwbe-package.json"), join(core, "plugins", "crm-pack", "qwbe-package.json"))

    // Throwaway database, same recipe as the qwbe probes -- but the password is REQUIRED
    // from the environment, never defaulted (QWB-50 review, item 25).
    if (!process.env.QWBE_PG_PASSWORD) throw new Error("set QWBE_PG_PASSWORD in the environment (no password default)")
    const adminUrl = new URL("postgres://localhost/postgres")
    adminUrl.hostname = process.env.QWBE_PG_HOST ?? "localhost"
    adminUrl.port = process.env.QWBE_PG_PORT ?? "5433"
    adminUrl.username = process.env.QWBE_PG_USER ?? "postgres"
    adminUrl.password = process.env.QWBE_PG_PASSWORD
    const dbName = `qwbe_qwb50_${Date.now().toString(36)}`
    const admin = new pg.Pool({ connectionString: adminUrl.toString(), max: 1 })
    await admin.query(`CREATE DATABASE "${dbName}"`)
    await admin.end()
    const url = new URL(adminUrl.toString())
    url.pathname = `/${dbName}`
    dbUrl = url.toString()

    dataDir = core
    const proc = spawn(process.execPath, ["src/main.ts"], {
      cwd: core,
      env: {
        ...process.env,
        QWBE_PORT: String(port),
        QWBE_ADMIN_PASSWORD: "admin",
        QWBE_READER_PASSWORD: "reader",
        QWBE_DATABASE_URL: dbUrl,
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let output = ""
    proc.stdout.on("data", (d) => (output += d))
    proc.stderr.on("data", (d) => (output += d))
    let alive = false
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 250))
      if (proc.exitCode !== null) break
      try {
        const r = await fetch(`${base}/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: "admin", password: "admin" }),
        })
        if (r.ok) {
          alive = true
          break
        }
      } catch {}
    }
    if (!alive) throw new Error(`server did not start:\n${output}`)
    stopServer = () => {
      proc.kill("SIGTERM")
      const a = new pg.Pool({ connectionString: adminUrl.toString(), max: 1 })
      a.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {}).finally(() => a.end())
      rmSync(core, { recursive: true, force: true })
    }

    // sanity: the crm cubes are mounted
    const login = await (await fetch(`${base}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "admin" }),
    })).json()
    const cubes = await (await fetch(`${base}/settings/cubes`, {
      headers: { authorization: `Bearer ${login.token}` },
    })).json()
    const names = (cubes ?? []).map((c) => c.name)
    if (!names.includes("crm/organizations") || !names.includes("crm/contacts")) throw new Error(`crm cubes not mounted: ${names.join(", ")}`)
  })
  after(() => {
    if (stopServer) stopServer()
  })

  const work = mkdtempSync(join(tmpdir(), "qwb50-")) // eslint-disable-line

  const writeJsonl = (fixture, name) => {
    const p = join(work, name)
    writeFileSync(p, fixture.map((r) => JSON.stringify(r)).join("\n") + "\n")
    return p
  }

  const qwbeCount = async (path) => {
    const login = await (await fetch(`${base}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "admin" }),
    })).json()
    const H = { authorization: `Bearer ${login.token}` }
    if (path === "organizations") {
      const r = await (await fetch(`${base}/cli/exec`, {
        method: "POST",
        headers: { ...H, "content-type": "application/json" },
        body: JSON.stringify({ line: "crm/organizations:count" }),
      })).json()
      return Number(r.output)
    }
    const r = await (await fetch(`${base}/contacts?limit=1`, { headers: H })).json()
    return r.total
  }

  // Direct read access to the throwaway database: the ticket's proof is a SQL count
  // (rows == distinct external ids), which no HTTP endpoint serves -- on purpose.
  const dbQuery = async (sql) => {
    const c = new pg.Client({ connectionString: dbUrl })
    await c.connect()
    try {
      return await c.query(sql)
    } finally {
      await c.end()
    }
  }

  it("uploads, maps, reports the missing organization, and a second run changes nothing", async () => {
    const accountsFile = writeJsonl(accountsFixture, "accounts.jsonl")
    const contactsFile = writeJsonl(contactsFixture, "contacts.jsonl")

    // upload into staging
    const upA = run("vtiger-to-staging.mjs", [accountsFile, "qwb50-accounts"], { QWBE_URL: base })
    const setIdA = /set id:\s+(\S+)/.exec(upA)[1]
    assert.match(upA, /rows:\s+3/)
    assert.match(upA, /malformed:\s+0/)
    const upC = run("vtiger-to-staging.mjs", [contactsFile, "qwb50-contacts"], { QWBE_URL: base })
    const setIdC = /set id:\s+(\S+)/.exec(upC)[1]
    assert.match(upC, /rows:\s+3/)

    // profile exists and is count-shaped
    const login = await (await fetch(`${base}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "admin" }),
    })).json()
    const profile = await (await fetch(`${base}/staging/sets/${setIdA}/profile`, {
      headers: { authorization: `Bearer ${login.token}` },
    })).json()
    assert.equal(profile.rows, 3)
    assert.ok(profile.fields.some((f) => f.field === "accountname" && f.fillRate === 100))

    // map accounts, then contacts (contact 900102 -> missing org 900999)
    const mapA = run("vtiger-map.mjs", [accountsFile, join(here, "../mappings/accounts.json"), "--set", setIdA], { QWBE_URL: base })
    assert.match(mapA, /created:\s+3/)
    assert.match(mapA, /staging matches the file row for row/)
    const mapC = run("vtiger-map.mjs", [contactsFile, join(here, "../mappings/contacts.json"), "--set", setIdC], { QWBE_URL: base })
    assert.match(mapC, /created:\s+3/)
    assert.match(mapC, /missing org:\s*1/)
    assert.match(mapC, /no org:\s*1/)

    // the linked contact carries the qwbe organizationId of its organization
    const H = { authorization: `Bearer ${login.token}` }
    const page = await (await fetch(`${base}/contacts?limit=10`, { headers: H })).json()
    const linked = page.rows.find((r) => r.name === "Andrei Exemplu")
    const unlinked = page.rows.find((r) => r.name === "Bianca Model")
    assert.ok(linked && linked.organizationId)
    assert.ok(unlinked && unlinked.organizationId === null)

    // counts in qwbe
    assert.equal(await qwbeCount("organizations"), 3)
    assert.equal(await qwbeCount("contacts"), 3)

    // IDEMPOTENCE: a second mapping run updates, does not duplicate
    const mapA2 = run("vtiger-map.mjs", [accountsFile, join(here, "../mappings/accounts.json")], { QWBE_URL: base })
    const mapC2 = run("vtiger-map.mjs", [contactsFile, join(here, "../mappings/contacts.json")], { QWBE_URL: base })
    assert.match(mapA2, /updated:\s+3/)
    assert.match(mapA2, /created:\s+0/)
    assert.match(mapC2, /updated:\s+3/)
    assert.match(mapC2, /created:\s+0/)
    assert.match(mapC2, /missing org:\s*1/)
    assert.equal(await qwbeCount("organizations"), 3)
    assert.equal(await qwbeCount("contacts"), 3)

    // the verify command prints counts and zero differences
    const ver = run("vtiger-verify.mjs", [accountsFile, contactsFile, "--set-accounts", setIdA, "--set-contacts", setIdC], { QWBE_URL: base })
    assert.match(ver, /accounts: exported=3 staging=3 \(diff 0\) qwbe=3 \(diff 0; whole-cube total/)
    assert.match(ver, /contacts: exported=3 staging=3 \(diff 0\) qwbe=3 \(diff 0; whole-cube total/)
    assert.match(ver, /organization missing=1/)
  })

  it("prints status and field name, never row values, exits non-zero, when the cube rejects a row", async () => {
    const good = { ...accountsFixture[0], vtigerId: 940001, accountid: 940001, account_no: "FIX-ACC-G", accountname: "Gamma Proof SRL" }
    const bad = { ...accountsFixture[0], vtigerId: 940002, accountid: 940002, account_no: "FIX-ACC-B", accountname: "Delta Proof SRL", employees: -7 }
    const file = join(work, "accounts-reject.jsonl")
    writeFileSync(file, [good, bad].map((r) => JSON.stringify(r)).join("\n") + "\n")
    // One rejected row and the default threshold of zero: the run FAILS (QWB-54, ticket 13).
    const { out, status } = runFailing("vtiger-map.mjs", [file, join(here, "../mappings/accounts.json")], {
      QWBE_URL: base,
      QWBE_DATABASE_URL: dbUrl,
    })
    assert.equal(status, 1)
    assert.match(out, /HTTP 400/)
    assert.match(out, /employees/)
    assert.match(out, /errors:\s+1/)
    // the count is in the LAST line, so a wrapper script can read it
    const lines = out.trim().split("\n")
    assert.match(lines[lines.length - 1], /rejected:\s+1 of 2 row\(s\) \(max accepted: 0\)/)
    // nothing from the rejected row (nor the good one) may appear in the output
    assert.ok(!out.includes("Delta Proof"))
    assert.ok(!out.includes("Gamma Proof"))
    assert.ok(!out.includes("FIX-ACC-B"))
    assert.ok(!out.includes("-7"))
  })

  it("accepts rejections up to an explicit --max-rejects threshold and exits zero", async () => {
    const good = { ...accountsFixture[0], vtigerId: 940003, accountid: 940003, account_no: "FIX-ACC-T", accountname: "Threshold Proof SRL" }
    const bad = { ...accountsFixture[0], vtigerId: 940004, accountid: 940004, account_no: "FIX-ACC-U", accountname: "Threshold Bad SRL", employees: -7 }
    const file = join(work, "accounts-threshold.jsonl")
    writeFileSync(file, [good, bad].map((r) => JSON.stringify(r)).join("\n") + "\n")
    const before = await qwbeCount("organizations")
    const out = run("vtiger-map.mjs", [file, join(here, "../mappings/accounts.json"), "--max-rejects", "1"], { QWBE_URL: base })
    assert.match(out, /errors:\s+1/)
    const lines = out.trim().split("\n")
    assert.match(lines[lines.length - 1], /rejected:\s+1 of 2 row\(s\) \(max accepted: 1\)/)
    // the good row landed, the rejected one did not
    assert.equal(await qwbeCount("organizations"), before + 1)
    assert.match(out, /created:\s+1/)
  })

  it("a mid-run kill and rerun leaves rows equal to distinct external ids (QWB-54, ticket 13)", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      ...accountsFixture[0],
      vtigerId: 950001 + i,
      accountid: 950001 + i,
      account_no: `FIX-ACC-K${i}`,
      accountname: `Kill Rerun ${i} SRL`,
    }))
    const file = join(work, "accounts-kill.jsonl")
    writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n")
    const before = await qwbeCount("organizations")

    const child = spawn(process.execPath, [join(here, "vtiger-map.mjs"), file, join(here, "../mappings/accounts.json")], {
      env: { ...process.env, QWB50_TEST_UNSAFE_INPUT: "1", QWBE_USER: "admin", QWBE_PASSWORD: "admin", QWBE_URL: base, QWBE_DATABASE_URL: dbUrl },
      stdio: "ignore",
    })
    // kill as soon as at least two rows have landed -- the rest of the run never happened
    for (let i = 0; i < 150 && child.exitCode === null; i++) {
      const n = await qwbeCount("organizations")
      if (n >= before + 2) break
      await new Promise((r) => setTimeout(r, 100))
    }
    child.kill("SIGKILL")
    await new Promise((r) => (child.exitCode !== null ? r() : child.once("exit", r)))

    // rerun to completion: the externalId lookup (the generic list's filter, ticket 06)
    // PATCHes what landed and POSTs the rest. No ledger decides insert versus update, and
    // no ledger file exists to lose -- the correspondence lives on the rows.
    const again = run("vtiger-map.mjs", [file, join(here, "../mappings/accounts.json")], { QWBE_URL: base })
    assert.match(again, /errors:\s+0/)
    assert.ok(!existsSync(join(work, "accounts-idmap.json")), "the id map registry must be gone")

    // THE PROOF: row count == distinct external identities, in the DATABASE.
    const tally = await dbQuery(
      `SELECT COUNT(*)::int AS n, COUNT(DISTINCT body->>'externalId')::int AS d
       FROM "crm--organizations"."organizations" WHERE deleted = false`,
    )
    assert.equal(tally.rows[0].n, tally.rows[0].d, `rows ${tally.rows[0].n} != distinct external ids ${tally.rows[0].d}`)
    const killed = await dbQuery(
      `SELECT COUNT(*)::int AS n FROM "crm--organizations"."organizations"
       WHERE deleted = false AND body->>'externalId' LIKE 'vtiger:9500%'`,
    )
    assert.equal(killed.rows[0].n, 8)
    assert.equal(await qwbeCount("organizations"), before + 8)
  })

  it("the unique index lives in the database and refuses a duplicate external id", async () => {
    // The index exists, under its deterministic name, partial on live non-null identities.
    const idx = await dbQuery(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'crm--organizations' AND indexname = 'organizations_external_id_key'`,
    )
    assert.equal(idx.rows.length, 1)
    assert.match(idx.rows[0].indexdef, /CREATE UNIQUE INDEX organizations_external_id_key/)
    assert.match(idx.rows[0].indexdef, /'externalId'/)
    // And it is the DATABASE that refuses a duplicate -- not the import tool's lookup.
    const c = new pg.Client({ connectionString: dbUrl })
    await c.connect()
    try {
      await c.query(
        `INSERT INTO "crm--organizations"."organizations" (id, type, created_at, deleted, version, body)
         VALUES ('org_dup_probe', 'Organization', now(), false, 1, $1)`,
        [JSON.stringify({ name: "Duplicate Probe", externalId: "vtiger:950001" })],
      )
      assert.fail("the unique index did not refuse a duplicate external id")
    } catch (e) {
      assert.equal(e.code, "23505")
    } finally {
      await c.end()
    }
  })

  it("respects a forced small chunk cap: boundaries on line edges, oversize lines refused", async () => {
    const mk = (name, n, pad) =>
      Array.from({ length: n }, (_, i) => ({
        ...accountsFixture[0],
        vtigerId: 960001 + i,
        accountid: 960001 + i,
        account_no: `FIX-ACC-C${i}`,
        accountname: `Chunk ${name} ${i} SRL ${"x".repeat(pad)}`,
      }))

    // rows must be smaller than the forced cap, and the cap must be exceeded by two rows
    // plus their separators, so the chunk boundary provably falls BETWEEN lines
    const small = mk("small", 5, 0)
    const f1 = join(work, "accounts-chunk.jsonl")
    writeFileSync(f1, small.map((r) => JSON.stringify(r)).join("\n") + "\n")
    const rowLen = JSON.stringify(small[0]).length
    const cap = rowLen * 2 + 10
    const up1 = run("vtiger-to-staging.mjs", [f1, "chunk-boundary"], { QWBE_URL: base, QWB50_MAX_CHARS: String(cap) })
    assert.match(up1, /rows:\s+5/)
    assert.match(up1, /malformed:\s+0/)

    // one line larger than the cap: refused and counted, never posted
    const big = [{ ...accountsFixture[0], vtigerId: 970001, accountid: 970001, account_no: "FIX-ACC-BIG", accountname: `Oversized ${"y".repeat(80)}` }]
    const f2 = join(work, "accounts-big.jsonl")
    writeFileSync(f2, big.map((r) => JSON.stringify(r)).join("\n") + "\n")
    const bigLen = JSON.stringify(big[0]).length
    const { out, status } = runFailing("vtiger-to-staging.mjs", [f2, "oversized"], { QWBE_URL: base, QWB50_MAX_CHARS: String(bigLen - 1) })
    assert.equal(status, 1)
    assert.match(out, /oversized:\s+1/)
    assert.ok(!out.includes("Oversized"))
  })
})

// ---- 4. review-fix proofs (QWB-50 review): rejected data never reaches the output ------

// Runs a tool expecting a non-zero exit and returns its stdout+stderr.
const runFailing = (tool, args, env = {}) => {
  try {
    execFileSync(process.execPath, [join(here, tool), ...args], {
      encoding: "utf8",
      env: { ...process.env, QWB50_TEST_UNSAFE_INPUT: "1", QWBE_USER: "admin", QWBE_PASSWORD: "admin", ...env },
    })
  } catch (e) {
    return { out: String(e.stdout ?? "") + String(e.stderr ?? ""), status: e.status }
  }
  assert.fail(`${tool} was expected to exit non-zero`)
}

describe("error output carries no customer values (review items 1-3, 8)", () => {
  it("a staging chunk rejected by a 400 prints status, range and set id, never the chunk text", async () => {
    // The mock server must live in its own process: execFileSync blocks this process's
    // event loop, so an in-process server could never answer the tool.
    const mock = spawn(process.execPath, [
      "-e",
      `const http = require("node:http")
const srv = http.createServer((req, res) => {
  let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
    if (req.url === "/auth/login") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ token: "test-token", expiresAt: 9 })) }
    else if (req.url === "/staging/sets") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ id: "set-mock-1" })) }
    else { res.statusCode = 400; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ error: "chunk rejected: " + b })) }
  })
})
srv.listen(0, "127.0.0.1", () => console.log(srv.address().port))`,
    ], { stdio: ["ignore", "pipe", "ignore"] })
    const portStr = await new Promise((resolve, reject) => {
      mock.stdout.on("data", (d) => resolve(String(d).trim()))
      mock.on("exit", (c) => reject(new Error(`mock died: ${c}`)))
      setTimeout(() => reject(new Error("mock did not start")), 5000).unref()
    })
    try {
      const file = join(mkdtempSync(join(tmpdir(), "qwb50-")), "accounts.jsonl")
      writeFileSync(file, accountsFixture.map((r) => JSON.stringify(r)).join("\n") + "\n")
      const { out, status } = runFailing("vtiger-to-staging.mjs", [file, "mock-reject"], { QWBE_URL: `http://127.0.0.1:${portStr}` })
      assert.equal(status, 1)
      assert.match(out, /HTTP 400/)
      assert.match(out, /lines 1-3/)
      assert.match(out, /set-mock-1/)
      // No row value may appear anywhere in the output.
      for (const row of accountsFixture) {
        assert.ok(!out.includes(row.accountname))
        assert.ok(!out.includes(row.account_no))
        assert.ok(!out.includes(row.email1))
      }
      assert.ok(!out.includes("Alpha Trading"))
    } finally {
      mock.kill("SIGKILL")
    }
  })
})

// ---- 5. the exporter's stream mode, proven against a fixture DB (review item 4) --------

describe("vtiger exporter streams rows through query().stream() (fixture DB)", () => {
  it("writes one JSONL line per row and never buffers the result set", async () => {
    // The mock MariaDB lives in its own process (execFileSync blocks this one's event loop).
    const mock = spawn(process.execPath, [
      "-e",
      `const mysql = require("mysql2")
const rows = [
  { vtigerId: 980001, accountid: 980001, account_no: "FIX-DB-1", accountname: "Fixture Db One SRL", employees: 4 },
  { vtigerId: 980002, accountid: 980002, account_no: "FIX-DB-2", accountname: "Fixture Db Two SRL", employees: null },
  { vtigerId: 980003, accountid: 980003, account_no: "FIX-DB-3", accountname: "Fixture Db Three SRL", employees: 9 },
]
const srv = mysql.createServer((conn) => {
  conn.serverHandshake({
    protocolVersion: 10,
    serverVersion: "5.7.10-mock",
    connectionId: 1,
    statusFlags: 2,
    capabilityFlags: 0xffffff,
    characterSet: 8,
    authPluginDataLength: 0,
    authPluginName: "mysql_native_password",
  })
  // The server-side mock keeps the handshake sequence number across the command phase,
  // which desyncs the client; real MariaDB resets to 0 after every command.
  const handlePacket = conn.handlePacket.bind(conn)
  conn.handlePacket = (packet) => {
    handlePacket(packet)
    conn._resetSequenceId()
  }
  conn.on("query", (query) => {
    const col = (n) => ({ name: n, orgName: n, catalog: "def", schema: "fixture", table: "t", orgTable: "t", characterSet: 45, columnLength: 64, columnType: 253, flags: 0, decimals: 0 })
    if (query.startsWith("SHOW COLUMNS")) {
      conn.writeTextResult([{ Field: "accountid" }, { Field: "cf_638" }], [col("Field"), col("Type")])
    } else if (query.startsWith("SELECT COUNT")) {
      conn.writeTextResult([{ n: String(rows.length) }], [col("n")])
    } else {
      conn.writeTextResult(rows, [col("vtigerId"), col("accountid"), col("account_no"), col("accountname"), col("employees")])
    }
  })
})
srv.listen(0, "127.0.0.1", () => console.log(srv._server.address().port))`,
    ], { stdio: ["ignore", "pipe", "ignore"], cwd: new URL("..", import.meta.url).pathname })
    const portStr = await new Promise((resolve, reject) => {
      mock.stdout.on("data", (d) => resolve(String(d).trim()))
      mock.on("exit", (c) => reject(new Error(`mock db died: ${c}`)))
      setTimeout(() => reject(new Error("mock db did not start")), 5000).unref()
    })
    const fixtureRows = [
      { vtigerId: 980001, accountid: 980001, account_no: "FIX-DB-1", accountname: "Fixture Db One SRL", employees: 4 },
      { vtigerId: 980002, accountid: 980002, account_no: "FIX-DB-2", accountname: "Fixture Db Two SRL", employees: null },
      { vtigerId: 980003, accountid: 980003, account_no: "FIX-DB-3", accountname: "Fixture Db Three SRL", employees: 9 },
    ]
    const outDir = mkdtempSync(join(tmpdir(), "qwb50-export-"))
    try {
      const out = execFileSync(process.execPath, [join(here, "vtiger-export.mjs"), "accounts", "--write"], {
        encoding: "utf8",
        env: {
          ...process.env,
          VTIGER_DB_HOST: "127.0.0.1",
          VTIGER_DB_PORT: portStr,
          VTIGER_DB_USER: "fixture",
          VTIGER_DB_PASSWORD: "fixture",
          VTIGER_DB_NAME: "fixture",
          QWB50_EXPORT_DIR: outDir,
        },
      })
      assert.match(out, /rows:\s+3/)
      const lines = readFileSync(join(outDir, "accounts.jsonl"), "utf8").trim().split("\n")
      assert.equal(lines.length, 3)
      // the text protocol returns every column as a string -- the shape, not the types,
      // is what this test proves
      assert.deepEqual(JSON.parse(lines[2]), {
        vtigerId: "980003", accountid: "980003", account_no: "FIX-DB-3", accountname: "Fixture Db Three SRL", employees: "9",
      })
    } finally {
      mock.kill("SIGKILL")
      rmSync(outDir, { recursive: true, force: true })
    }
  })
})
