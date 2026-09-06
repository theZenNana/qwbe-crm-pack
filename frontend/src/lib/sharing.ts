// Typed sharing adapter for the CRM detail page.
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

// Group members page (kernel slice 2026-09: GET /permissions/groups/{id}/members,
// PageParams offset/limit capped at 200 by the backend). The group id is ONE
// percent-encoded path segment; the page window travels explicitly.
export function groupMembersPath(groupId: string, offset: number, limit: number): string | null {
  const id = oneSegment(groupId)
  if (!id) return null
  if (!Number.isInteger(offset) || offset < 0) return null
  if (!Number.isInteger(limit) || limit < 1) return null
  return `/api/qwbe/permissions/groups/${id}/members?offset=${offset}&limit=${limit}`
}

export function groupCreatePath(): string {
  return "/api/qwbe/permissions/groups"
}

export function groupRenamePath(groupId: string): string | null {
  const id = oneSegment(groupId)
  return id ? `/api/qwbe/permissions/groups/${id}` : null
}

export function groupMembersAddPath(groupId: string): string | null {
  const id = oneSegment(groupId)
  return id ? `/api/qwbe/permissions/groups/${id}/members` : null
}

export function groupMembersRemovePath(groupId: string): string | null {
  const id = oneSegment(groupId)
  return id ? `/api/qwbe/permissions/groups/${id}/members/remove` : null
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
// Groups admin adapter (Settings > Users and Groups)
// ---------------------------------------------------------------------------

// GroupMembershipSchema (permissions-schemas.ts:13-19). Members are addressed
// by `username` on write, but carry an opaque `userId` here: labels resolve
// through lookupUserNames, falling back to the raw id.
export type GroupMembership = {
  id: string
  groupId: string
  userId: string
  createdBy: string
  createdAt: string
}

// PageOf(GroupMembershipSchema). This endpoint is NEW with the members kernel
// slice, so `total` is REQUIRED: a response without it is invalid and
// fetchGroupMembersPage fails visibly instead of guessing.
export type GroupMembershipPage = {
  rows: GroupMembership[]
  total: number
  offset: number
  limit: number
}

// Boundary check of the members page shape; the UI never renders a page that
// did not pass it (an unknown shape must never look like "no members").
export function parseMembersPage(raw: unknown): GroupMembershipPage | null {
  if (typeof raw !== "object" || raw === null) return null
  const page = raw as Record<string, unknown>
  const count = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0
  if (!Array.isArray(page.rows) || !count(page.total) || !count(page.offset) || !count(page.limit)) return null
  const rows: GroupMembership[] = []
  for (const row of page.rows as unknown[]) {
    if (typeof row !== "object" || row === null) return null
    const m = row as Record<string, unknown>
    if (typeof m.id !== "string" || typeof m.groupId !== "string" || typeof m.userId !== "string") return null
    rows.push({
      id: m.id,
      groupId: m.groupId,
      userId: m.userId,
      createdBy: typeof m.createdBy === "string" ? m.createdBy : "",
      createdAt: typeof m.createdAt === "string" ? m.createdAt : "",
    })
  }
  return { rows, total: page.total as number, offset: page.offset as number, limit: page.limit as number }
}

// One row of the members list. `username` is null when the account lookup
// did not return it: the row then shows the opaque id and a remove MUST ask
// for an explicit username, because the id can never be sent as a username.
export type MemberRow = {
  membershipId: string
  userId: string
  username: string | null
}

export function memberRowsOf(
  rows: ReadonlyArray<GroupMembership>,
  userNames: Readonly<Record<string, string>>,
): MemberRow[] {
  return rows.map((row) => ({
    membershipId: row.id,
    userId: row.userId,
    username: userNames[row.userId] ?? null,
  }))
}

// true = another page exists; empty rows with total 0 is the only "no
// members" signal (the caller already knows the page is valid).
export function membersHasMore(page: GroupMembershipPage): boolean {
  return page.offset + page.rows.length < page.total
}

// The admin calls validate at the boundary and keep qwbe's own message on
// refusal. status 0 = the request never reached the backend (network, proxy
// down): NOT a refusal, and for a member list NOT an empty group.

function jsonInit(payload: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }
}

// The full group rows of one cube. `status: 403` = the backend refused
// (requireCubeAccess: neither entity owner, nor cube admin, nor superadmin)
// -- the UI hides the admin panel; status 0 = network. Never throws.
export async function fetchGroups(
  cube: string,
  doFetch: typeof fetch = apiFetch,
): Promise<SharingResult<PermissionGroupRef[]>> {
  const name = cube.trim()
  if (name === "") return { ok: false, status: 400, message: "choose a cube" }
  try {
    const response = await doFetch(groupsPath(name))
    if (!response.ok) return refusal(response)
    return { ok: true, value: (await response.json()) as PermissionGroupRef[] }
  } catch {
    return { ok: false, status: 0, message: "network error" }
  }
}

// Create a group in one cube. The name is trimmed and must be nonempty
// (the server validates nonempty only; no uniqueness check exists).
export async function createGroup(opts: {
  cube: string
  name: string
  doFetch?: typeof fetch
}): Promise<SharingResult<PermissionGroupRef>> {
  const cube = opts.cube.trim()
  const name = opts.name.trim()
  if (cube === "") return { ok: false, status: 400, message: "choose a cube" }
  if (name === "") return { ok: false, status: 400, message: "the group name cannot be empty" }
  const doFetch = opts.doFetch ?? apiFetch
  try {
    const response = await doFetch(groupCreatePath(), jsonInit({ cube, name }))
    if (!response.ok) return refusal(response)
    return { ok: true, value: (await response.json()) as PermissionGroupRef }
  } catch {
    return { ok: false, status: 0, message: "network error" }
  }
}

// Rename by group id (PATCH). Same nonempty-name rule.
export async function renameGroup(opts: {
  groupId: string
  name: string
  doFetch?: typeof fetch
}): Promise<SharingResult<PermissionGroupRef>> {
  const name = opts.name.trim()
  if (name === "") return { ok: false, status: 400, message: "the group name cannot be empty" }
  const path = groupRenamePath(opts.groupId)
  if (!path) return { ok: false, status: 400, message: "invalid group id" }
  const doFetch = opts.doFetch ?? apiFetch
  try {
    const response = await doFetch(path, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    })
    if (!response.ok) return refusal(response)
    return { ok: true, value: (await response.json()) as PermissionGroupRef }
  } catch {
    return { ok: false, status: 0, message: "network error" }
  }
}

// One members page with EXPLICIT offset and limit; total comes back so the
// UI knows whether the list is truly empty or a refusal/network gap. Never
// throws: status 0 marks a network failure; a 200 with an invalid body is
// reported as a failure with the response status, never as an empty page.
export async function fetchGroupMembersPage(opts: {
  groupId: string
  offset: number
  limit: number
  doFetch?: typeof fetch
}): Promise<SharingResult<GroupMembershipPage>> {
  const path = groupMembersPath(opts.groupId, opts.offset, opts.limit)
  if (!path) return { ok: false, status: 400, message: "invalid group id or page window" }
  const doFetch = opts.doFetch ?? apiFetch
  try {
    const response = await doFetch(path)
    if (!response.ok) return refusal(response)
    const page = parseMembersPage(await response.json().catch(() => null))
    if (!page) return { ok: false, status: response.status, message: "invalid members page response" }
    return { ok: true, value: page }
  } catch {
    return { ok: false, status: 0, message: "network error" }
  }
}

// Add one member by username. Idempotent on the backend (an existing
// membership is returned as is).
export async function addGroupMember(opts: {
  groupId: string
  username: string
  doFetch?: typeof fetch
}): Promise<SharingResult<GroupMembership>> {
  const username = opts.username.trim()
  if (username === "") return { ok: false, status: 400, message: "choose a user" }
  const path = groupMembersAddPath(opts.groupId)
  if (!path) return { ok: false, status: 400, message: "invalid group id" }
  const doFetch = opts.doFetch ?? apiFetch
  try {
    const response = await doFetch(path, jsonInit({ username }))
    if (!response.ok) return refusal(response)
    return { ok: true, value: (await response.json()) as GroupMembership }
  } catch {
    return { ok: false, status: 0, message: "network error" }
  }
}

// Remove one member by username. The backend answers 404 for a membership
// that does not exist; qwbe's message travels verbatim.
export async function removeGroupMember(opts: {
  groupId: string
  username: string
  doFetch?: typeof fetch
}): Promise<SharingResult<{ removed: string }>> {
  const username = opts.username.trim()
  if (username === "") return { ok: false, status: 400, message: "choose a user" }
  const path = groupMembersRemovePath(opts.groupId)
  if (!path) return { ok: false, status: 400, message: "invalid group id" }
  const doFetch = opts.doFetch ?? apiFetch
  try {
    const response = await doFetch(path, jsonInit({ username }))
    if (!response.ok) return refusal(response)
    return { ok: true, value: (await response.json()) as { removed: string } }
  } catch {
    return { ok: false, status: 0, message: "network error" }
  }
}

// Remove the member whose account id the operator clicked. The remove route
// takes a USERNAME, so the id is resolved fresh through the directory right
// before the request; an id the directory cannot resolve now is refused
// without any request, and a username typed by the operator is never used
// as the target. The kernel answers with the id it actually removed; a
// mismatch is reported as a failure, never as success.
export async function removeGroupMemberById(opts: {
  groupId: string
  userId: string
  doFetch?: typeof fetch
}): Promise<SharingResult<{ removed: string; username: string }>> {
  const doFetch = opts.doFetch ?? apiFetch
  const username = (await lookupUserNames([opts.userId], doFetch))[opts.userId]
  if (!username) return { ok: false, status: 0, message: "cannot resolve this account right now, try again" }
  const result = await removeGroupMember({ groupId: opts.groupId, username, doFetch })
  if (!result.ok) return result
  if (result.value.removed !== opts.userId) {
    return {
      ok: false,
      status: 500,
      message: `removed account ${result.value.removed} instead of ${opts.userId}; the member list was refreshed`,
    }
  }
  return { ok: true, value: { removed: result.value.removed, username } }
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
