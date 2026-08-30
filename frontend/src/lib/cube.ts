// Metadata-driven list and detail logic for the CRM frontend (QWB-49).
//
// The one design rule: adding a field to a cube must appear in the list without a
// line of frontend code. Everything here reads the published cube metadata
// (GET /catalog/{cube}/metadata) and the cube's own list endpoint; no module in
// this frontend names a field of a specific cube.
//
// All qwbe calls go through the server-side proxy (/api/qwbe/...), so the token
// stays in the httpOnly cookie and never reaches browser-visible code.

// The published field metadata (qwbe core/src/metadata/schemas.ts).
export type FieldMetadata = {
  name: string
  label: string
  type: string
  required: boolean
  editable: boolean
  sortable: boolean
  searchable: boolean
  nullable: boolean
  enum: string[] | null
  relation: { target: string; entity: string; summary: string | null } | null
}

export type CubeMetadata = {
  cube: string
  entity: string | null
  version: string | null
  schemaHash: string
  fields: FieldMetadata[]
}

// A page as the qwbe list contract returns it (PageOf).
export type PageOf<T> = {
  rows: T[]
  total: number
  offset: number
  limit: number
}

export type Row = Record<string, unknown>

export type ListParams = {
  offset?: number
  limit?: number
  sortBy?: string
  descending?: boolean
  // Field filters (server-side equality, e.g. accountId on contacts). Keys are
  // field NAMES from the metadata, never hard-coded per entity here.
  filters?: Record<string, string>
}

// Proxy path for a cube-relative qwbe path: the cube name "crm/accounts" becomes
// proxy segments crm/accounts, so GET /api/qwbe/crm/accounts?... reaches qwbe.
export function cubeApiPath(cube: string, suffix = ""): string {
  return `/api/qwbe/${cube}${suffix}`
}

// Metadata is under /catalog/{cube}/metadata and a child cube name
// ("crm/accounts") is a single path parameter, so it must be percent-encoded.
export function metadataApiPath(cube: string): string {
  return `/api/qwbe/catalog/${encodeURIComponent(cube)}/metadata`
}

// Builds the query string of a list request. Paging and sorting go to qwbe
// (server-side paging end to end); there is no client-side slice anywhere.
// A test asserts the exact parameters this produces.
export function listQueryString(params: ListParams): string {
  const q = new URLSearchParams()
  if (params.offset !== undefined) q.set("offset", String(params.offset))
  if (params.limit !== undefined) q.set("limit", String(params.limit))
  if (params.sortBy !== undefined) q.set("sortBy", params.sortBy)
  if (params.descending) q.set("descending", "true")
  for (const [field, value] of Object.entries(params.filters ?? {})) {
    if (value !== "") q.set(field, value)
  }
  return q.toString()
}

export function listApiPath(cube: string, params: ListParams): string {
  const qs = listQueryString(params)
  return `${cubeApiPath(cube)}${qs ? `?${qs}` : ""}`
}

// Columns are DERIVED from metadata. Every field becomes a column; a field added
// to the cube's schema appears here with zero frontend changes. The returned
// entries carry only what the table needs to render and sort.
export type ColumnSpec = {
  field: FieldMetadata
  sortable: boolean
  editable: boolean
}

export function columnsFromFields(fields: FieldMetadata[]): ColumnSpec[] {
  return fields.map((field) => ({
    field,
    sortable: field.sortable,
    editable: field.editable,
  }))
}

// A cell is editable exactly when the metadata says so. A field that is not
// editable refuses editing, whatever the caller asks.
export function canEdit(field: FieldMetadata): boolean {
  return field.editable
}

// Extracts the human-readable message from a qwbe error response. A validation
// failure is a 400 whose body carries `issues` (per-field messages) and a
// `message`; the per-field message wins when it names the edited field.
export function errorMessage(body: unknown): string {
  if (typeof body === "string" && body.length > 0) return body
  if (body && typeof body === "object") {
    const b = body as { message?: unknown; issues?: unknown }
    if (Array.isArray(b.issues) && b.issues.length > 0) {
      const first = b.issues[0] as { message?: unknown }
      if (typeof first.message === "string" && first.message.length > 0) return first.message
    }
    if (typeof b.message === "string" && b.message.length > 0) return b.message
  }
  return "the change was refused"
}

// The frontend route of a related row, resolved through the relation metadata:
// relation target "crm/accounts" -> /accounts. No cube names hard-coded here
// either: the route is the target cube name with its parent dropped.
export function hrefForRelation(target: string, id: string): string {
  const leaf = target.includes("/") ? target.split("/").pop()! : target
  return `/${leaf}/${id}`
}

// The leaf route segment of a cube, used to link from a contact to its
// organization detail page and back.
export function routeOf(cube: string): string {
  return `/${cube.split("/").pop()}`
}
