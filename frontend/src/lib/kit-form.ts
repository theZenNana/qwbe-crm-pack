// Field-grouping and payload logic for the kit-based renderers (QWB-54).
//
// The kit renderers (components/kit) are reusable: an entity page supplies only
// its field grouping, while labels, types, enums, required flags and custom
// fields come from the published cube metadata -- the same metadata the list,
// detail and inline editor already use. Schema metadata stays authoritative:
// nothing here hard-codes a field of a specific cube.

import { coerce, type FieldMetadata, type Row } from "./cube.ts"

// Field grouping lives in cube.ts (groupFields, FieldGroupSpec): ONE
// distribution of the published fields over a page's named sections, with the
// leftovers and the runtime custom fields in their own sections, shared by
// the kit renderer for both entities. Nothing published is ever hidden; a
// non-editable field is displayed, never edited (canEdit).

// A row flattened for display and form defaults: published custom fields move
// from the row's `custom` sub-object to the top level (the same place the form
// and the kit's source-based fields read from). An ORPHAN custom value (one
// whose definition was deleted, or a key added after this frontend was
// written) has no published field and is left out: it never renders and never
// breaks the page.
export function displayRowOf(meta: { fields: FieldMetadata[] }, row: Row): Row {
  const flat: Row = { ...row }
  const custom = row.custom
  if (custom && typeof custom === "object") {
    for (const field of meta.fields) {
      if (!field.custom) continue
      const value = (custom as Row)[field.name]
      if (value !== undefined) flat[field.name] = value
    }
  }
  return flat
}

// Form default values for an edit form: strings for text and enum inputs, a
// real boolean for the checkbox kind (the same classifier the inline editor
// uses). A missing value becomes an empty string; a null stays "" and is
// turned back into null for nullable fields by updatePayloadOf on save.
export function initialValuesOf(
  fields: readonly FieldMetadata[],
  flatRow: Row,
): Record<string, string | boolean> {
  const values: Record<string, string | boolean> = {}
  for (const field of fields) {
    if (field.type === "boolean") {
      values[field.name] = flatRow[field.name] === true
    } else {
      const value = flatRow[field.name]
      values[field.name] = value === null || value === undefined ? "" : String(value)
    }
  }
  return values
}

// The body of an update request, built from the form's values with the SAME
// coerce the inline editor saves with. A cleared field becomes null when the
// metadata says nullable, is skipped when it does not (a non-nullable field
// cannot carry null, and an empty string would only earn qwbe's refusal), and
// a cleared REQUIRED field is refused client-side by its label -- qwbe's own
// field name, without a 400 round trip.
export function updatePayloadOf(
  fields: readonly FieldMetadata[],
  values: Record<string, string | boolean>,
): { payload: Record<string, unknown>; missing: string[] } {
  const payload: Record<string, unknown> = {}
  const missing: string[] = []
  for (const field of fields) {
    if (field.type === "boolean") {
      payload[field.name] = values[field.name] === true
      continue
    }
    const value = String(values[field.name] ?? "").trim()
    if (value === "") {
      if (field.required) {
        missing.push(field.label)
      } else if (field.nullable) {
        payload[field.name] = null
      }
      // ponytail: a non-nullable optional field is skipped, not sent as "",
      // because qwbe would refuse the empty string; if a cube ever needs to
      // send "" on purpose, this is the line to change.
    } else {
      payload[field.name] = coerce(field, value)
    }
  }
  return { payload, missing }
}

// The in-place form's save body: updatePayloadOf restricted to the fields
// whose value differs from what the form started with, so an untouched field
// is never re-sent (and never re-validated server-side). An unchanged
// required field left empty by the row itself is therefore not refused.
export function changedPayloadOf(
  fields: readonly FieldMetadata[],
  initial: Record<string, string | boolean>,
  values: Record<string, string | boolean>,
): { payload: Record<string, unknown>; missing: string[] } {
  const changed = fields.filter(
    (field) => String(values[field.name] ?? "").trim() !== String(initial[field.name] ?? "").trim(),
  )
  return updatePayloadOf(changed, values)
}
