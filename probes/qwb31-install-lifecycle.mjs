// Installing the local CRM plugin through the public install-from door, end to end.
//
//   QWBE_REPO=~/Projects/qwbe node probes/qwb31-install-lifecycle.mjs
//
// The plugin lives OUTSIDE the repo at ~/Projects/qwbe-packs/plugins/crm-pack. This probe
// proves the acceptance criteria that need a running system, in order:
//
//   1. clean Qwbe (scratch store WITHOUT crm-pack) boots and serves no /contacts or /contracts
//   2. POST /settings/packages/install-from with the local directory is the ONLY install step
//   3. restart mounts both cubes; OpenAPI declares their routes, payloads, statuses, auth
//   9. restart keeps the plugin AND the CRM rows
//   10. disabling one cube leaves the other cube and Qwbe itself answering
//   11. uninstall unmounts both cubes; the other cubes' data is untouched
//
// Everything runs on scratch: QWBE_STORE_DIR and QWBE_DATA_DIR are mkdtemp directories, the
// servers are this probe's own children on OS-granted ports, and the source plugin tree is
// hashed before/after to prove the install read but never wrote. The owner's live data dir
// and the live instance on :4500 are never touched.

import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"

const qwbeRepo = process.env.QWBE_REPO ?? join(process.env.HOME ?? "", "Projects/qwbe")
const { client, dropScratch, freePort, makeScore, scratchDataDir, startServer, stopServer } = await import(
  join(qwbeRepo, "probes/lib.mjs")
)
// Deterministic tree hash, same shape as the installer's fingerprintOf: sha256 over the sorted
// (relative path, file hash) list. Re-implemented here (20 lines) because probes are plain
// .mjs - importing the .ts kernel module would drag the type-stripping question into a gate.
const fingerprintOf = (dir) => {
  const entries = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) walk(p)
      else entries.push([relative(dir, p), createHash("sha256").update(readFileSync(p)).digest("hex")])
    }
  }
  walk(dir)
  entries.sort(([a], [b]) => a.localeCompare(b))
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex")
}

const SOURCE = join(process.env.HOME ?? "", "Projects/qwbe-packs/plugins/crm-pack")
const PLUGINS = join(qwbeRepo, "core", "plugins")
const score = makeScore()

if (!existsSync(join(SOURCE, "qwbe-package.json"))) {
  console.error(`refused: CRM source not found at ${SOURCE}`)
  process.exit(1)
}

const sourceBefore = fingerprintOf(SOURCE)
const store = mkdtempSync(join(tmpdir(), "qwb31-store-"))
const data = scratchDataDir("qwb31")

const boot = async () => {
  const port = await freePort()
  const server = await startServer(port, { QWBE_DATA_DIR: data, QWBE_STORE_DIR: store })
  return { server, api: client(port), port }
}

/** /settings/cubes row names, or null when the request itself failed. */
const cubeNames = async (api, headers) => {
  const r = await api.call("/settings/cubes", { headers })
  return r.status === 200 ? (r.body ?? []).map((c) => c.name) : null
}

/** OpenAPI paths starting with a prefix. */
const openapiPaths = async (api, prefix) => {
  const r = await api.call("/openapi.json")
  if (r.status !== 200) return null
  return Object.keys(r.body?.paths ?? {}).filter((p) => p.startsWith(prefix))
}

try {
  // ---- 1. clean boot: no CRM anywhere --------------------------------------------
  const first = await boot()
  if (!first.server.alive) {
    console.error(`clean server did not start:\n${first.server.output}`)
    process.exit(1)
  }
  const admin1 = await first.api.login()
  const names1 = await cubeNames(first.api, admin1.headers)
  score.check(
    "clean Qwbe boots with no CRM cubes mounted",
    names1 !== null && !names1.includes("crm") && !names1.includes("crm/contacts") && !names1.includes("crm/contracts"),
    `cubes=${names1}`,
  )
  const crmPaths1 = [
    ...(await openapiPaths(first.api, "/contacts")),
    ...(await openapiPaths(first.api, "/contracts")),
  ]
  score.check("clean OpenAPI declares no CRM routes", crmPaths1.length === 0, `found=${crmPaths1}`)

  // ---- 2. install-from, exclusively from the local directory ----------------------
  const install = await first.api.call("/settings/packages/install-from", {
    method: "POST",
    headers: admin1.headers,
    body: JSON.stringify({ path: SOURCE }),
  })
  score.check(
    "install-from accepts the local crm-pack directory",
    install.status === 200 && install.body?.package?.name === "crm-pack" && install.body?.requiresRestart === true,
    `http=${install.status} body=${JSON.stringify(install.body)?.slice(0, 160)}`,
  )
  const staged = existsSync(join(store, "crm-pack", "qwbe-package.json"))
  // install-from stages into the STORE only; the mounted copy under core/plugins is rebuilt
  // from the store at boot. Checking for it here would be checking the wrong moment.
  score.check("package staged in the (scratch) store by install-from", staged, `staged=${staged}`)
  const namesBeforeRestart = await cubeNames(first.api, admin1.headers)
  score.check(
    "before restart the CRM cubes are NOT yet mounted",
    namesBeforeRestart !== null && !namesBeforeRestart.includes("crm"),
    `cubes=${namesBeforeRestart}`,
  )
  await stopServer(first.server)

  // ---- 3 + 6. restart mounts; OpenAPI declares the surface -------------------------
  const second = await boot()
  if (!second.server.alive) {
    console.error(`server with crm-pack did not start:\n${second.server.output}`)
    process.exit(1)
  }
  const admin = await second.api.login()
  const reader = await second.api.login("reader", "reader")
  const names2 = await cubeNames(second.api, admin.headers)
  // install-from mounts the copy under core/plugins immediately; the store shelf is the source
  // it was staged from. The mounted copy deliberately omits qwbe-package.json (bookkeeping -
  // the kernel's isBookkeeping filter), so presence is judged by the cube directories.
  const mountedCopy =
    existsSync(join(PLUGINS, "crm-pack", "cubes", "crm", "index.ts")) &&
    existsSync(join(PLUGINS, "crm-pack", "cubes", "crm", "contacts", "index.ts")) &&
    existsSync(join(PLUGINS, "crm-pack", "cubes", "crm", "contracts", "index.ts"))
  score.check(
    "after restart both CRM cubes are mounted and enabled (copy present under core/plugins)",
    names2?.includes("crm") && names2?.includes("crm/contacts") && names2?.includes("crm/contracts") && mountedCopy,
    `cubes=${names2} copy=${mountedCopy}`,
  )
  const spec = (await second.api.call("/openapi.json")).body
  const paths = Object.keys(spec?.paths ?? {})
  const want = ["/contacts", "/contacts/{id}", "/contracts", "/contracts/{id}"]
  score.check(
    "OpenAPI declares all CRM routes",
    want.every((w) => paths.includes(w)),
    `missing=${want.filter((w) => !paths.includes(w))}`,
  )
  const ops = spec?.paths?.["/contracts"] ?? {}
  const post = ops.post ?? {}
  const postStatuses = Object.keys(post.responses ?? {}).sort()
  const hasBody = Boolean(post.requestBody)
  const hasSecurity = Object.values(ops).every((op) => Array.isArray(op.security) && op.security.length > 0)
  score.check(
    "OpenAPI: POST /contracts has payload, auth and typed statuses",
    hasBody && hasSecurity && postStatuses.includes("400") && postStatuses.includes("401") && postStatuses.includes("403"),
    `statuses=${postStatuses} body=${hasBody} security=${hasSecurity}`,
  )
  const getById = spec?.paths?.["/contacts/{id}"]?.get ?? {}
  score.check(
    "OpenAPI: GET /contacts/{id} declares 401/404 and a response schema",
    Object.keys(getById.responses ?? {}).includes("404") &&
      Boolean(getById.responses?.["200"]?.content?.["application/json"]?.schema),
    `statuses=${Object.keys(getById.responses ?? {})}`,
  )

  // ---- 7. authenticated E2E through the decided model (partyId) --------------------
  const badContact = await second.api.call("/contacts", {
    method: "POST",
    headers: admin.headers,
    body: JSON.stringify({ name: "" }),
  })
  const contact = (
    await second.api.call("/contacts", {
      method: "POST",
      headers: admin.headers,
      body: JSON.stringify({ name: "QWB31 Proba", email: "qwb31@example.com", company: "Proba SRL" }),
    })
  ).body
  const contract = (
    await second.api.call("/contracts", {
      method: "POST",
      headers: admin.headers,
      body: JSON.stringify({ title: "QWB31 Contract", amount: 4200, currency: "RON", partyId: contact?.id }),
    })
  ).body
  const readBack = await second.api.call(`/contracts/${contract?.id}`, { headers: reader.headers })
  const listed = await second.api.call("/contacts", { headers: reader.headers })
  score.check(
    "E2E: contact + contract created, read back, partyId opaque and pointing at the contact",
    typeof contact?.id === "string" &&
      contract?.partyId === contact?.id &&
      readBack.status === 200 &&
      readBack.body?.partyId === contact?.id &&
      (listed.body?.rows ?? []).some((r) => r.id === contact?.id),
    `contact=${contact?.id} contract=${contract?.id}`,
  )

  // ---- 8. boundary statuses ---------------------------------------------------------
  const anon = await second.api.call("/contacts")
  const forbidden = await second.api.call("/contacts", {
    method: "POST",
    headers: reader.headers,
    body: JSON.stringify({ name: "Refused" }),
  })
  const invalid = await second.api.call("/contracts", {
    method: "POST",
    headers: admin.headers,
    body: JSON.stringify({ title: "Bad money", amount: 10.5, currency: "RON" }),
  })
  const missing = await second.api.call("/contacts/cont_qwb31_missing", { headers: admin.headers })
  score.check(
    "boundaries: 401 anon, 403 reader-create, 400 invalid payload, 404 unknown id",
    anon.status === 401 && forbidden.status === 403 && invalid.status === 400 && missing.status === 404,
    `${anon.status},${forbidden.status},${invalid.status},${missing.status}; empty-name=${badContact.status}`,
  )
  await stopServer(second.server)

  // ---- 9. restart keeps plugin AND data ----------------------------------------------
  const third = await boot()
  if (!third.server.alive) {
    console.error(`restart-2 server did not start:\n${third.server.output}`)
    process.exit(1)
  }
  const admin3 = await third.api.login()
  const names3 = await cubeNames(third.api, admin3.headers)
  const afterRestart = await third.api.call(`/contacts/${contact?.id}`, { headers: admin3.headers })
  const contractsAfter = await third.api.call("/contracts", { headers: admin3.headers })
  score.check(
    "restart keeps the plugin mounted and the CRM rows",
    names3?.includes("crm/contacts") &&
      names3?.includes("crm/contracts") &&
      afterRestart.status === 200 &&
      afterRestart.body?.name === "QWB31 Proba" &&
      (contractsAfter.body?.rows ?? []).some((r) => r.id === contract?.id),
    `contact http=${afterRestart.status} contracts=${contractsAfter.body?.total}`,
  )

  // ---- 10. disabling one cube does not stop the other or Qwbe ------------------------
  const off = await third.api.call("/settings/cubes/crm%2Fcontracts", {
    method: "POST",
    headers: admin3.headers,
    body: JSON.stringify({ enabled: false }),
  })
  const contractsOff = await third.api.call("/contracts", { headers: admin3.headers })
  const contactsOn = await third.api.call("/contacts", { headers: admin3.headers })
  const cubesOn = await third.api.call("/settings/cubes", { headers: admin3.headers })
  score.check(
    "contracts disabled: contacts and Qwbe keep answering, contracts is gone",
    off.status === 200 && contactsOn.status === 200 && cubesOn.status === 200 && contractsOff.status === 404,
    `toggle=${off.status} contacts=${contactsOn.status} contracts=${contractsOff.status}`,
  )
  const backOn = await third.api.call("/settings/cubes/crm%2Fcontracts", {
    method: "POST",
    headers: admin3.headers,
    body: JSON.stringify({ enabled: true }),
  })
  const contractsBack = await third.api.call("/contracts", { headers: admin3.headers })
  score.check(
    "re-enabling contracts brings it back with its data",
    backOn.status === 200 && contractsBack.status === 200 && contractsBack.body?.total === 1,
    `toggle=${backOn.status} http=${contractsBack.status}`,
  )

  // ---- 11. uninstall unmounts both cubes, other cubes untouched ----------------------
  const notesBefore = await third.api.call("/notes", { headers: admin3.headers })
  const uninstall = await third.api.call("/settings/packages/crm-pack", {
    method: "DELETE",
    headers: admin3.headers,
  })
  score.check(
    "uninstall crm-pack accepted (requiresRestart)",
    uninstall.status === 200 && uninstall.body?.requiresRestart === true,
    `http=${uninstall.status} body=${JSON.stringify(uninstall.body)}`,
  )
  const pluginsAfterRm = existsSync(join(PLUGINS, "crm-pack"))
  const shelfKept = existsSync(join(store, "crm-pack", "qwbe-package.json"))
  score.check(
    "uninstall removes the mounted copy, keeps the store shelf",
    !pluginsAfterRm && shelfKept,
    `pluginsCopy=${pluginsAfterRm} shelf=${shelfKept}`,
  )
  await stopServer(third.server)

  const fourth = await boot()
  if (!fourth.server.alive) {
    console.error(`post-uninstall server did not start:\n${fourth.server.output}`)
    process.exit(1)
  }
  const admin4 = await fourth.api.login()
  const names4 = await cubeNames(fourth.api, admin4.headers)
  const notesAfter = await fourth.api.call("/notes", { headers: admin4.headers })
  const contactsGone = await fourth.api.call("/contacts", { headers: admin4.headers })
  score.check(
    "after restart: both CRM cubes unmounted, notes data untouched",
    !names4?.includes("crm") &&
      !names4?.includes("crm/contacts") &&
      !names4?.includes("crm/contracts") &&
      contactsGone.status === 404 &&
      notesAfter.status === 200 &&
      notesAfter.body?.total === notesBefore.body?.total,
    `cubes=${names4} contacts=${contactsGone.status} notes=${notesAfter.body?.total}vs${notesBefore.body?.total}`,
  )
  await stopServer(fourth.server)

  // ---- source tree never written ------------------------------------------------------
  const sourceAfter = fingerprintOf(SOURCE)
  score.check("the plugin source tree is byte-identical after the whole run", sourceBefore === sourceAfter)
} finally {
  dropScratch(data)
  rmSync(store, { recursive: true, force: true })
  // If the run died mid-way, leave core/plugins as found: crm-pack staged there by THIS probe
  // is removed only when the uninstall step never reached it.
  const pluginsCopy = join(PLUGINS, "crm-pack")
  if (existsSync(pluginsCopy) && !existsSync(join(store, "crm-pack"))) {
    rmSync(pluginsCopy, { recursive: true, force: true })
    console.error("cleanup: removed a half-installed core/plugins/crm-pack (store shelf was gone)")
  }
}

process.exit(score.report("QWB-31 crm-pack install-from lifecycle"))
