"use client"

// The admin-kit edit island (QWB-53, the Organizations pilot): one row of one
// cube as a shadcn-admin-kit form, grouped into the fieldsets the page names.
//
// The island owns a scoped ra-core runtime and nothing outside it: a
// CoreAdminContext with the pilot data provider (lib/qwbe-data-provider.ts,
// two verbs over the cookie proxy), a MemoryRouter so ra-core's routing hooks
// have a context without touching the Next.js router or the URL, and an
// EditBase in pessimistic mode so a refused PATCH comes back as field errors
// under the kit inputs. Navigation, auth and every other page stay on the
// existing Next.js surface; the island never links through react-router.
//
// Everything rendered inside the form is a kit component
// (components/admin-kit, see its README): SimpleForm, FormToolbar, SaveButton,
// TextInput, NumberInput, BooleanInput, SelectInput, RecordField. Which one a
// field gets follows the metadata alone: editable or not, enum, boolean,
// integer or number, relation; a runtime custom field rides on the form path
// formSourceOf gives it, so a field defined tomorrow is edited tomorrow.

import Link from "next/link"
import { useEffect, useMemo, useState } from "react"
import { MemoryRouter } from "react-router"
import { CoreAdminContext, EditBase, required, useEditContext } from "ra-core"
import { toast } from "sonner"

import {
  apiFetch,
  type CubeMetadata,
  type FieldGroupSpec,
  type FieldMetadata,
  type Row,
  canEdit,
  customValueOf,
  formSourceOf,
  groupFields,
  hrefForRelation,
  httpPrefixOf,
  metadataApiPath,
  renderKindOf,
  titleOf,
} from "@/lib/cube"
import { qwbeDataProvider } from "@/lib/qwbe-data-provider"
import { relationRefsOf } from "@/lib/relation-batch"
import { useRelationTitles } from "@/hooks/use-relation-titles"
import { BooleanInput } from "@/components/admin-kit/boolean-input"
import { SaveButton } from "@/components/admin-kit/form"
import { NumberInput } from "@/components/admin-kit/number-input"
import { RecordField } from "@/components/admin-kit/record-field"
import { SelectInput } from "@/components/admin-kit/select-input"
import { FormToolbar, SimpleForm } from "@/components/admin-kit/simple-form"
import { TextInput } from "@/components/admin-kit/text-input"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { FieldLegend, FieldSet } from "@/components/ui/field"
import { Skeleton } from "@/components/ui/skeleton"

export function CubeAdminEdit({
  cube,
  id,
  groups,
}: {
  cube: string
  id: string
  // Fieldsets by field NAME (lib/cube.ts groupFields); leftovers and custom
  // fields get their own sections, so nothing published is hidden.
  groups: FieldGroupSpec[]
}) {
  const [meta, setMeta] = useState<CubeMetadata | null>(null)
  const [error, setError] = useState<string | null>(null)

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
        if (alive) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      alive = false
    }
  }, [cube])

  // One provider per cube and metadata: the PATCH body is derived from the
  // same fields the inputs are rendered from.
  const dataProvider = useMemo(
    () => (meta ? qwbeDataProvider(cube, meta.fields) : null),
    [cube, meta],
  )

  if (error) return <p role="alert">{error}</p>
  if (!meta || !dataProvider) return <Skeleton className="h-64 w-full" />

  return (
    <MemoryRouter>
      <CoreAdminContext dataProvider={dataProvider}>
        <EditBase
          resource={httpPrefixOf(cube)}
          id={id}
          mutationMode="pessimistic"
          redirect={false}
          redirectOnError={false}
          mutationOptions={{
            onSuccess: () => toast.success("Saved"),
            onError: (e: unknown) => {
              // A field error is already under its input (body.errors); only
              // a refusal about nothing in particular needs the toast.
              const errors = (e as { body?: { errors?: Record<string, string> } }).body?.errors
              if (!errors || Object.keys(errors).length === 0) {
                toast.error(e instanceof Error ? e.message : "the change was refused")
              }
            },
          }}
        >
          <AdminForm meta={meta} groups={groups} />
        </EditBase>
      </CoreAdminContext>
    </MemoryRouter>
  )
}

function AdminForm({ meta, groups }: { meta: CubeMetadata; groups: FieldGroupSpec[] }) {
  const { record, isPending, error } = useEditContext<Row & { id: string }>()
  const sections = useMemo(() => groupFields(meta.fields, groups), [meta, groups])
  const relationRefs = useMemo(
    () => (record ? relationRefsOf([record], meta.fields) : []),
    [record, meta],
  )
  const resolveTitle = useRelationTitles(relationRefs)

  if (error) return <p role="alert">{error.message}</p>
  if (isPending || !record) return <Skeleton className="h-64 w-full" />

  return (
    <Card>
      <CardHeader>
        <CardTitle>{titleOf(meta, record)}</CardTitle>
      </CardHeader>
      <CardContent>
        <SimpleForm
          className="max-w-none gap-6"
          disableInvalidFormNotification
          toolbar={
            <FormToolbar>
              <div className="flex flex-row justify-end gap-2">
                <SaveButton label="Save" />
              </div>
            </FormToolbar>
          }
        >
          {sections.map((section) => (
            <FieldSet key={section.legend}>
              {section.legend && <FieldLegend>{section.legend}</FieldLegend>}
              <div className="grid gap-4 md:grid-cols-2">
                {section.fields.map((field) => (
                  <AdminField
                    key={field.name}
                    field={field}
                    record={record}
                    resolveTitle={resolveTitle}
                  />
                ))}
              </div>
            </FieldSet>
          ))}
        </SimpleForm>
      </CardContent>
    </Card>
  )
}

// One field as the kit component its metadata calls for. A non-editable
// field is a RecordField (label and value, a link for a filled relation); an
// editable one is the matching kit input on the form path formSourceOf gives
// it. A required field carries the kit's required validator, so the form
// refuses an empty value before the request and qwbe stays the backstop.
function AdminField({
  field,
  record,
  resolveTitle,
}: {
  field: FieldMetadata
  record: Row
  resolveTitle: (target: string, id: string) => string | null
}) {
  const source = formSourceOf(field)
  const value = customValueOf(record, field)
  const relationLink = () => {
    if (!field.relation || value === null || value === undefined) return null
    const href = hrefForRelation(field.relation.target, String(value))
    const title = resolveTitle(field.relation.target, String(value)) ?? String(value)
    return href ? (
      <Link className="underline" href={href}>
        {title}
      </Link>
    ) : (
      title
    )
  }

  if (!canEdit(field)) {
    return (
      <RecordField
        label={field.label}
        source={source}
        data-field={field.name}
        empty={"\u2014"}
        render={() => {
          if (field.relation) return relationLink()
          if (field.type === "boolean" && value !== null && value !== undefined) return value ? "yes" : "no"
          return value === null || value === undefined ? null : String(value)
        }}
      />
    )
  }

  const validate = field.required ? required("Required") : undefined
  const common = { source, label: field.label, "data-field": field.name }
  if (renderKindOf(field) === "select") {
    return (
      <SelectInput
        {...common}
        choices={field.enum!.map((v) => ({ id: v, name: v }))}
        validate={validate}
      />
    )
  }
  if (field.type === "boolean") return <BooleanInput {...common} />
  if (field.type === "integer" || field.type === "number") {
    return <NumberInput {...common} validate={validate} />
  }
  // A relation edits as its opaque id, exactly like the list; the current
  // target is linked under the input.
  return <TextInput {...common} validate={validate} helperText={relationLink()} />
}
