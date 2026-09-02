#!/usr/bin/env node
// Verification of the import: COUNTS only, never a row value.
//
// Per entity it prints: rows exported (line count of the JSONL), rows in the staging set
// (optional), rows living in qwbe (the organizations count command; the contacts page total),
// and the differences. For the organization-to-contact relation it counts, from the export
// file and externalId lookups into qwbe (the
// correspondence lives on the rows), how many contacts point at an organization that never
// made it into qwbe.
//
// Environment: QWBE_URL, QWBE_USER, QWBE_PASSWORD (all required; the tool exits 2
// without them, and fails fast on a rejected login instead of printing n/a counts).
//
// Usage: node tools/vtiger-verify.mjs <accounts.jsonl> [contacts.jsonl] [--set-accounts ID] [--set-contacts ID]

import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"

const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"))
const flag = (name) => {
  const i = process.argv.indexOf(name)
  return i > -1 ? process.argv[i + 1] : undefined
}
const [accountsFile, contactsFile] = positional
if (!accountsFile) {
  console.error("usage: node tools/vtiger-verify.mjs <accounts.jsonl> [contacts.jsonl] [--set-accounts ID] [--set-contacts ID]")
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
if (!login.ok) {
  console.error(`login failed: HTTP ${login.status} -- refusing to print misleading n/a counts`)
  process.exit(1)
}
const H = () => ({ authorization: `Bearer ${login.body.token}`, "content-type": "application/json" })

const countLines = async (file) => {
  let n = 0
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity })
  for await (const line of rl) if (line.trim() !== "") n++
  return n
}

const stagingRows = async (setId) => {
  if (!setId) return undefined
  const s = await call(`/staging/sets/${setId}`, { headers: H() })
  return s.ok ? s.body.rowCount : undefined
}

const accountsInQwbe = async () => {
  const r = await call("/cli/exec", {
    method: "POST",
    headers: H(),
    body: JSON.stringify({ line: "crm/organizations:count" }),
  })
  return r.ok ? Number(r.body.output) : undefined
}
const contactsInQwbe = async () => {
  const r = await call("/contacts?limit=1", { headers: H() })
  return r.ok ? r.body.total : undefined
}

const line = async (label, file, setId, inQwbe) => {
  const exported = await countLines(file)
  const staged = await stagingRows(setId)
  const diffStaging = staged === undefined ? "n/a" : String(staged - exported)
  const diffQwbe = inQwbe === undefined ? "n/a" : String(inQwbe - exported)
  console.log(`${label}: exported=${exported} staging=${staged ?? "n/a"} (diff ${diffStaging}) qwbe=${inQwbe ?? "n/a"} (diff ${diffQwbe}; whole-cube total -- assume the cube held nothing before this import, otherwise the diff is off by that)`)
  return exported
}

await line("accounts", accountsFile, flag("--set-accounts"), await accountsInQwbe())
if (contactsFile) {
  await line("contacts", contactsFile, flag("--set-contacts"), await contactsInQwbe())

  // Organization-to-contact divergences, from the export file plus one externalId lookup per
  // DISTINCT organization (cached by the Set -- thousands of contacts share one organization).
  let withOrg = 0
  const orgKeys = new Set()
  const rl = createInterface({ input: createReadStream(contactsFile, { encoding: "utf8" }), crlfDelay: Infinity })
  for await (const l of rl) {
    if (l.trim() === "") continue
    let row
    try {
      row = JSON.parse(l)
    } catch {
      continue
    }
    const org = row.accountid
    if (org === undefined || org === null || String(org) === "0" || String(org) === "") continue
    withOrg++
    orgKeys.add(String(org))
  }
  let orgImported = 0
  let orgMissing = 0
  for (const orgKey of orgKeys) {
    const r = await call(`/organizations?externalId=${encodeURIComponent(`vtiger:${orgKey}`)}&limit=1`, { headers: H() })
    if (r.ok && (r.body.total ?? 0) > 0) orgImported++
    else orgMissing++
  }
  console.log(`org-to-contact: contacts with an organization=${withOrg} organization imported=${orgImported} organization missing=${orgMissing}`)
}
console.log("verification: counts only, no row value printed")
