"use client"

// The detail page body, assembled from the same cube metadata as the list.
// One block per published field: label, value, with a link for a
// filled relation. Optional child lists (for example the derived contacts of
// one organization) reuse the generic CubeList with a pinned filter.
//
// Grouping and editing (QWB-53, the Organizations pilot) are opt-in per page:
// `groups` distributes the fields over named fieldsets (shadcn FieldSet and
// FieldLegend, the components already in components/ui/field.tsx) with the
// leftovers and the runtime custom fields in their own sections, so nothing
// the metadata publishes is ever hidden; `editable` gives every field the
// metadata marks editable an inline editor that saves through the SAME
// saveCell the list uses -- one PATCH of the edited key, qwbe's own refusal
// message under the field. A page that passes neither renders as before.

import Link from "next/link"
import { useEffect, useMemo, useState } from "react"

import {
  apiFetch,
  type CubeMetadata,
  type FieldGroupSpec,
  type FieldMetadata,
  type Row,
  canEdit,
  cubeApiPath,
  customValueOf,
  groupFields,
  hrefForRelation,
  metadataApiPath,
  renderKindOf,
  routeOf,
  saveCell,
  titleOf,
  withSavedValue,
} from "@/lib/cube"
import { relationRefsOf } from "@/lib/relation-batch"
import { useRelationTitles } from "@/hooks/use-relation-titles"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { FieldError, FieldLegend, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { CubeList } from "@/components/cube-list"

export type ChildList = {
  // The cube the child rows live in, e.g. "crm/contacts".
  cube: string
  // The field on the child that points back to this row, e.g. "organizationId".
  field: string
  label?: string
}

export function CubeDetail({
  cube,
  id,
  childLists = [],
  groups,
  editable = false,
}: {
  cube: string
  id: string
  childLists?: ChildList[]
  // Fieldsets by field NAME (lib/cube.ts groupFields). Absent: one flat block.
  groups?: FieldGroupSpec[]
  // Inline editing on the fields the metadata marks editable.
  editable?: boolean
}) {
  const [meta, setMeta] = useState<CubeMetadata | null>(null)
  const [row, setRow] = useState<Row | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Per-field messages from a refused PATCH, keyed by field name.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    let alive = true
    Promise.all([
      apiFetch(metadataApiPath(cube)).then(async (r) => {
        if (!r.ok) throw new Error(`metadata request failed: ${r.status}`)
        return (await r.json()) as CubeMetadata
      }),
      apiFetch(cubeApiPath(cube, `/${id}`)).then(async (r) => {
        if (!r.ok) throw new Error(`row request failed: ${r.status}`)
        return (await r.json()) as Row
      }),
    ])
      .then(([m, r]) => {
        if (alive) {
          setMeta(m)
          setRow(r)
        }
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      alive = false
    }
  }, [cube, id])

  // Every relation value on the row, deduplicated; one ids batch per distinct
  // target cube resolves their titles (the same hook the list uses).
  const relationRefs = useMemo(
    () => (meta && row ? relationRefsOf([row], meta.fields) : []),
    [meta, row],
  )
  const resolveTitle = useRelationTitles(relationRefs)

  const sections = useMemo(
    () => (meta ? (groups ? groupFields(meta.fields, groups) : [{ legend: "", fields: meta.fields }]) : []),
    [meta, groups],
  )

  if (error) return <p role="alert">{error}</p>
  if (!meta || !row) return <Skeleton className="h-64 w-full" />

  const save = async (field: FieldMetadata, next: string) => {
    const result = await saveCell({
      rowPath: cubeApiPath(cube, `/${id}`),
      row,
      field,
      next,
      doFetch: apiFetch,
    })
    if (result.status === "saved") {
      setRow((r) => (r ? withSavedValue(r, field, result.value) : r))
      setFieldErrors((e) => {
        const rest = { ...e }
        delete rest[field.name]
        return rest
      })
    } else if (result.status === "refused") {
      // qwbe's message stays under the field, the old value stays in the row,
      // until a save succeeds.
      setFieldErrors((e) => ({ ...e, [field.name]: result.message }))
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{titleOf(meta, row)}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {sections.map((section) => (
            <FieldSet key={section.legend} className="gap-0">
              {section.legend && <FieldLegend>{section.legend}</FieldLegend>}
              {section.fields.map((field, index) => (
                <div key={field.name}>
                  {index > 0 && <Separator />}
                  <DetailField
                    field={field}
                    value={customValueOf(row, field)}
                    editable={editable && canEdit(field)}
                    error={fieldErrors[field.name]}
                    resolveTitle={resolveTitle}
                    onSave={(next) => save(field, next)}
                  />
                </div>
              ))}
            </FieldSet>
          ))}
        </CardContent>
      </Card>
      {childLists.map((child) => (
        <section key={child.cube} className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">{child.label ?? child.cube}</h2>
          <CubeList cube={child.cube} fixedFilters={{ [child.field]: id }} />
          <Link className="text-sm underline" href={routeOf(child.cube)}>
            All rows
          </Link>
        </section>
      ))}
    </div>
  )
}

// One field of the detail: label, value (a link for a filled relation, yes/no
// for a boolean), and -- when editable -- the inline editor. The control
// follows the metadata alone (renderKindOf, the list's classifier): an enum
// edits as a select and a custom boolean as a checkbox, both saving on
// change; everything else as a text input with explicit Save and Cancel
// (Enter saves, Escape cancels). A relation edits as its opaque id, exactly
// like the list: the editable surface is not shrunk silently.
function DetailField({
  field,
  value,
  editable,
  error,
  resolveTitle,
  onSave,
}: {
  field: FieldMetadata
  value: unknown
  editable: boolean
  error?: string
  resolveTitle: (target: string, id: string) => string | null
  onSave: (next: string) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const text = value === null || value === undefined ? "" : String(value)
  const commit = async (next: string) => {
    setEditing(false)
    await onSave(next)
  }

  let display: React.ReactNode
  if (field.relation && value !== null && value !== undefined) {
    const href = hrefForRelation(field.relation.target, String(value))
    const title = resolveTitle(field.relation.target, String(value)) ?? String(value)
    display = href ? (
      <Link className="underline" href={href}>
        {title}
      </Link>
    ) : (
      title
    )
  } else if (field.type === "boolean" && value !== null && value !== undefined) {
    display = value ? "yes" : "no"
  } else {
    display = text === "" ? "\u2014" : text
  }

  let editor: React.ReactNode = null
  if (editing && renderKindOf(field) === "select") {
    editor = (
      <Select
        // Radix forbids an empty-string SelectItem value; the empty item
        // rides on a sentinel and is translated back to "" on save.
        value={text === "" ? "__clear__" : text}
        onValueChange={(v) => commit(v === "__clear__" ? "" : v)}
      >
        <SelectTrigger className="w-64" aria-label={field.label} autoFocus>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {!field.required && <SelectItem value="__clear__">{"\u2014"}</SelectItem>}
          {field.enum!.map((v) => (
            <SelectItem key={v} value={v}>
              {v}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  } else if (editing && renderKindOf(field) === "checkbox") {
    editor = (
      <Checkbox
        autoFocus
        aria-label={field.label}
        checked={value === true}
        onCheckedChange={(checked) => commit(checked ? "true" : "false")}
      />
    )
  } else if (editing) {
    editor = (
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          const input = e.currentTarget.elements.namedItem("value") as HTMLInputElement
          commit(input.value)
        }}
      >
        <Input
          name="value"
          autoFocus
          defaultValue={text}
          aria-label={field.label}
          required={field.required}
          className="w-64"
          onKeyDown={(e) => {
            if (e.key === "Escape") setEditing(false)
          }}
        />
        <Button type="submit" size="sm">
          Save
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </form>
    )
  }

  return (
    <div className="grid grid-cols-[10rem_1fr] gap-2 py-2 text-sm" data-field={field.name}>
      <span className="text-muted-foreground">{field.label}</span>
      <div className="flex flex-col gap-1">
        {editor ?? (
          <div className="flex items-center gap-2">
            <span>{display}</span>
            {editable && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`Edit ${field.label}`}
                onClick={() => setEditing(true)}
              >
                Edit
              </Button>
            )}
          </div>
        )}
        {error && <FieldError data-field-error={field.name}>{error}</FieldError>}
      </div>
    </div>
  )
}
