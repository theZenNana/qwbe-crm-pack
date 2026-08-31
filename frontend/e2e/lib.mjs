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
  // A screenshot miss is an evidence degradation, not a silent pass: the
  // verdict carries it (QWB-52 review 21) instead of only a console WARN.
  if (verdict === "PASS" && typeof screenshot === "string" && screenshot.startsWith("(screenshot unavailable")) {
    verdict = "PASS (no screenshot evidence)"
  }
  results.push({ name, verdict, detail, screenshot })
  console.log(`${verdict.startsWith("PASS") ? "  PASS" : verdict === "RED" ? "  RED " : "  SKIP"} ${name}${detail ? ` — ${detail}` : ""}${screenshot ? ` [${screenshot}]` : ""}`)
  return verdict.startsWith("PASS")
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

/**
 * Bring the element carrying this accessible name into the viewport.
 *
 * Orca clicks at the element's viewport coordinates and does NOT scroll to it
 * first, so an element outside the viewport takes the click on whatever sits
 * at those coordinates -- `<html>` -- and nothing happens. The entity tables
 * scroll horizontally, so every column past the fold (Billing City among them)
 * was unreachable: measured 2026-08-31, the button sat at x=1127 in an 829px
 * viewport and the click landed on HTML; after this scroll the same single
 * click opens the editor and focus lands in it.
 *
 * Matching is by accessible name, the same string the click already carries,
 * and takes the FIRST match -- the order the snapshot refs are in, so it is
 * the element `clickStable` picked.
 */
const scrollNameIntoView = (name) => {
  const expr =
    `(() => { const want = ${JSON.stringify(name)};` +
    // Only controls: a table header or a cell can carry the same words as the
    // control being clicked (the definitions panel has a "Required" column
    // header above its "Required" checkbox), and scrolling that instead moves
    // the real target out from under the click.
    ` const controls = [...document.querySelectorAll("button, input, textarea, select, a[href], [role=checkbox], [role=combobox], [role=option], [role=textbox]")];` +
    // The accessible name first (aria-label, the label that points at this id,
    // a wrapping label, title); the visible text only as a last resort.
    ` const byId = (el) => el.id ? document.querySelector('label[for="' + el.id + '"]') : null;` +
    ` const accName = (el) => (el.getAttribute("aria-label") || "").trim() ||` +
    ` (byId(el) ? byId(el).textContent.trim() : "") ||` +
    ` (el.closest("label") ? el.closest("label").textContent.trim() : "") ||` +
    ` (el.getAttribute("title") || "").trim();` +
    ` const el = controls.find((e) => accName(e) === want) || controls.find((e) => (e.textContent || "").trim() === want);` +
    ` if (!el) return "not-found";` +
    ` const r = el.getBoundingClientRect();` +
    // Only move the page when the element is actually out of reach: scrolling
    // one that is already visible shifts the coordinates Orca is about to
    // click at, for no gain.
    ` if (r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth) return "in-view";` +
    ` el.scrollIntoView({ block: "center", inline: "center" });` +
    ` return "scrolled" })()`
  try {
    orca("eval", "--expression", expr, ...pageArgs())
  } catch {
    // A scroll that cannot run must not fail the click: the click still
    // reports its own outcome, and an off-screen target shows up as the
    // scenario's own RED rather than as an error from a helper.
  }
}

export const click = (ref, expectName) => {
  // The accessible name of the element just clicked: `type` asserts that the
  // focus actually landed there, instead of assuming it did.
  lastClicked = expectName ?? null
  if (expectName) scrollNameIntoView(expectName)
  return orca("click", "--element", ref, ...pageArgs())
}
let lastClicked = null
const activeElementName =
  `(() => { const el = document.activeElement; if (!el) return "";` +
  ` if (el.getAttribute("aria-label")) return el.getAttribute("aria-label");` +
  ` const l = el instanceof HTMLElement && el.labels ? [...el.labels][0] : null;` +
  ` return l ? l.textContent.trim() : "" })()`
/**
 * Type at the current focus, through the browser, not the desktop.
 *
 * The OS-level `orca type` needs a focused desktop window; on a locked screen
 * it reports ok and lands nothing (observed 2026-08-31, three runs). The CDP
 * path below has the same semantics for the inputs this suite types into: the
 * value is set through the native setter (so React's controlled inputs see
 * it) and an `input` event is dispatched, exactly what a keystroke does.
 *
 * A synthetic value set is not a keystroke (locked-desktop workaround, QWB-52
 * review 20), so the assertion that proves this helper did land is focus:
 * after the click that preceded the type, document.activeElement must carry
 * the same accessible name the click targeted.
 */
export function type(text) {
  const payload = JSON.stringify(text)
  if (lastClicked) {
    const focus = orca("eval", "--expression", activeElementName, ...pageArgs())
    const focusedName = typeof focus?.result === "string" ? focus.result : ""
    // The editor focus carries the FIELD's label ("Billing City") while the
    // clicked affordance is named "Edit <label>"; both must be accepted.
    const related =
      focusedName === lastClicked ||
      (lastClicked.startsWith("Edit ") && focusedName === lastClicked.slice(5).trim())
    if (!related) {
      throw new Error(
        `type("${text}") would land on "${focusedName || "(no focus)"}, not the clicked "${lastClicked}"`,
      )
    }
  }
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
/**
 * Press a key at the focused element, through the browser.
 *
 * `orca keypress` is an OS-level key event: like `orca type` it needs a
 * focused desktop window, and on a locked screen it answers "Pressed Return"
 * while nothing reaches the page (measured 2026-08-31: a capture keydown
 * listener recorded an empty array after the CLI reported success, and the
 * inline editor stayed open with its value uncommitted). Dispatching the key
 * at `document.activeElement` has the semantics the suite needs: React
 * listens for these events, and a dispatched Enter commits the inline editor
 * exactly as a real one does -- proved on the live stack, where the same
 * editor closed and the saved value appeared in the cell.
 *
 * Only the two keys the scenarios use are supported; anything else is a
 * mistake to hear about, not to translate silently.
 */
export const keypress = (key) => {
  if (key === "ctrl+a") {
    return orca(
      "eval",
      "--expression",
      `(() => { const el = document.activeElement;` +
        ` if (el && typeof el.select === "function") { el.select(); return "selected" }` +
        ` return "no-input" })()`,
      ...pageArgs(),
    )
  }
  if (key !== "Return") throw new Error(`keypress(${key}): only "Return" and "ctrl+a" are supported`)
  return orca(
    "eval",
    "--expression",
    `(() => { const el = document.activeElement; if (!el) return "no-focus";` +
      ` const fire = (t) => el.dispatchEvent(new KeyboardEvent(t, {` +
      ` key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));` +
      ` fire("keydown"); fire("keyup"); return "pressed" })()`,
    ...pageArgs(),
  )
}

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
