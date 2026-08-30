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
// COUNTED and reported; the contact gets accountId null and nothing is invented.
//
// Environment: QWBE_URL, QWBE_USER, QWBE_PASSWORD (as vtiger-to-staging.mjs).
//
// Usage: node tools/vtiger-map.mjs <file.jsonl> <mappings/xxx.json> [--set <stagingSetId>]

import { createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs"
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
    username: process.env.QWBE_USER ?? "admin",
    password: process.env.QWBE_PASSWORD ?? "admin",
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

const tally = { created: 0, updated: 0, missingOrg: 0, noOrg: 0, errors: 0, skipped: 0 }
const missingOrgSample = [] // vtiger account ids only -- ids, never row values
let seen = 0

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
  const { payload, error } = mapRow(row, mapping)
  if (error || payload.name === null || payload.name === undefined || payload.name === "") {
    tally.skipped++
    continue
  }

  if (mapping.entity === "contacts") {
    const orgKey = row[mapping.accountKey]
    if (orgKey === undefined || orgKey === null || String(orgKey) === "0" || String(orgKey) === "") {
      tally.noOrg++
    } else {
      const accId = accountsLedger[String(orgKey)]
      if (accId) payload.accountId = accId
      else {
        tally.missingOrg++
        if (missingOrgSample.length < 20) missingOrgSample.push(String(orgKey))
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
      if (created.ok && key) ledger[key] = created.body.id
      tally.created++
    } else tally.errors++
  } else {
    const created = await call(mapping.route, { method: "POST", headers: H(), body: JSON.stringify(payload) })
    if (created.ok) {
      if (key) ledger[key] = created.body.id
      tally.created++
    } else tally.errors++
  }
}

writeFileSync(ledgerPath, JSON.stringify(ledger))

console.log(`entity:     ${mapping.entity}`)
console.log(`rows seen:  ${seen}`)
console.log(`created:    ${tally.created}`)
console.log(`updated:    ${tally.updated}`)
if (mapping.entity === "contacts") {
  console.log(`no org:     ${tally.noOrg} (contact has no organization in vtiger)`)
  console.log(`missing org:${tally.missingOrg} (organization not among the imported accounts; accountId left null)`)
  if (missingOrgSample.length > 0) console.log(`missing org vtiger ids (first 20): ${missingOrgSample.join(", ")}`)
}
console.log(`skipped:    ${tally.skipped} (empty required name or a mapping error)`)
console.log(`errors:     ${tally.errors}`)
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
