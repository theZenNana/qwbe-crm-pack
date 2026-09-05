"use client"

// The reusable kit-based detail and in-place edit renderer (QWB-53 / QWB-54,
// merged): the SAME component renders Contacts and Organizations. One entity
// page supplies only its field grouping by name; everything else -- labels,
// values, editability, relation links, runtime custom fields, the title --
// comes from the published cube metadata and the row. The frame, card, field
// display and buttons are REAL shadcn-admin-kit 1.0.7 components; navigation
// between pages stays with Next's router.
//
// The row is loaded through the ra-core data provider (getOne) inside the
// KitContext; the metadata is the app's own published-metadata request, the
// same one every other surface uses. Read mode shows each value with a Copy
// action; the Edit button turns the SAME page into a form (same URL, no
// navigation) with the kit inputs in their sections and one Save/Cancel pair.
// A field the metadata marks non-editable is displayed in both modes and
// never becomes an input. Save PATCHes only the changed fields through the
// provider; a refusal keeps the drafts on screen with qwbe's own message.

import Link from "next/link"
import { useEffect, useMemo, useState } from "react"
import { CopyIcon } from "lucide-react"
import { toast } from "sonner"

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  RecordField,
  SaveButton,
  Skeleton,
  Button,
} from "shadcn-admin-kit"

import {
  apiFetch,
  canEdit,
  groupFields,
  hrefForRelation,
  metadataApiPath,
  titleOf,
  type CubeMetadata,
  type FieldGroupSpec,
  type FieldMetadata,
  type FieldSection,
  type Row,
} from "@/lib/cube.ts"
import { changedPayloadOf, displayRowOf, initialValuesOf } from "@/lib/kit-form.ts"
import { cn } from "@/lib/utils"
import { KitFieldInput } from "./field-input"
import { relationRefsOf } from "@/lib/relation-batch.ts"
import { useRelationTitles } from "@/hooks/use-relation-titles"
import { Form, RecordContextProvider, useGetOne, useUpdate } from "ra-core"

export function CubeKitShow({
  cube,
  id,
  groups,
}: {
  cube: string
  id: string
  // Fieldsets by field NAME (lib/cube.ts groupFields); leftovers and custom
  // fields get their own sections, so nothing published is hidden.
  groups: readonly FieldGroupSpec[]
}) {
  const [meta, setMeta] = useState<CubeMetadata | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
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

  const error = loadError ?? (rowError ? String((rowError as Error).message) : null)

  // Relation titles resolve in one batch per target cube (the same hook the
  // list uses); computed from the same metadata.
  const relationRefs = useMemo(
    () => (meta && row ? relationRefsOf([row as Row], meta.fields) : []),
    [meta, row],
  )
  const resolveTitle = useRelationTitles(relationRefs)

  const sections = useMemo(
    () => (meta ? groupFields(meta.fields, groups) : []),
    [meta, groups],
  )
  const flatRow = useMemo(
    () => (meta && row ? displayRowOf(meta, row as Row) : null),
    [meta, row],
  )
  const editableFields = useMemo(
    () => sections.flatMap((s) => s.fields).filter(canEdit),
    [sections],
  )

  // In-place editing: the form mounts when Edit is pressed (so its defaults
  // are the values shown at that moment) and unmounts on Save or Cancel,
  // which is what discards unsaved drafts. A refusal leaves it mounted.
  const [editing, setEditing] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [update, { isPending }] = useUpdate()
  const initial = useMemo(
    () => (flatRow ? initialValuesOf(editableFields, flatRow) : {}),
    [editableFields, flatRow],
  )

  function cancel() {
    setRefusal(null)
    setEditing(false)
  }

  async function onSubmit(values: Record<string, string | boolean>) {
    const { payload, missing } = changedPayloadOf(editableFields, initial, values)
    if (missing.length > 0) {
      setRefusal(`Required: ${missing.join(", ")}`)
      return
    }
    if (Object.keys(payload).length === 0) {
      cancel()
      return
    }
    try {
      // Pessimistic through ra-core so the getOne cache -- and this page --
      // shows what qwbe actually stored (custom values fold into `custom`).
      await update(
        cube,
        { id, data: payload, previousData: row as Row },
        { returnPromise: true, mutationMode: "pessimistic" },
      )
      toast.success("Saved")
      cancel()
    } catch (e: unknown) {
      setRefusal(refusalTextOf(e, editableFields))
    }
  }

  if (error) return <p role="alert">{error}</p>
  if (!meta || !row || !flatRow) return <Skeleton className="h-64 w-full" />

  const shown = (field: FieldMetadata) => (
    <RecordField
      key={field.name}
      source={field.name}
      label={field.label}
      className="min-w-0 gap-1 break-words text-sm"
      render={(record: Row) => {
        const text = textOf(field, record, resolveTitle)
        return (
          <span className="flex items-center gap-1">
            <span className="min-w-0 flex-1">{showValueOf(field, record, text)}</span>
            {text !== null && <CopyButton label={field.label} text={text} />}
          </span>
        )
      }}
    />
  )

  const fieldsets = (cell: (field: FieldMetadata) => React.ReactNode) =>
    sections.map((section) => <Section key={section.legend} section={section} cell={cell} />)

  return (
    <div className="flex w-full max-w-5xl flex-col gap-4">
      <Card>
        <CardHeader className="border-b">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Record details</p>
          <CardTitle className="text-2xl">{titleOf(meta, row as Row)}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {editing ? (
            <Form defaultValues={initial} onSubmit={onSubmit} className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center justify-end gap-2">
                {refusal && (
                  <p role="alert" className="mr-auto text-sm text-destructive">
                    {refusal}
                  </p>
                )}
                {/* label spelled out: without an i18n provider the kit's
                    default "ra.action.save" key would render verbatim. */}
                <SaveButton label="Save" disabled={isPending} />
                <Button type="button" variant="outline" disabled={isPending} onClick={cancel}>
                  Cancel
                </Button>
              </div>
              {/* A non-editable field keeps its read-only display inside the
                  form, so the whole record stays visible while editing. */}
              <RecordContextProvider value={flatRow}>
                {fieldsets((field) =>
                  canEdit(field) ? <KitFieldInput key={field.name} field={field} /> : shown(field),
                )}
              </RecordContextProvider>
            </Form>
          ) : (
            <>
              {editableFields.length > 0 && (
                <div className="flex justify-end">
                  <Button variant="outline" onClick={() => setEditing(true)}>
                    Edit
                  </Button>
                </div>
              )}
              <RecordContextProvider value={flatRow}>{fieldsets(shown)}</RecordContextProvider>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// One titled section. The optional emphasis is a border accent PLUS the word
// "Important" in the legend, so it never relies on color alone; it is a
// layout choice of the page, not a fact about the record.
function Section({
  section,
  cell,
}: {
  section: FieldSection
  cell: (field: FieldMetadata) => React.ReactNode
}) {
  return (
    <fieldset
      className={cn("min-w-0 rounded-lg border p-4", section.important && "border-l-4 border-l-primary")}
      aria-label={section.important ? `${section.legend} (important)` : undefined}
    >
      <legend className="flex items-center gap-2 px-2 text-sm font-semibold">
        {section.legend}
        {section.important && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Important
          </span>
        )}
      </legend>
      <div className="grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2">{section.fields.map(cell)}</div>
    </fieldset>
  )
}

// The refusal shown on the form: qwbe's own message, followed by each
// per-field issue the provider mapped (HttpError body.errors) under the
// field's label, so the user learns WHICH input was refused.
function refusalTextOf(e: unknown, fields: readonly FieldMetadata[]): string {
  const message = e instanceof Error ? e.message : String(e)
  const errors = (e as { body?: { errors?: Record<string, string> } }).body?.errors ?? {}
  const details = Object.entries(errors).map(([name, text]) => {
    const label = fields.find((f) => f.name === name)?.label ?? name
    return `${label}: ${text}`
  })
  return details.length > 0 ? `${message} (${details.join("; ")})` : message
}

// A discreet copy action next to a value: named for screen readers, sized
// for a finger (36px), never enters edit mode, reports a clipboard refusal
// (insecure context, denied permission) instead of failing silently.
function CopyButton({ label, text }: { label: string; text: string }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(`${label} copied`)
    } catch (e: unknown) {
      toast.error(`Copy failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-9 shrink-0 text-muted-foreground"
      aria-label={`Copy ${label}`}
      onClick={copy}
    >
      <CopyIcon aria-hidden />
    </Button>
  )
}

// The displayed text of one field in the flattened row, or null when empty:
// a relation shows the target's title resolved through the relation metadata,
// a boolean yes/no, anything else its text. This is exactly what Copy copies.
type ResolveTitle = (target: string, id: string) => string | null

function textOf(field: FieldMetadata, record: Row, resolveTitle: ResolveTitle): string | null {
  const value = record[field.name]
  if (value === null || value === undefined || value === "") return null
  if (field.relation) {
    const id = String(value)
    return resolveTitle(field.relation.target, id) ?? id
  }
  if (field.type === "boolean") return value ? "yes" : "no"
  return String(value)
}

// The rendered value: the text, linked to the target's page for a relation
// when this app has a route for it (Next's Link -- the organization relation
// keeps its navigation), a dash when empty.
function showValueOf(field: FieldMetadata, record: Row, text: string | null): React.ReactNode {
  if (text === null) return "—"
  const href = field.relation ? hrefForRelation(field.relation.target, String(record[field.name])) : null
  return href ? (
    <Link className="underline" href={href}>
      {text}
    </Link>
  ) : (
    text
  )
}
