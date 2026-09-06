"use client"

// Record sharing on a CRM detail page: who this record is shared with (one
// chip per grant), share with @username or a group, revoke. Everything goes
// through lib/sharing.ts; no path or payload is built here.
//
// Authority comes from ONE signal: the grant list. 200 = this account manages
// access (owner, cube admin or superadmin); 403 = a neutral sentence and no
// further sharing request. The panel never infers "owner" or "shared with
// you" from roles: the backend is the only gate.
//
// What it deliberately does NOT do (no API for it, or out of scope): show
// group members, audit history, the owner's name, transfer ownership, or
// grant the cube write capability (QWB-63) -- sharing opens the record only.

import { useCallback, useEffect, useId, useRef, useState, type RefObject } from "react"
import { toast } from "sonner"

import { Badge } from "shadcn-admin-kit"

import { apiFetch } from "@/lib/cube"
import {
  CUSTOM_ACTIONS,
  actionsForLevel,
  chipsOf,
  createGroupGrant,
  createUserGrant,
  fetchGrantPage,
  grantActionsLabel,
  grantsPageView,
  lookupGroups,
  lookupUserNames,
  revokeGrant,
  searchUsers,
  type AccountRef,
  type EntityAction,
  type GrantChip,
  type GrantsPageView,
  type ShareLevel,
} from "@/lib/sharing"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"

const PAGE = 50
const SEARCH_LIMIT = 20
const SEARCH_PAUSE_MS = 300

const CAPABILITY_NOTE =
  "Sharing opens this record only. Editing also needs the cube write capability, managed separately. A grantee cannot manage or re-share this record."

type Access = "loading" | "manage" | "denied" | "failed"

export function SharingPanel({
  cube,
  entityType,
  id,
}: {
  cube: string
  entityType: string
  id: string
}) {
  const [access, setAccess] = useState<Access>("loading")
  const [page, setPage] = useState<GrantsPageView | null>(null)
  const [offset, setOffset] = useState(0)
  const [userNames, setUserNames] = useState<Record<string, string>>({})
  // undefined = not asked yet; null = refused (group form hidden).
  const [groups, setGroups] = useState<Record<string, string> | null | undefined>(undefined)
  const [me, setMe] = useState<{ id: string; username: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  // One flag serialises every mutation: Share, Confirm and Revoke are all
  // disabled while any of them is in flight.
  const [busy, setBusy] = useState(false)
  // Only the latest list load may paint (same guard as relation-typeahead).
  const seq = useRef(0)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const load = useCallback(
    (at: number) => {
      const mine = ++seq.current
      let alive = true
      void (async () => {
        const result = await fetchGrantPage({ cube, entityType, entityId: id, offset: at, limit: PAGE })
        if (!alive || seq.current !== mine) return
        if (!result.ok) {
          if (result.status === 403) {
            setAccess("denied")
          } else {
            setAccess((a) => (a === "manage" ? a : "failed"))
            setError(result.message)
          }
          return
        }
        const view = grantsPageView(result.value)
        const names = await lookupUserNames(
          view.rows.flatMap((r) => (r.subject.kind === "user" ? [r.subject.userId] : [])),
        )
        if (!alive || seq.current !== mine) return
        setUserNames(names)
        setPage(view)
        setAccess("manage")
        setError(null)
        // The last row of a later page was revoked: step back one page.
        if (view.rows.length === 0 && at > 0) setOffset(Math.max(0, at - PAGE))
      })()
      return () => {
        alive = false
      }
    },
    [cube, entityType, id],
  )

  useEffect(() => load(offset), [load, offset])

  // Groups and the session identity are needed only by the management form,
  // so they are fetched once the list has answered 200 -- never after a 403.
  useEffect(() => {
    if (access !== "manage" || groups !== undefined) return
    let alive = true
    void lookupGroups(cube).then((g) => {
      if (alive) setGroups(g)
    })
    void apiFetch("/api/qwbe/auth/me")
      .then(async (r) => (r.ok ? ((await r.json()) as { id: string; username: string }) : null))
      .then((m) => {
        if (alive && m) setMe({ id: m.id, username: m.username })
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [access, groups, cube])

  const refetch = () => load(offset)

  const revoke = async (chip: GrantChip) => {
    setBusy(true)
    try {
      const result = await revokeGrant(chip.grantId)
      if (!mounted.current) return
      if (!result.ok) {
        setError(result.message)
      } else {
        toast.success(`Revoked access for ${chipTitle(chip)}`)
      }
      // The list is the source of truth after any mutation; a 403 flips the
      // panel to the neutral sentence through the same path.
      refetch()
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  if (access === "loading") return <Skeleton className="h-24 w-full" aria-label="Loading sharing" />
  if (access === "denied")
    return (
      <Card>
        <CardHeader>
          <CardTitle>Sharing</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Access to this record is managed by its owner or an administrator.
          </p>
        </CardContent>
      </Card>
    )
  if (access === "failed")
    return (
      <Card>
        <CardHeader>
          <CardTitle>Sharing</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <p role="alert" className="text-sm text-destructive">
            {error ?? "the grant list could not be loaded"}
          </p>
          <Button size="sm" variant="outline" className="self-start" onClick={() => refetch()}>
            Retry
          </Button>
        </CardContent>
      </Card>
    )

  const chips = chipsOf(page?.rows ?? [], userNames, groups ?? {})
  const total = page?.total
  const shownTo = (page?.offset ?? 0) + (page?.rows.length ?? 0)
  const canNext = page !== null && (page.hasMore === true || (page.hasMore === null && page.rows.length === PAGE))

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sharing</CardTitle>
        <CardDescription>You manage access to this record. {CAPABILITY_NOTE}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && (
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        {chips.length === 0 ? (
          <p className="text-sm text-muted-foreground">Shared with: none</p>
        ) : (
          <ul aria-label="Shared with" className="flex flex-col gap-2">
            {chips.map((chip) => (
              <ChipRow key={chip.grantId} chip={chip} busy={busy} onRevoke={() => revoke(chip)} />
            ))}
          </ul>
        )}
        {(total === undefined || total > PAGE || (page?.offset ?? 0) > 0) && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>
              Showing {(page?.offset ?? 0) + (chips.length > 0 ? 1 : 0)}-{shownTo} of {total ?? "?"}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={(page?.offset ?? 0) === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE))}
            >
              Previous
            </Button>
            <Button size="sm" variant="outline" disabled={!canNext} onClick={() => setOffset(offset + PAGE)}>
              Next
            </Button>
          </div>
        )}
        <ShareForm
          cube={cube}
          entityType={entityType}
          id={id}
          me={me}
          groups={groups ?? null}
          chips={chips}
          busy={busy}
          setBusy={setBusy}
          onShared={refetch}
        />
      </CardContent>
    </Card>
  )
}

const chipTitle = (chip: GrantChip) => (chip.kind === "user" ? `@${chip.label}` : `group ${chip.label}`)

// One grant row: subject, level badge, two-step inline revoke.
function ChipRow({ chip, busy, onRevoke }: { chip: GrantChip; busy: boolean; onRevoke: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const title = chipTitle(chip)
  const focusTrigger = () =>
    requestAnimationFrame(() =>
      document.querySelector<HTMLButtonElement>(`[data-revoke="${chip.grantId}"]`)?.focus(),
    )
  const cancel = () => {
    setConfirming(false)
    focusTrigger()
  }
  return (
    <li
      className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm"
      onKeyDown={(e) => {
        if (e.key === "Escape" && confirming) cancel()
      }}
    >
      <span className="font-medium">{title}</span>
      <Badge variant={chip.total ? "default" : "secondary"}>{chip.actions}</Badge>
      {confirming ? (
        <span role="group" aria-label={`Confirm revoke ${title}`} className="ml-auto flex flex-wrap items-center gap-1">
          <span className="text-xs text-muted-foreground">
            {chip.kind === "group" ? `Revokes access for every member of ${chip.label}. ` : ""}
            Other grants, direct or through a group, may still give access.
          </span>
          <Button
            variant="destructive"
            size="sm"
            disabled={busy}
            aria-label={`Confirm revoke ${title}`}
            onClick={() => {
              setConfirming(false)
              onRevoke()
            }}
          >
            Confirm revoke
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} aria-label={`Cancel revoke ${title}`} onClick={cancel}>
            Cancel
          </Button>
        </span>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          disabled={busy}
          data-revoke={chip.grantId}
          aria-label={`Revoke access for ${title}`}
          onClick={() => setConfirming(true)}
        >
          Revoke
        </Button>
      )}
    </li>
  )
}

function ShareForm({
  cube,
  entityType,
  id,
  me,
  groups,
  chips,
  busy,
  setBusy,
  onShared,
}: {
  cube: string
  entityType: string
  id: string
  me: { id: string; username: string } | null
  groups: Record<string, string> | null
  chips: GrantChip[]
  busy: boolean
  setBusy: (b: boolean) => void
  onShared: () => void
}) {
  const [kind, setKind] = useState<"user" | "group">("user")
  const [username, setUsername] = useState("")
  const [groupId, setGroupId] = useState("")
  const [level, setLevel] = useState<ShareLevel>("total")
  const [custom, setCustom] = useState<EntityAction[]>(["read"])
  const [confirming, setConfirming] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const pickerRef = useRef<HTMLInputElement | null>(null)
  const radioName = useId()

  const groupEntries = Object.entries(groups ?? {})
  const actions = actionsForLevel(level, custom)
  const subjectLabel = kind === "user" ? `@${username.trim()}` : `group ${groups?.[groupId] ?? groupId}`

  const switchKind = (next: "user" | "group") => {
    setKind(next)
    // Group grants have no backend default (G3): the form starts at read only.
    setLevel(next === "group" ? "read" : "total")
    setConfirming(false)
    setFormError(null)
  }

  // Client-side guards before the confirmation step; the server stays the
  // truth (duplicates are not rejected there, so they are refused here).
  const begin = () => {
    const name = username.trim()
    if (kind === "user") {
      if (name === "") return setFormError("choose a user")
      if (me && name === me.username) return setFormError("you already manage this record")
      if (chips.some((c) => c.kind === "user" && c.label === name))
        return setFormError(`already shared directly with @${name}; revoke that grant first`)
    } else {
      if (groupId === "") return setFormError("choose a group")
      if (chips.some((c) => c.kind === "group" && c.subjectId === groupId))
        return setFormError(`already shared with group ${groups?.[groupId] ?? groupId}; revoke that grant first`)
    }
    if (actions.length === 0) return setFormError("choose at least one action")
    setFormError(null)
    setConfirming(true)
  }

  const confirm = async () => {
    setBusy(true)
    try {
      const ref = { cube, entityType, entityId: id, actions }
      const result =
        kind === "user"
          ? await createUserGrant({ ...ref, username: username.trim() })
          : await createGroupGrant({ ...ref, groupId })
      if (!result.ok) {
        // The draft survives a refusal: qwbe's own message under the form.
        setFormError(result.message)
        setConfirming(false)
        if (result.status === 403) onShared()
        return
      }
      toast.success(`Shared with ${subjectLabel}`)
      setUsername("")
      setGroupId("")
      setConfirming(false)
      onShared()
      requestAnimationFrame(() => pickerRef.current?.focus())
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="flex flex-col gap-3 border-t pt-4"
      onSubmit={(e) => {
        e.preventDefault()
        if (!confirming) begin()
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && confirming) setConfirming(false)
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">Share with</span>
        <Button type="button" size="sm" variant={kind === "user" ? "default" : "outline"} aria-pressed={kind === "user"} onClick={() => switchKind("user")}>
          User
        </Button>
        {groupEntries.length > 0 && (
          <Button type="button" size="sm" variant={kind === "group" ? "default" : "outline"} aria-pressed={kind === "group"} onClick={() => switchKind("group")}>
            Group
          </Button>
        )}
      </div>
      {kind === "user" ? (
        <UserPicker
          ref={pickerRef}
          value={username}
          exclude={[...(me ? [me.username] : []), ...chips.filter((c) => c.kind === "user").map((c) => c.label)]}
          onChange={(v) => {
            setUsername(v)
            setConfirming(false)
          }}
        />
      ) : (
        <select
          aria-label="Group"
          className="h-9 w-64 rounded-md border bg-background px-2 text-sm"
          value={groupId}
          onChange={(e) => {
            setGroupId(e.target.value)
            setConfirming(false)
          }}
        >
          <option value="">choose a group</option>
          {groupEntries.map(([gid, name]) => (
            <option key={gid} value={gid}>
              {name}
            </option>
          ))}
        </select>
      )}
      <fieldset className="flex flex-wrap items-center gap-3 text-sm">
        <legend className="sr-only">Access level</legend>
        {(
          [
            ["total", "Full access (TOTAL)"],
            ["read", "Read only"],
            ["custom", "Custom"],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="flex items-center gap-1">
            <input
              type="radio"
              name={radioName}
              value={value}
              checked={level === value}
              onChange={() => {
                setLevel(value)
                setConfirming(false)
              }}
            />
            {label}
          </label>
        ))}
      </fieldset>
      {level === "custom" && (
        <fieldset className="flex flex-wrap items-center gap-3 text-sm">
          <legend className="sr-only">Custom actions</legend>
          {CUSTOM_ACTIONS.map((a) => (
            <label key={a} className="flex items-center gap-1">
              <Checkbox
                checked={custom.includes(a)}
                onCheckedChange={(c) => {
                  setCustom(c === true ? [...custom, a] : custom.filter((x) => x !== a))
                  setConfirming(false)
                }}
              />
              {a}
            </label>
          ))}
        </fieldset>
      )}
      {formError && (
        <p role="alert" className="text-sm text-destructive">
          {formError}
        </p>
      )}
      {confirming ? (
        <div role="group" aria-label="Confirm share" className="flex flex-col gap-2 rounded-md border px-3 py-2 text-sm">
          <p>
            Share with <strong>{subjectLabel}</strong>: {grantActionsLabel(actions)} ({actions.join(", ")}).
            {kind === "group" ? " Applies to every member of the group." : ""}
          </p>
          {actions.includes("transfer") && (
            <p className="font-semibold text-destructive">
              Includes transfer: the grantee can take ownership of this record away from the current owner.
            </p>
          )}
          <p className="text-xs text-muted-foreground">{CAPABILITY_NOTE}</p>
          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={busy} aria-label="Confirm share" onClick={confirm}>
              Confirm share
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} aria-label="Cancel share" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button type="submit" size="sm" className="self-start" disabled={busy}>
          Share
        </Button>
      )}
    </form>
  )
}

// The @username combobox: the typed text IS the identity sent to the backend
// (username, never an id), so it keeps working when the directory search is
// refused -- the picker then says so instead of showing "no matches".
function UserPicker({
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
  const [active, setActive] = useState(-1)
  const listboxId = useId()
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

  const pick = (row: AccountRef) => {
    onChange(row.username)
    setOpen(false)
    setActive(-1)
  }
  const rows = options ?? []

  return (
    <div className="relative w-64" ref={rootRef}>
      <Input
        ref={ref}
        role="combobox"
        aria-label="Username"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={open && active >= 0 ? `${listboxId}-${active}` : undefined}
        placeholder="@username"
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
          setActive(-1)
          if (timer.current) clearTimeout(timer.current)
          timer.current = setTimeout(() => runSearch(e.target.value), SEARCH_PAUSE_MS)
        }}
        onFocus={() => {
          setOpen(true)
          runSearch(value)
        }}
        onKeyDown={(e) => {
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
          } else if (e.key === "Escape" && open) {
            e.stopPropagation()
            setOpen(false)
            setActive(-1)
          }
        }}
      />
      {open && options === null && (
        <p className="mt-1 text-xs text-muted-foreground">
          Directory search unavailable: type the exact username.
        </p>
      )}
      {open && options !== null && options !== undefined && options.length === 0 && (
        <p className="absolute z-50 mt-1 w-full rounded-md border bg-popover px-2 py-1.5 text-sm text-popover-foreground shadow-md">
          no matches
        </p>
      )}
      {open && rows.length > 0 && (
        <ul
          id={listboxId}
          role="listbox"
          aria-label="Search users"
          className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {rows.map((row, i) => (
            <li
              key={row.id}
              id={`${listboxId}-${i}`}
              role="option"
              aria-selected={row.username === value}
              className="cursor-pointer rounded px-2 py-1.5 text-sm hover:bg-accent data-[active=true]:bg-accent"
              data-active={i === active}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(row)}
            >
              {/* username + displayName only; email never renders (G8). */}
              @{row.username}
              {row.displayName ? ` (${row.displayName})` : ""}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
