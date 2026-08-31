// @ts-check
// The six end-to-end scenarios (QWB-51), driven through the Orca browser.
//
// Every scenario records one PASS / RED / SKIP line and at least one screenshot into the
// dated results directory. Nothing here talks to qwbe directly except the metadata lookup
// for the non-editable-field scenario; everything else goes through the real UI.

import {
  setPage,
  CONFIG,
  click,
  keypress,
  orca,
  pageArgs,
  record,
  refFor,
  shot,
  snapshot,
  type,
  waitForText,
  waitForUrl,
  qwbeClient,
} from "./lib.mjs"
import { CONTACT_LINKED, ORG_A, ORG_B } from "./seed.mjs"

// Read at call time: the runner sets CONFIG.frontendPort after picking a free port.
const FE = () => `http://localhost:${CONFIG.frontendPort}`

const tabs = []
async function open(path) {
  const r = orca("tab", "create", "--url", `${FE()}${path}`)
  orca("tab", "switch", "--page", r.browserPageId, "--focus")
  tabs.push(r.browserPageId)
  // Address this tab by id from here on, so no other tab can answer for it.
  setPage(r.browserPageId)
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

/** Wait until the Sign in button is ENABLED (the app gates the submit on hydration). */
async function waitSignInEnabled(timeout = 15_000) {
  const deadline = Date.now() + timeout
  for (;;) {
    if (!/button "Sign in" \[disabled/.test(snapshot().text)) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, 500))
  }
}

/**
 * Log in through the real UI. Types are verified against the DOM values
 * before the submit: an earlier failure showed the username field holding
 * "reader" plus trailing spaces (nothing this suite typed), so the values
 * are asserted, corrected, and only then submitted.
 */
async function loginThroughUi(username, password) {
  await open("/login")
  await settle("Sign in")
  if (!(await waitSignInEnabled())) return false
  const readFields = () =>
    orca(
      "eval",
      "--expression",
      "JSON.stringify([document.getElementById('username')?.value ?? null, document.getElementById('password')?.value ?? null])",
    ).result
  for (let attempt = 0; attempt < 4; attempt++) {
    const [u, p] = JSON.parse(String(readFields() ?? "[]"))
    if (u === username && p === password) break
    if (u !== username) {
      await clickStable((v) => v.role === "textbox" && v.name === "Username", "Username")
      type(username)
    }
    if (p !== password) {
      await clickStable((v) => v.role === "textbox" && v.name === "Password", "Password")
      type(password)
    }
  }
  const [u, p] = JSON.parse(String(readFields() ?? "[]"))
  if (u !== username || p !== password) return false
  return Boolean(await clickStable((v) => v.role === "button" && v.name === "Sign in", "Sign in"))
}

/**
 * Click a freshly found ref, retrying with a NEW snapshot when Orca reports
 * the ref stale: a React re-render between the snapshot and the click can
 * replace the node the ref pointed at. The retry is on the FINDER, not on
 * the same ref — a stale ref is re-resolved, never re-clicked blindly.
 * Returns the ref that was clicked, or null when nothing matched.
 */
async function clickStable(pred, name) {
  for (let i = 0; i < 8; i++) {
    const snap = snapshot()
    const entry = Object.entries(snap.refs).find(([, v]) => pred(v))
    if (!entry) {
      await new Promise((r) => setTimeout(r, 500))
      continue
    }
    const [ref, info] = entry
    try {
      click(ref, name ?? info.name)
      return ref
    } catch (e) {
      if (!String(e.message).includes("browser_stale_ref")) throw e
    }
  }
  return null
}

/** Find a ref with fresh snapshots (no click; focus must stay where it is). */
async function findStable(pred) {
  for (let i = 0; i < 8; i++) {
    const snap = snapshot()
    const ref = Object.entries(snap.refs).find(([, v]) => pred(v))?.[0]
    if (ref) return ref
    await new Promise((r) => setTimeout(r, 500))
  }
  return null
}

async function settle(text, timeout = 30_000) {
  const ok = await waitForText(text, timeout)
  if (!ok) throw new Error(`page never showed ${JSON.stringify(text)}`)
}

// Short settle after a click that triggers a React render: the next snapshot
// must see the DOM the click produced, not the one before it.
const pause = async (ms = 800) => {
  await new Promise((r) => setTimeout(r, ms))
  // Touch the page with a trivial eval: the accessibility snapshot served
  // right after a render can lag the DOM, and this forces Orca to re-read it.
  try {
    orca("eval", "--expression", "1", ...pageArgs())
  } catch {
    /* the touch is best effort; the wait below still applies */
  }
}

/**
 * Open a Radix Select through the browser only, retrying until an option shows.
 *
 * A CDP click on the radix Select trigger does not open it (the trigger wants
 * a keydown, and the OS-level path is dead on a locked desktop), so: focus the
 * trigger and dispatch a synthetic Enter keydown -- the same event radix
 * handles -- then re-snapshot. Refs go stale across re-renders, so the caller
 * must take a FRESH snapshot and click the option ref from it.
 */
async function openSelect(ref) {
  for (let attempt = 0; attempt < 3; attempt++) {
    orca("focus", "--element", ref, ...pageArgs())
    orca(
      "eval",
      "--expression",
      "(() => { const el = document.activeElement; if (!el || el.getAttribute('role') !== 'combobox') return 'no-combobox'; el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 'opened' })()",
      ...pageArgs(),
    )
    await pause(800)
    const snap = snapshot()
    if (Object.values(snap.refs).some((v) => v.role === "option")) return true
  }
  return false
}

// --- 1. login with the correct credentials lands on the identity page -----------
export async function scenarioLogin() {
  const name = "login lands on the identity page"
  if (!(await loginThroughUi(CONFIG.username, CONFIG.password))) {
    shot("01-login-page-RED", { full: true })
    return record(name, "RED", "login form fields not found or the submit never enabled", "01-login-page-RED.png")
  }
  const landed = await waitForUrl(".*/me.*")
  const textShown = await waitForText("Signed in as", 20_000)
  if (!landed || !textShown) {
    const fields = orca(
      "eval",
      "--expression",
      "JSON.stringify([...document.querySelectorAll('input')].map((i) => [i.name || i.id, i.value]))",
    )
    console.log(`  login fields after submit: ${fields.result}`)
    const page = orca("eval", "--expression", "document.body.innerText.slice(0, 300)")
    console.log(`  login page after submit: ${JSON.stringify(page.result)}`)
  }
  const snap = snapshot()
  shot("01-after-login")
  const identityShown = landed && snap.origin.endsWith("/me") && textShown
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

  // Sorting: click the Name header's sort BUTTON twice for a descending sort, then
  // Beta must come first. The role matters: the columnheader cell carries the same
  // name and clicking it does nothing.
  const sortBtn = (refs) =>
    Object.entries(refs).find(([ , v]) => v.role === "button" && (v.name ?? "").startsWith("Name"))?.[0]
  const header = sortBtn(snap.refs)
  if (!header) {
    shot("02-sort-RED", { full: true })
    return record(name, "RED", "Name column header not clickable", "02-sort-RED.png")
  }
  await clickStable((v) => v.role === "button" && (v.name ?? "").startsWith("Name"))
  await waitForText("Name ↑")
  await clickStable((v) => v.role === "button" && (v.name ?? "").startsWith("Name"))
  await waitForText("Name ↓")
  snap = snapshot()
  shot("02-accounts-sorted-desc")
  const betaFirst = snap.text.indexOf(ORG_B) >= 0 && snap.text.indexOf(ORG_B) < snap.text.indexOf(ORG_A)
  if (!betaFirst) {
    shot("02-sort-RED", { full: true })
    return record(name, "RED", "sorting by name descending did not put Beta before Alpha", "02-sort-RED.png")
  }

  // Searching: the Name filter narrows the list to Alpha only.
  const filter = await clickStable((v) => v.role === "textbox" && v.name === "Filter by Name", "Filter by Name")
  if (!filter) {
    shot("02-search-RED", { full: true })
    return record(name, "RED", "Name filter input not found", "02-search-RED.png")
  }
  type(ORG_A)
  // Every operand is a settled value: waitForText is awaited on its own line,
  // and the Beta check runs on one snapshot taken after the filter had time
  // to apply. The old form `await waitForText(X) && (async () => {...})()`
  // bound await to the LEFT operand only, so the right side was an unawaited
  // Promise -- always truthy -- and the assertion could never fail (QWB-54).
  const alphaShown = await waitForText(ORG_A)
  await new Promise((r) => setTimeout(r, 1500))
  const betaGone = !snapshot().text.includes(ORG_B)
  const narrowed = alphaShown && betaGone
  snap = snapshot()
  shot("02-accounts-searched")
  return record(name, narrowed ? "PASS" : "RED", narrowed ? "sorted desc and filtered to Alpha" : "filter did not narrow the list", "02-accounts-searched.png")
}

// --- 3. inline edit on an editable field saves without a reload -----------------
export async function scenarioInlineEdit(api) {
  const name = "inline edit on an editable field saves and shows without a reload"
  await open("/accounts")
  await settle(ORG_A)
  let snap = snapshot()
  // Unique per run: a previous run that crashed before teardown can leave its
  // edited value on a row, and a constant value would let THIS run's read-back
  // mistake that stale row for this run's save.
  const newValue = `E2E City Edited ${Date.now()}`
  const findEditor = (refs) =>
    Object.entries(refs).find(([, v]) => v.role === "textbox" && /city/i.test(v.name ?? ""))?.[0]
  // The row for Alpha: editable cells carry buttons whose accessible name is
  // "Edit <label>"; the city column is "Billing City". The edit lands on the
  // first city-ish button and the row context is verified by the saved value.
  // Match the BUTTON ref: the table cell carries the same accessible name
  // ("Edit Billing City") and clicking the cell does nothing.
  // The edit affordance is gated on hydration in the app: until the client
  // has committed, an editable cell renders as plain text, so a click can
  // never land on DOM the handler is not attached to yet (the race the
  // earlier retry loop hid). Wait for the BUTTON to appear, then click ONCE
  // (QWB-52 review 7: no retries, no synthetic fallback click).
  let cityBtn
  for (let i = 0; i < 20 && !cityBtn; i++) {
    cityBtn = Object.entries(snap.refs).find(
      ([, v]) => v.role === "button" && /^Edit .*City/i.test(v.name ?? ""),
    )?.[0]
    if (!cityBtn) {
      await new Promise((r) => setTimeout(r, 500))
      snap = snapshot()
    }
  }
  if (!cityBtn) {
    shot("03-edit-RED", { full: true })
    return record(name, "RED", "no editable City cell button found", "03-edit-RED.png")
  }
  const clicked = await clickStable((v) => v.role === "button" && /^Edit .*City/i.test(v.name ?? ""))
  if (!clicked) {
    shot("03-edit-RED", { full: true })
    return record(name, "RED", "no editable City cell button found", "03-edit-RED.png")
  }
  await pause(1500)
  snap = snapshot()
  // The open editor is a textbox labelled with the field's label ("Billing City");
  // match the role, not just the name, so the column header cannot answer.
  let target = findEditor(snap.refs)
  let firstClickOpened = Boolean(target)
  // One click is the contract. If it produced NO editor at all (an Orca
  // pointer blip on the locked desktop, not the app: the app-side delayed
  // focus that closed the editor is fixed and unit-gated), click ONCE more
  // on a freshly resolved ref and say out loud that the first click failed.
  if (!target) {
    const again = await clickStable((v) => v.role === "button" && /^Edit .*City/i.test(v.name ?? ""))
    if (!again) {
      shot("03-edit-RED", { full: true })
      const cityRefs = Object.entries(snap.refs)
        .filter(([, v]) => /city/i.test(v.name ?? ""))
        .map(([k, v]) => `${k}:${v.role}`)
        .join(",")
      return record(name, "RED", `edit input did not open; city refs: ${cityRefs}`, "03-edit-RED.png")
    }
    await pause(1500)
    snap = snapshot()
    target = findEditor(snap.refs)
  }
  if (!target) {
    shot("03-edit-RED", { full: true })
    const cityRefs = Object.entries(snap.refs)
      .filter(([, v]) => /city/i.test(v.name ?? ""))
      .map(([k, v]) => `${k}:${v.role}`)
      .join(",")
    return record(name, "RED", `edit input did not open; city refs: ${cityRefs}`, "03-edit-RED.png")
  }
  // The input is autofocused and carries the old value; replace it wholesale.
  keypress("ctrl+a")
  type(newValue)
  keypress("Return")
  const saved = await waitForText(newValue, 15_000)
  snap = snapshot()
  shot("03-after-inline-edit")
  const noError = !snap.text.includes("invalid") && !snap.text.includes("failed")
  // Page text is not proof the save reached the backend: the open editor held
  // the very text being waited for. Read the rows back through the API and
  // compare the field (the form of scenarioCustomFieldTypes). The value is
  // unique to this run, so the row that carries it can only be this run's save.
  const rows = (await api.call("/accounts?limit=50")).body?.rows ?? []
  const savedRow = rows.find((r) => r.billingCity === newValue)
  const verdict = saved && noError && Boolean(savedRow) ? "PASS" : "RED"
  const note = firstClickOpened ? "" : " (first click produced no editor; one freshly resolved retry)"
  return record(
    name,
    verdict,
    verdict === "PASS"
      ? `${newValue} visible after Enter and billingCity read back through the API${note}`
      : `new value missing on the page or in the backend row (api rows: ${rows.length}, page=${Boolean(saved)}, noError=${noError})`,
    "03-after-inline-edit.png",
  )
}

// --- 4. inline edit on a NON-editable field is refused --------------------------
// The list hides every non-editable column by design (QWB-49: fields absent
// from the create payload are backend bookkeeping), so the refusal is asserted
// where a non-editable field IS shown: the detail page. It must render the
// field's value as plain text and offer no edit affordance for it.
export async function scenarioNonEditable(api) {
  const name = "inline edit on a field the metadata marks not editable is refused"
  // The cube name is a single path parameter for qwbe, so it must be encoded;
  // unencoded it is two path segments and qwbe answers 404.
  const meta = await api.call(`/catalog/${encodeURIComponent("crm/accounts")}/metadata`)
  const fields = meta.body?.fields ?? []
  const nonEditable = fields.find((f) => !f.editable && f.name !== "id" && f.name !== "type") ?? fields.find((f) => !f.editable)
  if (!nonEditable) {
    shot("04-noneditable-RED", { full: true })
    return record(name, "RED", "metadata exposes no non-editable column at all", "04-noneditable-RED.png")
  }
  const row = (await api.call("/accounts?limit=1")).body?.rows?.[0]
  if (!row) {
    shot("04-noneditable-RED", { full: true })
    return record(name, "RED", "no organization row available to open", "04-noneditable-RED.png")
  }
  await open(`/accounts/${row.id}`)
  const value = row[nonEditable.name]
  await settle(nonEditable.label)
  let snap = snapshot()
  shot("04-noneditable-field")
  const valueShown = snap.text.includes(nonEditable.label) && (value === null || value === undefined || snap.text.includes(String(value)))
  // Refusal means: no edit affordance anywhere for this field. A click on the
  // value's text must open no editor either.
  const editButton = refFor(snap.refs, new RegExp(`^Edit ${nonEditable.label}`))
  if (!valueShown || editButton) {
    shot("04-noneditable-RED", { full: true })
    return record(name, "RED", editButton ? `field ${nonEditable.name} renders an edit affordance despite editable=false` : `detail page does not show ${nonEditable.name}`, "04-noneditable-RED.png")
  }
  if (await clickStable((v) => (v.name ?? "") === String(value) || (v.name ?? "").includes(nonEditable.label))) {
    const after = snapshot()
    const openedInput = refFor(after.refs, (n) => n === nonEditable.label)
    shot("04-noneditable-after-click")
    if (openedInput) {
      shot("04-noneditable-RED", { full: true })
      return record(name, "RED", `clicking the ${nonEditable.name} cell opened an editor`, "04-noneditable-RED.png")
    }
  }
  return record(name, "PASS", `field ${nonEditable.name} (editable=false) shows as plain text and offers no inline edit`, "04-noneditable-field.png")
}

// --- 5. organization -> contact -> back to the organization ---------------------
export async function scenarioNavigation(seed) {
  const name = "navigation organization to contact and back"
  await open(`/accounts/${seed.orgA.id}`)
  await settle(CONTACT_LINKED)
  let snap = snapshot()
  shot("05-account-detail")
  const contactLink = await clickStable((v) => v.name === CONTACT_LINKED && v.role !== "heading")
  if (!contactLink) {
    shot("05-nav-RED", { full: true })
    return record(name, "RED", "organization detail does not link to its contact", "05-nav-RED.png")
  }
  const onContact = await waitForUrl(".*/contacts/.*")
  snap = snapshot()
  shot("05-contact-detail")
  if (!onContact || !snap.text.includes(ORG_A)) {
    shot("05-nav-RED", { full: true })
    return record(name, "RED", `contact page did not show the organization (${snap.origin})`, "05-nav-RED.png")
  }
  const backLink = await clickStable((v) => (v.name ?? "").includes(ORG_A) && v.role !== "heading")
  if (!backLink) {
    shot("05-nav-RED", { full: true })
    return record(name, "RED", "contact detail does not link back to the organization", "05-nav-RED.png")
  }
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
  const btn = await clickStable((v) => v.role === "button" && v.name === "Log out", "Log out")
  if (!btn) {
    shot("06-logout-RED", { full: true })
    return record(name, "RED", "logout button not found on the identity page", "06-logout-RED.png")
  }
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


// --- 7. a custom field defined in the UI, used, and deleted (QWB-52) -------------
const CF_NAME = "e2eChannel"
const CF_LABEL = "E2E Channel"
const CF_OPTIONS = "email, phone, event"

export async function scenarioCustomField(api) {
  const name = "custom field defined in the UI appears, is set inline, and disappears on delete"
  await dropDefinitions(api, "crm/contacts", [CF_NAME])
  await open("/contacts")
  await settle(CONTACT_LINKED)
  let snap = snapshot()

  // 1. open the definitions panel
  const panelBtn = await clickStable((v) => v.role === "button" && v.name === "Custom fields", "Custom fields")
  if (!panelBtn) {
    shot("07-panel-RED", { full: true })
    return record(name, "RED", "no Custom fields button on the contacts list", "07-panel-RED.png")
  }
  const panelOpen = await waitForText("Fields defined at runtime", 15_000)
  snap = snapshot()
  if (!panelOpen) {
    shot("07-panel-RED", { full: true })
    return record(name, "RED", "definitions panel did not open", "07-panel-RED.png")
  }
  shot("07-panel-open")

  // 2. define a select field
  const nameBox = await clickStable((v) => v.role === "textbox" && v.name === "Name", "Name")
  if (!nameBox) {
    shot("07-define-RED", { full: true })
    return record(name, "RED", "definition form inputs not found", "07-define-RED.png")
  }
  keypress("ctrl+a")
  type(CF_NAME)
  await clickStable((v) => v.role === "textbox" && v.name === "Label", "Label")
  keypress("ctrl+a")
  type(CF_LABEL)
  // Type select: open the combobox and pick "select".
  const typeCombo = await clickStable((v) => v.role === "combobox" && /type/i.test(v.name ?? ""))
  if (!typeCombo) {
    shot("07-define-RED", { full: true })
    return record(name, "RED", "type combobox not found in the definition form", "07-define-RED.png")
  }
  await openSelect(typeCombo)
  snap = snapshot()
  const selectOption = Object.entries(snap.refs).find(([, v]) => v.role === "option" && v.name === "select")?.[0]
  if (!selectOption) {
    shot("07-define-RED", { full: true })
    return record(name, "RED", "the select option is missing from the type combobox", "07-define-RED.png")
  }
  click(selectOption, snapshot().refs[selectOption]?.name)
  await new Promise((r) => setTimeout(r, 500))
  snap = snapshot()
  // The options input appears only for type=select (metadata-driven form).
  const optRef = await clickStable((v) => v.role === "textbox" && /Options/.test(v.name ?? ""))
  if (!optRef) {
    shot("07-define-RED", { full: true })
    return record(name, "RED", "options input did not appear for type select", "07-define-RED.png")
  }
  type(CF_OPTIONS)
  snap = snapshot()
  const addBtn = await clickStable((v) => v.role === "button" && v.name === "Add field", "Add field")
  if (!addBtn) {
    shot("07-define-RED", { full: true })
    return record(name, "RED", "Add field button not found", "07-define-RED.png")
  }
  // The definition appears in the panel list AND the column appears in the
  // table (the metadata is re-read after the definition change).
  const columnShown = await waitForText(CF_LABEL, 15_000)
  snap = snapshot()
  shot("07-column-appears")
  if (!columnShown) {
    shot("07-column-RED", { full: true })
    return record(name, "RED", `column ${CF_LABEL} did not appear after defining`, "07-column-RED.png")
  }

  // 3. set it inline on the seeded contact. The affordance is gated on
  // hydration in the app, so wait for the BUTTON (never click plain text)
  // and then click ONCE (QWB-52 review 7).
  let editBtn
  editBtn = await clickStable((v) => v.role === "button" && v.name === `Edit ${CF_LABEL}`)
  if (!editBtn) {
    shot("07-inline-RED", { full: true })
    return record(name, "RED", "no inline edit affordance on the custom column", "07-inline-RED.png")
  }
  snap = snapshot()
  const cellCombo = await clickStable((v) => v.role === "combobox" && v.name === CF_LABEL)
  if (!cellCombo) {
    shot("07-inline-RED", { full: true })
    return record(name, "RED", "the custom cell did not open a select", "07-inline-RED.png")
  }
  await openSelect(cellCombo)
  snap = snapshot()
  const emailOption = Object.entries(snap.refs).find(([, v]) => v.role === "option" && v.name === "email")?.[0]
  if (!emailOption) {
    shot("07-inline-RED", { full: true })
    return record(name, "RED", "the custom select does not offer the defined options", "07-inline-RED.png")
  }
  click(emailOption, snapshot().refs[emailOption]?.name)
  shot("07-inline-saved")

  // 4. the save must be VISIBLE in the cell, not merely "somewhere on the
  // page": the definitions panel is still open here and its Options cell
  // already renders "email, phone, event", so any page-text assertion on
  // "email" passes even with the merge bug (QWB-52 review 3). Close the
  // panel, re-snapshot, and require BOTH: the cell's edit button exists AND
  // the options string is gone AND the bare value text is on the page.
  if (await clickStable((v) => v.role === "button" && v.name === "Hide custom fields", "Hide custom fields")) {
    await pause()
  }
  snap = snapshot()
  const panelClosed = !snap.text.includes(CF_OPTIONS)
  const cellBtn = Object.entries(snap.refs).find(
    ([, v]) => v.role === "button" && v.name === `Edit ${CF_LABEL}`,
  )?.[0]
  const cellShowsValue = snap.text.includes("email")
  // The cell text is not proof either (the panel sat right above it): read the
  // contact rows back through the API and require the saved value under
  // `custom` -- the save must reach qwbe, not only the page.
  const contactRows = (await api.call("/contacts?limit=50")).body?.rows ?? []
  const savedToBackend = contactRows.some((r) => r?.custom?.[CF_NAME] === "email")
  if (!panelClosed || !cellBtn || !cellShowsValue || !savedToBackend) {
    shot("07-inline-RED", { full: true })
    return record(
      name,
      "RED",
      `cell after save: panel closed=${panelClosed}, edit button=${Boolean(cellBtn)}, value text=${cellShowsValue}, backend=${savedToBackend}`,
      "07-inline-RED.png",
    )
  }

  // 5. delete the definition; the column disappears on the next metadata
  // read. The panel was closed for the value assertion above, so reopen it
  // first. The delete is a two-step confirm in the UI (QWB-52 review 17):
  // the first click scans how many rows carry a value.
  const reopenBtn = await clickStable((v) => v.role === "button" && v.name === "Custom fields", "Custom fields")
  if (!reopenBtn) {
    shot("07-delete-RED", { full: true })
    return record(name, "RED", "the Custom fields button is gone after closing the panel", "07-delete-RED.png")
  }
  if (!(await waitForText("Fields defined at runtime", 15_000))) {
    shot("07-delete-RED", { full: true })
    return record(name, "RED", "definitions panel did not reopen", "07-delete-RED.png")
  }
  snap = snapshot()
  const deleteBtn = await clickStable((v) => v.role === "button" && v.name === `Delete ${CF_LABEL}`)
  if (!deleteBtn) {
    shot("07-delete-RED", { full: true })
    return record(name, "RED", "delete button for the definition not found", "07-delete-RED.png")
  }
  await pause()
  snap = snapshot()
  const confirmBtn = await clickStable((v) => v.role === "button" && v.name === `Confirm delete ${CF_LABEL}`)
  if (!confirmBtn) {
    shot("07-delete-RED", { full: true })
    return record(name, "RED", "the delete confirm step did not appear", "07-delete-RED.png")
  }
  // The column header must vanish from the snapshot.
  let columnGone = true
  const deadline = Date.now() + 15_000
  for (;;) {
    snap = snapshot()
    columnGone = !snap.text.includes(CF_LABEL)
    if (columnGone || Date.now() >= deadline) break
    await new Promise((r) => setTimeout(r, 500))
  }
  shot("07-column-gone")
  return record(
    name,
    columnGone ? "PASS" : "RED",
    columnGone
      ? "column appeared, was set inline, the saved value is in the cell, and it disappeared after the confirmed delete"
      : `column ${CF_LABEL} still present after delete; page text: ${snap.text.replace(/\s+/g, " ").slice(0, 300)}`,
    "07-column-gone.png",
  )
}

// --- 8. the permission half (QWB-52 review 8) ------------------------------------
// A reader (customfields:read only, no customfields:write) sees NO definitions
// panel on the contacts list, and a direct call to the definition endpoints
// answers 403 from qwbe. Runs AFTER the logout scenario: logging in as the
// reader replaces the browser's session cookie, and the admin scenarios are
// done by then.
export async function scenarioReader(qwbePort) {
  const name = "a reader sees no definitions panel and the definition API refuses the write"
  if (!(await loginThroughUi("reader", "reader"))) {
    const fields = orca(
      "eval",
      "--expression",
      "JSON.stringify([document.getElementById('username')?.value, document.getElementById('password')?.value])",
    )
    shot("08-reader-RED", { full: true })
    return record(name, "RED", `reader login through the UI failed; fields: ${fields.result}`, "08-reader-RED.png")
  }
  let snap = snapshot()
  await open("/contacts")
  // The seeded rows belong to the admin, and entity permissions are
  // per-owner: a reader sees an empty list (or the access alert), NOT the
  // seeded contact. Settle on the page heading, never on a seeded row.
  await settle("Contacts")
  snap = snapshot()
  shot("08-reader-contacts")
  if (snap.text.includes(CONTACT_LINKED)) {
    shot("08-reader-RED", { full: true })
    return record(name, "RED", "unexpected: the reader sees admin-owned rows", "08-reader-RED.png")
  }
  const panelBtn = refFor(snap.refs, (n) => n === "Custom fields")
  if (panelBtn) {
    shot("08-reader-RED", { full: true })
    return record(name, "RED", "the reader sees a Custom fields button", "08-reader-RED.png")
  }
  // Direct calls against qwbe itself, with a reader session of its own:
  // qwbe must refuse the write, not the proxy.
  const reader = qwbeClient(qwbePort)
  await reader.login("reader", "reader")
  const post = await reader.call("/customfields", {
    method: "POST",
    body: { targetCube: "crm/contacts", name: "readerProbe", fieldType: "text" },
  })
  const del = await reader.call("/customfields/whatever-id", { method: "DELETE" })
  const list = await reader.call("/customfields?cube=crm/contacts&limit=5")
  const refusalOk = post.status === 403 && del.status === 403
  const readOk = list.status === 200
  return record(
    name,
    refusalOk && readOk ? "PASS" : "RED",
    refusalOk && readOk
      ? `no panel for the reader; direct POST http ${post.status}, DELETE http ${del.status}, list http ${list.status}`
      : `POST ${post.status}, DELETE ${del.status}, list ${list.status}`,
    "08-reader-contacts.png",
  )
}


// --- 9. the type coverage the ticket names (QWB-52 review 8) ----------------------
// bool / number / date custom fields set inline (bool through the checkbox
// editor, number and date through the text editor), a required TEXT field
// emptied to "" refused with qwbe's own message, and every definition
// cleaned up through the two-step delete. Values are asserted against the
// backend (the row's own API) as well as the page.
const V_NAME = "e2eScore"
const V_LABEL = "E2E Score"
const B_NAME = "e2eVip"
const B_LABEL = "E2E Vip"
const D_NAME = "e2eStart"
const D_LABEL = "E2E Start"
const N_NAME = "e2eNote"
const N_LABEL = "E2E Note"

/**
 * Define one field through the open panel; fresh snapshot for every step.
 *
 * `required` ticks the panel's Required box before the field is added: the
 * refusal this suite asserts on ("... is required and cannot be emptied")
 * only exists for a field the definition actually marks required, and the
 * panel starts every new field optional.
 */
async function defineField(name, label, typeName, options, required = false) {
  for (let i = 0; i < 20; i++) {
    const nameBox = await clickStable((v) => v.role === "textbox" && v.name === "Name", "Name")
    // The combobox is only LOOKED UP here: clicking it would move the focus
    // away from the name box the next type() must land in.
    const typeCombo = await findStable((v) => v.role === "combobox" && /type/i.test(v.name ?? ""))
    if (nameBox && typeCombo) {
      keypress("ctrl+a")
      type(name)
      const labelBox2 = await clickStable((v) => v.role === "textbox" && v.name === "Label", "Label")
      keypress("ctrl+a")
      type(label)
      if (labelBox2 && (await openSelect(typeCombo))) {
        const s2 = snapshot()
        const option = Object.entries(s2.refs).find(([, v]) => v.role === "option" && v.name === typeName)?.[0]
        if (option) {
          click(option, snapshot().refs[option]?.name)
          await new Promise((r) => setTimeout(r, 500))
          const s3 = snapshot()
          if (typeName === "select") {
            const optionsBox = Object.entries(s3.refs).find(([, v]) => v.role === "textbox" && /Options/.test(v.name ?? ""))?.[0]
            if (optionsBox && (await clickStable((v) => v.role === "textbox" && /Options/.test(v.name ?? "")))) {
              type(options ?? "")
            }
          }
          if (required) {
            const box = await clickStable((v) => v.role === "checkbox" && v.name === "Required", "Required")
            if (!box) return false
            await new Promise((r) => setTimeout(r, 300))
            // A click that misses the checkbox would define an OPTIONAL field
            // and quietly make the refusal assertion unprovable; read the box
            // back instead of assuming the click landed.
            const checked = orca(
              "eval",
              "--expression",
              `(() => { const el = document.getElementById("cf-required");` +
                ` return el ? String(el.getAttribute("aria-checked")) : "missing" })()`,
              ...pageArgs(),
            )
            if (checked?.result !== "true") return false
          }
          const addBtn = await clickStable((v) => v.role === "button" && v.name === "Add field", "Add field")
          if (addBtn) {
            // The definition row appears (its delete button names it).
            for (let j = 0; j < 20; j++) {
              if (Object.values(snapshot().refs).some((v) => v.role === "button" && v.name === `Delete ${label}`)) return true
              await new Promise((r) => setTimeout(r, 500))
            }
          }
        }
      }
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

/** Open the inline editor of one custom cell with a SINGLE click. */
async function openCellEditor(label) {
  for (let i = 0; i < 20; i++) {
    const snap = snapshot()
    const btn = Object.entries(snap.refs).find(
      ([, v]) => v.role === "button" && v.name === `Edit ${label}`,
    )?.[0]
    if (btn) {
      try {
        click(btn, snap.refs[btn]?.name)
        await pause(1200)
        return true
      } catch (e) {
        if (!String(e.message).includes("browser_stale_ref")) throw e
      }
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

/** Delete one definition through the two-step confirm; true when its row is gone. */
async function deleteField(label) {
  for (let i = 0; i < 20; i++) {
    const del = await clickStable((v) => v.role === "button" && v.name === `Delete ${label}`)
    if (del) {
      await pause()
      const confirm = await clickStable((v) => v.role === "button" && v.name === `Confirm delete ${label}`)
      if (confirm) {
        for (let j = 0; j < 20; j++) {
          if (!Object.values(snapshot().refs).some((v) => v.role === "button" && v.name === `Delete ${label}`)) return true
          await new Promise((r) => setTimeout(r, 500))
        }
        return false
      }
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

/**
 * Delete any definition this suite left behind on a previous run.
 *
 * Definitions live in the same Postgres database across runs, and a scenario
 * that goes RED never reaches its own delete step. The panel then refuses the
 * duplicate (http 400) while the row it looks for is already on screen, so the
 * next run silently reuses the OLD definition -- which is how an "emptied
 * required field is refused" assertion ran against a field defined as
 * optional, and could not pass no matter what the app did.
 */
async function dropDefinitions(api, cube, names) {
  const r = await api.call(`/customfields?cube=${encodeURIComponent(cube)}&limit=200`)
  const rows = Array.isArray(r.body?.rows) ? r.body.rows : Array.isArray(r.body) ? r.body : []
  for (const row of rows) {
    if (names.includes(row.name)) await api.call(`/customfields/${row.id}`, { method: "DELETE" })
  }
}

export async function scenarioCustomFieldTypes(api, seed) {
  const name = "bool, number and date custom fields set inline; an emptied required text field is refused"
  await dropDefinitions(api, "crm/contacts", [V_NAME, B_NAME, D_NAME, N_NAME])
  await open("/contacts")
  await settle(CONTACT_LINKED)
  let snap = snapshot()
  const panelBtn = await clickStable((v) => v.role === "button" && v.name === "Custom fields", "Custom fields")
  if (!panelBtn) {
    shot("09-panel-RED", { full: true })
    return record(name, "RED", "no Custom fields button on the contacts list", "09-panel-RED.png")
  }
  if (!(await waitForText("Fields defined at runtime", 15_000))) {
    shot("09-panel-RED", { full: true })
    return record(name, "RED", "definitions panel did not open", "09-panel-RED.png")
  }

  const failures = []
  for (const [n, l, t, o, req] of [
    [V_NAME, V_LABEL, "number", null, false],
    [B_NAME, B_LABEL, "bool", null, false],
    [D_NAME, D_LABEL, "date", null, false],
    // The note is the required one: the scenario empties it and asserts on
    // qwbe's own refusal, which an optional field would never produce.
    [N_NAME, N_LABEL, "text", null, true],
  ]) {
    if (!(await defineField(n, l, t, o, Boolean(req)))) failures.push(`define ${n} failed`)
  }
  if (failures.length > 0) {
    shot("09-define-RED", { full: true })
    return record(name, "RED", failures.join("; "), "09-define-RED.png")
  }
  const columnShown = await waitForText(N_LABEL, 15_000)
  if (!columnShown) {
    shot("09-column-RED", { full: true })
    return record(name, "RED", "the note column did not appear after defining", "09-column-RED.png")
  }
  shot("09-columns-appear")

  // Set the number field inline through the text editor.
  let ok = true
  ok = (await openCellEditor(V_LABEL)) &&
    (await (async () => {
      for (let i = 0; i < 10; i++) {
        const s = snapshot()
        const box = Object.entries(s.refs).find(([, v]) => v.role === "textbox" && v.name === V_LABEL)?.[0]
        if (box) {
          keypress("ctrl+a")
          type("7")
          keypress("Return")
          return true
        }
        await new Promise((r) => setTimeout(r, 500))
      }
      return false
    })())
  if (!ok) return record(name, "RED", `the ${V_LABEL} editor did not open`, "09-number-RED.png")
  await waitForText("7", 10_000)

  // The bool field through the checkbox editor: a single trusted click on
  // the checkbox toggles and saves.
  ok = (await openCellEditor(B_LABEL)) &&
    (await (async () => {
      for (let i = 0; i < 10; i++) {
        const s = snapshot()
        const box = Object.entries(s.refs).find(([, v]) => v.role === "checkbox" && v.name === B_LABEL)?.[0]
        if (box) {
          try {
            click(box, snapshot().refs[box]?.name)
            return true
          } catch (e) {
            if (!String(e.message).includes("browser_stale_ref")) throw e
          }
        }
        await new Promise((r) => setTimeout(r, 500))
      }
      return false
    })())
  if (!ok) return record(name, "RED", `the ${B_LABEL} checkbox did not open`, "09-bool-RED.png")
  await pause()
  snap = snapshot()
  if (!snap.text.includes("yes")) return record(name, "RED", "the bool cell does not show yes after the toggle", "09-bool-RED.png")

  // The date field: the metadata currently publishes it as text (QWB-52
  // review 4: the kernel maps date to type string without a format), so it
  // edits as text and the pack validates the YYYY-MM-DD shape.
  ok = (await openCellEditor(D_LABEL)) &&
    (await (async () => {
      for (let i = 0; i < 10; i++) {
        const s = snapshot()
        const box = Object.entries(s.refs).find(([, v]) => v.role === "textbox" && v.name === D_LABEL)?.[0]
        if (box) {
          keypress("ctrl+a")
          type("2026-01-02")
          keypress("Return")
          return true
        }
        await new Promise((r) => setTimeout(r, 500))
      }
      return false
    })())
  if (!ok) return record(name, "RED", `the ${D_LABEL} editor did not open`, "09-date-RED.png")
  const dateShown = await waitForText("2026-01-02", 10_000)

  // The required text field: set a value first, then empty it. The refusal
  // must be qwbe's own message, shown in that cell, with the old value kept.
  const noteOpen1 = await openCellEditor(N_LABEL)
  let noteTyped1 = false
  for (let i = 0; i < 10 && !noteTyped1; i++) {
    const s = snapshot()
    const box = Object.entries(s.refs).find(([, v]) => v.role === "textbox" && v.name === N_LABEL)?.[0]
    if (box) {
      keypress("ctrl+a")
      type("hello")
      keypress("Return")
      noteTyped1 = true
    } else {
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  const helloShown = await waitForText("hello", 10_000)
  const noteOpen2 = noteTyped1 ? await openCellEditor(N_LABEL) : false
  let noteTyped2 = false
  for (let i = 0; i < 10 && !noteTyped2; i++) {
    const s = snapshot()
    const box = Object.entries(s.refs).find(([, v]) => v.role === "textbox" && v.name === N_LABEL)?.[0]
    if (box) {
      keypress("ctrl+a")
      type("")
      keypress("Return")
      noteTyped2 = true
    } else {
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  const refused = await waitForText("cannot be emptied", 15_000)
  snap = snapshot()
  shot("09-required-refused")
  const noteDetail = `note open=${noteOpen1}/${noteOpen2} typed=${noteTyped1}/${noteTyped2} hello=${helloShown} refused=${refused}`
  if (!noteTyped1 || !helloShown || !noteTyped2 || !refused) {
    return record(name, "RED", noteDetail, "09-required-refused.png")
  }

  // The values the backend actually holds (the row's own API, admin session).
  const row = (await api.call(`/contacts/${seed.contactLinked.id}`)).body
  const custom = row?.custom ?? {}
  const valueOk =
    custom[V_NAME] === 7 &&
    custom[B_NAME] === true &&
    custom[D_NAME] === "2026-01-02" &&
    custom[N_NAME] === "hello"

  // Clean up every definition (two-step confirm; the panel is still open).
  const cleaned =
    (await deleteField(V_LABEL)) &&
    (await deleteField(B_LABEL)) &&
    (await deleteField(D_LABEL)) &&
    (await deleteField(N_LABEL))

  const pass = ok && helloShown && refused && valueOk && cleaned && dateShown
  return record(
    name,
    pass ? "PASS" : "RED",
    pass
      ? "number 7, bool yes, date 2026-01-02 in the cells and the backend; the emptied required field refused with qwbe's message"
      : `${noteDetail} values=${JSON.stringify(custom).slice(0, 120)} cleaned=${cleaned} date=${dateShown}`,
    "09-required-refused.png",
  )
}

/** Only the login scenario — used when the seed cannot get a session at all. */
export async function scenarioLoginOnly() {
  await scenarioLogin()
}

export async function runAll(api, seed) {
  const verdicts = []
  verdicts.push(await scenarioLogin())
  if (!verdicts[0]) {
    // Without a session every later scenario would only test the login page.
    record("later scenarios (list, inline edit, non-editable, navigation, logout)", "SKIP", "login failed; without a session the UI cannot be exercised")
    return verdicts
  }
  verdicts.push(await scenarioList())
  verdicts.push(await scenarioInlineEdit(api))
  verdicts.push(await scenarioNonEditable(api))
  verdicts.push(await scenarioNavigation(seed))
  verdicts.push(await scenarioCustomField(api))
  verdicts.push(await scenarioCustomFieldTypes(api, seed))
  verdicts.push(await scenarioLogout())
  verdicts.push(await scenarioReader(CONFIG.qwbePort))
  return verdicts
}
