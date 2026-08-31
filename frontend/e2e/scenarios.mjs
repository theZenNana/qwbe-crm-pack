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
  await open("/login")
  await settle("Sign in")
  if (!(await waitSignInEnabled())) {
    shot("01-login-page-RED", { full: true })
    return record(name, "RED", "the Sign in submit never became enabled (no hydration)", "01-login-page-RED.png")
  }
  shot("01-login-page")
  let snap = snapshot()
  const userRef = refFor(snap.refs, "Username")
  const passRef = refFor(snap.refs, "Password")
  if (!userRef || !passRef) {
    shot("01-login-page-RED", { full: true })
    return record(name, "RED", "login form fields not found", "01-login-page-RED.png")
  }
  click(userRef, snap.refs[userRef]?.name)
  type(CONFIG.username)
  click(passRef, snap.refs[passRef]?.name)
  type(CONFIG.password)
  const submit = refFor(snap.refs, (n) => n === "Sign in")
  click(submit, snap.refs[submit]?.name)
  const landed = await waitForUrl(".*/me.*")
  // Assert the text with Orca's own wait, not with the snapshot string: the snapshot is an
  // accessibility tree that does not always carry a card's description text, so a page that
  // plainly reads "Signed in as admin" was scored RED three runs in a row.
  const textShown = await waitForText("Signed in as", 20_000)
  snap = snapshot()
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
  click(header, snap.refs[header]?.name)
  await waitForText("Name ↑")
  const second = sortBtn(snapshot().refs)
  click(second, snapshot().refs[second]?.name)
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
  click(filter, snapshot().refs[filter]?.name)
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
  click(cityBtn, snap.refs[cityBtn]?.name)
  await pause(1500)
  snap = snapshot()
  // The open editor is a textbox labelled with the field's label ("Billing City");
  // match the role, not just the name, so the column header cannot answer.
  const target = Object.entries(snap.refs).find(
    ([, v]) => v.role === "textbox" && /city/i.test(v.name ?? ""),
  )?.[0]
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
  const verdict = saved && noError ? "PASS" : "RED"
  return record(name, verdict, verdict === "PASS" ? `${newValue} visible after Enter` : "new value did not appear", "03-after-inline-edit.png")
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
  const textField = refFor(snap.refs, (n) => n === String(value) || n.includes(nonEditable.label))
  if (textField) {
    click(textField, snap.refs[textField]?.name)
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
  const contactLink = refFor(snap.refs, CONTACT_LINKED)
  if (!contactLink) {
    shot("05-nav-RED", { full: true })
    return record(name, "RED", "organization detail does not link to its contact", "05-nav-RED.png")
  }
  click(contactLink, snap.refs[contactLink]?.name)
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
  click(backLink, snap.refs[backLink]?.name)
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
  click(btn, snap.refs[btn]?.name)
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

export async function scenarioCustomField() {
  const name = "custom field defined in the UI appears, is set inline, and disappears on delete"
  await open("/contacts")
  await settle(CONTACT_LINKED)
  let snap = snapshot()

  // 1. open the definitions panel
  const panelBtn = refFor(snap.refs, (n) => n === "Custom fields")
  if (!panelBtn) {
    shot("07-panel-RED", { full: true })
    return record(name, "RED", "no Custom fields button on the contacts list", "07-panel-RED.png")
  }
  click(panelBtn, snap.refs[panelBtn]?.name)
  const panelOpen = await waitForText("Fields defined at runtime", 15_000)
  snap = snapshot()
  if (!panelOpen) {
    shot("07-panel-RED", { full: true })
    return record(name, "RED", "definitions panel did not open", "07-panel-RED.png")
  }
  shot("07-panel-open")

  // 2. define a select field
  const nameBox = Object.entries(snap.refs).find(([, v]) => v.role === "textbox" && v.name === "Name")?.[0]
  const labelBox = Object.entries(snap.refs).find(([, v]) => v.role === "textbox" && v.name === "Label")?.[0]
  if (!nameBox || !labelBox) {
    shot("07-define-RED", { full: true })
    return record(name, "RED", "definition form inputs not found", "07-define-RED.png")
  }
  click(nameBox, snap.refs[nameBox]?.name)
  keypress("ctrl+a")
  type(CF_NAME)
  click(labelBox, snap.refs[labelBox]?.name)
  keypress("ctrl+a")
  type(CF_LABEL)
  // Type select: open the combobox and pick "select".
  const typeCombo = Object.entries(snap.refs).find(([, v]) => v.role === "combobox" && /type/i.test(v.name ?? ""))?.[0]
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
  click(selectOption, snap.refs[selectOption]?.name)
  await new Promise((r) => setTimeout(r, 500))
  snap = snapshot()
  // The options input appears only for type=select (metadata-driven form).
  const optionsBox = Object.entries(snap.refs).find(([, v]) => v.role === "textbox" && /Options/.test(v.name ?? ""))?.[0]
  if (!optionsBox) {
    shot("07-define-RED", { full: true })
    return record(name, "RED", "options input did not appear for type select", "07-define-RED.png")
  }
  click(optionsBox, snap.refs[optionsBox]?.name)
  type(CF_OPTIONS)
  snap = snapshot()
  const addBtn = refFor(snap.refs, "Add field")
  if (!addBtn) {
    shot("07-define-RED", { full: true })
    return record(name, "RED", "Add field button not found", "07-define-RED.png")
  }
  click(addBtn, snap.refs[addBtn]?.name)
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
  for (let i = 0; i < 20 && !editBtn; i++) {
    editBtn = Object.entries(snap.refs).find(
      ([, v]) => v.role === "button" && v.name === `Edit ${CF_LABEL}`,
    )?.[0]
    if (!editBtn) {
      await new Promise((r) => setTimeout(r, 500))
      snap = snapshot()
    }
  }
  if (!editBtn) {
    shot("07-inline-RED", { full: true })
    return record(name, "RED", "no inline edit affordance on the custom column", "07-inline-RED.png")
  }
  click(editBtn, snap.refs[editBtn]?.name)
  snap = snapshot()
  const cellCombo = Object.entries(snap.refs).find(([, v]) => v.role === "combobox" && v.name === CF_LABEL)?.[0]
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
  click(emailOption, snap.refs[emailOption]?.name)
  shot("07-inline-saved")

  // 4. the save must be VISIBLE in the cell, not merely "somewhere on the
  // page": the definitions panel is still open here and its Options cell
  // already renders "email, phone, event", so any page-text assertion on
  // "email" passes even with the merge bug (QWB-52 review 3). Close the
  // panel, re-snapshot, and require BOTH: the cell's edit button exists AND
  // the options string is gone AND the bare value text is on the page.
  const hideBtn = Object.entries(snapshot().refs).find(
    ([, v]) => v.role === "button" && v.name === "Hide custom fields",
  )?.[0]
  if (hideBtn) {
    click(hideBtn, "Hide custom fields")
    await pause()
  }
  snap = snapshot()
  const panelClosed = !snap.text.includes(CF_OPTIONS)
  const cellBtn = Object.entries(snap.refs).find(
    ([, v]) => v.role === "button" && v.name === `Edit ${CF_LABEL}`,
  )?.[0]
  const cellShowsValue = snap.text.includes("email")
  if (!panelClosed || !cellBtn || !cellShowsValue) {
    shot("07-inline-RED", { full: true })
    return record(
      name,
      "RED",
      `cell after save: panel closed=${panelClosed}, edit button=${Boolean(cellBtn)}, value text=${cellShowsValue}`,
      "07-inline-RED.png",
    )
  }

  // 5. delete the definition; the column disappears on the next metadata
  // read. The panel was closed for the value assertion above, so reopen it
  // first. The delete is a two-step confirm in the UI (QWB-52 review 17):
  // the first click scans how many rows carry a value.
  const reopenBtn = Object.entries(snap.refs).find(
    ([, v]) => v.role === "button" && v.name === "Custom fields",
  )?.[0]
  if (!reopenBtn) {
    shot("07-delete-RED", { full: true })
    return record(name, "RED", "the Custom fields button is gone after closing the panel", "07-delete-RED.png")
  }
  click(reopenBtn, "Custom fields")
  if (!(await waitForText("Fields defined at runtime", 15_000))) {
    shot("07-delete-RED", { full: true })
    return record(name, "RED", "definitions panel did not reopen", "07-delete-RED.png")
  }
  snap = snapshot()
  const deleteBtn = Object.entries(snap.refs).find(
    ([, v]) => v.role === "button" && v.name === `Delete ${CF_LABEL}`,
  )?.[0]
  if (!deleteBtn) {
    shot("07-delete-RED", { full: true })
    return record(name, "RED", "delete button for the definition not found", "07-delete-RED.png")
  }
  click(deleteBtn, snap.refs[deleteBtn]?.name)
  await pause()
  snap = snapshot()
  const confirmBtn = Object.entries(snap.refs).find(
    ([, v]) => v.role === "button" && v.name === `Confirm delete ${CF_LABEL}`,
  )?.[0]
  if (!confirmBtn) {
    shot("07-delete-RED", { full: true })
    return record(name, "RED", "the delete confirm step did not appear", "07-delete-RED.png")
  }
  click(confirmBtn, snap.refs[confirmBtn]?.name)
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
  await open("/login")
  await settle("Sign in")
  if (!(await waitSignInEnabled())) {
    shot("08-reader-RED", { full: true })
    return record(name, "RED", "the Sign in submit never became enabled (no hydration)", "08-reader-RED.png")
  }
  let snap = snapshot()
  const userRef = refFor(snap.refs, "Username")
  const passRef = refFor(snap.refs, "Password")
  if (!userRef || !passRef) {
    shot("08-reader-RED", { full: true })
    return record(name, "RED", "login form fields not found for the reader", "08-reader-RED.png")
  }
  click(userRef, snap.refs[userRef]?.name)
  type("reader")
  click(passRef, snap.refs[passRef]?.name)
  type("reader")
  const submit = refFor(snap.refs, (n) => n === "Sign in")
  click(submit, snap.refs[submit]?.name)
  const landed = (await waitForUrl(".*/me.*", 20_000)) && (await waitForText("Signed in as", 15_000))
  if (!landed) {
    const fields = orca(
      "eval",
      "--expression",
      "JSON.stringify([...document.querySelectorAll('input')].map((i) => [i.name || i.id, i.value]))",
    )
    console.log(`  reader fields after submit: ${fields.result}`)
  }
  if (!landed) {
    shot("08-reader-RED", { full: true })
    snap = snapshot()
    return record(name, "RED", `reader login did not land on the identity page (origin ${snap.origin}; text: ${snap.text.replace(/\s+/g, " ").slice(0, 200)})`, "08-reader-RED.png")
  }
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

/** Define one field through the open panel; fresh snapshot for every step. */
async function defineField(name, label, typeName, options) {
  for (let i = 0; i < 20; i++) {
    const snap = snapshot()
    const nameBox = Object.entries(snap.refs).find(([, v]) => v.role === "textbox" && v.name === "Name")?.[0]
    const labelBox = Object.entries(snap.refs).find(([, v]) => v.role === "textbox" && v.name === "Label")?.[0]
    const typeCombo = Object.entries(snap.refs).find(([, v]) => v.role === "combobox" && /type/i.test(v.name ?? ""))?.[0]
    if (nameBox && labelBox && typeCombo) {
      click(nameBox, snap.refs[nameBox]?.name)
      keypress("ctrl+a")
      type(name)
      click(labelBox, snap.refs[labelBox]?.name)
      keypress("ctrl+a")
      type(label)
      if (await openSelect(typeCombo)) {
        const s2 = snapshot()
        const option = Object.entries(s2.refs).find(([, v]) => v.role === "option" && v.name === typeName)?.[0]
        if (option) {
          click(option, s2.refs[option]?.name)
          await new Promise((r) => setTimeout(r, 500))
          const s3 = snapshot()
          if (typeName === "select") {
            const optionsBox = Object.entries(s3.refs).find(([, v]) => v.role === "textbox" && /Options/.test(v.name ?? ""))?.[0]
            if (optionsBox) {
              click(optionsBox, s3.refs[optionsBox]?.name)
              type(options ?? "")
            }
          }
          const s4 = snapshot()
          const addBtn = refFor(s4.refs, "Add field")
          if (addBtn) {
            click(addBtn, s4.refs[addBtn]?.name)
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
      click(btn, snap.refs[btn]?.name)
      await pause(1200)
      return true
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

/** Delete one definition through the two-step confirm; true when its row is gone. */
async function deleteField(label) {
  for (let i = 0; i < 20; i++) {
    const snap = snapshot()
    const del = Object.entries(snap.refs).find(([, v]) => v.role === "button" && v.name === `Delete ${label}`)?.[0]
    if (del) {
      click(del, snap.refs[del]?.name)
      await pause()
      const s2 = snapshot()
      const confirm = Object.entries(s2.refs).find(
        ([, v]) => v.role === "button" && v.name === `Confirm delete ${label}`,
      )?.[0]
      if (confirm) {
        click(confirm, s2.refs[confirm]?.name)
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

export async function scenarioCustomFieldTypes(api, seed) {
  const name = "bool, number and date custom fields set inline; an emptied required text field is refused"
  await open("/contacts")
  await settle(CONTACT_LINKED)
  let snap = snapshot()
  const panelBtn = refFor(snap.refs, (n) => n === "Custom fields")
  if (!panelBtn) {
    shot("09-panel-RED", { full: true })
    return record(name, "RED", "no Custom fields button on the contacts list", "09-panel-RED.png")
  }
  click(panelBtn, "Custom fields")
  if (!(await waitForText("Fields defined at runtime", 15_000))) {
    shot("09-panel-RED", { full: true })
    return record(name, "RED", "definitions panel did not open", "09-panel-RED.png")
  }

  const failures = []
  for (const [n, l, t, o] of [
    [V_NAME, V_LABEL, "number", null],
    [B_NAME, B_LABEL, "bool", null],
    [D_NAME, D_LABEL, "date", null],
    [N_NAME, N_LABEL, "text", null],
  ]) {
    if (!(await defineField(n, l, t, o))) failures.push(`define ${n} failed`)
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
          click(box, s.refs[box]?.name)
          return true
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
  verdicts.push(await scenarioInlineEdit())
  verdicts.push(await scenarioNonEditable(api))
  verdicts.push(await scenarioNavigation(seed))
  verdicts.push(await scenarioCustomField())
  verdicts.push(await scenarioCustomFieldTypes(api, seed))
  verdicts.push(await scenarioLogout())
  verdicts.push(await scenarioReader(CONFIG.qwbePort))
  return verdicts
}
