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
// The plugin must be installed first - the official path (QWB-54, ticket 22):
//   settings:install-from <this directory>  (or POST /settings/packages/install-from)
// and the server restarted. Never a hand copy into core/plugins.
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
// The scratch ledger has no record of crm/accounts (the organizations cube's declared
// predecessor, QWB-54 ticket 14): the boot authorizes its own pre-ledger history, exactly
// like the throwaway bench in tools/import.test.mjs.
const LEGACY = { QWBE_LEGACY_MIGRATIONS: "crm/accounts:crm-pack" }
const server = await startServer(port, { QWBE_DATA_DIR: data, ...LEGACY })

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
  for (const want of ["crm", "crm/organizations", "crm/contacts", "crm/contracts"]) {
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
    "company stays free text on the contact (no organization entity folded in)",
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

  // ---- organizations (QWB-47): create / get / update, 403, 404, paging, sorting ----------------
  const anonA = await api.call("/organizations")
  score.check("organizations requires authentication (401)", anonA.status === 401, `http=${anonA.status}`)

  const forbiddenA = await api.call("/organizations", {
    method: "POST",
    headers: reader.headers,
    body: JSON.stringify({ name: "Refused Reader SRL" }),
  })
  score.check("reader cannot create an organization (403)", forbiddenA.status === 403, `http=${forbiddenA.status}`)

  const missingA = await api.call("/organizations/acc_missing", { headers: admin.headers })
  score.check("missing organization is 404", missingA.status === 404, `http=${missingA.status}`)

  const createdA = await api.call("/organizations", {
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

  const updatedA = await api.call(`/organizations/${org?.id}`, {
    method: "PATCH",
    headers: admin.headers,
    body: JSON.stringify({ billingCity: "Cluj", rating: "active" }),
  })
  score.check(
    "admin updates an organization (patch keeps the rest)",
    updatedA.status === 200 && updatedA.body?.billingCity === "Cluj" && updatedA.body?.name === "Ada Industries SRL",
    `http=${updatedA.status}`,
  )

  const pageA = await api.call("/organizations?limit=1&sortBy=name", { headers: reader.headers })
  score.check(
    "organizations list pages and sorts",
    pageA.status === 200 && pageA.body?.rows?.length === 1 && pageA.body?.total === 1 && pageA.body?.sortedBy === "name",
    `http=${pageA.status} sortedBy=${pageA.body?.sortedBy}`,
  )

  // Ticket 07: the list is the kernel's generic one, and the manifest's `searchable` fields
  // are the filter contract. Two organizations, a filter on name, exactly one back.
  const secondOrg = await api.call("/organizations", {
    method: "POST",
    headers: admin.headers,
    body: JSON.stringify({ name: "Beta Constructions SRL", industry: "construction" }),
  })
  const filteredA = await api.call(`/organizations?name=${encodeURIComponent("Ada Industries SRL")}`, {
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

  // ---- the relation: organizationId on the contact is the one truth -----------------------------
  const withOrganization = await api.call("/contacts", {
    method: "POST",
    headers: admin.headers,
    body: JSON.stringify({ name: "Dan Pop", email: "dan@example.com", organizationId: org?.id }),
  })
  score.check(
    "contact created with organizationId pointing at an existing organization",
    withOrganization.status === 200 && withOrganization.body?.organizationId === org?.id,
    `http=${withOrganization.status} organizationId=${withOrganization.body?.organizationId}`,
  )

  const withoutOrganization = await api.call("/contacts", {
    method: "POST",
    headers: admin.headers,
    body: JSON.stringify({ name: "Maria Radu", email: "maria@example.com" }),
  })
  score.check(
    "contact created without organizationId comes back null",
    withoutOrganization.status === 200 && withoutOrganization.body?.organizationId === null,
    `http=${withoutOrganization.status} organizationId=${withoutOrganization.body?.organizationId}`,
  )

  const orgContacts = await api.call(`/contacts?organizationId=${org?.id}`, { headers: reader.headers })
  score.check(
    "an organization's contacts are derived by filtering on organizationId",
    orgContacts.status === 200 &&
      orgContacts.body?.total === 1 &&
      orgContacts.body?.rows?.[0]?.name === "Dan Pop" &&
      orgContacts.body?.rows?.[0]?.organizationId === org?.id,
    `http=${orgContacts.status} total=${orgContacts.body?.total}`,
  )

  const badOrganizationId = await api.call("/contacts", {
    method: "POST",
    headers: admin.headers,
    body: JSON.stringify({ name: "Bad Link", email: "bad@example.com", organizationId: "   " }),
  })
  score.check(
    "a blank organizationId is refused at the schema edge (400)",
    badOrganizationId.status === 400,
    `http=${badOrganizationId.status}`,
  )

  // A well-formed but NONEXISTENT organizationId. Today the kernel offers cubes no cross-cube
  // read, so the refusal is not implementable yet: the create SUCCEEDS and this assertion
  // pins today's real behaviour. This is the assertion to FLIP to 400 once the
  // kernel-enforced relation lands (shepherd's separate change in the qwbe repo).
  const ghostOrganizationId = await api.call("/contacts", {
    method: "POST",
    headers: admin.headers,
    body: JSON.stringify({ name: "Ghost Link", email: "ghost@example.com", organizationId: "org-doesnotexist" }),
  })
  score.check(
    "a nonexistent organizationId is still accepted (kernel relation pending) — FLIP to 400 when it lands",
    ghostOrganizationId.status === 200 && ghostOrganizationId.body?.organizationId === "org-doesnotexist",
    `http=${ghostOrganizationId.status}`,
  )

  // The move: PATCH /contacts/:id changes the one truth, including unlinking.
  const movedContact = await api.call(`/contacts/${contact?.id}`, {
    method: "PATCH",
    headers: admin.headers,
    body: JSON.stringify({ organizationId: org?.id }),
  })
  score.check(
    "PATCH /contacts/:id moves a contact to another organization",
    movedContact.status === 200 && movedContact.body?.organizationId === org?.id,
    `http=${movedContact.status} organizationId=${movedContact.body?.organizationId}`,
  )
  const unlinkedContact = await api.call(`/contacts/${contact?.id}`, {
    method: "PATCH",
    headers: admin.headers,
    body: JSON.stringify({ organizationId: null }),
  })
  score.check(
    "PATCH /contacts/:id unlinks a contact (organizationId null)",
    unlinkedContact.status === 200 && unlinkedContact.body?.organizationId === null,
    `http=${unlinkedContact.status}`,
  )

  // ---- independence: each cube serves while the others are absent -----------------
  // QWBE_MOUNTED restricts the mount set; boot twice more, one cube at a time. This is the
  // decided minimal relation made observable: neither cube needs the other to start.
  for (const [only, route] of [
    ["crm/contacts", "/contacts"],
    ["crm/contracts", "/contracts"],
    ["crm/organizations", "/organizations"],
  ]) {
    const p2 = await freePort()
    const d2 = scratchDataDir(`crm-only-${only.replace("/", "-")}`)
    const s2 = await startServer(p2, {
      QWBE_DATA_DIR: d2,
      QWBE_MOUNTED: `auth,account,settings,cli,crm,${only}`,
      ...LEGACY,
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
