"use client"

// The one generic list, driven entirely by cube metadata (QWB-49).
//
// It takes a cube name, fetches that cube's metadata and its rows through the
// server-side proxy, and renders columns from the published fields: label from
// `label`, cell shape from `type` and `enum`, sortable headers only where
// `sortable` is true, and a filter control for every field the metadata marks
// `searchable` (a relation field becomes a select, a plain field a text input).
// Paging and sorting are server-side end to end: the page, page size and sort
// parameters travel to qwbe; nothing here slices a full result set.

import Link from "next/link"
import { useCallback, useEffect, useMemo, useState } from "react"

import {
  type ColumnSpec,
  type CubeMetadata,
  type FieldMetadata,
  type PageOf,
  type Row,
  canEdit,
  columnsFromFields,
  customValueOf,
  renderKindOf,
  cubeApiPath,
  hrefForRelation,
  rowHref,
  listApiPath,
  metadataApiPath,
  resolveRelationTitle,
  saveCell,
  sortRequestFor,
  titleOf,
} from "@/lib/cube"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

const PAGE_SIZE = 25

type EditState = { id: string; field: string; value: string }

export function CubeList({
  cube,
  fixedFilters,
}: {
  cube: string
  // Server-side equality filters pinned by the caller (for example the derived
  // contact list of one organization). Values are opaque ids.
  fixedFilters?: Record<string, string>
}) {
  const [meta, setMeta] = useState<CubeMetadata | null>(null)
  const [metaError, setMetaError] = useState<string | null>(null)
  const [page, setPage] = useState<PageOf<Row> | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [offset, setOffset] = useState(0)
  const [sortBy, setSortBy] = useState<string | undefined>(undefined)
  const [descending, setDescending] = useState(false)
  // The chosen values of the searchable fields, keyed by field name; empty
  // string means "all".
  const [search, setSearch] = useState<Record<string, string>>({})
  const [edit, setEdit] = useState<EditState | null>(null)
  // Per-cell error messages from a failed PATCH, keyed "id:field".
  const [cellErrors, setCellErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    let alive = true
    fetch(metadataApiPath(cube))
      .then(async (r) => {
        if (!r.ok) throw new Error(`metadata request failed: ${r.status}`)
        return (await r.json()) as CubeMetadata
      })
      .then((m) => {
        if (alive) setMeta(m)
      })
      .catch((e: unknown) => {
        if (alive) setMetaError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      alive = false
    }
  }, [cube])

  const filters = useMemo<Record<string, string>>(() => {
    const chosen: Record<string, string> = {}
    for (const f of meta?.fields ?? []) {
      if (f.searchable && search[f.name]) chosen[f.name] = search[f.name]
    }
    return { ...(fixedFilters ?? {}), ...chosen }
  }, [fixedFilters, search, meta])
  const effectiveFilters = useMemo(
    () => Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== "")),
    [filters],
  )

  const load = useCallback(() => {
    let alive = true
    fetch(listApiPath(cube, { offset, limit: PAGE_SIZE, sortBy, descending, filters: effectiveFilters }))
      .then(async (r) => {
        if (!r.ok) throw new Error(`list request failed: ${r.status}`)
        return (await r.json()) as PageOf<Row>
      })
      .then((p) => {
        if (alive) setPage(p)
      })
      .catch((e: unknown) => {
        if (alive) setListError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      alive = false
    }
  }, [cube, offset, sortBy, descending, effectiveFilters])

  useEffect(() => load(), [load])

  if (metaError) return <p role="alert">metadata unavailable: {metaError}</p>
  if (!meta) return <Skeleton className="h-64 w-full" />

  const columns = columnsFromFields(meta.fields).filter((c) => c.visible)
  // The title field is the row's human identity (the same field titleOf uses
  // on the detail page). When this app has a route for the cube, the title
  // cell links to the row's detail page; the other cells stay inline-editable.
  const titleFieldName = meta.fields.find((f) => f.required)?.name
  const searchableFields = meta.fields.filter((f) => f.searchable)
  const total = page?.total
  const rowCount = page?.rows.length ?? 0

  // A stale cell error must not survive a change of page, sort or filter: the
  // row it was about is not the row in view any more. Every entry point below
  // changes the request parameters, so each clears the map as it goes.
  const requery = (apply: () => void) => {
    setCellErrors({})
    apply()
  }

  const toggleSort = (column: ColumnSpec) => {
    // A column the metadata does not mark sortable never produces a request.
    const next = sortRequestFor(column, sortBy, descending)
    if (!next) return
    requery(() => {
      setSortBy(next.sortBy)
      setDescending(next.descending)
      setOffset(0)
    })
  }

  const saveEdit = async (row: Row, fieldMeta: FieldMetadata, next: string) => {
    const current = row[fieldMeta.name]
    setEdit(null)
    if (next === String(current ?? "")) return
    const key = `${String(row.id)}:${fieldMeta.name}`
    const result = await saveCell({
      rowPath: cubeApiPath(cube, `/${String(row.id)}`),
      field: fieldMeta,
      current,
      next,
      doFetch: fetch,
    })
    if (result.status === "saved") {
      // Only the patched key is merged: a concurrent, out-of-order response
      // body must not overwrite the other columns of the row.
      setPage((p) =>
        p
          ? {
              ...p,
              rows: p.rows.map((r) =>
                String(r.id) === String(row.id) ? { ...r, [result.field]: result.value } : r,
              ),
            }
          : p,
      )
      setCellErrors((e) => {
        const next = { ...e }
        delete next[key]
        return next
      })
    } else if (result.status === "refused") {
      // The message qwbe returned is shown in that cell, and the old value
      // stays until a save succeeds.
      setCellErrors((e) => ({ ...e, [key]: result.message }))
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {searchableFields
        .filter((f) => !fixedFilters?.[f.name])
        .map((f) =>
          f.relation ? (
            <RelationSearch
              key={f.name}
              meta={meta}
              field={f}
              value={search[f.name] ?? ""}
              onChange={(v) => {
                requery(() => setSearch((s) => ({ ...s, [f.name]: v })))
                setOffset(0)
              }}
            />
          ) : (
            <TextSearch
              key={f.name}
              field={f}
              value={search[f.name] ?? ""}
              onChange={(v) => {
                requery(() => setSearch((s) => ({ ...s, [f.name]: v })))
                setOffset(0)
              }}
            />
          ),
        )}
      {listError && <p role="alert">{listError}</p>}
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((column) => (
              <TableHead key={column.field.name}>
                {column.sortable ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => toggleSort(column)}
                    aria-sort={sortBy === column.field.name ? (descending ? "descending" : "ascending") : "none"}
                  >
                    {column.field.label}
                    {sortBy === column.field.name ? (descending ? " ↓" : " ↑") : ""}
                  </Button>
                ) : (
                  column.field.label
                )}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {!page &&
            Array.from({ length: 5 }).map((_, i) => (
              <TableRow key={i}>
                {columns.map((c) => (
                  <TableCell key={c.field.name}>
                    <Skeleton className="h-4 w-full" />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          {page?.rows.map((row) => (
            <TableRow key={String(row.id)}>
              {columns.map((column) => (
                <TableCell key={column.field.name}>
                  <Cell
                    row={row}
                    column={column}
                    isTitle={column.field.name === titleFieldName}
                    rowLink={rowHref(cube, String(row.id))}
                    edit={edit}
                    setEdit={setEdit}
                    error={cellErrors[`${String(row.id)}:${column.field.name}`]}
                    onSave={(value) => saveEdit(row, column.field, value)}
                  />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">
          {page
            ? total !== undefined
              ? `${page.offset + 1}-${page.offset + rowCount} of ${total}`
              : `${page.offset + 1}-${page.offset + rowCount}`
            : "loading"}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={offset === 0}
            onClick={() => requery(() => setOffset(Math.max(0, offset - PAGE_SIZE)))}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            // Without a total from qwbe, a short page is the only proof that
            // the end was reached.
            disabled={!page || (total !== undefined ? offset + PAGE_SIZE >= total : rowCount < PAGE_SIZE)}
            onClick={() => requery(() => setOffset(offset + PAGE_SIZE))}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  )
}

// A searchable field the backend serves by exact equality. A text field gets a
// text input; the value travels as the field's filter value.
function TextSearch({
  field,
  value,
  onChange,
}: {
  field: FieldMetadata
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-muted-foreground">{field.label}</span>
      <Input
        className="w-64"
        aria-label={`Filter by ${field.label}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  )
}

// A searchable relation field: the caller picks one row of the target cube.
// The options are the first page of the target (200 is qwbe's MAX_LIMIT); when
// the target holds more, the select says so instead of pretending to be whole.
function RelationSearch({
  meta,
  field,
  value,
  onChange,
}: {
  meta: CubeMetadata
  field: FieldMetadata
  value: string
  onChange: (value: string) => void
}) {
  const [targetMeta, setTargetMeta] = useState<CubeMetadata | null>(null)
  const [options, setOptions] = useState<Row[] | null>(null)
  const [truncated, setTruncated] = useState(false)
  const target = field.relation!.target

  useEffect(() => {
    let alive = true
    Promise.all([
      fetch(metadataApiPath(target))
        .then(async (r) => (r.ok ? ((await r.json()) as CubeMetadata) : null))
        .catch(() => null),
      fetch(listApiPath(target, { offset: 0, limit: 200 }))
        .then(async (r) => (r.ok ? ((await r.json()) as PageOf<Row>) : null))
        .catch(() => null),
    ]).then(([m, p]) => {
      if (!alive) return
      setTargetMeta(m)
      setOptions(p?.rows ?? [])
      setTruncated(p !== null && p.rows.length >= 200 && (p.total === undefined || p.total > p.rows.length))
    })
    return () => {
      alive = false
    }
  }, [target])

  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-muted-foreground">{field.label}</span>
      <Select value={value || "all"} onValueChange={(v) => onChange(v === "all" ? "" : v)}>
        <SelectTrigger className="w-64" aria-label={field.label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All {meta.entity ?? "rows"}</SelectItem>
          {(options ?? []).map((row) => (
            <SelectItem key={String(row.id)} value={String(row.id)}>
              {targetMeta ? titleOf(targetMeta, row) : String(row.id)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {truncated && <span className="text-xs text-muted-foreground">first 200 shown</span>}
    </div>
  )
}

function Cell({
  row,
  column,
  isTitle,
  rowLink,
  edit,
  setEdit,
  error,
  onSave,
}: {
  row: Row
  column: ColumnSpec
  isTitle: boolean
  rowLink: string | null
  edit: EditState | null
  setEdit: (edit: EditState | null) => void
  error?: string
  onSave: (value: string) => void
}) {
  const field = column.field
  // The value wherever the backend keeps it: a custom field's value rides in
  // the row's `custom` sub-object, a static field's at the top level.
  const value = customValueOf(row, field)
  const key = `${String(row.id)}:${field.name}`
  const editing = edit?.id === String(row.id) && edit.field === field.name

  const startEdit = () =>
    setEdit({
      id: String(row.id),
      field: field.name,
      value: value === null || value === undefined ? "" : String(value),
    })

  // The edit affordance follows the metadata alone: editable is enough. A
  // relation field edits as its opaque id for now; a picker is future work,
  // and shrinking the editable surface silently is not an option.
  const editable = canEdit(field)

  let content: React.ReactNode
  if (field.relation && value !== null && value !== undefined) {
    content = <RelationValue target={field.relation.target} id={String(value)} />
  } else if (field.type === "boolean") {
    content = value ? "yes" : "no"
  } else {
    content = value === null || value === undefined ? "—" : String(value)
  }

  return (
    <div className="flex flex-col gap-1">
      {editing ? (
        renderKindOf(field) === "select" ? (
          <Select
            value={edit.value}
            onValueChange={(v) => {
              setEdit(null)
              onSave(v)
            }}
          >
            <SelectTrigger className="w-40" aria-label={field.label}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {field.nullable && <SelectItem value="">—</SelectItem>}
              {field.enum!.map((v) => (
                <SelectItem key={v} value={v}>
                  {v}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : renderKindOf(field) === "checkbox" ? (
          <Checkbox
            autoFocus
            aria-label={field.label}
            checked={edit.value === "true"}
            onCheckedChange={(checked) => {
              setEdit(null)
              onSave(checked ? "true" : "false")
            }}
          />
        ) : (
          <Input
            autoFocus
            defaultValue={edit.value}
            aria-label={field.label}
            onBlur={(e) => onSave(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSave(e.currentTarget.value)
              if (e.key === "Escape") setEdit(null)
            }}
          />
        )
      ) : field.relation && hrefForRelation(field.relation.target, String(value ?? "")) ? (
        <Link
          className="underline"
          href={hrefForRelation(field.relation.target, String(value))!}
        >
          {content}
        </Link>
      ) : isTitle && rowLink ? (
        <Link className="underline" href={rowLink}>
          {content}
        </Link>
      ) : editable ? (
        <button
          type="button"
          className="cursor-text text-left"
          title={`Edit ${field.label}`}
          // The accessible name must say what the button does; the cell value
          // alone left a screen reader no way to find the edit affordance.
          aria-label={`Edit ${field.label}`}
          onClick={startEdit}
        >
          {content}
        </button>
      ) : (
        content
      )}
      {error && (
        <span className="text-xs text-destructive" role="alert" data-cell-error={key}>
          {error}
        </span>
      )}
    </div>
  )
}

// A relation cell shows the target row's title, resolved through the target
// cube's own metadata and row endpoint, falling back to the raw id. The link,
// when this app has a route for the target, wraps the resolved title.
function RelationValue({ target, id }: { target: string; id: string }) {
  const [title, setTitle] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    resolveRelationTitle(target, id).then((t) => {
      if (alive) setTitle(t)
    })
    return () => {
      alive = false
    }
  }, [target, id])
  return <>{title ?? id}</>
}
