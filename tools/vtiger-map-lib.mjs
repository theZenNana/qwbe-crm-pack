// Pure mapping for QWB-50: an exported vtiger row + a mapping file -> the payload for the
// qwbe cube API. No I/O, so the tests can run it on synthetic fixtures.
//
// Idempotency rule: the vtiger id (the mapping's `key` column, e.g. vtigerId) is the
// external key. It rides on every staged row and decides insert versus update in the map
// tool; the vtigerId -> qwbeId correspondence is kept in a ledger file next to the export
// (outside git), because the cube schemas are fixed and carry no externalId field.

const emptyToNull = (v) => (v === undefined || v === null || String(v).trim() === "" ? null : v)
const truthy = (v) => v === true || v === 1 || v === "1" || v === "on" || v === "true"

/**
 * Build the create/patch payload for one exported row.
 * Mapping shapes:
 *   "vtigerCol": "qwbeField"                 -- straight copy (null for empty)
 *   "qwbeField": { "join": ["a", "b"] }      -- join non-empty parts with one space
 * `booleans` / `integers` coerce the varchar(3)-style vtiger flags and int columns.
 * `emptyString` lists qwbe fields that must stay a string even when vtiger is empty
 * (the contact cube's `email` is `""`, not null).
 * Returns { payload } or { error } (e.g. an empty required name).
 */
export const mapRow = (row, mapping) => {
  const booleans = new Set(mapping.booleans ?? [])
  const integers = new Set(mapping.integers ?? [])
  const emptyString = new Set(mapping.emptyString ?? [])
  const payload = {}
  for (const [src, dst] of Object.entries(mapping.map)) {
    if (typeof dst === "string") {
      let v = row[src]
      if (booleans.has(src)) v = truthy(v)
      else if (integers.has(src)) {
        v = v === null || v === undefined || v === "" ? null : Number(v)
        if (v !== null && !Number.isInteger(v)) return { error: `${src} is not an integer` }
      } else v = emptyToNull(v)
      if (v === null && emptyString.has(dst)) v = ""
      payload[dst] = v
    } else if (dst && Array.isArray(dst.join)) {
      const joined = dst.join
        .map((part) => String(row[part] ?? "").trim())
        .filter((part) => part !== "")
        .join(" ")
      payload[Object.keys(mapping.map).find((k) => mapping.map[k] === dst)] = joined === "" ? null : joined
    }
  }
  return { payload }
}

/** The external key of a row (the mapping's `key` column), as a string, or null if absent. */
export const rowKey = (row, mapping) => {
  const v = row[mapping.key]
  return v === undefined || v === null ? null : String(v)
}
