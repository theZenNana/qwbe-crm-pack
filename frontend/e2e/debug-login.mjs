// Diagnostic for the login scenario: prints what each step actually returns, so a RED verdict
// can be traced to the step that produced it instead of guessed at. Not part of `npm run e2e`.
//
// Usage: QWBE_E2E_QWBE_PORT=<p1> QWBE_E2E_FRONTEND_PORT=<p2> node e2e/debug-login.mjs
// The stack must already be running on those ports.

import { CONFIG, orca, refFor, setPage, snapshot, waitForText, waitForUrl } from "./lib.mjs"

const fe = `http://localhost:${CONFIG.frontendPort}`
console.log("frontend:", fe)

const created = orca("tab", "create", "--url", `${fe}/login`)
setPage(created.browserPageId)
orca("tab", "switch", "--page", created.browserPageId, "--focus")
console.log("page id:", created.browserPageId)

console.log("wait for 'Sign in':", await waitForText("Sign in", 20_000))
let snap = snapshot()
console.log("origin after open:", snap.origin)
console.log("snapshot text length:", snap.text.length)

const userRef = refFor(snap.refs, "Username")
const passRef = refFor(snap.refs, "Password")
const submitRef = refFor(snap.refs, (n) => n === "Sign in")
console.log("refs:", { userRef, passRef, submitRef })

orca("click", "--element", userRef, "--page", created.browserPageId)
orca("type", "--input", CONFIG.username, "--page", created.browserPageId)
orca("click", "--element", passRef, "--page", created.browserPageId)
orca("type", "--input", CONFIG.password, "--page", created.browserPageId)
orca("click", "--element", submitRef, "--page", created.browserPageId)

console.log("waitForUrl('.*/me.*'):", await waitForUrl(".*/me.*", 25_000))
console.log("waitForText('Signed in as'):", await waitForText("Signed in as", 25_000))
snap = snapshot()
console.log("origin after login:", snap.origin)
console.log("text has 'Signed in as':", snap.text.includes("Signed in as"))
console.log("text has 'admin':", snap.text.includes("admin"))
console.log("--- snapshot head ---")
console.log(snap.text.slice(0, 700))

orca("tab", "close", "--page", created.browserPageId)
