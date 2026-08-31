// Diagnostic for the inline-edit scenario: logs in, opens /accounts, clicks the
// City edit button, and prints the full accessibility snapshot so the editor
// (role, name, existence) can be seen. Not part of `npm run e2e`.
//
// Usage: QWBE_E2E_QWBE_PORT=<p1> QWBE_E2E_FRONTEND_PORT=<p2> node e2e/debug-inline-edit.mjs

import { CONFIG, orca, setPage, snapshot, type, waitForText, waitForUrl } from "./lib.mjs"
import { makeClient, seedUp } from "./seed.mjs"

const FE = () => `http://localhost:${CONFIG.frontendPort}`
const openTab = async (path) => {
  const r = orca("tab", "create", "--url", `${FE()}${path}`)
  orca("tab", "switch", "--page", r.browserPageId, "--focus")
  setPage(r.browserPageId)
  for (let i = 0; i < 15; i++) {
    const s = snapshot()
    if (s.origin.startsWith(FE())) return r.browserPageId
    orca("tab", "switch", "--page", r.browserPageId, "--focus")
    await new Promise((res) => setTimeout(res, 2000))
  }
  throw new Error("tab never became snapshot target")
}

const api = await makeClient(CONFIG.qwbePort)
await seedUp(api, console.log)

const pageId = await openTab("/login")
await waitForText("Sign in", 20_000)
let snap = snapshot()
const ref = (role, re) => Object.entries(snap.refs).find(([, v]) => v.role === role && re.test(v.name ?? ""))?.[0]
orca("click", "--element", ref("textbox", /user/i))
type(CONFIG.username)
orca("click", "--element", ref("textbox", /pass/i))
type(CONFIG.password)
orca("click", "--element", ref("button", /^Sign in$/))
console.log("waitForUrl /me:", await waitForUrl(".*/me.*", 25_000))
orca("tab", "close", "--page", pageId)

const listPage = await openTab("/accounts")
await waitForText("E2E Alpha", 30_000)
snap = snapshot()
const cityBtn = Object.entries(snap.refs).find(([, v]) => v.role === "button" && /^Edit .*City/i.test(v.name ?? ""))
console.log("city button ref:", cityBtn?.[0], JSON.stringify(cityBtn?.[1]))
console.log("all refs:")
for (const [k, v] of Object.entries(snap.refs)) console.log(`  ${k} ${v.role} ${JSON.stringify(v.name ?? "")}`)

for (let attempt = 1; attempt <= 3; attempt++) {
  orca("click", "--element", cityBtn[0])
  await new Promise((r) => setTimeout(r, 1500))
  snap = snapshot()
  const textboxes = Object.entries(snap.refs).filter(([, v]) => ["textbox", "combobox", "searchbox"].includes(v.role))
  console.log(`--- after click attempt ${attempt}: ${textboxes.length} text-like refs ---`)
  for (const [k, v] of textboxes) console.log(`  ${k} ${v.role} ${JSON.stringify(v.name ?? "")}`)
  if (textboxes.length) {
    console.log("--- full snapshot text ---")
    console.log(snap.text.slice(0, 3000))
    break
  }
}
orca("tab", "close", "--page", listPage)
