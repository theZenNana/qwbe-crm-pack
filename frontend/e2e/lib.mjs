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
  mounted: "auth,settings,cli,crm,crm/accounts,crm/contacts,crm/contracts",
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

/** Run one orca command; throw with the CLI's own output on failure. */
export function orca(...args) {
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

/** Accessibility snapshot of the current tab: { origin, text, refs }. */
export function snapshot() {
  const r = orca("snapshot")
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

export const click = (ref) => orca("click", "--element", ref)
export const type = (text) => orca("type", "--input", text)
export const keypress = (key) => orca("keypress", "--key", key)

/** Wait for a condition (orca wait), swallowing only the timeout error. */
export async function waitFor(flags, timeout = 15_000) {
  try {
    orca("wait", ...flags, "--timeout", String(timeout))
    return true
  } catch (e) {
    if (String(e.message).includes("browser_timeout")) return false
    throw e
  }
}

export const waitForText = (text, timeout) => waitFor(["--text", text], timeout)
export const waitForUrl = (pattern, timeout) => waitFor(["--url", pattern], timeout)

/** Full-page or viewport screenshot saved into the results directory. */
export function shot(name, { full = false } = {}) {
  const r = full ? orca("full-screenshot") : orca("screenshot")
  return saveScreenshot(name, Buffer.from(r.data, "base64"))
}

// ---------------------------------------------------------------------------
// qwbe API client (for the seed)
// ---------------------------------------------------------------------------

export function qwbeClient(port) {
  const base = `http://127.0.0.1:${port}`
  let token = null
  const call = async (path, options = {}) => {
    const headers = { ...(options.headers ?? {}) }
    if (token) headers.authorization = `Bearer ${token}`
    if (options.body !== undefined) headers["content-type"] = "application/json"
    const r = await fetch(base + path, { ...options, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) })
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
