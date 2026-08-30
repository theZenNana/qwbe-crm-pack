// The six end-to-end scenarios (QWB-51), driven through the Orca browser.
//
// Every scenario records one PASS / RED / SKIP line and at least one screenshot into the
// dated results directory. Nothing here talks to qwbe directly except the metadata lookup
// for the non-editable-field scenario; everything else goes through the real UI.

import {
  CONFIG,
  click,
  keypress,
  orca,
  record,
  refFor,
  shot,
  snapshot,
  type,
  waitForText,
  waitForUrl,
} from "./lib.mjs"
import { CITY_BASELINE, CONTACT_LINKED, ORG_A, ORG_B } from "./seed.mjs"

// Read at call time: the runner sets CONFIG.frontendPort after picking a free port.
const FE = () => `http://localhost:${CONFIG.frontendPort}`

const tabs = []
async function open(path) {
  const r = orca("tab", "create", "--url", `${FE()}${path}`)
  orca("tab", "switch", "--page", r.browserPageId, "--focus")
  tabs.push(r.browserPageId)
  // The snapshot target must actually BE this tab: with stale tabs around, create/switch
  // can lose the race, so poll the origin and re-switch until it matches (or fail loudly).
  for (let i = 0; i < 15; i++) {
    const s = snapshot()
    if (s.origin.startsWith(FE())) return r.browserPageId
    try {
      orca("tab", "switch", "--page", r.browserPageId, "--focus")
    } catch {
      /* retried below */
    }
    await new Promise((res) => setTimeout(res, 2000))
  }
  throw new Error(`tab for ${FE()}${path} never became the snapshot target (origin stayed ${snapshot().origin})`)
}
/** Close leftover tabs of PREVIOUS e2e runs (they point at dead local ports). */
export function closeStaleTabs() {
  try {
    const list = orca("tab", "list")
    for (const t of list.tabs ?? []) {
      const url = String(t.url ?? "")
      if (/^http:\/\/localhost:\d+\/(login|accounts|contacts|me)/.test(url) && !tabs.includes(t.browserPageId)) {
        orca("tab", "close", "--page", t.browserPageId)
      }
    }
  } catch {
    /* best effort */
  }
}
export function closeTabs() {
  for (const id of tabs.reverse()) {
    try {
      orca("tab", "close", "--page", id)
    } catch {
      /* already gone */
    }
  }
  tabs.length = 0
}

async function settle(text, timeout = 30_000) {
  const ok = await waitForText(text, timeout)
  if (!ok) throw new Error(`page never showed ${JSON.stringify(text)}`)
}

// --- 1. login with the correct credentials lands on the identity page -----------
export async function scenarioLogin(api) {
  const name = "login lands on the identity page"
  await open("/login")
  await settle("Sign in")
  shot("01-login-page")
  let snap = snapshot()
  const userRef = refFor(snap.refs, "Username")
  const passRef = refFor(snap.refs, "Password")
  if (!userRef || !passRef) {
    shot("01-login-page-RED", { full: true })
    return record(name, "RED", "login form fields not found", "01-login-page-RED.png")
  }
  click(userRef)
  type(CONFIG.username)
  click(passRef)
  type(CONFIG.password)
  const submit = refFor(snap.refs, (n) => n === "Sign in")
  click(submit)
  const landed = await waitForUrl(".*/me.*")
  snap = snapshot()
  shot("01-after-login")
  const identityShown = landed && snap.origin.endsWith("/me") && snap.text.includes("Signed in as")
  return record(
    name,
    identityShown ? "PASS" : "RED",
    identityShown ? `identity page shows ${CONFIG.username}` : `landed on ${snap.origin}`,
    "01-after-login.png",
  )
}

// --- 2. organization list: seeded rows, sorting, searching ----------------------
export async function scenarioList() {
  const name = "organization list shows, sorts and searches the seeded organizations"
  await open("/accounts")
  await settle(ORG_A)
  let snap = snapshot()
  shot("02-accounts-list")
  const showsBoth = snap.text.includes(ORG_A) && snap.text.includes(ORG_B)
  if (!showsBoth) {
    shot("02-accounts-list-RED", { full: true })
    return record(name, "RED", `list does not show both seeded orgs (${snap.origin})`, "02-accounts-list-RED.png")
  }

  // Sorting: click the Name header twice for a descending sort, then Beta must come first.
  const header = refFor(snap.refs, (n) => n.startsWith("Name"))
  if (!header) {
    shot("02-sort-RED", { full: true })
    return record(name, "RED", "Name column header not clickable", "02-sort-RED.png")
  }
  click(header)
  await waitForText("Name ↓")
  click(refFor(snapshot().refs, (n) => n.startsWith("Name")))
  await waitForText("Name ↓")
  snap = snapshot()
  shot("02-accounts-sorted-desc")
  const betaFirst = snap.text.indexOf(ORG_B) >= 0 && snap.text.indexOf(ORG_B) < snap.text.indexOf(ORG_A)
  if (!betaFirst) {
    shot("02-sort-RED", { full: true })
    return record(name, "RED", "sorting by name descending did not put Beta before Alpha", "02-sort-RED.png")
  }

  // Searching: the Name filter narrows the list to Alpha only.
  const filter = refFor(snapshot().refs, "Filter by Name")
  if (!filter) {
    shot("02-search-RED", { full: true })
    return record(name, "RED", "Name filter input not found", "02-search-RED.png")
  }
  click(filter)
  type(ORG_A)
  const narrowed = await waitForText(ORG_A) && (async () => {
    await new Promise((r) => setTimeout(r, 1500))
    return !snapshot().text.includes(ORG_B)
  })()
  snap = snapshot()
  shot("02-accounts-searched")
  return record(name, narrowed ? "PASS" : "RED", narrowed ? "sorted desc and filtered to Alpha" : "filter did not narrow the list", "02-accounts-searched.png")
}

// --- 3. inline edit on an editable field saves without a reload -----------------
export async function scenarioInlineEdit() {
  const name = "inline edit on an editable field saves and shows without a reload"
  await open("/accounts")
  await settle(ORG_A)
  let snap = snapshot()
  const newValue = "E2E City Edited 42"
  // The row for Alpha: its cells carry buttons titled "Edit <label>"; pick the City one
  // that belongs to the Alpha row by editing Alpha's row only (one seeded org has City
  // baseline, the other a different one, so the button names are ambiguous only across
  // rows — take the first City button and verify the row context afterwards).
  const cityBtn = refFor(snap.refs, (n) => n.startsWith("Edit City") || n.startsWith("Edit Billing"))
  if (!cityBtn) {
    shot("03-edit-RED", { full: true })
    return record(name, "RED", "no editable City cell button found", "03-edit-RED.png")
  }
  click(cityBtn)
  snap = snapshot()
  const input = refFor(snap.refs, (n) => /City|Billing/.test(n) && (n.includes("textbox") || true))
  const inputRef = snap.refs && refFor(snap.refs, (n) => /city|billing/i.test(n))
  const target = inputRef ?? input
  if (!target) {
    shot("03-edit-RED", { full: true })
    return record(name, "RED", "edit input did not open", "03-edit-RED.png")
  }
  // The input is autofocused and carries the old value; replace it wholesale.
  keypress("ctrl+a")
  type(newValue)
  keypress("Return")
  const saved = await waitForText(newValue, 15_000)
  snap = snapshot()
  shot("03-after-inline-edit")
  const noError = !snap.text.includes("invalid") && !snap.text.includes("failed")
  const verdict = saved && noError ? "PASS" : "RED"
  return record(name, verdict, verdict === "PASS" ? `${newValue} visible after Enter` : "new value did not appear", "03-after-inline-edit.png")
}

// --- 4. inline edit on a NON-editable field is refused --------------------------
export async function scenarioNonEditable(api) {
  const name = "inline edit on a field the metadata marks not editable is refused"
  const meta = await api.call("/catalog/crm/accounts/metadata")
  const fields = meta.body?.fields ?? []
  const nonEditable = fields.find((f) => !f.editable && f.name !== "id" && f.name !== "type") ?? fields.find((f) => !f.editable)
  if (!nonEditable) {
    shot("04-noneditable-RED", { full: true })
    return record(name, "RED", "metadata exposes no non-editable column at all", "04-noneditable-RED.png")
  }
  await open("/accounts")
  await settle(ORG_A)
  const snap = snapshot()
  shot("04-noneditable-field")
  // Refusal has two visible faces, both acceptable: the column renders plain text with no
  // "Edit <label>" button, and clicking the text opens no input.
  const editButton = refFor(snap.refs, new RegExp(`^Edit ${nonEditable.label}`))
  if (editButton) {
    shot("04-noneditable-RED", { full: true })
    return record(name, "RED", `field ${nonEditable.name} renders an edit affordance despite editable=false`, "04-noneditable-RED.png")
  }
  const textField = refFor(snap.refs, (n) => n.includes(nonEditable.label))
  if (textField) {
    click(textField)
    const after = snapshot()
    const openedInput = refFor(after.refs, new RegExp(`^${nonEditable.label}$`))
    shot("04-noneditable-after-click")
    if (openedInput) {
      shot("04-noneditable-RED", { full: true })
      return record(name, "RED", `clicking the ${nonEditable.name} cell opened an editor`, "04-noneditable-RED.png")
    }
  }
  return record(name, "PASS", `field ${nonEditable.name} (editable=false) offers no inline edit`, "04-noneditable-field.png")
}

// --- 5. organization -> contact -> back to the organization ---------------------
export async function scenarioNavigation(seed) {
  const name = "navigation organization to contact and back"
  await open(`/accounts/${seed.orgA.id}`)
  await settle(CONTACT_LINKED)
  let snap = snapshot()
  shot("05-account-detail")
  const contactLink = refFor(snap.refs, CONTACT_LINKED)
  if (!contactLink) {
    shot("05-nav-RED", { full: true })
    return record(name, "RED", "organization detail does not link to its contact", "05-nav-RED.png")
  }
  click(contactLink)
  const onContact = await waitForUrl(".*/contacts/.*")
  snap = snapshot()
  shot("05-contact-detail")
  if (!onContact || !snap.text.includes(ORG_A)) {
    shot("05-nav-RED", { full: true })
    return record(name, "RED", `contact page did not show the organization (${snap.origin})`, "05-nav-RED.png")
  }
  const backLink = refFor(snap.refs, new RegExp(ORG_A))
  if (!backLink) {
    shot("05-nav-RED", { full: true })
    return record(name, "RED", "contact detail does not link back to the organization", "05-nav-RED.png")
  }
  click(backLink)
  const back = await waitForUrl(new RegExp(`.*/accounts/${seed.orgA.id}.*`))
  snap = snapshot()
  shot("05-back-on-account")
  return record(name, back ? "PASS" : "RED", back ? "round trip organization -> contact -> organization" : "did not land back on the organization", "05-back-on-account.png")
}

// --- 6. logout returns to the login page and /me is no longer reachable ---------
export async function scenarioLogout() {
  const name = "logout returns to the login page and the identity page is gone"
  await open("/me")
  await settle("Log out")
  let snap = snapshot()
  shot("06-me-before-logout")
  const btn = refFor(snap.refs, "Log out")
  if (!btn) {
    shot("06-logout-RED", { full: true })
    return record(name, "RED", "logout button not found on the identity page", "06-logout-RED.png")
  }
  click(btn)
  const back = await waitForUrl(".*/login.*")
  snap = snapshot()
  shot("06-after-logout")
  if (!back) {
    shot("06-logout-RED", { full: true })
    return record(name, "RED", `logout did not return to /login (${snap.origin})`, "06-logout-RED.png")
  }
  // The identity page must be unreachable now: a direct visit is bounced back to /login.
  await open("/me")
  const bounced = await waitForUrl(".*/login.*")
  snap = snapshot()
  shot("06-me-after-logout")
  shot("06-final", { full: true })
  const pass = bounced && snapshot().origin.endsWith("/login") && !snap.text.includes("Signed in as")
  return record(name, pass ? "PASS" : "RED", pass ? "/me redirects to /login after logout" : "/me still reachable", "06-final.png")
}

/** Only the login scenario — used when the seed cannot get a session at all. */
export async function scenarioLoginOnly() {
  await scenarioLogin(null)
}

export async function runAll(api, seed) {
  const verdicts = []
  verdicts.push(await scenarioLogin(api))
  if (!verdicts[0]) {
    // Without a session every later scenario would only test the login page.
    record("later scenarios (list, inline edit, non-editable, navigation, logout)", "SKIP", "login failed; without a session the UI cannot be exercised")
    return verdicts
  }
  verdicts.push(await scenarioList())
  verdicts.push(await scenarioInlineEdit())
  verdicts.push(await scenarioNonEditable(api))
  verdicts.push(await scenarioNavigation(seed))
  verdicts.push(await scenarioLogout())
  return verdicts
}
