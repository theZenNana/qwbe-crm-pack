// Runtime proof for the rebuilt CRM plugin (QWB-30, criterion 12).
//
// Boots a real Qwbe kernel on a scratch data dir (QWBE_DATA_DIR + mkdtemp — live data is
// never touched) with the plugin installed at core/plugins/crm-pack, and attacks the cubes
// over the authenticated HTTP boundary: 401 without a token, 403 with the wrong permission,
// 404 on a missing id, create/list/get for both cubes, an invalid payload refused at the
// schema edge (fractional minor units), the party relation as opaque data, money kept in
// minor units and never summed across currencies — and, as the decided minimal relation,
// each cube booting and serving while the other is absent.
//
// Runs from the plugin directory or anywhere, against a Qwbe checkout:
//
//   QWBE_REPO=~/Projects/qwbe node probes/crm.mjs
//
// The plugin must be installed first (QWB-31):
//   POST /settings/packages/install-from {"path": "~/Projects/qwbe-packs/plugins/crm-pack"}
// and the server restarted, or simply copy this directory to <qwbe>/core/plugins/crm-pack.
// The probe refuses to run if the cubes are not mounted, rather than proving nothing.

import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const qwbeRepo = process.env.QWBE_REPO ?? join(homedir(), "Projects/qwbe")
const { client, dropScratch, freePort, makeScore, scratchDataDir, startServer, stopServer } = await import(
  join(qwbeRepo, "probes/lib.mjs")
)

const score = makeScore()
const port = await freePort()
const data = scratchDataDir("crm")
const api = client(port)
const server = await startServer(port, { QWBE_DATA_DIR: data })

if (!server.alive) {
  dropScratch(data)
  console.error(`server did not start:\n${server.output}`)
  process.exit(1)
}

try {
  const admin = await api.login()
  const reader = await api.login("reader", "reader")

  const cubes = await api.call("/settings/cubes", { headers: admin.headers })
  const names = (cubes.body ?? []).map((c) => c.name)
  for (const want of ["crm", "crm/accounts", "crm/contacts", "crm/contracts"]) {
    if (!names.includes(want)) {
      console.error(`refused: cube "${want}" is not mounted — install crm-pack first (see header).`)
      process.exit(1)
    }
  }

  // ---- auth boundary -------------------------------------------------------------
  const anon = await api.call("/contacts")
  score.check("contacts requires authentication (401)", anon.status === 401, `http=${anon.status}`)
  const anonC = await api.call("/contracts")
  score.check("contracts requires authentication (401)", anonC.status === 401, `http=${anonC.status}`)

  // ---- contacts: create / list / get, 403, 404 -----------------------------------
  const forbiddenCreate = await api.call("/contacts", {
    method: "POST",
    headers: reader.headers,
    body: JSON.stringify({ name: "Refused Reader" }),
  })
  score.check("reader cannot create a contact (403)", forbiddenCreate.status === 403, `http=${forbiddenCreate.status}`)

  const missing = await api.call("/contacts/cont_missing", { headers: admin.headers })
  score.check("missing contact is 404", missing.status === 404, `http=${missing.status}`)

  const created = await api.call("/contacts", {
    method: "POST",
    headers: admin.headers,
    body: JSON.stringify({ name: "Ada Ionescu", email: "ada@example.com", company: "Ada SRL" }),
  })
  const contact = created.body
  score.check(
    "admin creates a contact",
    created.status === 200 && typeof contact?.id === "string" && contact.type === "Contact",
    `http=${created.status} id=${contact?.id}`,
  )

  const list = await api.call("/contacts", { headers: reader.headers })
  score.check(
    "reader lists contacts",
    list.status === 200 && list.body?.total === 1 && list.body?.rows?.[0]?.name === "Ada Ionescu",
    `http=${list.status} total=${list.body?.total}`,
  )

  const got = await api.call(`/contacts/${contact?.id}`, { headers: reader.headers })
  score.check(
    "company stays free text on the contact (no account entity)",
    got.status === 200 && got.body?.company === "Ada SRL",
    `http=${got.status}`,
  )

  // ---- contracts: invalid payload, create / list / get, party id -----------------
  const fractional = await api.call("/contracts", {
    method: "POST",
    headers: admin.headers,
    body: JSON.stringify({ title: "Bad money", amount: 12.5, currency: "RON" }),
  })
  score.check(
    "fractional minor units are refused at the schema edge (400)",
    fractional.status === 400,
    `http=${fractional.status}`,
  )

  const forbiddenC = await api.call("/contracts", {
    method: "POST",
    headers: reader.headers,
    body: JSON.stringify({ title: "Refused" }),
  })
  score.check("reader cannot create a contract (403)", forbiddenC.status === 403, `http=${forbiddenC.status}`)

  const missingC = await api.call("/contracts/ctr_missing", { headers: admin.headers })
  score.check("missing contract is 404", missingC.status === 404, `http=${missingC.status}`)

  const c1 = await api.call("/contracts", {
    method: "POST",
    headers: admin.headers,
    body: JSON.stringify({ title: "Maintenance 2026", amount: 15050, currency: "RON", partyId: contact?.id }),
  })
  const c2 = await api.call("/contracts", {
    method: "POST",
    headers: admin.headers,
    body: JSON.stringify({ title: "Hosting", amount: 9900, currency: "EUR" }),
  })
  score.check(
    "admin creates contracts in minor units",
    c1.status === 200 && c1.body?.amount === 15050 && c2.status === 200 && c2.body?.amount === 9900,
    `http=${c1.status},${c2.status}`,
  )

  score.check(
    "the minimal relation: partyId stored opaque and nullable",
    c1.body?.partyId === contact?.id && c2.body?.partyId === null,
    `partyId=${c1.body?.partyId}`,
  )

  const clist = await api.call("/contracts", { headers: reader.headers })
  score.check("reader lists contracts", clist.status === 200 && clist.body?.total === 2, `http=${clist.status}`)

  // ---- money: per-currency totals, never summed -----------------------------------
  const value = await api.call("/cli/exec", {
    method: "POST",
    headers: admin.headers,
    body: JSON.stringify({ line: "crm/contracts:value" }),
  })
  const out = String(value.body?.output ?? "")
  score.check(
    "contracts:value renders per currency, never a cross-currency sum",
    value.status === 200 && out.includes("150.50 RON") && out.includes("99.00 EUR") && !out.includes("249.50"),
    `out=${JSON.stringify(out)}`,
  )

  // ---- accounts (QWB-47): create / get / update, 403, 404, paging, sorting ----------------
  const anonA = await api.call("/accounts")
  score.check("accounts requires authentication (401)", anonA.status === 401, `http=${anonA.status}`)

  const forbiddenA = await api.call("/accounts", {
    method: "POST",
    headers: reader.headers,
    body: JSON.stringify({ name: "Refused Reader SRL" }),
  })
  score.check("reader cannot create an organization (403)", forbiddenA.status === 403, `http=${forbiddenA.status}`)

  const missingA = await api.call("/accounts/acc_missing", { headers: admin.headers })
  score.check("missing organization is 404", missingA.status === 404, `http=${missingA.status}`)

  const createdA = await api.call("/accounts", {
    method: "POST",
    headers: admin.headers,
    body: JSON.stringify({
      name: "Ada Industries SRL",
      industry: "manufacturing",
      website: "https://ada.example.com",
      billingCity: "Iasi",
      employees: 42,
    }),
  })
  const org = createdA.body
  score.check(
    "admin creates an organization",
    createdA.status === 200 && typeof org?.id === "string" && org.type === "Organization" && org.employees === 42,
    `http=${createdA.status} id=${org?.id}`,
  )

  const updatedA = await api.call(`/accounts/${org?.id}`, {
    method: "PATCH",
    headers: admin.headers,
    body: JSON.stringify({ billingCity: "Cluj", rating: "active" }),
  })
  score.check(
    "admin updates an organization (patch keeps the rest)",
    updatedA.status === 200 && updatedA.body?.billingCity === "Cluj" && updatedA.body?.name === "Ada Industries SRL",
    `http=${updatedA.status}`,
  )

  const pageA = await api.call("/accounts?limit=1&sortBy=name", { headers: reader.headers })
  score.check(
    "accounts list pages and sorts",
    pageA.status === 200 && pageA.body?.rows?.length === 1 && pageA.body?.total === 1 && pageA.body?.sortedBy === "name",
    `http=${pageA.status} sortedBy=${pageA.body?.sortedBy}`,
  )

  // Ticket 07: the list is the kernel's generic one, and the manifest's `searchable` fields
  // are the filter contract. Two organizations, a filter on name, exactly one back.
  const secondOrg = await api.call("/accounts", {
    method: "POST",
    headers: admin.headers,
    body: JSON.stringify({ name: "Beta Constructions SRL", industry: "construction" }),
  })
  const filteredA = await api.call(`/accounts?name=${encodeURIComponent("Ada Industries SRL")}`, {
    headers: reader.headers,
  })
  score.check(
    "filtering organizations by name returns exactly the matching one",
    secondOrg.status === 200 &&
      filteredA.status === 200 &&
      filteredA.body?.total === 1 &&
      filteredA.body?.rows?.length === 1 &&
      filteredA.body?.rows?.[0]?.name === "Ada Industries SRL",
    `http=${filteredA.status} total=${filteredA.body?.total}`,
  )

  // ---- the relation: accountId on the contact is the one truth -----------------------------
  const withAccount = await api.call("/contacts", {
    method: "POST",
    headers: admin.headers,
    body: JSON.stringify({ name: "Dan Pop", email: "dan@example.com", accountId: org?.id }),
  })
  score.check(
    "contact created with accountId pointing at an existing organization",
    withAccount.status === 200 && withAccount.body?.accountId === org?.id,
    `http=${withAccount.status} accountId=${withAccount.body?.accountId}`,
  )

  const withoutAccount = await api.call("/contacts", {
    method: "POST",
    headers: admin.headers,
    body: JSON.stringify({ name: "Maria Radu", email: "maria@example.com" }),
  })
  score.check(
    "contact created without accountId comes back null",
    withoutAccount.status === 200 && withoutAccount.body?.accountId === null,
    `http=${withoutAccount.status} accountId=${withoutAccount.body?.accountId}`,
  )

  const orgContacts = await api.call(`/contacts?accountId=${org?.id}`, { headers: reader.headers })
  score.check(
    "an organization's contacts are derived by filtering on accountId",
    orgContacts.status === 200 &&
      orgContacts.body?.total === 1 &&
      orgContacts.body?.rows?.[0]?.name === "Dan Pop" &&
      orgContacts.body?.rows?.[0]?.accountId === org?.id,
    `http=${orgContacts.status} total=${orgContacts.body?.total}`,
  )

  const badAccount = await api.call("/contacts", {
    method: "POST",
    headers: admin.headers,
    body: JSON.stringify({ name: "Bad Link", email: "bad@example.com", accountId: "   " }),
  })
  score.check(
    "a blank accountId is refused at the schema edge (400)",
    badAccount.status === 400,
    `http=${badAccount.status}`,
  )

  // A well-formed but NONEXISTENT accountId. Today the kernel offers cubes no cross-cube
  // read, so the refusal is not implementable yet: the create SUCCEEDS and this assertion
  // pins today's real behaviour. This is the assertion to FLIP to 400 once the
  // kernel-enforced relation lands (shepherd's separate change in the qwbe repo).
  const ghostAccount = await api.call("/contacts", {
    method: "POST",
    headers: admin.headers,
    body: JSON.stringify({ name: "Ghost Link", email: "ghost@example.com", accountId: "acc-doesnotexist" }),
  })
  score.check(
    "a nonexistent accountId is still accepted (kernel relation pending) — FLIP to 400 when it lands",
    ghostAccount.status === 200 && ghostAccount.body?.accountId === "acc-doesnotexist",
    `http=${ghostAccount.status}`,
  )

  // The move: PATCH /contacts/:id changes the one truth, including unlinking.
  const movedContact = await api.call(`/contacts/${contact?.id}`, {
    method: "PATCH",
    headers: admin.headers,
    body: JSON.stringify({ accountId: org?.id }),
  })
  score.check(
    "PATCH /contacts/:id moves a contact to another organization",
    movedContact.status === 200 && movedContact.body?.accountId === org?.id,
    `http=${movedContact.status} accountId=${movedContact.body?.accountId}`,
  )
  const unlinkedContact = await api.call(`/contacts/${contact?.id}`, {
    method: "PATCH",
    headers: admin.headers,
    body: JSON.stringify({ accountId: null }),
  })
  score.check(
    "PATCH /contacts/:id unlinks a contact (accountId null)",
    unlinkedContact.status === 200 && unlinkedContact.body?.accountId === null,
    `http=${unlinkedContact.status}`,
  )

  // ---- independence: each cube serves while the others are absent -----------------
  // QWBE_MOUNTED restricts the mount set; boot twice more, one cube at a time. This is the
  // decided minimal relation made observable: neither cube needs the other to start.
  for (const [only, route] of [
    ["crm/contacts", "/contacts"],
    ["crm/contracts", "/contracts"],
    ["crm/accounts", "/accounts"],
  ]) {
    const p2 = await freePort()
    const d2 = scratchDataDir(`crm-only-${only.replace("/", "-")}`)
    const s2 = await startServer(p2, {
      QWBE_DATA_DIR: d2,
      QWBE_MOUNTED: `auth,account,settings,cli,crm,${only}`,
    })
    if (!s2.alive) {
      score.check(`${only} boots without the other cube`, false, s2.output.split("\n").slice(-3).join(" "))
      dropScratch(d2)
      continue
    }
    try {
      const a2 = client(p2)
      const login = await a2.login()
      const res = await a2.call(route, { headers: login.headers })
      score.check(`${only} serves without the other cube`, res.status === 200 && res.body?.total === 0, `http=${res.status}`)
    } finally {
      await stopServer(s2)
      dropScratch(d2)
    }
  }
} finally {
  await stopServer(server)
  dropScratch(data)
}

process.exit(score.report("crm-pack runtime probe"))
