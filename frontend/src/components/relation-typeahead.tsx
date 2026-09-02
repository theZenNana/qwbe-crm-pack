"use client"

// The searchable relation filter.
//
// This is a typeahead: nothing is
// loaded until the field is focused, and every keystroke pause sends ONE
// `q=<text>&limit=20` search request -- qwbe scans exactly the fields the
// target's manifest declares searchable -- and answers with 20 candidates.
//
// The displayed filter shows the chosen row's title, resolved through one
// `ids=` batch request when the component learns the value from outside (its
// own selections resolve from the option row already in hand: no extra
// request).
//
// A target cube that declares no searchable fields cannot filter by text:
// qwbe's `q` is then a no-op, so the component says so instead of showing
// results that silently ignore what was typed.

import { useCallback, useEffect, useId, useRef, useState } from "react"

import {
  apiFetch,
  relationMeta,
  titleOf,
  type CubeMetadata,
  type FieldMetadata,
  type PageOf,
  type Row,
} from "@/lib/cube"
import { batchListApiPath, relationSearchApiPath, titlesOfPage } from "@/lib/relation-batch"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

// Suggestions per search. Small on purpose: the picker narrows by text, it
// does not paginate.
const SEARCH_LIMIT = 20
// Same pause the text filters use: the search is substring-ish server side,
// so per-keystroke requests are misses by construction.
const SEARCH_PAUSE_MS = 300

export function RelationTypeahead({
  field,
  value,
  onChange,
  // "filter" (default) is the list filter row: the aria labels say Filter by /
  // Clear ... filter and the empty input's placeholder is All. "form" is the
  // create-form picker: same combobox behaviour, labels that name
  // the field instead of the filter.
  variant = "filter",
}: {
  field: FieldMetadata
  // The current filter value: the related row's opaque id, or "" for all.
  value: string
  onChange: (id: string) => void
  variant?: "filter" | "form"
}) {
  const target = field.relation!.target
  const [targetMeta, setTargetMeta] = useState<CubeMetadata | null>(null)
  // The chosen row, kept so the input can show its title. Null = no filter.
  const [selected, setSelected] = useState<{ id: string; title: string } | null>(null)
  const [text, setText] = useState("")
  const [open, setOpen] = useState(false)
  const [options, setOptions] = useState<Row[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const [active, setActive] = useState(-1)
  const listboxId = useId()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Only the latest search may paint: an older response landing late must
  // not overwrite the results of the query the input now holds.
  const seq = useRef(0)

  // The target's metadata: the title field for labels, and the searchable
  // check for the honesty hint. Cached per session, so this is free after
  // the first relation surface touched this cube.
  useEffect(() => {
    let alive = true
    void relationMeta(target).then((m) => {
      if (alive) setTargetMeta(m)
    })
    return () => {
      alive = false
    }
  }, [target])

  // A value learned from OUTSIDE this component (mount with a preset, or a
  // parent reset) has no option row in hand: resolve the title with one ids
  // batch. The component's own selections skip this -- selected.id matches
  // already -- so picking costs no extra request. A stale selected entry (for
  // a value that is no longer current) is harmless: every read site checks
  // selected.id === value, so nothing needs to be cleared here.
  useEffect(() => {
    if (value === "") return
    if (selected?.id === value) return
    let alive = true
    void (async () => {
      try {
        const meta = await relationMeta(target)
        if (!meta) throw new Error("metadata unavailable")
        const r = await apiFetch(batchListApiPath(target, [value]))
        if (!r.ok) throw new Error(`batch request failed: ${r.status}`)
        const p = (await r.json()) as PageOf<Row>
        if (!alive) return
        const title = titlesOfPage(meta, p.rows)[value] ?? value
        setSelected({ id: value, title })
        setText(title)
      } catch {
        if (alive) {
          setSelected({ id: value, title: value })
          setText(value)
        }
      }
    })()
    return () => {
      alive = false
    }
    // `selected` is deliberately not a dependency: this effect reacts to
    // VALUE changes, and the own-selection path is excluded above by identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, value])

  const label = useCallback(
    (row: Row) => (targetMeta ? titleOf(targetMeta, row) : String(row.id)),
    [targetMeta],
  )

  const runSearch = useCallback(
    (q: string) => {
      const mine = ++seq.current
      setSearching(true)
      apiFetch(relationSearchApiPath(target, q, SEARCH_LIMIT))
        .then(async (r) => (r.ok ? ((await r.json()) as PageOf<Row>) : null))
        .then((p) => {
          if (seq.current !== mine) return
          setOptions(p?.rows ?? [])
          setTruncated(p !== null && p.rows.length >= SEARCH_LIMIT)
        })
        .catch(() => {
          if (seq.current === mine) setOptions([])
        })
        .finally(() => {
          if (seq.current === mine) setSearching(false)
        })
    },
    [target],
  )

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  // Commit (or dismiss) when the pointer goes down OUTSIDE the picker, as a
  // capture listener on the document -- the same pattern the inline editor
  // uses, because commit-on-blur loses the race against the browser's delayed
  // focus changes (see cube-list.tsx).
  useEffect(() => {
    if (!open) return undefined
    const onDocPointerDown = (e: PointerEvent) => {
      const root = rootRef.current
      if (!root || !(e.target instanceof Node)) return
      if (root.contains(e.target)) return
      setOpen(false)
      setText(selected?.title ?? value)
    }
    document.addEventListener("pointerdown", onDocPointerDown, true)
    return () => document.removeEventListener("pointerdown", onDocPointerDown, true)
  }, [open, selected, value])

  const pick = (row: Row) => {
    const id = String(row.id)
    setSelected({ id, title: label(row) })
    setText(label(row))
    setOpen(false)
    setActive(-1)
    setOptions(null)
    onChange(id)
  }

  const clear = () => {
    setSelected(null)
    setText("")
    setOpen(false)
    setActive(-1)
    setOptions(null)
    onChange("")
  }

  const noSearchable = targetMeta !== null && !targetMeta.fields.some((f) => f.searchable)

  const clearLabel = variant === "form" ? `Clear ${field.label}` : `Clear ${field.label} filter`

  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-muted-foreground">{field.label}</span>
      <div className="relative" ref={rootRef}>
        <div className="flex items-center gap-1">
          <Input
            className="w-64"
            role="combobox"
            aria-label={variant === "form" ? field.label : `Filter by ${field.label}`}
            aria-expanded={open}
            aria-controls={open ? listboxId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={open && active >= 0 ? `${listboxId}-${active}` : undefined}
            value={text}
            placeholder={value === "" && variant === "filter" ? "All" : undefined}
            onChange={(e) => {
              const next = e.target.value
              setText(next)
              setOpen(true)
              if (timer.current) clearTimeout(timer.current)
              timer.current = setTimeout(() => runSearch(next), SEARCH_PAUSE_MS)
            }}
            onFocus={() => {
              setOpen(true)
              runSearch(text)
            }}
            onKeyDown={(e) => {
              const rows = options ?? []
              if (e.key === "ArrowDown") {
                e.preventDefault()
                setOpen(true)
                setActive((a) => Math.min(a + 1, rows.length - 1))
              } else if (e.key === "ArrowUp") {
                e.preventDefault()
                setActive((a) => Math.max(a - 1, -1))
              } else if (e.key === "Enter" && open && active >= 0 && rows[active]) {
                e.preventDefault()
                pick(rows[active])
              } else if (e.key === "Escape") {
                setOpen(false)
                setActive(-1)
                setText(selected?.title ?? value)
              }
            }}
          />
          {value !== "" && (
            <Button
              variant="ghost"
              size="sm"
              aria-label={clearLabel}
              onClick={clear}
            >
              ✕
            </Button>
          )}
        </div>
        {open && searching && options === null && (
          <p className="absolute z-50 mt-1 w-full rounded-md border bg-popover px-2 py-1.5 text-sm text-popover-foreground shadow-md">
            searching…
          </p>
        )}
        {open && !searching && options !== null && options.length === 0 && (
          <p className="absolute z-50 mt-1 w-full rounded-md border bg-popover px-2 py-1.5 text-sm text-popover-foreground shadow-md">
            no matches
          </p>
        )}
        {open && options !== null && options.length > 0 && (
          <ul
            id={listboxId}
            role="listbox"
            aria-label={`Search ${field.label}`}
            className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
          >
            {options.map((row, i) => (
              <li
                key={String(row.id)}
                id={`${listboxId}-${i}`}
                role="option"
                aria-selected={String(row.id) === value}
                className="cursor-pointer rounded px-2 py-1.5 text-sm hover:bg-accent data-[active=true]:bg-accent"
                data-active={i === active}
                // Keep focus in the input: the combobox pattern drives
                // selection through aria-activedescendant, not focus moves.
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(row)}
              >
                {label(row)}
              </li>
            ))}
          </ul>
        )}
        {open && noSearchable && (
          <p className="mt-1 text-xs text-muted-foreground">
            {target} publishes no searchable fields: results are the first rows, not a
            search.
          </p>
        )}
        {open && truncated && !noSearchable && (
          <p className="mt-1 text-xs text-muted-foreground">type to narrow the search</p>
        )}
      </div>
    </div>
  )
}
