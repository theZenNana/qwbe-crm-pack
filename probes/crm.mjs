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
  for (const want of ["crm", "crm/contacts", "crm/contracts"]) {
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

  // ---- independence: each cube serves while the other is absent --------------------
  // QWBE_MOUNTED restricts the mount set; boot twice more, one cube at a time. This is the
  // decided minimal relation made observable: neither cube needs the other to start.
  for (const [only, route] of [
    ["crm/contacts", "/contacts"],
    ["crm/contracts", "/contracts"],
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
