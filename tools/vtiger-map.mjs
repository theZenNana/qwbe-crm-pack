#!/usr/bin/env node
// Maps an exported vtiger JSONL file into crm/accounts / crm/contacts through the qwbe API
// (QWB-50). The staging set (optional --set) is the per-field profile step and the row-count
// cross-check; the staging cube exposes no row-read endpoint, so the rows come from the same
// export file that fed the set.
//
// Idempotency: the vtiger id of each row is the external key. The vtigerId -> qwbeId
// correspondence lives in a LEDGER file next to the export (<entity>-idmap.json, outside
// git). A row already in the ledger is PATCHed, not re-created, so a second run leaves the
// same counts. (The cube schemas are fixed and carry no externalId field; the ledger is the
// external-key store. If the cubes grow one, the ledger migrates.)
//
// Contacts: accountId comes from vtiger's own foreign key (contactdetails.accountid),
// resolved through the accounts ledger. An organization that is missing from the ledger is
// COUNTED and reported (count only, never the id); the contact gets accountId null and
// nothing is invented. On a rerun a still-missing organization clears a stale accountId.
//
// Environment: QWBE_URL, QWBE_USER, QWBE_PASSWORD (all required; the tool exits 2
// without them rather than silently authenticating as a default user).
//
// Usage: node tools/vtiger-map.mjs <file.jsonl> <mappings/xxx.json> [--set <stagingSetId>]

import { createReadStream, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { createInterface } from "node:readline"
import { mapRow, rowKey } from "./vtiger-map-lib.mjs"

const [file, mappingPath] = process.argv.slice(2).filter((a) => !a.startsWith("--"))
const setFlag = process.argv.indexOf("--set")
const setId = setFlag > -1 ? process.argv[setFlag + 1] : undefined
if (!file || !mappingPath) {
  console.error("usage: node tools/vtiger-map.mjs <file.jsonl> <mapping.json> [--set <setId>]")
  process.exit(2)
}

// No customer-derived file may ever land inside the repository (QWB-50 review, item 9):
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
const H = (extra = {}) => ({ authorization: `Bearer ${login.body.token}`, "content-type": "application/json", ...extra })

const mapping = JSON.parse(readFileSync(mappingPath, "utf8"))

// The ledger: vtigerId -> qwbeId, outside git, next to the export.
const ledgerPath = join(dirname(file), `${mapping.entity}-idmap.json`)
const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")) : {}

// For contacts: the accounts ledger resolves vtiger accountid -> qwbe accountId.
const accountsLedgerPath = join(dirname(file), "accounts-idmap.json")
const accountsLedger = existsSync(accountsLedgerPath) ? JSON.parse(readFileSync(accountsLedgerPath, "utf8")) : {}

const tally = { created: 0, updated: 0, missingOrg: 0, noOrg: 0, errors: 0, skipped: 0, skippedNoKey: 0 }
let seen = 0
let firstError = null

// Error reporting: the kernel adds no error mapping, so a rejected payload can come back
// embedded in the Effect decode error. NEVER print any part of the response body -- only
// the HTTP status and the schema field path(s) the body's decode error names. Field paths
// are extracted structurally (the ["field"] positions of the decode error); if none can
// be extracted, only the status is printed. Row values never reach stdout or the log.
const fieldPaths = (body) => {
  const text = typeof body === "string" ? body : JSON.stringify(body ?? "")
  const names = [...text.matchAll(/\[\\?"([A-Za-z0-9_]+)\\?"\]/g)].map((m) => m[1])
  return [...new Set(names)]
}
const describeFailure = (verb, status, body) => {
  const fields = fieldPaths(body)
  return `${verb}: HTTP ${status}${fields.length > 0 ? ` (field: ${fields.join(", ")})` : ""}`
}

// The ledger is flushed to disk every FLUSH_EVERY rows (tmp file + rename), so a crash,
// a kill or a dropped network mid-run keeps every vtigerId -> qwbeId pair recorded so far
// and the rerun PATCHes instead of re-creating (QWB-50 review, item 5).
const FLUSH_EVERY = 100
let ledgerDirty = 0
const saveLedger = (path, data) => {
  writeFileSync(`${path}.tmp`, JSON.stringify(data))
  renameSync(`${path}.tmp`, path)
  ledgerDirty = 0
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
  const key = rowKey(row, mapping)
  if (key === null) {
    // A row without its external key can never be recorded in the ledger: POSTing it
    // would silently duplicate it on every rerun (QWB-50 review, item 10).
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
      payload.accountId = null
    } else {
      const accId = accountsLedger[String(orgKey)]
      if (accId) payload.accountId = accId
      else {
        // Counted, never quoted: a vtiger id is re-identifiable against the source DB.
        tally.missingOrg++
        payload.accountId = null
      }
    }
  }

  const known = key ? ledger[key] : undefined
  if (known) {
    const res = await call(`${mapping.route}/${known}`, { method: "PATCH", headers: H(), body: JSON.stringify(payload) })
    if (res.ok) tally.updated++
    else if (res.status === 404) {
      // The qwbe row was deleted under us: create it anew and re-record the ledger.
      const created = await call(mapping.route, { method: "POST", headers: H(), body: JSON.stringify(payload) })
      if (created.ok) {
        ledger[key] = created.body.id
        ledgerDirty++
        tally.created++
      } else {
        tally.errors++
        if (!firstError) firstError = describeFailure(`recreate ${mapping.entity}`, created.status, created.body)
      }
    } else {
      tally.errors++
      if (!firstError) firstError = describeFailure(`update ${mapping.entity}`, res.status, res.body)
    }
  } else {
    const created = await call(mapping.route, { method: "POST", headers: H(), body: JSON.stringify(payload) })
    if (created.ok) {
      ledger[key] = created.body.id
      ledgerDirty++
      tally.created++
    } else {
      tally.errors++
      if (!firstError) firstError = describeFailure(`create ${mapping.entity}`, created.status, created.body)
    }
  }
  if (ledgerDirty >= FLUSH_EVERY) saveLedger(ledgerPath, ledger)
}

saveLedger(ledgerPath, ledger)

console.log(`entity:     ${mapping.entity}`)
console.log(`rows seen:  ${seen}`)
console.log(`created:    ${tally.created}`)
console.log(`updated:    ${tally.updated}`)
if (mapping.entity === "contacts") {
  console.log(`no org:     ${tally.noOrg} (contact has no organization in vtiger)`)
  console.log(`missing org:${tally.missingOrg} (organization not among the imported accounts; accountId set to null; count only, ids never printed)`)
}
console.log(`skipped:    ${tally.skipped} (empty required name or a mapping error)`)
console.log(`no key:     ${tally.skippedNoKey} (row without ${mapping.key}; never POSTed, never recorded)`)
console.log(`errors:     ${tally.errors}`)
if (firstError) console.log(`first error: ${firstError}`)
console.log(`ledger:     ${ledgerPath}`)

if (setId) {
  const state = await call(`/staging/sets/${setId}`, { headers: H() })
  if (state.ok) {
    console.log(`staging:    set ${setId} holds ${state.body.rowCount} rows, ${state.body.malformedCount} malformed`)
    if (state.body.rowCount !== seen)
      console.log(`DIVERGENCE: staging ${state.body.rowCount} vs file ${seen} rows`)
    else console.log("staging matches the file row for row (count)")
  }
}
