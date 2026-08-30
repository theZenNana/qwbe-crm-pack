"use client"

// The one generic list, driven entirely by cube metadata (QWB-49).
//
// It takes a cube name, fetches that cube's metadata and its rows through the
// server-side proxy, and renders columns from the published fields: label from
// `label`, cell shape from `type` and `enum`, sortable headers only where
// `sortable` is true, and a filter control only for the search surface the
// backend actually serves (equality on a searchable relation field).
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
  cubeApiPath,
  errorMessage,
  hrefForRelation,
  listApiPath,
  metadataApiPath,
  titleOf,
} from "@/lib/cube"
import { Button } from "@/components/ui/button"
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
  // The chosen value of the searchable relation field, or empty for "all".
  const [search, setSearch] = useState("")
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
    const field = meta ? searchField(meta) : null
    const chosen = field && search !== "" ? { [field.name]: search } : {}
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

  const columns = columnsFromFields(meta.fields)
  const relationSearchField = searchField(meta)
  const total = page?.total ?? 0

  const toggleSort = (column: ColumnSpec) => {
    if (!column.sortable) return
    if (sortBy === column.field.name) {
      setDescending(!descending)
    } else {
      setSortBy(column.field.name)
      setDescending(false)
    }
    setOffset(0)
  }

  const saveEdit = async (row: Row, fieldMeta: FieldMetadata, next: string) => {
    const current = row[fieldMeta.name]
    setEdit(null)
    if (next === String(current ?? "")) return
    const key = `${String(row.id)}:${fieldMeta.name}`
    const response = await fetch(cubeApiPath(cube, `/${String(row.id)}`), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ [fieldMeta.name]: coerce(fieldMeta, next) }),
    })
    if (response.ok) {
      // The saved value shows without a reload: the row is patched in place.
      const saved = (await response.json()) as Row
      setPage((p) =>
        p ? { ...p, rows: p.rows.map((r) => (String(r.id) === String(row.id) ? saved : r)) } : p,
      )
      setCellErrors((e) => {
        const next = { ...e }
        delete next[key]
        return next
      })
    } else {
      // The message qwbe returned is shown in that cell, and the old value
      // stays until a save succeeds.
      const body: unknown = await response.json().catch(() => undefined)
      setCellErrors((e) => ({ ...e, [key]: errorMessage(body) }))
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {relationSearchField && !fixedFilters?.[relationSearchField.name] && (
        <RelationSearch meta={meta} field={relationSearchField} value={search} onChange={(v) => {
          setSearch(v)
          setOffset(0)
        }} />
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
          {page ? `${page.offset + 1}-${page.offset + page.rows.length} of ${total}` : "loading"}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!page || offset + PAGE_SIZE >= total}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  )
}

// The one field the backend can search by: a searchable field carrying a
// relation (equality on the link). qwbe publishes no free-text search route.
function searchField(meta: CubeMetadata): FieldMetadata | null {
  return meta.fields.find((f) => f.searchable && f.relation) ?? null
}

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
  const [options, setOptions] = useState<Row[] | null>(null)
  const target = field.relation!.target

  useEffect(() => {
    let alive = true
    fetch(listApiPath(target, { offset: 0, limit: 200 }))
      .then(async (r) => (r.ok ? ((await r.json()) as PageOf<Row>) : null))
      .then((p) => {
        if (alive) setOptions(p?.rows ?? [])
      })
      .catch(() => {
        if (alive) setOptions([])
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
              {titleOf(meta, row)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function Cell({
  row,
  column,
  edit,
  setEdit,
  error,
  onSave,
}: {
  row: Row
  column: ColumnSpec
  edit: EditState | null
  setEdit: (edit: EditState | null) => void
  error?: string
  onSave: (value: string) => void
}) {
  const field = column.field
  const value = row[field.name]
  const key = `${String(row.id)}:${field.name}`
  const editing = edit?.id === String(row.id) && edit.field === field.name

  let content: React.ReactNode
  if (field.relation && value !== null && value !== undefined) {
    content = (
      <Link className="underline" href={hrefForRelation(field.relation.target, String(value))}>
        {String(value)}
      </Link>
    )
  } else if (field.type === "boolean") {
    content = value ? "yes" : "no"
  } else {
    content = value === null || value === undefined ? "—" : String(value)
  }

  return (
    <div className="flex flex-col gap-1">
      {editing ? (
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
      ) : canEdit(field) && field.relation === null ? (
        <button
          type="button"
          className="cursor-text text-left"
          title={`Edit ${field.label}`}
          onClick={() => setEdit({ id: String(row.id), field: field.name, value: value === null || value === undefined ? "" : String(value) })}
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

// Empty string stays null for nullable fields, numbers become numbers.
function coerce(field: FieldMetadata, value: string): unknown {
  if (value === "") return null
  if (field.type === "integer" || field.type === "number") {
    const n = Number(value)
    return Number.isFinite(n) ? n : value
  }
  return value
}
