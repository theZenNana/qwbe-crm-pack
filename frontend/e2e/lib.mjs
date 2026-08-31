// Shared helpers for the Orca-driven end-to-end scenarios (QWB-51).
//
// Plain Node, no new dependencies. Three concerns live here:
// - an orca() wrapper around the Orca CLI (every call --json, every failure loud),
// - a tiny qwbe API client for the seed,
// - the results ledger (one PASS/FAIL line per scenario) and screenshot writer.

import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export const here = dirname(fileURLToPath(import.meta.url))
export const frontendDir = join(here, "..")

export const ORCA = process.env.ORCA_CLI ?? "/home/lucian/.config/orca/linux-orca-cli-shim/orca"

/** Ports are picked at run time and must never be 4500 or 4510 (owner's servers). */
export const isForbiddenPort = (p) => p === 4500 || p === 4510

export const CONFIG = {
  qwbeRepo: process.env.QWBE_REPO ?? "/home/lucian/Projects/Qwbe/qwbe",
  crmPack: process.env.CRM_PACK ?? "/home/lucian/Projects/Qwbe/plugins/crm-pack",
  // The customfields pack is a separate repository (QWB-46); it owns the
  // definition endpoints the custom-field UI talks to.
  customFieldsPack:
    process.env.CUSTOMFIELDS_PACK ?? "/home/lucian/Projects/Qwbe/plugins/customfields-pack",
  workDir: process.env.QWBE_E2E_WORK ?? "/tmp/qwbe-e2e",
  dataDir: process.env.QWBE_E2E_DATA ?? "/tmp/qwbe-e2e-data",
  resultsDir:
    process.env.QWBE_E2E_RESULTS ??
    join("/home/lucian/Projects/wiki/aplicatii/qwbe/crm-pack/e2e", new Date().toISOString().slice(0, 10)),
  username: "admin",
  password: "admin",
  qwbePort: Number(process.env.QWBE_E2E_QWBE_PORT ?? 0),
  frontendPort: Number(process.env.QWBE_E2E_FRONTEND_PORT ?? 0),
  // The stack this suite runs against, as the merged platform defines it.
  //
  // `account` is not optional: it is the credentials provider, so without it every login is
  // 401 and every scenario after the first is skipped. `catalog` publishes the field metadata
  // the lists are built from, and `links` resolves a relation to its summary.
  // `permissions` is the entity-permission provider: without it every create answers 500 with
  // `PermissionInvalid: entity permissions provider unavailable` and nothing can be seeded.
  mounted:
    "auth,account,permissions,settings,cli,catalog,links,crm,crm/accounts,crm/contacts,crm/contracts,customfields",
}

// ---------------------------------------------------------------------------
// Results ledger
// ---------------------------------------------------------------------------

const results = []

export function record(name, verdict, detail = "", screenshot = "") {
  results.push({ name, verdict, detail, screenshot })
  console.log(`${verdict === "PASS" ? "  PASS" : verdict === "RED" ? "  RED " : "  SKIP"} ${name}${detail ? ` — ${detail}` : ""}${screenshot ? ` [${screenshot}]` : ""}`)
  return verdict === "PASS"
}

export function writeResults(extraLines = []) {
  mkdirSync(CONFIG.resultsDir, { recursive: true })
  const date = new Date().toISOString().replace("T", " ").slice(0, 19)
  const lines = [
    `# crm-pack frontend e2e (Orca browser) — ${date}`,
    "",
    ...extraLines,
    "",
    ...results.map((r) => `- **${r.verdict}** ${r.name}${r.detail ? ` — ${r.detail}` : ""}${r.screenshot ? ` (screenshot: ${r.screenshot})` : ""}`),
    "",
  ]
  writeFileSync(join(CONFIG.resultsDir, "results.md"), lines.join("\n"))
  return results
}

/** One scenario screenshot, saved into the dated results directory. */
export function saveScreenshot(name, png) {
  mkdirSync(CONFIG.resultsDir, { recursive: true })
  const file = `${name}.png`
  writeFileSync(join(CONFIG.resultsDir, file), png)
  return file
}

// ---------------------------------------------------------------------------
// Orca CLI
// ---------------------------------------------------------------------------

const sleepSync = (ms) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    // Deliberate: orca() is synchronous and its callers are not, so the retry backoff cannot be
    // awaited here. The pause is short and only happens after the runtime has already dropped.
  }
}

/** One attempt: run the command and return its parsed envelope, or throw. */
function orcaOnce(args) {
  let out
  try {
    out = execFileSync(ORCA, [...args, "--json"], { encoding: "utf8", timeout: 60_000 })
  } catch (e) {
    // A failed orca command still prints its JSON envelope on stdout — surface it.
    out = typeof e.stdout === "string" && e.stdout.trim() ? e.stdout : ""
    if (!out) throw new Error(`orca ${args.join(" ")} failed: ${e.message}`)
  }
  let parsed
  try {
    parsed = JSON.parse(out)
  } catch {
    throw new Error(`orca ${args.join(" ")} returned non-JSON output:\n${out.slice(0, 500)}`)
  }
  if (!parsed.ok) {
    throw new Error(`orca ${args.join(" ")} failed: ${parsed.error?.code ?? "?"} ${parsed.error?.message ?? ""}`)
  }
  return parsed.result
}

/**
 * Run one orca command; throw with the CLI's own output on failure.
 *
 * A dropped runtime connection (`runtime_unavailable`) is retried: the Orca app recovers on its
 * own within a second or two, and one such blip killed an otherwise green run at the second
 * scenario. Every other failure is raised immediately — a retry loop must not hide a real defect.
 */
export function orca(...args) {
  let lastError
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return orcaOnce(args)
    } catch (e) {
      lastError = e
      if (!String(e.message).includes("runtime_unavailable")) throw e
      sleepSync(2000 * (attempt + 1))
    }
  }
  throw lastError
}

// The page every command talks to. Orca addresses tabs by a stable page id, and the suite must
// name it on EVERY call: relying on which tab happens to be focused means a tab the owner opened
// (or a stale one from an earlier run) answers instead, and the scenario reads someone else's
// page. That is exactly how run 2 read "Signed in as" as missing while the screenshot showed it.
let currentPage
export const setPage = (id) => {
  currentPage = id
}
export const pageArgs = () => (currentPage ? ["--page", currentPage] : [])

/** Accessibility snapshot of the suite's tab: { origin, text, refs }. */
export function snapshot() {
  const r = orca("snapshot", ...pageArgs())
  return { origin: r.origin ?? "", text: r.snapshot ?? "", refs: r.refs ?? {} }
}

/** First ref whose accessible name matches a predicate (string or regex). */
export function refFor(refs, match) {
  const pred = typeof match === "string" ? (n) => n.includes(match) : typeof match === "function" ? match : (n) => match.test(n)
  for (const [ref, info] of Object.entries(refs)) {
    if (pred(info.name ?? "")) return ref
  }
  return undefined
}

export const click = (ref) => orca("click", "--element", ref, ...pageArgs())
/**
 * Type at the current focus, through the browser, not the desktop.
 *
 * The OS-level `orca type` needs a focused desktop window; on a locked screen
 * it reports ok and lands nothing (observed 2026-08-31, three runs). The CDP
 * path below has the same semantics for the inputs this suite types into: the
 * value is set through the native setter (so React's controlled inputs see
 * it) and an `input` event is dispatched, exactly what a keystroke does.
 */
export function type(text) {
  const payload = JSON.stringify(text)
  const r = orca(
    "eval",
    "--expression",
    `(() => {
      const el = document.activeElement
      if (!el || !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return "no-input-focus"
      const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${payload})
      el.dispatchEvent(new Event("input", { bubbles: true }))
      return "typed:" + el.value
    })()`,
    ...pageArgs(),
  )
  if (typeof r?.result === "string" && r.result.startsWith("typed:")) return r.result
  throw new Error(`type(${payload}) landed nowhere: ${JSON.stringify(r).slice(0, 200)}`)
}
export const keypress = (key) => orca("keypress", "--key", key, ...pageArgs())

/** Wait for a condition (orca wait), swallowing only the timeout error. */
export async function waitFor(flags, timeout = 15_000) {
  try {
    orca("wait", ...flags, "--timeout", String(timeout), ...pageArgs())
    return true
  } catch (e) {
    if (String(e.message).includes("browser_timeout")) return false
    throw e
  }
}

/**
 * Wait until the tab's accessibility snapshot contains `text`.
 *
 * Not `orca wait --text`: on the list page it repeatedly took the Orca runtime down mid-run
 * (`runtime_unavailable`, twice in a row, killing the whole suite), while `orca snapshot` on the
 * same page kept answering. Same reason as waitForUrl below: poll what answers.
 */
export async function waitForText(text, timeout = 15_000) {
  const deadline = Date.now() + timeout
  for (;;) {
    if (snapshot().text.includes(text)) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, 500))
  }
}

/**
 * Wait until the tab's own origin matches `pattern`.
 *
 * Not `orca wait --url`: that returned false for a tab measurably sitting on /me (verified with
 * e2e/debug-login.mjs — text wait true, snapshot origin ".../me", url wait false), which scored a
 * working login RED four runs in a row. Polling the origin we already read is what can be trusted.
 */
export async function waitForUrl(pattern, timeout = 15_000) {
  const re = new RegExp(pattern)
  const deadline = Date.now() + timeout
  for (;;) {
    if (re.test(snapshot().origin)) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, 500))
  }
}

/** Full-page or viewport screenshot saved into the results directory.
 *
 * A locked or unfocused desktop makes CDP's Page.captureScreenshot time out
 * ("the browser tab may not be visible or the window may not have focus")
 * while every snapshot/click/type path keeps working. That is an environment
 * condition, not a scenario verdict, so ONLY that error degrades: the miss is
 * said out loud, the returned marker is written into the ledger, and the
 * scenario's verdict stays whatever its snapshot assertions prove. Any other
 * screenshot failure still raises.
 */
export function shot(name, { full = false } = {}) {
  try {
    const r = full ? orca("full-screenshot", ...pageArgs()) : orca("screenshot", ...pageArgs())
    return saveScreenshot(name, Buffer.from(r.data, "base64"))
  } catch (e) {
    if (!String(e.message).includes("may not be visible or the window may not have focus")) throw e
    const marker = "(screenshot unavailable: desktop window not visible)"
    console.log(`  WARN screenshot ${name}: ${marker}`)
    return marker
  }
}

// ---------------------------------------------------------------------------
// qwbe API client (for the seed)
// ---------------------------------------------------------------------------

export function qwbeClient(port) {
  const base = `http://127.0.0.1:${port}`
  let token = null
  const call = async (path, options = {}, attempt = 0) => {
    const headers = { ...(options.headers ?? {}) }
    if (token) headers.authorization = `Bearer ${token}`
    if (options.body !== undefined) headers["content-type"] = "application/json"
    let r
    try {
      r = await fetch(base + path, { ...options, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) })
    } catch (e) {
      // qwbe closes idle keep-alive connections; undici can then reuse a dead
      // socket and fail with `fetch failed`. The retry opens a fresh socket.
      if (attempt < 2) return call(path, options, attempt + 1)
      throw e
    }
    const text = await r.text()
    let body
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
    return { status: r.status, body }
  }
  return {
    call,
    base,
    async login(username = CONFIG.username, password = CONFIG.password) {
      const r = await call("/auth/login", { method: "POST", body: { username, password } })
      if (r.status !== 200 || !r.body?.token) {
        throw new Error(`qwbe login failed (http ${r.status}): ${JSON.stringify(r.body).slice(0, 300)}`)
      }
      token = r.body.token
      return token
    },
    get token() {
      return token
    },
  }
}
