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

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, describe, it } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import pg from "pg"

import { buildQuery, cfColumnQuery, ENTITIES } from "./vtiger-export-query.mjs"
import { mapRow, rowKey } from "./vtiger-map-lib.mjs"

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
    assert.equal(payload.accountNo, "FIX-ACC-1")
    assert.equal(payload.accountType, "Customer")
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
    assert.equal(payload.accountId, undefined) // resolved by the tool from the ledger, not here
  })

  it("keeps the row key stable", () => {
    assert.equal(rowKey(accountsFixture[0], accountsMapping), "900001")
    assert.equal(rowKey({}, accountsMapping), null)
  })
})

// ---- 3. end-to-end on a throwaway kernel --------------------------------------

const qwbeRepo = process.env.QWBE_REPO

describe("import chain end-to-end (synthetic fixture, throwaway kernel)", { skip: !qwbeRepo && "QWBE_REPO not set" }, () => {
  let stopServer, dataDir, port, base
  const run = (tool, args, env = {}) =>
    execFileSync(process.execPath, [join(here, tool), ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
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
    // this repository IS the plugin: cubes and the package manifest are all the kernel needs
    cpSync(join(repoRoot, "cubes"), join(core, "plugins", "crm-pack", "cubes"), { recursive: true })
    cpSync(join(repoRoot, "qwbe-package.json"), join(core, "plugins", "crm-pack", "qwbe-package.json"))

    // Throwaway database, same recipe as the qwbe probes.
    const adminUrl = new URL("postgres://localhost/postgres")
    adminUrl.hostname = process.env.QWBE_PG_HOST ?? "localhost"
    adminUrl.port = process.env.QWBE_PG_PORT ?? "5433"
    adminUrl.username = process.env.QWBE_PG_USER ?? "postgres"
    adminUrl.password = process.env.QWBE_PG_PASSWORD ?? "qwbe"
    const dbName = `qwbe_qwb50_${Date.now().toString(36)}`
    const admin = new pg.Pool({ connectionString: adminUrl.toString(), max: 1 })
    await admin.query(`CREATE DATABASE "${dbName}"`)
    await admin.end()
    const dbUrl = new URL(adminUrl.toString())
    dbUrl.pathname = `/${dbName}`

    dataDir = core
    const proc = spawn(process.execPath, ["src/main.ts"], {
      cwd: core,
      env: {
        ...process.env,
        QWBE_PORT: String(port),
        QWBE_ADMIN_PASSWORD: "admin",
        QWBE_READER_PASSWORD: "reader",
        QWBE_DATABASE_URL: dbUrl.toString(),
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
    if (!names.includes("crm/accounts") || !names.includes("crm/contacts")) throw new Error(`crm cubes not mounted: ${names.join(", ")}`)
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
    if (path === "accounts") {
      const r = await (await fetch(`${base}/cli/exec`, {
        method: "POST",
        headers: { ...H, "content-type": "application/json" },
        body: JSON.stringify({ line: "crm/accounts:count" }),
      })).json()
      return Number(r.output)
    }
    const r = await (await fetch(`${base}/contacts?limit=1`, { headers: H })).json()
    return r.total
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

    // the linked contact carries the qwbe accountId of its organization
    const H = { authorization: `Bearer ${login.token}` }
    const page = await (await fetch(`${base}/contacts?limit=10`, { headers: H })).json()
    const linked = page.rows.find((r) => r.name === "Andrei Exemplu")
    const unlinked = page.rows.find((r) => r.name === "Bianca Model")
    assert.ok(linked && linked.accountId)
    assert.ok(unlinked && unlinked.accountId === null)

    // counts in qwbe
    assert.equal(await qwbeCount("accounts"), 3)
    assert.equal(await qwbeCount("contacts"), 3)

    // IDEMPOTENCE: a second mapping run updates, does not duplicate
    const mapA2 = run("vtiger-map.mjs", [accountsFile, join(here, "../mappings/accounts.json")], { QWBE_URL: base })
    const mapC2 = run("vtiger-map.mjs", [contactsFile, join(here, "../mappings/contacts.json")], { QWBE_URL: base })
    assert.match(mapA2, /updated:\s+3/)
    assert.match(mapA2, /created:\s+0/)
    assert.match(mapC2, /updated:\s+3/)
    assert.match(mapC2, /created:\s+0/)
    assert.match(mapC2, /missing org:\s*1/)
    assert.equal(await qwbeCount("accounts"), 3)
    assert.equal(await qwbeCount("contacts"), 3)

    // the verify command prints counts and zero differences
    const ver = run("vtiger-verify.mjs", [accountsFile, contactsFile, "--set-accounts", setIdA, "--set-contacts", setIdC], { QWBE_URL: base })
    assert.match(ver, /accounts: exported=3 staging=3 \(diff 0\) qwbe=3 \(diff 0\)/)
    assert.match(ver, /contacts: exported=3 staging=3 \(diff 0\) qwbe=3 \(diff 0\)/)
    assert.match(ver, /organization missing=1/)
  })
})
