// @ts-check
// The e2e seed (QWB-51): two organizations with distinguishable names, two contacts, one of
// them pointing at the first organization through `organizationId`.
//
// Idempotent: a second run finds its own rows by the seeded names and reuses them, so the
// same rows exist after any number of runs. Teardown (`seedDown`) deletes EXACTLY the rows
// the seed created, looked up by the same names — never by "everything in the cube".
//
// All names are obviously fake; no customer-like personal data is ever written.

import { CONFIG, qwbeClient } from "./lib.mjs"

export const ORG_A = "E2E Alpha Trading SRL"
export const ORG_B = "E2E Beta Logistics SRL"
export const CONTACT_LINKED = "E2E Contact Dana Popescu"
export const CONTACT_FREE = "E2E Contact Mircea Ionescu"
// A value the inline-edit scenario writes; teardown never needs to undo it because the
// whole row is deleted anyway, but the seed re-asserts the baseline on every run.
export const CITY_BASELINE = "E2E City Alfa"

export async function makeClient(qwbePort) {
  const api = qwbeClient(qwbePort)
  await api.login()
  return api
}

const findByName = async (api, cube, name) => {
  const r = await api.call(`/${cube}?limit=50&sortBy=name`, {})
  const rows = r.body?.rows ?? []
  return rows.find((row) => row.name === name) ?? null
}

/** Create whatever is missing; return { orgA, orgB, contactLinked, contactFree }. */
export async function seedUp(api, log = console.log) {
  let orgA = await findByName(api, "organizations", ORG_A)
  if (!orgA) {
    const r = await api.call("/organizations", { method: "POST", body: { name: ORG_A, billingCity: CITY_BASELINE, industry: "manufacturing", employees: 42 } })
    if (r.status !== 200) throw new Error(`seed: create ${ORG_A} failed http ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`)
    orgA = r.body
    log(`seed: created organization ${ORG_A} (${orgA.id})`)
  }
  let orgB = await findByName(api, "organizations", ORG_B)
  if (!orgB) {
    const r = await api.call("/organizations", { method: "POST", body: { name: ORG_B, billingCity: "E2E City Beta", industry: "logistics", employees: 7 } })
    if (r.status !== 200) throw new Error(`seed: create ${ORG_B} failed http ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`)
    orgB = r.body
    log(`seed: created organization ${ORG_B} (${orgB.id})`)
  }
  // The linked contact must point at orgA; an idempotent re-run also repairs a stale link.
  let contactLinked = await findByName(api, "contacts", CONTACT_LINKED)
  if (!contactLinked) {
    const r = await api.call("/contacts", { method: "POST", body: { name: CONTACT_LINKED, email: "e2e-dana@example.com", organizationId: orgA.id } })
    if (r.status !== 200) throw new Error(`seed: create contact failed http ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`)
    contactLinked = r.body
    log(`seed: created contact ${CONTACT_LINKED} (${contactLinked.id})`)
  } else if (contactLinked.organizationId !== orgA.id) {
    const r = await api.call(`/contacts/${contactLinked.id}`, { method: "PATCH", body: { organizationId: orgA.id } })
    if (r.status !== 200) throw new Error(`seed: relink contact failed http ${r.status}`)
    log("seed: relinked contact to the first organization")
  }
  let contactFree = await findByName(api, "contacts", CONTACT_FREE)
  if (!contactFree) {
    const r = await api.call("/contacts", { method: "POST", body: { name: CONTACT_FREE, email: "e2e-mircea@example.com" } })
    if (r.status !== 200) throw new Error(`seed: create contact failed http ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`)
    contactFree = r.body
    log(`seed: created contact ${CONTACT_FREE} (${contactFree.id})`)
  }
  return { orgA, orgB, contactLinked, contactFree }
}

/** Delete exactly the rows the seed owns, by id, looked up by the seeded names. */
export async function seedDown(api) {
  // Log in again: the session token is still valid, but be defensive about it.
  try {
    await api.login()
  } catch {
    /* if login itself is gone the rows outlive the server anyway (scratch data dir) */
  }
  for (const [cube, name] of [
    ["contacts", CONTACT_LINKED],
    ["contacts", CONTACT_FREE],
    ["organizations", ORG_A],
    ["organizations", ORG_B],
  ]) {
    const row = await findByName(api, cube, name)
    if (row) {
      const r = await api.call(`/${cube}/${row.id}`, { method: "DELETE" })
      console.log(`teardown: deleted ${cube} ${name} (${row.id}) http ${r.status}`)
    }
  }
}

export const frontendUrl = (path = "/") => `http://localhost:${CONFIG.frontendPort}${path}`
