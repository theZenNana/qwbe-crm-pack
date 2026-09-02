// Per-browser UI preferences over custom fields (QWB-54, F2): which fields
// this browser hides from the lists, and what default value a create form
// prefills per field.
//
// # ponytail: the kernel's custom-field definition has no `hidden` and no
// `defaultValue` (qwbe core/src/cubes/customfields/schema.ts: CustomFieldUpdate
// allows only label/options/required/position) and the F2 brief forbids kernel
// changes, so the state lives in localStorage, one JSON document per cube --
// definitions and stored values stay on the server, which keeps hide != delete
// true at the data level. Upgrade path: when the kernel grows the flags, ONLY
// this module changes (read/write through the definition PATCH); the panel,
// the list and the create form all read through here.
//
// localStorage is a trust boundary like any other: another tab, an old deploy
// or a curious hand can put anything under the key, so the reader validates
// the shape and falls back to the empty preference instead of trusting it.

export type CustomFieldPrefs = {
  // Field names this browser does not display on the lists. The definition,
  // the values and the detail page are untouched.
  hidden: string[]
  // Prefill for new rows, by field name, as the string a form field holds.
  // coerce() in lib/cube.ts converts on submit, exactly like a typed value.
  defaults: Record<string, string>
}

export const EMPTY_PREFS: CustomFieldPrefs = { hidden: [], defaults: {} }

export const prefsKey = (cube: string): string => `crm.customFields.${cube}`

// The storage is injected so node --test can exercise the parse without a DOM;
// every caller in the app omits it and reads the browser's localStorage.
export function readPrefs(cube: string, storage?: Storage): CustomFieldPrefs {
  const raw = (storage ?? globalThis.localStorage)?.getItem(prefsKey(cube))
  if (!raw) return { hidden: [], defaults: {} }
  try {
    const parsed = JSON.parse(raw) as Partial<CustomFieldPrefs>
    const hidden = Array.isArray(parsed.hidden)
      ? [...new Set(parsed.hidden.filter((n): n is string => typeof n === "string" && n.length > 0))]
      : []
    const defaults: Record<string, string> = {}
    if (parsed.defaults && typeof parsed.defaults === "object") {
      for (const [name, value] of Object.entries(parsed.defaults)) {
        if (typeof value === "string" && value !== "") defaults[name] = value
      }
    }
    return { hidden, defaults }
  } catch {
    return { hidden: [], defaults: {} }
  }
}

export function writePrefs(cube: string, prefs: CustomFieldPrefs, storage?: Storage): void {
  ;(storage ?? globalThis.localStorage)?.setItem(prefsKey(cube), JSON.stringify(prefs))
}

// A fresh object per call: the components hold prefs in React state and the
// state must change identity for a toggle to re-render the table.
export function withHidden(prefs: CustomFieldPrefs, name: string, hidden: boolean): CustomFieldPrefs {
  return hidden
    ? { ...prefs, hidden: [...new Set([...prefs.hidden, name])] }
    : { ...prefs, hidden: prefs.hidden.filter((n) => n !== name) }
}

// An empty value means "no default": the key is removed, not stored as "".
export function withDefault(prefs: CustomFieldPrefs, name: string, value: string): CustomFieldPrefs {
  const defaults = { ...prefs.defaults }
  if (value === "") delete defaults[name]
  else defaults[name] = value
  return { ...prefs, defaults }
}
