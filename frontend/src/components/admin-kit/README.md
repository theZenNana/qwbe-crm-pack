# shadcn-admin-kit, vendored (QWB-53)

Source: the `shadcn-admin-kit` npm package, version 1.0.7, MIT (the LICENSE
file next to this one is the package's own). The files here are the kit's
`src/components/admin/*`, `src/lib/field.type.ts` and
`src/hooks/useSupportCreateSuggestion.tsx`, copied the way the kit's registry
installer copies them into a project, but into this namespace instead of
`components/admin` so nothing shared is overwritten. That release of the kit
targets the Radix shadcn components, the same family as `components/ui`
here, so the kit files import this app's `ui/button`, `ui/input`, `ui/label`,
`ui/select`, `ui/skeleton`, `ui/switch` and `ui/textarea` unchanged.

Every file keeps its `This file is part of Shadcn Admin Kit` header. The
deliberate edits, and nothing else:

| file | edit |
|---|---|
| all | `@/components/admin/...` imports point to `@/components/admin-kit/...`; `@/lib/field.type.ts` and `@/hooks/useSupportCreateSuggestion` point to the copies here |
| `form.tsx` | `@radix-ui/react-label` and `@radix-ui/react-slot` imported through the `radix-ui` package this app already has (`LabelPrimitive.Root`, `SlotPrimitive.Root`); the `react-refresh` lint directive dropped (no such plugin here) |
| `simple-form.tsx` | `CancelButton` removed from the default toolbar: it navigates react-router history, which the pilot island does not own |
| `select-input.tsx` | the em-space literal written as the `\u2003` escape (ASCII-only source rule) |

Components used by the pilot (`components/cube-admin-edit.tsx`): `SimpleForm`,
`FormToolbar`, `SaveButton`, `FormField`/`FormLabel`/`FormControl`/`FormError`/
`FormDescription`, `TextInput`, `NumberInput`, `BooleanInput`, `SelectInput`,
`InputHelperText`, `RecordField`, `TextField`. They run on `ra-core` (the
kit's runtime dependency) inside a scoped `CoreAdminContext`; see the island
file for how it is wired to the cookie proxy.

Lint: `eslint.config.mjs` relaxes two rules for this directory only, because
the files follow the kit's conventions.
