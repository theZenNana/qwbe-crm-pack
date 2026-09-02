#!/usr/bin/env node
// Maps an exported vtiger JSONL file into crm/organizations / crm/contacts through the qwbe
// API. The staging set (optional --set) is the
// per-field profile step and the row-count cross-check; the staging cube exposes no row-read
// endpoint, so the rows come from the same export file that fed the set.
//
// Idempotency: every row carries its external identity ON the row --
// `externalId: "vtiger:<vtigerId>"` -- and the DATABASE holds a unique index on it
// (tools/ensure-external-id-index.mjs). The run looks each row up first through the generic
// list's `?externalId=` filter and POSTs only when it is missing; a row
// that exists is PATCHed. There is NO ledger file to lose: a run killed at half and rerun
// ends with exactly one row per external identity, because uniqueness lives in the database,
// not in what a file managed to write down.
//
// Contacts: organizationId comes from vtiger's own foreign key (contactdetails.accountid),
// resolved by looking the organization up in qwbe through the same externalId filter (cached
// in memory for the run; the durable correspondence is the externalId on the row, not this
// map). An organization that is not in qwbe is COUNTED and reported (count only, never the
// id); the contact gets organizationId null and nothing is invented.
//
// Exit code: 0 when every row was imported; 1 when rows were REJECTED (cube rejections,
// mapping errors, rows without their external key) and the count exceeds --max-rejects
// (default 0 -- any rejection fails the run). The LAST output line always carries the
// rejected count, so a wrapper script can read it. No row value is ever printed -- only
// counts, HTTP statuses and schema field names.
//
// Environment: QWBE_URL, QWBE_USER, QWBE_PASSWORD (all required; the tool exits 2 without
// them rather than silently authenticating as a default user). A database connection
// (QWBE_DATABASE_URL, or QWBE_PG_PASSWORD plus optional QWBE_PG_HOST/PORT/USER) is required
// too: the unique index on externalId must be in place before the first row is written --
// a plugin cube cannot create it (the kernel's per-cube role holds DML only), so this tool
// does, as the database user that owns the cube tables.
//
// Usage: node tools/vtiger-map.mjs <file.jsonl> <mappings/xxx.json> [--set <stagingSetId>] [--max-rejects <n>]

import { createReadStream, readFileSync } from "node:fs"
import { createInterface } from "node:readline"
import pg from "pg"
import { dbUrl } from "./db-url.mjs"
import { ensureExternalIdIndex, indexName, schemaOf } from "./ensure-external-id-index.mjs"
import { externalKey, mapRow } from "./vtiger-map-lib.mjs"

const argv = process.argv.slice(2)
const VALUE_FLAGS = new Set(["--set", "--max-rejects"])
const flagValue = (name) => {
  const i = argv.indexOf(name)
  return i > -1 ? argv[i + 1] : undefined
}
const positional = []
for (let i = 0; i < argv.length; i++) {
  if (VALUE_FLAGS.has(argv[i])) {
    i++
    continue
  }
  if (!argv[i].startsWith("--")) positional.push(argv[i])
}
const [file, mappingPath] = positional
const setId = flagValue("--set")
const maxRejectsRaw = flagValue("--max-rejects")
const maxRejects = maxRejectsRaw === undefined ? 0 : Number(maxRejectsRaw)
if (!file || !mappingPath || !Number.isInteger(maxRejects) || maxRejects < 0) {
  console.error("usage: node tools/vtiger-map.mjs <file.jsonl> <mapping.json> [--set <setId>] [--max-rejects <n>]")
  process.exit(2)
}

// No customer-derived file may ever land inside the repository:
// the input must live under the export directory, outside git. Tests opt out explicitly.
const EXPORT_DIR = "/home/lucian/WebProjects/vtiger-export"
if (process.env.QWB50_TEST_UNSAFE_INPUT !== "1" && !file.startsWith(EXPORT_DIR + "/")) {
  console.error(`refusing input outside ${EXPORT_DIR}: customer files never enter the repository`)
  process.exit(2)
}

for (const name of ["QWBE_USER", "QWBE_PASSWORD"]) {
  if (!process.env[name]) {
    console.error(`set ${name} in the environment (no default credentials)`)
    process.exit(2)
  }
}
const db = dbUrl()
if (!db) {
  console.error(
    "set QWBE_DATABASE_URL, or QWBE_PG_PASSWORD (plus optional QWBE_PG_HOST/PORT/USER): " +
      "the unique index on externalId must be ensured in the database before any row is written",
  )
  process.exit(2)
}

const base = (process.env.QWBE_URL ?? "http://127.0.0.1:4500").replace(/\/$/, "")
const call = async (path, options = {}) => {
  const r = await fetch(base + path, options)
  const text = await r.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: r.status, body, ok: r.status < 300 }
}

const login = await call("/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    username: process.env.QWBE_USER,
    password: process.env.QWBE_PASSWORD,
  }),
})
if (!login.ok) throw new Error(`login failed: ${login.status}`)
const H = () => ({ authorization: `Bearer ${login.body.token}`, "content-type": "application/json" })

const mapping = JSON.parse(readFileSync(mappingPath, "utf8"))
if (!mapping.cube || !mapping.table) {
  console.error('the mapping must declare "cube" and "table": the unique index lives on the cube\'s own table')
  process.exit(2)
}

// The kernel creates the cube's table on first use; one list request is enough, and it also
// proves the read permission before anything is written.
const touch = await call(`${mapping.route}?limit=1`, { headers: H() })
if (!touch.ok) {
  console.error(`cannot read ${mapping.route}: HTTP ${touch.status} -- the list request creates the table the index needs`)
  process.exit(1)
}

// The one database write this tool ever makes: the partial unique index on externalId.
const pool = new pg.Pool({ connectionString: db, max: 1 })
let indexState
try {
  indexState = await ensureExternalIdIndex(pool, schemaOf(mapping.cube), mapping.table)
} catch (err) {
  console.error(`could not ensure the unique index on ${mapping.cube}: ${err.message}`)
  process.exit(1)
} finally {
  await pool.end()
}
console.log(`index:      ${schemaOf(mapping.cube)}.${mapping.table} (${indexName(mapping.table)}) ${indexState}`)

const tally = { created: 0, updated: 0, missingOrg: 0, noOrg: 0, errors: 0, skipped: 0, skippedNoKey: 0 }
let seen = 0
let firstError = null

// Error reporting: the kernel adds no error mapping, so a rejected payload can come back
// embedded in the Effect decode error. For CREATE/PATCH failures only the HTTP status and
// the schema field path(s) the body's decode error names are printed -- field paths are
// extracted structurally (the ["field"] positions of the decode error); if none can be
// extracted, only the status is printed. LOOKUP failures print the status alone: their
// bodies are page payloads, not decode errors, and no part of a row may ever be echoed.
const fieldPaths = (body) => {
  const text = typeof body === "string" ? body : JSON.stringify(body ?? "")
  const names = [...text.matchAll(/\[\\?"([A-Za-z0-9_]+)\\?"\]/g)].map((m) => m[1])
  return [...new Set(names)]
}
const describeFailure = (verb, status, body) => {
  const fields = fieldPaths(body)
  return `${verb}: HTTP ${status}${fields.length > 0 ? ` (field: ${fields.join(", ")})` : ""}`
}
const describeStatus = (verb, status) => `${verb}: HTTP ${status}`

// Organization lookups of one run, cached in memory only: vtiger accountid -> qwbe
// organization id, or null for "looked up, not there" (distinct from "not looked up yet").
// The durable correspondence is the externalId on the rows; this cache only spares the
// repeated HTTP round trips for the many contacts of one organization.
const ORG_ROUTE = "/organizations" // one name everywhere
const orgCache = new Map()
const resolveOrganization = async (orgKey) => {
  const k = String(orgKey)
  if (!orgCache.has(k)) {
    const r = await call(`${ORG_ROUTE}?externalId=${encodeURIComponent(`vtiger:${k}`)}&limit=1`, { headers: H() })
    if (!r.ok) return { error: r.status }
    if ((r.body.total ?? 0) > 1) return { ambiguous: true }
    orgCache.set(k, r.body.rows?.[0]?.id ?? null)
  }
  return { id: orgCache.get(k) }
}

const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity })
for await (const line of rl) {
  if (line.trim() === "") continue
  let row
  try {
    row = JSON.parse(line)
  } catch {
    tally.errors++
    continue
  }
  seen++
  const externalId = externalKey(row, mapping)
  if (externalId === null) {
    // A row without its external key can never carry an externalId: POSTing it would
    // silently duplicate it on every rerun (still true under the
    // unique index -- the index only guards rows that HAVE their identity).
    tally.skippedNoKey++
    continue
  }
  const { payload, error } = mapRow(row, mapping)
  if (error || payload.name === null || payload.name === undefined || payload.name === "") {
    tally.skipped++
    continue
  }

  if (mapping.entity === "contacts") {
    const orgKey = row[mapping.accountKey]
    if (orgKey === undefined || orgKey === null || String(orgKey) === "0" || String(orgKey) === "") {
      tally.noOrg++
      payload.organizationId = null
    } else {
      const found = await resolveOrganization(orgKey)
      if (found.error !== undefined || found.ambiguous) {
        // A lookup that failed (or came back ambiguous) is not "the organization is
        // missing": the contact is not imported at all, so a rerun can decide it again
        // with full information instead of linking on a guess.
        tally.errors++
        if (!firstError)
          firstError = found.ambiguous
            ? "resolve organization: multiple rows share one externalId; refusing to guess"
            : describeStatus("resolve organization", found.error)
        continue
      }
      if (found.id) payload.organizationId = found.id
      else {
        // Counted, never quoted: a vtiger id is re-identifiable against the source DB.
        tally.missingOrg++
        payload.organizationId = null
      }
    }
  }

  const find = await call(`${mapping.route}?externalId=${encodeURIComponent(externalId)}&limit=1`, { headers: H() })
  if (!find.ok) {
    tally.errors++
    if (!firstError) firstError = describeStatus(`lookup ${mapping.entity}`, find.status)
    continue
  }
  if ((find.body.total ?? 0) > 1) {
    // Only a database that lost its unique index can answer this way; refuse to guess.
    tally.errors++
    if (!firstError) firstError = `${mapping.entity}: multiple rows share one externalId; refusing to guess`
    continue
  }
  const existing = find.body.rows?.[0]
  if (existing) {
    // The external identity never changes: the patch carries the domain fields only.
    const res = await call(`${mapping.route}/${existing.id}`, { method: "PATCH", headers: H(), body: JSON.stringify(payload) })
    if (res.ok) tally.updated++
    else if (res.status === 404) {
      // The row was deleted between the lookup and the patch: create it anew. If a
      // concurrent importer wins that POST, the unique index turns the loss into a
      // counted error -- visible, exit non-zero, never a silent duplicate.
      const created = await call(mapping.route, {
        method: "POST",
        headers: H(),
        body: JSON.stringify({ ...payload, externalId }),
      })
      if (created.ok) tally.created++
      else {
        tally.errors++
        if (!firstError) firstError = describeFailure(`recreate ${mapping.entity}`, created.status, created.body)
      }
    } else {
      tally.errors++
      if (!firstError) firstError = describeFailure(`update ${mapping.entity}`, res.status, res.body)
    }
  } else {
    const created = await call(mapping.route, {
      method: "POST",
      headers: H(),
      body: JSON.stringify({ ...payload, externalId }),
    })
    if (created.ok) tally.created++
    else {
      tally.errors++
      if (!firstError) firstError = describeFailure(`create ${mapping.entity}`, created.status, created.body)
    }
  }
}

console.log(`entity:     ${mapping.entity}`)
console.log(`rows seen:  ${seen}`)
console.log(`created:    ${tally.created}`)
console.log(`updated:    ${tally.updated}`)
if (mapping.entity === "contacts") {
  console.log(`no org:     ${tally.noOrg} (contact has no organization in vtiger)`)
  console.log(`missing org:${tally.missingOrg} (organization not in qwbe; organizationId set to null; count only, ids never printed)`)
}
console.log(`skipped:    ${tally.skipped} (empty required name or a mapping error)`)
console.log(`no key:     ${tally.skippedNoKey} (row without ${mapping.key}; never POSTed)`)
console.log(`errors:     ${tally.errors}`)
if (firstError) console.log(`first error: ${firstError}`)

if (setId) {
  const state = await call(`/staging/sets/${setId}`, { headers: H() })
  if (state.ok) {
    console.log(`staging:    set ${setId} holds ${state.body.rowCount} rows, ${state.body.malformedCount} malformed`)
    if (state.body.rowCount !== seen) console.log(`DIVERGENCE: staging ${state.body.rowCount} vs file ${seen} rows`)
    else console.log("staging matches the file row for row (count)")
  }
}

// The last line, always: how many rows the run refused, and the threshold it was judged by.
const rejected = tally.errors + tally.skipped + tally.skippedNoKey
console.log(`rejected:   ${rejected} of ${seen} row(s) (max accepted: ${maxRejects})`)
if (rejected > maxRejects) process.exitCode = 1
