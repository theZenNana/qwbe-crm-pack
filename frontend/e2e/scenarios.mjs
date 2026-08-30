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
  record,
  refFor,
  shot,
  snapshot,
  type,
  waitForText,
  waitForUrl,
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

async function settle(text, timeout = 30_000) {
  const ok = await waitForText(text, timeout)
  if (!ok) throw new Error(`page never showed ${JSON.stringify(text)}`)
}

// --- 1. login with the correct credentials lands on the identity page -----------
export async function scenarioLogin() {
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
  click(header)
  await waitForText("Name ↑")
  click(sortBtn(snapshot().refs))
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
  // The row for Alpha: editable cells carry buttons whose accessible name is
  // "Edit <label>"; the city column is "Billing City". The edit lands on the
  // first city-ish button and the row context is verified by the saved value.
  const cityBtn = refFor(snap.refs, (n) => /^Edit .*City/i.test(n))
  if (!cityBtn) {
    shot("03-edit-RED", { full: true })
    return record(name, "RED", "no editable City cell button found", "03-edit-RED.png")
  }
  click(cityBtn)
  snap = snapshot()
  // The open editor is a textbox labelled with the field's label ("Billing City");
  // match the role, not just the name, so the column header cannot answer.
  const target = Object.entries(snap.refs).find(
    ([, v]) => v.role === "textbox" && /city/i.test(v.name ?? ""),
  )?.[0]
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
    click(textField)
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
  click(panelBtn)
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
  click(nameBox)
  keypress("ctrl+a")
  type(CF_NAME)
  click(labelBox)
  keypress("ctrl+a")
  type(CF_LABEL)
  // Type select: open the combobox and pick "select".
  const typeCombo = Object.entries(snap.refs).find(([, v]) => v.role === "combobox" && /type/i.test(v.name ?? ""))?.[0]
  if (!typeCombo) {
    shot("07-define-RED", { full: true })
    return record(name, "RED", "type combobox not found in the definition form", "07-define-RED.png")
  }
  click(typeCombo)
  snap = snapshot()
  const selectOption = Object.entries(snap.refs).find(([, v]) => v.role === "option" && v.name === "select")?.[0]
  if (!selectOption) {
    shot("07-define-RED", { full: true })
    return record(name, "RED", "the select option is missing from the type combobox", "07-define-RED.png")
  }
  click(selectOption)
  await new Promise((r) => setTimeout(r, 500))
  snap = snapshot()
  // The options input appears only for type=select (metadata-driven form).
  const optionsBox = Object.entries(snap.refs).find(([, v]) => v.role === "textbox" && /Options/.test(v.name ?? ""))?.[0]
  if (!optionsBox) {
    shot("07-define-RED", { full: true })
    return record(name, "RED", "options input did not appear for type select", "07-define-RED.png")
  }
  click(optionsBox)
  type(CF_OPTIONS)
  snap = snapshot()
  const addBtn = refFor(snap.refs, "Add field")
  if (!addBtn) {
    shot("07-define-RED", { full: true })
    return record(name, "RED", "Add field button not found", "07-define-RED.png")
  }
  click(addBtn)
  // The definition appears in the panel list AND the column appears in the
  // table (the metadata is re-read after the definition change).
  const columnShown = await waitForText(CF_LABEL, 15_000)
  snap = snapshot()
  shot("07-column-appears")
  if (!columnShown) {
    shot("07-column-RED", { full: true })
    return record(name, "RED", `column ${CF_LABEL} did not appear after defining`, "07-column-RED.png")
  }

  // 3. set it inline on the seeded contact
  const editBtn = refFor(snap.refs, `Edit ${CF_LABEL}`)
  if (!editBtn) {
    shot("07-inline-RED", { full: true })
    return record(name, "RED", "no inline edit affordance on the custom column", "07-inline-RED.png")
  }
  click(editBtn)
  snap = snapshot()
  const cellCombo = Object.entries(snap.refs).find(([, v]) => v.role === "combobox" && v.name === CF_LABEL)?.[0]
  if (!cellCombo) {
    shot("07-inline-RED", { full: true })
    return record(name, "RED", "the custom cell did not open a select", "07-inline-RED.png")
  }
  click(cellCombo)
  snap = snapshot()
  const emailOption = Object.entries(snap.refs).find(([, v]) => v.role === "option" && v.name === "email")?.[0]
  if (!emailOption) {
    shot("07-inline-RED", { full: true })
    return record(name, "RED", "the custom select does not offer the defined options", "07-inline-RED.png")
  }
  click(emailOption)
  const saved = await waitForText("email", 15_000)
  snap = snapshot()
  shot("07-inline-saved")
  if (!saved) {
    shot("07-inline-RED", { full: true })
    return record(name, "RED", "the chosen option did not appear in the cell", "07-inline-RED.png")
  }

  // 4. delete the definition; the column disappears on the next metadata read
  const deleteBtn = refFor(snap.refs, `Delete ${CF_LABEL}`)
  if (!deleteBtn) {
    shot("07-delete-RED", { full: true })
    return record(name, "RED", "delete button for the definition not found", "07-delete-RED.png")
  }
  click(deleteBtn)
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
    columnGone ? "column appeared, was set inline, and disappeared after the definition was deleted" : `column ${CF_LABEL} still present after delete`,
    "07-column-gone.png",
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
  verdicts.push(await scenarioLogout())
  return verdicts
}
