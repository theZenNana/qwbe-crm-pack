"use client"

// The reusable kit-based edit renderer (QWB-54). One entity page supplies its
// field grouping; the form itself is assembled from the published cube
// metadata with REAL shadcn-admin-kit 1.0.7 form components: Form, TextInput,
// SelectInput (metadata enums), BooleanInput (custom booleans), ReferenceInput
// + AutocompleteInput (declared relations) and SaveButton -- no homemade input
// per field. Runtime custom fields appear through the custom group; a field
// defined after this code was written joins the form on its own.
//
// The submit PATCHes through the ra-core data provider (the httpOnly-cookie
// proxy); qwbe's own refusal message is shown on the form and the typed values
// stay. Navigation on save or cancel stays with Next's router.

import { useRouter } from "next/navigation"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { required as requiredValidator } from "ra-core"
import {
  AutocompleteInput,
  BooleanInput,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ReferenceInput,
  SaveButton,
  SelectInput,
  Skeleton,
  TextInput,
} from "shadcn-admin-kit"
import { Form, useDataProvider, useGetOne } from "ra-core"

import {
  apiFetch,
  metadataApiPath,
  renderKindOf,
  relationMeta,
  rowHref,
  routeOf,
  titleOf,
  type CubeMetadata,
  type FieldMetadata,
  type Row,
} from "@/lib/cube.ts"
import {
  displayRowOf,
  groupedFieldsOf,
  initialValuesOf,
  updatePayloadOf,
  type FieldGroup,
} from "@/lib/kit-form.ts"

export function CubeKitEditForm({
  cube,
  id,
  fieldGroups,
}: {
  cube: string
  id: string
  fieldGroups: readonly FieldGroup[]
}) {
  const router = useRouter()
  const dataProvider = useDataProvider()
  const [meta, setMeta] = useState<CubeMetadata | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const {
    data: row,
    error: rowError,
  } = useGetOne(cube, { id })

  useEffect(() => {
    let alive = true
    apiFetch(metadataApiPath(cube))
      .then(async (r) => {
        if (!r.ok) throw new Error(`metadata request failed: ${r.status}`)
        return (await r.json()) as CubeMetadata
      })
      .then((m) => {
        if (alive) setMeta(m)
      })
      .catch((e: unknown) => {
        if (alive) setLoadError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      alive = false
    }
  }, [cube])

  const loadFailure = loadError ?? (rowError ? String((rowError as Error).message) : null)

  const groups = useMemo(
    () => (meta ? groupedFieldsOf(fieldGroups, meta) : []),
    [meta, fieldGroups],
  )
  const flatRow = useMemo(
    () => (meta && row ? displayRowOf(meta, row as Row) : null),
    [meta, row],
  )
  const formFields = useMemo(() => groups.flatMap((g) => g.fields), [groups])
  const defaultValues = useMemo(
    () => (meta && flatRow ? initialValuesOf(formFields, flatRow) : {}),
    // The form mounts once, with both metadata and row present; later
    // re-fetches must not reset what the user typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [meta, flatRow],
  )

  async function onSubmit(values: Record<string, string | boolean>) {
    const { payload, missing } = updatePayloadOf(formFields, values)
    if (missing.length > 0) {
      setRefusal(`Required: ${missing.join(", ")}`)
      return
    }
    setRefusal(null)
    setPending(true)
    try {
      // Custom values ride at the top level; the kernel folds the declared
      // keys into the row's `custom` sub-object (the same fold the inline
      // editor's PATCH uses).
      await dataProvider.update(cube, {
        id,
        data: payload,
        previousData: (row as Record<string, unknown>) ?? undefined,
      })
      toast.success("Saved")
      // The detail page shows what was actually stored.
      router.push(rowHref(cube, id) ?? routeOf(cube))
    } catch (error: unknown) {
      setPending(false)
      setRefusal(error instanceof Error ? error.message : String(error))
    }
  }

  if (loadFailure) return <p role="alert">{loadFailure}</p>
  if (!meta || !row || !flatRow) return <Skeleton className="h-64 w-full" />

  return (
    <div className="flex w-full max-w-2xl flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>{titleOf(meta, row as Row)}</CardTitle>
        </CardHeader>
        <CardContent>
          <Form defaultValues={defaultValues} onSubmit={onSubmit}>
            {groups.map((group) => (
              <fieldset key={group.title} className="flex flex-col gap-4 border-0 p-0">
                <legend className="text-sm font-semibold text-muted-foreground">
                  {group.title}
                </legend>
                {group.fields.map((field) => (
                  <KitFieldInput key={field.name} field={field} />
                ))}
              </fieldset>
            ))}
            {refusal && (
              <p role="alert" className="text-sm text-destructive">
                {refusal}
              </p>
            )}
            <div className="flex gap-2">
              {/* label spelled out: without an i18n provider the kit's default
                  "ra.action.save" key would render verbatim. */}
              <SaveButton label="Save" disabled={pending} />
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => router.push(rowHref(cube, id) ?? routeOf(cube))}
              >
                Cancel
              </Button>
            </div>
          </Form>
        </CardContent>
      </Card>
    </div>
  )
}

// The one input per field, derived from the metadata alone -- the same
// classifier the list's inline editor uses (renderKindOf): an enum is a
// select, a custom boolean a switch, a declared relation the kit's reference
// picker, everything else a text input. Shared with the detail page's
// in-place form (cube-show.tsx).
export function KitFieldInput({ field }: { field: FieldMetadata }) {
  const validate = field.required ? requiredValidator() : undefined

  if (field.relation) {
    // The metadata guarantees a declared target once relation is set.
    return <RelationFieldInput field={field as RelationFieldMetadata} validate={validate} />
  }

  if (renderKindOf(field) === "select") {
    return (
      <SelectInput
        source={field.name}
        label={field.label}
        validate={validate}
        choices={(field.enum ?? []).map((value) => ({ id: value, name: value }))}
        emptyText={field.nullable ? "—" : undefined}
      />
    )
  }
  if (renderKindOf(field) === "checkbox") {
    return <BooleanInput source={field.name} label={field.label} />
  }
  return <TextInput source={field.name} label={field.label} validate={validate} />
}

// A declared relation edits with the kit's reference picker: the choices come
// from the data provider's getList on the target cube (the `q` filter scans
// exactly the fields the target's manifest declares searchable), the current
// value's title from getOne. The title field is the target's own metadata
// title (the same derivation every relation surface uses), fetched once per
// session.
export type RelationFieldMetadata = FieldMetadata & {
  relation: { target: string; entity: string; summary: string | null }
}

export function RelationFieldInput({
  field,
  validate,
}: {
  field: RelationFieldMetadata
  validate: unknown
}) {
  const [targetMeta, setTargetMeta] = useState<CubeMetadata | null>(null)
  useEffect(() => {
    let alive = true
    relationMeta(field.relation.target).then((meta) => {
      if (alive) setTargetMeta(meta)
    })
    return () => {
      alive = false
    }
  }, [field.relation.target])

  // The target metadata's title field: the first required field, or nothing
  // (AutocompleteInput then falls back to the record representation).
  const titleField = targetMeta?.fields.find((f) => f.required)
  return (
    <ReferenceInput source={field.name} reference={field.relation.target}>
      <AutocompleteInput
        label={field.label}
        validate={validate as never}
        optionText={titleField ? titleField.name : "id"}
        // An empty input on a nullable relation means "unlink"; qwbe refuses
        // an empty string on a non-nullable one with its own message.
        parse={(value: string) => (value === "" ? null : value)}
      />
    </ReferenceInput>
  )
}
