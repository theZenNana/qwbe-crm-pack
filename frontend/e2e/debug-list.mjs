// @ts-check
// Diagnostic for the list scenario: seeds through the API, then shows what the /accounts page
// actually renders and what the proxy returns, so a missing row can be traced to the API, the
// proxy or the page. Not part of `npm run e2e`.
//
// Usage: QWBE_E2E_QWBE_PORT=<p1> QWBE_E2E_FRONTEND_PORT=<p2> node e2e/debug-list.mjs
// The stack must already be running on those ports.

import { CONFIG, orca, setPage, snapshot } from "./lib.mjs"
import { makeClient, seedUp } from "./seed.mjs"

const fe = `http://localhost:${CONFIG.frontendPort}`
const api = await makeClient(CONFIG.qwbePort)
const seeded = await seedUp(api)
console.log("seeded:", JSON.stringify(seeded).slice(0, 300))

const list = await api.call("/accounts?offset=0&limit=5")
console.log("API /accounts:", list.status, JSON.stringify(list.body).slice(0, 400))

const meta = await api.call(`/catalog/${encodeURIComponent("crm/accounts")}/metadata`)
console.log("API metadata:", meta.status, JSON.stringify(meta.body).slice(0, 200))

const created = orca("tab", "create", "--url", `${fe}/accounts`)
setPage(created.browserPageId)
orca("tab", "switch", "--page", created.browserPageId, "--focus")
await new Promise((r) => setTimeout(r, 6000))
const snap = snapshot()
console.log("origin:", snap.origin)
console.log("--- page snapshot ---")
console.log(snap.text.slice(0, 1500))
orca("tab", "close", "--page", created.browserPageId)
