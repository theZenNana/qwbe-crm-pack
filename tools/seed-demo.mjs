#!/usr/bin/env node
// Demo data for the local sandbox stack: 50 organizations, 50 contacts,
// 5 contracts, plus the custom fields they carry -- generated, never imported.
//
// The rule: dummy data is GENERATED, never committed; vtiger
// contributes only the STRUCTURE of the custom fields (names, types, required flags --
// read once from the real system's field definitions), never a row and never its picklist
// values. Every value below is produced deterministically from a row index, so the same
// seed always yields the same sandbox: reruns fill what is missing and touch nothing that
// is already there (the idempotent-lookup pattern of the vtiger import, tools/vtiger-map.mjs).
//
// Usage:
//   node tools/seed-demo.mjs            create what is missing (defs first, then rows)
//   node tools/seed-demo.mjs --wipe     delete the demo rows and the demo field defs,
//                                       then build the whole set again
//
// Environment:
//   QWBE_API_URL        the kernel of the local stack (default http://localhost:4600)
//   QWBE_USER/PASSWORD  API credentials (default admin/admin -- the sandbox login)
//   QWBE_DATABASE_URL   required only by --wipe: there are no DELETE endpoints on the CRM
//                       cubes, so demo rows are removed directly in Postgres -- the exact
//                       connection the kernel itself runs with (core/src/pg/db.ts requires it).
//
// The custom values ride the target cubes' own API: the kernel folds defined custom keys
// into the row's `custom` sub-object (core/src/custom-values.ts), so no database write is
// needed on the way IN. Demo rows mark themselves with externalId "demo:..." -- the wipe
// deletes only marked rows, never anything a human or the vtiger import created.

import pg from "pg"

// ---------------------------------------------------------------------------
// The demo custom fields: structure mirrored from the real vtiger custom fields
// (field label + type + required, from vtiger_field; the two hidden "Cod import"
// markers -- presence=1 -- are left out). The TYPES are mapped from vtiger uitypes:
// 1 -> text, 7 -> number, 56 -> bool, 15 -> select, 11/13/17 -> text. Options are
// SYNTHETIC on purpose: the real picklist values are the customer's own taxonomy --
// data, not structure. Labels are the real ones, ASCII-folded.
// ---------------------------------------------------------------------------

/** @type {Array<{name: string, label: string, fieldType: "text"|"number"|"date"|"bool"|"select", options: string[], required: boolean}>} */
export const ORGANIZATION_CUSTOM_FIELDS = [
  { name: "otherIndustry", label: "Other Industry", fieldType: "select", required: false, options: ["Services", "Retail", "Manufacturing", "Construction", "IT and Software", "Agriculture", "Transport", "Energy"] },
  { name: "form", label: "Form", fieldType: "select", required: true, options: ["SRL", "SRL-D", "PFA", "SA", "SNC", "RA"] },
  { name: "otherIndustrySpec", label: "Other Industry Spec", fieldType: "text", required: false, options: [] },
  { name: "tva", label: "TVA", fieldType: "bool", required: true, options: [] },
  { name: "cui", label: "CUI", fieldType: "text", required: true, options: [] },
  { name: "regNo", label: "Reg no", fieldType: "text", required: false, options: [] },
  { name: "category", label: "Category", fieldType: "select", required: false, options: ["Lead", "Active", "Preferred", "Past"] },
  { name: "bank", label: "Bank", fieldType: "select", required: false, options: ["Alpha Bank", "Beta Bank", "Gamma Bank", "Delta Bank", "Epsilon Bank"] },
  { name: "productCategory", label: "Product Category", fieldType: "select", required: false, options: ["Tools", "Machinery", "Electrical", "Services", "Spare parts"] },
  { name: "iban", label: "IBAN", fieldType: "text", required: false, options: [] },
  { name: "compMobilePhone", label: "Comp Mobile Phone", fieldType: "text", required: false, options: [] },
  { name: "otherFax", label: "Other Fax", fieldType: "text", required: false, options: [] },
  { name: "accountTurnover", label: "Account Turnover EUR", fieldType: "number", required: false, options: [] },
  { name: "industrySpec", label: "Industry Spec", fieldType: "text", required: false, options: [] },
]

export const CONTACT_CUSTOM_FIELDS = [
  { name: "socialNet", label: "Social Net", fieldType: "text", required: false, options: [] },
  { name: "skypeAcc", label: "Skype Acc", fieldType: "text", required: false, options: [] },
  { name: "cnp", label: "CNP", fieldType: "number", required: false, options: [] },
  { name: "website", label: "Website", fieldType: "text", required: false, options: [] },
  { name: "serieBuletin", label: "Serie buletin", fieldType: "text", required: false, options: [] },
  { name: "office", label: "Office", fieldType: "text", required: false, options: [] },
  { name: "numarBuletin", label: "Numar buletin", fieldType: "text", required: false, options: [] },
  { name: "title", label: "Title", fieldType: "select", required: false, options: ["Manager", "Director", "Specialist", "Technician"] },
  { name: "department", label: "Department", fieldType: "select", required: false, options: ["Sales", "Production", "Finance", "IT", "Logistics"] },
  { name: "compMobilePhone", label: "Comp Mobile Phone", fieldType: "text", required: false, options: [] },
  { name: "extensionOffice", label: "Extension Office", fieldType: "text", required: false, options: [] },
  { name: "homeEmail", label: "Home Email", fieldType: "text", required: false, options: [] },
  { name: "personalEmail", label: "Personal Email", fieldType: "text", required: false, options: [] },
]

export const COUNTS = { organizations: 50, contacts: 50, contracts: 5 }
/** Demo rows carry this externalId prefix; the wipe touches only prefixed rows. */
export const DEMO_PREFIX = "demo:"

// ---------------------------------------------------------------------------
// The generator: pure functions of the row index. No Math.random, no clock --
// the same seed produces the same sandbox (owner requirement: idempotent reruns).
// ---------------------------------------------------------------------------

const FIRST = ["Andrei", "Mihai", "Ionut", "Elena", "Ana", "Maria", "Cristina", "Vlad", "Sorin", "Diana"]
const LAST = ["Popescu", "Ionescu", "Popa", "Dumitrescu", "Stan", "Marin", "Radu", "Gheorghiu", "Iliescu", "Constantin", "Barbu", "Neagu"]
const COMPANY1 = ["Nord", "Delta", "Valea", "Corola", "Urban", "Terra", "Solar", "Metal", "Silvania", "Prima"]
const COMPANY2 = ["Construct", "Systems", "Import", "Group", "Partners", "Logistics", "Energy", "Tools", "Design", "Foods", "Consulting", "Solutions"]
const LEGAL = ["SRL", "SRL-D", "PFA", "SA", "SNC"]
const CITIES = ["Iasi", "Cluj", "Sibiu", "Brasov", "Timisoara", "Oradea", "Bacau", "Suceava"]
const INDUSTRY = ["manufacturing", "construction", "retail", "services", "it", "agriculture", "transport", "energy"]
const RATING = ["active", "prospect", "past"]
const OWNERSHIP = ["private", "public", "family"]

const cycle = (list, i, step) => list[(i * step) % list.length]
const pad = (n, width) => String(n).padStart(width, "0")

/** The create payload of demo organization `i` (1-based): static fields plus custom keys. */
export const organizationRow = (i) => {
  const name = `${cycle(COMPANY1, i, 7)} ${cycle(COMPANY2, i, 13)} ${LEGAL[i % LEGAL.length]}`
  const values = {
    otherIndustry: cycle(ORGANIZATION_CUSTOM_FIELDS[0].options, i, 11),
    form: cycle(ORGANIZATION_CUSTOM_FIELDS[1].options, i, 3),
    otherIndustrySpec: `Spec ${cycle(COMPANY2, i, 5).toLowerCase()}`,
    tva: i % 3 !== 0,
    cui: `RO${10000000 + i * 137}`,
    regNo: `J${1 + (i % 40)}/${100 + i}/2023`,
    category: cycle(ORGANIZATION_CUSTOM_FIELDS[6].options, i, 7),
    bank: cycle(ORGANIZATION_CUSTOM_FIELDS[7].options, i, 13),
    productCategory: cycle(ORGANIZATION_CUSTOM_FIELDS[8].options, i, 3),
    iban: `RO${20 + (i % 79)}DEMO0000${pad(i, 4)}`,
    compMobilePhone: `+40 72${pad((i * 101) % 1000000, 6)}`,
    otherFax: `+40 31 ${pad(500 + i, 3)} ${pad(100 + i, 3)}`,
    accountTurnover: 1000 + ((i * 7919) % 499000),
    industrySpec: `Spec ${cycle(COMPANY1, i, 3).toLowerCase()}`,
  }
  return {
    externalId: `${DEMO_PREFIX}organization:${i}`,
    name,
    organizationNo: `ORG-2026-${pad(i, 4)}`,
    phone: `+40 264 ${pad(400 + (i % 500), 3)} ${pad(100 + i, 3)}`,
    email: `office${i}@example.test`,
    website: `https://demo-org-${i}.example.test`,
    organizationType: LEGAL[i % LEGAL.length],
    industry: INDUSTRY[i % INDUSTRY.length],
    rating: RATING[i % RATING.length],
    ownership: OWNERSHIP[i % OWNERSHIP.length],
    employees: (i * 17) % 250,
    emailOptOut: i % 7 === 0,
    billingStreet: `Str. Demo nr. ${i}`,
    billingCity: CITIES[i % CITIES.length],
    billingCode: String(100000 + i * 211),
    billingCountry: "Romania",
    description: `Demo organization ${i} - generated dummy data.`,
    ...values,
  }
}

/** The create payload of demo contact `i`, linked 1:1 to organization `i`. */
export const contactRow = (i) => {
  const name = `${cycle(FIRST, i, 7)} ${cycle(LAST, i, 13)}`
  return {
    externalId: `${DEMO_PREFIX}contact:${i}`,
    name,
    email: `${name.toLowerCase().replace(/ /g, ".")}@example.test`,
    phone: `+40 74${pad((i * 211) % 1000000, 6)}`,
    company: organizationRow(i).name,
    organizationExternalId: `${DEMO_PREFIX}organization:${i}`,
    custom: {
      socialNet: `https://social.example.test/demo${i}`,
      skypeAcc: `demo.skype.${i}`,
      cnp: 5000000000000 + i * 13,
      website: `https://demo-${i}.example.test`,
      serieBuletin: `R${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + ((i * 7) % 26))}`,
      office: `Office ${1 + (i % 12)}`,
      numarBuletin: String(100000 + i * 13),
      title: cycle(CONTACT_CUSTOM_FIELDS[7].options, i, 7),
      department: cycle(CONTACT_CUSTOM_FIELDS[8].options, i, 3),
      compMobilePhone: `+40 72${pad((i * 57) % 1000000, 6)}`,
      extensionOffice: String(100 + i),
      homeEmail: `home${i}@example.test`,
      personalEmail: `personal${i}@example.test`,
    },
  }
}

/** The create payload of demo contract `j` (1-based), party = organization j*10. */
export const contractRow = (j) => {
  const org = j * 10
  const signedAt = [`2026-01-15T10:00:00Z`, `2026-02-20T09:30:00Z`, `2026-03-10T14:00:00Z`, `2026-04-02T11:15:00Z`]
  return {
    title: `Maintenance 2026 - ${organizationRow(org).name}`,
    amount: (250 + j * 137) * 100,
    currency: j % 2 === 0 ? "EUR" : "RON",
    signedAt: j <= signedAt.length ? signedAt[j - 1] : null,
    partyExternalId: `${DEMO_PREFIX}organization:${org}`,
  }
}

/** The five deterministic demo contract titles -- the wipe finds demo contracts by them
 *  (the contracts cube has no externalId field to mark rows with). */
export const demoContractTitles = () => Array.from({ length: COUNTS.contracts }, (_, k) => contractRow(k + 1).title)

// ---------------------------------------------------------------------------
// The API side: definitions first (the fold is OFF while a cube has no active
// definitions, so custom keys would be silently stripped), then the rows.
// ---------------------------------------------------------------------------

const apiBase = () => process.env.QWBE_API_URL ?? "http://localhost:4600"

const makeClient = async () => {
  const user = process.env.QWBE_USER ?? "admin"
  const password = process.env.QWBE_PASSWORD ?? "admin"
  const login = await fetch(`${apiBase()}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: user, password }),
  })
  if (!login.ok) throw new Error(`login failed: http ${login.status} at ${apiBase()}`)
  const { token } = await login.json()
  return async (path, opts = {}) => {
    const res = await fetch(`${apiBase()}${path}`, {
      ...opts,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(opts.headers ?? {}) },
    })
    if (!res.ok) throw new Error(`http ${res.status} on ${opts.method ?? "GET"} ${path}: ${await res.text()}`)
    return res.json()
  }
}

async function ensureDefs(api) {
  const report = []
  for (const [cube, fields] of [
    ["crm/organizations", ORGANIZATION_CUSTOM_FIELDS],
    ["crm/contacts", CONTACT_CUSTOM_FIELDS],
  ]) {
    const existing = await api(`/customfields?cube=${encodeURIComponent(cube)}&limit=200`)
    const known = new Set(existing.rows.filter((d) => d.deleted === false).map((d) => d.name))
    let created = 0
    for (const [position, field] of fields.entries()) {
      if (known.has(field.name)) continue
      await api("/customfields", { method: "POST", body: JSON.stringify({ targetCube: cube, position, ...field }) })
      created++
    }
    report.push({ cube, created, existing: fields.length - created })
  }
  return report
}

async function lookupByExternalId(api, route, externalId) {
  const page = await api(`${route}?externalId=${encodeURIComponent(externalId)}&limit=1`)
  return page.rows.find((r) => r.externalId === externalId) ?? null
}

/** Create the missing demo rows; returns {created, existing} per cube. Never rewrites
 *  a row that is already there -- a rerun must not stomp edits made through the UI. */
async function ensureRows(api) {
  const report = {}

  // Organizations: lookup by the deterministic externalId, create only what is missing.
  // The payload carries the custom keys at the top level: the kernel folds them.
  report.organizations = { created: 0, existing: 0 }
  const orgIds = new Map()
  for (let i = 1; i <= COUNTS.organizations; i++) {
    const payload = organizationRow(i)
    const found = await lookupByExternalId(api, "/organizations", payload.externalId)
    if (found) {
      orgIds.set(payload.externalId, found.id)
      report.organizations.existing++
      continue
    }
    const made = await api("/organizations", { method: "POST", body: JSON.stringify(payload) })
    orgIds.set(payload.externalId, made.id)
    report.organizations.created++
  }

  // Contacts: linked to their organization through the one truth, organizationId.
  report.contacts = { created: 0, existing: 0 }
  for (let i = 1; i <= COUNTS.contacts; i++) {
    const payload = contactRow(i)
    const found = await lookupByExternalId(api, "/contacts", payload.externalId)
    if (found) {
      report.contacts.existing++
      continue
    }
    const { organizationExternalId, custom, ...statics } = payload
    await api("/contacts", {
      method: "POST",
      body: JSON.stringify({ ...statics, organizationId: orgIds.get(organizationExternalId), ...custom }),
    })
    report.contacts.created++
  }

  // Contracts: no externalId on this cube, so the deterministic TITLES are the marker
  // (the same ones the wipe deletes by). The party is the organization's id -- opaque
  // data on a nullable field, exactly as the cube contract defines it.
  report.contracts = { created: 0, existing: 0 }
  const knownTitles = new Set()
  // ponytail: the scan stops at 2000 rows (10 pages of MAX_LIMIT=200) -- a sandbox holds
  // the 5 demo contracts; when a real 60k-row import lands, this marker moves to a
  // declared field on the cube, not to an ever-growing scan.
  for (let offset = 0; offset < 2000; offset += 200) {
    const page = await api(`/contracts?limit=200&offset=${offset}`)
    for (const row of page.rows) knownTitles.add(row.title)
    if (offset + 200 >= page.total) break
  }
  for (let j = 1; j <= COUNTS.contracts; j++) {
    const payload = contractRow(j)
    if (knownTitles.has(payload.title)) {
      report.contracts.existing++
      continue
    }
    const { partyExternalId, ...statics } = payload
    await api("/contracts", {
      method: "POST",
      body: JSON.stringify({ ...statics, partyId: orgIds.get(partyExternalId) }),
    })
    report.contracts.created++
  }
  return report
}

async function totals(api) {
  const out = {}
  for (const route of ["/organizations", "/contacts", "/contracts"]) out[route] = (await api(`${route}?limit=1`)).total
  return out
}

// ---------------------------------------------------------------------------
// The wipe: demo rows out of Postgres (no DELETE endpoints exist on the cubes),
// demo definitions soft-deleted through the API (keeps the kernel's snapshot fresh),
// then the plain create path rebuilds everything. Only demo-marked rows are touched:
// anything a human or the vtiger import created survives and is reported.
// ---------------------------------------------------------------------------

async function wipeDemoRows() {
  const url = process.env.QWBE_DATABASE_URL
  if (!url) {
    throw new Error("refusing to guess the database: set QWBE_DATABASE_URL (the same one the kernel runs with)")
  }
  const pool = new pg.Pool({ connectionString: url, max: 1 })
  try {
    const titles = demoContractTitles()
    const out = {}
    const contracts = await pool.query(
      `DELETE FROM "crm--contracts".contracts WHERE body->>'title' = ANY($1) RETURNING id`,
      [titles],
    )
    out.contracts = { deleted: contracts.rowCount }
    const contacts = await pool.query(
      `DELETE FROM "crm--contacts".contacts WHERE body->>'externalId' LIKE $1 RETURNING id`,
      [`${DEMO_PREFIX}contact:%`],
    )
    out.contacts = { deleted: contacts.rowCount }
    const organizations = await pool.query(
      `DELETE FROM "crm--organizations".organizations WHERE body->>'externalId' LIKE $1 RETURNING id`,
      [`${DEMO_PREFIX}organization:%`],
    )
    out.organizations = { deleted: organizations.rowCount }
    out.leftover = {}
    for (const [name, sql] of [
      ["organizations", `SELECT count(*)::int AS n FROM "crm--organizations".organizations`],
      ["contacts", `SELECT count(*)::int AS n FROM "crm--contacts".contacts`],
      ["contracts", `SELECT count(*)::int AS n FROM "crm--contracts".contracts`],
    ]) {
      const r = await pool.query(sql)
      out.leftover[name] = r.rows[0].n
    }
    return out
  } finally {
    await pool.end()
  }
}

async function wipeDemoDefs(api) {
  const demoNames = new Set([...ORGANIZATION_CUSTOM_FIELDS, ...CONTACT_CUSTOM_FIELDS].map((f) => f.name))
  let removed = 0
  for (const cube of ["crm/organizations", "crm/contacts"]) {
    const existing = await api(`/customfields?cube=${encodeURIComponent(cube)}&limit=200`)
    for (const def of existing.rows) {
      if (def.deleted === true || !demoNames.has(def.name)) continue
      await api(`/customfields/${def.id}`, { method: "DELETE" })
      removed++
    }
  }
  return removed
}

// ---------------------------------------------------------------------------

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (isMain) {
  const wipe = process.argv.includes("--wipe")
  try {
    const api = await makeClient()
    let wipedRows = null
    if (wipe) {
      wipedRows = await wipeDemoRows()
      for (const cube of ["organizations", "contacts", "contracts"]) {
        const left = wipedRows.leftover[cube]
        console.log(`wipe crm/${cube}: ${wipedRows[cube].deleted} demo row(s) deleted, ${left} non-demo row(s) left untouched`)
      }
      const defs = await wipeDemoDefs(api)
      console.log(`wipe custom field defs: ${defs} removed`)
    }
    const defs = await ensureDefs(api)
    for (const d of defs) console.log(`defs ${d.cube}: ${d.created} created, ${d.existing} already defined`)
    const rows = await ensureRows(api)
    for (const [cube, r] of Object.entries(rows)) console.log(`crm/${cube}: ${r.created} created, ${r.existing} already present`)
    const t = await totals(api)
    for (const [route, total] of Object.entries(t)) console.log(`total in cube ${route}: ${total}`)
    console.log(wipe ? "sandbox rebuilt." : "sandbox up to date.")
  } catch (err) {
    console.error(`seed-demo failed: ${err.message}`)
    process.exit(1)
  }
}
