// Typed sharing adapter for the CRM detail page (QWB-66).
//
// Wraps the qwbe `permissions` cube's entity-sharing routes (verified against
// qwbe core/src/cubes/permissions/api.ts and permissions-schemas.ts) so the
// sharing panel never builds a path or payload by hand. All calls go through
// the same-origin proxy (/api/qwbe/...), the same rule as lib/cube.ts.
//
// Authority model (backend-enforced, mirrored here only as copy): only the
// entity owner, a cube admin or a superadmin may list, create or revoke
// grants; a TOTAL grantee may NOT re-share (requireShare ignores the share
// action). No capability (QWB-63) grant is ever issued from here.

import { apiFetch, errorBody, errorMessage } from "./cube.ts"

// The exact action vocabulary qwbe's permissions model publishes
// (core/src/cubes/permissions/permissions-model.ts). TOTAL is this exact SET
// of six, never "an array of length 6".
export const ENTITY_ACTIONS = ["read", "create", "edit", "delete", "share", "transfer"] as const
export type EntityAction = (typeof ENTITY_ACTIONS)[number]
export const TOTAL_ACTIONS: ReadonlyArray<EntityAction> = [...ENTITY_ACTIONS]

export type GrantSubject =
  | { kind: "user"; userId: string }
  | { kind: "group"; groupId: string }

// EntityGrantSchema (core/src/cubes/permissions/permissions-schemas.ts:20-33).
export type EntityGrant = {
  id: string
  cube: string
  entityType: string
  entityId: string
  subject: GrantSubject
  actions: EntityAction[]
  createdBy: string
  createdAt: string
}

// EntityGrantPageSchema (permissions-schemas.ts:136-142): total is required
// here, but the view keeps it optional so a response from an older kernel
// cannot push the panel into silent truncation (see grantsPageView).
export type EntityGrantPage = {
  rows: EntityGrant[]
  total?: number
  offset: number
  limit: number
  sortedBy?: string
}

// Account fields the panel uses; the hash never travels and the picker must
// never render `email` (contract inventory G8).
export type AccountRef = {
  id: string
  username: string
  displayName: string | null
}

export type PermissionGroupRef = {
  id: string
  cube: string
  name: string
  createdBy: string
  createdAt: string
}

export type SharingResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; message: string }

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function oneSegment(value: string): string | null {
  const trimmed = value.trim()
  return trimmed === "" ? null : encodeURIComponent(trimmed)
}

// The entity reference the permissions cube serves. The cube name carries a
// slash and is ONE path parameter, so it travels percent-encoded as one
// segment (the proxy re-encodes each decoded segment for the same reason).
export function grantsRefPath(
  cube: string,
  entityType: string,
  entityId: string,
): string | null {
  const c = oneSegment(cube)
  const t = oneSegment(entityType)
  const e = oneSegment(entityId)
  if (!c || !t || !e) return null
  return `/api/qwbe/permissions/entities/${c}/${t}/${e}`
}

// One grant page with EXPLICIT offset and limit: the panel asks for a page,
// reads `total` from the response and continues by offset -- never a silent
// client-side slice of one big request.
export function grantsPagePath(
  cube: string,
  entityType: string,
  entityId: string,
  offset: number,
  limit: number,
): string | null {
  const ref = grantsRefPath(cube, entityType, entityId)
  if (!ref) return null
  if (!Number.isInteger(offset) || offset < 0) return null
  if (!Number.isInteger(limit) || limit < 1) return null
  return `${ref}/grants?offset=${offset}&limit=${limit}`
}

// Typeahead search over the account directory (q scans username,
// displayName, email; the picker renders username + displayName only).
export function userSearchPath(q: string, limit: number): string {
  const params = new URLSearchParams()
  const text = q.trim()
  if (text !== "") params.set("q", text)
  params.set("limit", String(Number.isInteger(limit) && limit > 0 ? limit : 20))
  return `/api/qwbe/account?${params.toString()}`
}

// Batch label resolution for grant rows, by opaque account id
// (`ids=a,b` is a batch, not a page -- same contract as relation-batch).
export function userNamesPath(ids: ReadonlyArray<string>): string | null {
  const unique = [...new Set(ids.map((id) => id.trim()).filter((id) => id !== ""))]
  if (unique.length === 0) return null
  return `/api/qwbe/account?ids=${encodeURIComponent(unique.join(","))}`
}

// The groups of ONE cube, for the group picker and group chip labels.
export function groupsPath(cube: string): string {
  return `/api/qwbe/permissions/groups?cube=${encodeURIComponent(cube.trim())}`
}

// Revoke goes by grant id, one path segment.
export function grantRevokePath(grantId: string): string | null {
  const id = oneSegment(grantId)
  return id ? `/api/qwbe/permissions/grants/${id}` : null
}

// ---------------------------------------------------------------------------
// Payloads: EXPLICIT, nonempty actions on every create
// ---------------------------------------------------------------------------

// True only for the exact six-action set. A six-element array with a
// duplicate and a missing action is NOT total.
export function isTotalActions(actions: ReadonlyArray<string>): actions is ReadonlyArray<EntityAction> {
  if (actions.length !== ENTITY_ACTIONS.length) return false
  return new Set(actions).size === ENTITY_ACTIONS.length &&
    actions.every((a) => (ENTITY_ACTIONS as readonly string[]).includes(a))
}

export type GrantPayloadError = "subject" | "actions"

type PayloadOutcome =
  | { payload: { actions: EntityAction[]; [k: string]: string | EntityAction[] } }
  | { error: GrantPayloadError }

function normalizeActions(raw: ReadonlyArray<string>): PayloadOutcome {
  // Deduplicate while keeping the caller's order; every element must be a
  // published action.
  const seen = new Set<string>()
  const actions: EntityAction[] = []
  for (const a of raw) {
    if (!(ENTITY_ACTIONS as readonly string[]).includes(a)) return { error: "actions" }
    if (!seen.has(a)) {
      seen.add(a)
      actions.push(a as EntityAction)
    }
  }
  // Explicit and nonempty: the backend would default user grants to TOTAL
  // when `actions` is omitted, and this adapter never relies on a silent
  // default (G3: group grants have no default at all).
  if (actions.length === 0) return { error: "actions" }
  // A custom set never carries `share` (G6): requireShare ignores the share
  // action, so a "share" checkbox would lie. Only the exact TOTAL set
  // includes it.
  if (!isTotalActions(actions) && seen.has("share")) return { error: "actions" }
  return { payload: { actions } }
}

// Share with one user by username. Returns qwbe's payload shape
// (UserGrantCreate) with an EXPLICIT actions array.
export function userGrantPayload(
  username: string,
  actions: ReadonlyArray<string>,
): PayloadOutcome {
  const name = username.trim()
  if (name === "") return { error: "subject" }
  const outcome = normalizeActions(actions)
  if ("error" in outcome) return outcome
  return { payload: { username: name, actions: outcome.payload.actions } }
}

// Share with one group. The backend REQUIRES actions here (no default, G3).
export function groupGrantPayload(
  groupId: string,
  actions: ReadonlyArray<string>,
): PayloadOutcome {
  const id = groupId.trim()
  if (id === "") return { error: "subject" }
  const outcome = normalizeActions(actions)
  if ("error" in outcome) return outcome
  return { payload: { groupId: id, actions: outcome.payload.actions } }
}

// Chip label for a grant's action list: the literal "TOTAL" for the exact six
// (never colour, never a length check), else the action names joined.
export function grantActionsLabel(actions: ReadonlyArray<string>): string {
  return isTotalActions(actions) ? "TOTAL" : actions.join(", ")
}

// The three levels the form offers. "custom" never carries `share` (G6) and
// is offered in the published action order, so the confirmation line and the
// payload list the same set in the same order.
export type ShareLevel = "total" | "read" | "custom"
export const CUSTOM_ACTIONS: ReadonlyArray<EntityAction> = ENTITY_ACTIONS.filter((a) => a !== "share")

export function actionsForLevel(level: ShareLevel, custom: ReadonlyArray<string>): EntityAction[] {
  if (level === "total") return [...TOTAL_ACTIONS]
  if (level === "read") return ["read"]
  return CUSTOM_ACTIONS.filter((a) => custom.includes(a))
}

// ---------------------------------------------------------------------------
// Grant page: explicit offset + total, no silent truncation
// ---------------------------------------------------------------------------

export type GrantsPageView = {
  rows: EntityGrant[]
  total: number | undefined
  offset: number
  limit: number
  // true = another page exists (total known and not reached);
  // false = this page is the last;
  // null = the response carried no total: the ONLY safe continuation is
  // probing the next offset, and the UI must say "more?" instead of counting.
  hasMore: boolean | null
}

export function grantsPageView(page: EntityGrantPage): GrantsPageView {
  const nextOffset = page.offset + page.rows.length
  return {
    rows: page.rows,
    total: page.total,
    offset: page.offset,
    limit: page.limit,
    hasMore: page.total === undefined ? (page.rows.length > 0 ? null : false) : nextOffset < page.total,
  }
}

// ---------------------------------------------------------------------------
// Chips: one per grant row, opaque-id fallback
// ---------------------------------------------------------------------------

export type GrantChip = {
  grantId: string
  kind: "user" | "group"
  // The raw subject id (opaque account id or group id) -- always present so a
  // chip survives an unresolved name.
  subjectId: string
  label: string
  actions: string
  total: boolean
}

// One chip per grant row, in response order. Duplicate rows for the same
// subject stay as separate, separately revokable chips (the backend does not
// deduplicate grants). Names come from the resolved lookups; an id with no
// resolved name falls back to the raw id -- never to an empty chip.
export function chipsOf(
  rows: ReadonlyArray<EntityGrant>,
  userNames: Readonly<Record<string, string>>,
  groupNames: Readonly<Record<string, string>>,
): GrantChip[] {
  return rows.map((row) => {
    const subject = row.subject
    const isUser = subject.kind === "user"
    const subjectId = isUser ? subject.userId : (subject as { groupId: string }).groupId
    const names = isUser ? userNames : groupNames
    return {
      grantId: row.id,
      kind: row.subject.kind,
      subjectId,
      label: names[subjectId] ?? subjectId,
      actions: grantActionsLabel(row.actions),
      total: isTotalActions(row.actions),
    }
  })
}

// ---------------------------------------------------------------------------
// Calls: every refusal keeps qwbe's own message
// ---------------------------------------------------------------------------

async function refusal(response: Response): Promise<{ ok: false; status: number; message: string }> {
  return {
    ok: false,
    status: response.status,
    message: errorMessage(await errorBody(response)),
  }
}

// One grant page. offset/limit travel explicitly; the caller decides whether
// to continue.
export async function fetchGrantPage(opts: {
  cube: string
  entityType: string
  entityId: string
  offset: number
  limit: number
  doFetch?: typeof fetch
}): Promise<SharingResult<EntityGrantPage>> {
  const path = grantsPagePath(opts.cube, opts.entityType, opts.entityId, opts.offset, opts.limit)
  const doFetch = opts.doFetch ?? apiFetch
  if (!path) return { ok: false, status: 400, message: "invalid entity reference or page window" }
  const response = await doFetch(path)
  if (!response.ok) return refusal(response)
  return { ok: true, value: (await response.json()) as EntityGrantPage }
}

// Directory search for the user picker. `null` = the directory refused or is
// unreachable (403 on account:read, network): the picker must say so and
// leave the typed username as the identity, never show "no matches" for a
// refusal and never ask for anything more (no enumeration escalation).
export async function searchUsers(opts: {
  q: string
  limit: number
  doFetch?: typeof fetch
}): Promise<AccountRef[] | null> {
  const doFetch = opts.doFetch ?? apiFetch
  try {
    const response = await doFetch(userSearchPath(opts.q, opts.limit))
    if (!response.ok) return null
    const page = (await response.json()) as { rows?: Array<Record<string, unknown>> }
    return (page.rows ?? []).flatMap((row) => {
      const id = typeof row.id === "string" ? row.id : ""
      const username = typeof row.username === "string" ? row.username : ""
      if (id === "" || username === "") return []
      return [{
        id,
        username,
        displayName: typeof row.displayName === "string" ? row.displayName : null,
      }]
    })
  } catch {
    return null
  }
}

// Batch label resolution for user chips. A row the response did not return
// (deleted account) is simply absent, so the chip falls back to the raw id.
export async function lookupUserNames(
  ids: ReadonlyArray<string>,
  doFetch: typeof fetch = apiFetch,
): Promise<Record<string, string>> {
  const path = userNamesPath(ids)
  if (!path) return {}
  try {
    const response = await doFetch(path)
    if (!response.ok) return {}
    const page = (await response.json()) as { rows?: Array<Record<string, unknown>> }
    const names: Record<string, string> = {}
    for (const row of page.rows ?? []) {
      if (typeof row.id === "string" && typeof row.username === "string") {
        names[row.id] = row.username
      }
    }
    return names
  } catch {
    return {}
  }
}

// The groups of one cube. `null` means the backend refused -- 403 for a user
// who is neither an entity owner nor a cube admin nor a superadmin
// (requireCubeAccess): the panel hides the group form and keeps the user
// form. Any other failure degrades the same way; it never throws.
export async function lookupGroups(
  cube: string,
  doFetch: typeof fetch = apiFetch,
): Promise<Record<string, string> | null> {
  try {
    const response = await doFetch(groupsPath(cube))
    if (!response.ok) return null
    const rows = (await response.json()) as PermissionGroupRef[]
    const names: Record<string, string> = {}
    for (const group of rows) names[group.id] = group.name
    return names
  } catch {
    return null
  }
}

// Share with a user. The payload is built by userGrantPayload -- an EXPLICIT,
// nonempty action set, never a silent backend default.
export async function createUserGrant(opts: {
  cube: string
  entityType: string
  entityId: string
  username: string
  actions: ReadonlyArray<string>
  doFetch?: typeof fetch
}): Promise<SharingResult<EntityGrant>> {
  const outcome = userGrantPayload(opts.username, opts.actions)
  if ("error" in outcome) {
    return { ok: false, status: 400, message: "choose a user and at least one action" }
  }
  const ref = grantsRefPath(opts.cube, opts.entityType, opts.entityId)
  if (!ref) return { ok: false, status: 400, message: "invalid entity reference" }
  const doFetch = opts.doFetch ?? apiFetch
  const response = await doFetch(`${ref}/grants/user`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(outcome.payload),
  })
  if (!response.ok) return refusal(response)
  return { ok: true, value: (await response.json()) as EntityGrant }
}

// Share with a group. Actions are REQUIRED (no backend default, G3).
export async function createGroupGrant(opts: {
  cube: string
  entityType: string
  entityId: string
  groupId: string
  actions: ReadonlyArray<string>
  doFetch?: typeof fetch
}): Promise<SharingResult<EntityGrant>> {
  const outcome = groupGrantPayload(opts.groupId, opts.actions)
  if ("error" in outcome) {
    return { ok: false, status: 400, message: "choose a group and at least one action" }
  }
  const ref = grantsRefPath(opts.cube, opts.entityType, opts.entityId)
  if (!ref) return { ok: false, status: 400, message: "invalid entity reference" }
  const doFetch = opts.doFetch ?? apiFetch
  const response = await doFetch(`${ref}/grants/group`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(outcome.payload),
  })
  if (!response.ok) return refusal(response)
  return { ok: true, value: (await response.json()) as EntityGrant }
}

// Revoke by grant id (the backend answers 404 for a missing or soft-deleted
// grant; qwbe's message travels verbatim).
export async function revokeGrant(
  grantId: string,
  doFetch: typeof fetch = apiFetch,
): Promise<SharingResult<{ revoked: string }>> {
  const path = grantRevokePath(grantId)
  if (!path) return { ok: false, status: 400, message: "invalid grant id" }
  const response = await doFetch(path, { method: "DELETE" })
  if (!response.ok) return refusal(response)
  return { ok: true, value: (await response.json()) as { revoked: string } }
}
