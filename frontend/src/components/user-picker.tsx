"use client"

// The @username combobox on the kit's Command (cmdk), shared by the record
// sharing panel and the groups panel. The typed text IS the identity sent to
// the backend (username, never an id), so it keeps working when the directory
// search is refused -- the picker then says so instead of showing "no
// matches". cmdk owns the keyboard: arrows move the active option, which
// carries aria-selected and aria-activedescendant; Enter picks it.

import { useEffect, useRef, useState, type RefObject } from "react"

import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "shadcn-admin-kit"

import { searchUsers, type AccountRef } from "@/lib/sharing"

const SEARCH_LIMIT = 20
const SEARCH_PAUSE_MS = 300

export const DIRECTORY_NOTE = "Directory search unavailable: type the exact username."

export function UserPicker({
  ref,
  value,
  exclude,
  onChange,
}: {
  ref: RefObject<HTMLInputElement | null>
  value: string
  exclude: string[]
  onChange: (username: string) => void
}) {
  const [open, setOpen] = useState(false)
  // undefined = nothing searched yet; null = directory refused.
  const [options, setOptions] = useState<AccountRef[] | null | undefined>(undefined)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const seq = useRef(0)

  // Called from event handlers only, so it needs no stable identity.
  const runSearch = (q: string) => {
    const mine = ++seq.current
    void searchUsers({ q, limit: SEARCH_LIMIT }).then((rows) => {
      if (seq.current !== mine) return
      setOptions(rows === null ? null : rows.filter((r) => !exclude.includes(r.username)))
    })
  }

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  useEffect(() => {
    if (!open) return undefined
    const onDocPointerDown = (e: PointerEvent) => {
      const root = rootRef.current
      if (!root || !(e.target instanceof Node) || root.contains(e.target)) return
      setOpen(false)
    }
    document.addEventListener("pointerdown", onDocPointerDown, true)
    return () => document.removeEventListener("pointerdown", onDocPointerDown, true)
  }, [open])

  const rows = options ?? []
  const searched = options !== undefined && options !== null
  // One persistent live region: a message that appears together with its
  // container is not announced, so the visible texts below are echoes of this.
  const status = !open ? "" : options === null ? DIRECTORY_NOTE : searched && rows.length === 0 ? "no matches" : ""

  return (
    <Command
      ref={rootRef}
      shouldFilter={false}
      className="relative w-64 overflow-visible rounded-md border bg-transparent **:data-[slot=command-input-wrapper]:border-b-0"
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") setOpen(true)
        if (e.key === "Escape" && open) {
          e.stopPropagation()
          setOpen(false)
        }
      }}
    >
      <CommandInput
        ref={ref}
        aria-label="Username"
        placeholder="@username"
        value={value}
        onValueChange={(v) => {
          onChange(v)
          setOpen(true)
          if (timer.current) clearTimeout(timer.current)
          timer.current = setTimeout(() => runSearch(v), SEARCH_PAUSE_MS)
        }}
        onFocus={() => {
          setOpen(true)
          runSearch(value)
        }}
      />
      <p role="status" className="sr-only">
        {status}
      </p>
      {open && options === null && (
        <p aria-hidden className="mt-1 text-xs text-muted-foreground">
          {DIRECTORY_NOTE}
        </p>
      )}
      {open && searched && (
        <CommandList
          aria-label="Search users"
          className="absolute top-full z-50 mt-1 w-full rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          <CommandEmpty aria-hidden className="px-2 py-1.5 text-left">
            no matches
          </CommandEmpty>
          {rows.map((row) => (
            <CommandItem
              key={row.id}
              value={row.username}
              onSelect={() => {
                onChange(row.username)
                setOpen(false)
              }}
            >
              {/* username + displayName only; email never renders (G8). */}
              @{row.username}
              {row.displayName ? ` (${row.displayName})` : ""}
            </CommandItem>
          ))}
        </CommandList>
      )}
    </Command>
  )
}
