"use client"

// Settings > Groups: the permission groups of ONE cube, their members, and
// the four writes the kernel offers (create, rename, add member, remove
// member). Everything goes through lib/sharing.ts; no path or payload is
// built here.
//
// Authority comes from the backend only. The group list's 200/403 gates the
// panel; every later request is judged by its own answer (the kernel's
// `administer` re-checks cube access per group on each call, and a group can
// vanish or be refused between two clicks), so a refusal is shown from the
// server's message and the lists are refetched -- never an optimistic update.
//
// Deliberately absent (no API, or out of scope): group delete, cube admin
// management, audit history.

import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { Badge } from "shadcn-admin-kit"

import {
  addGroupMember,
  createGroup,
  fetchGroupMembersPage,
  fetchGroups,
  lookupUserNames,
  memberRowsOf,
  membersHasMore,
  removeGroupMemberById,
  renameGroup,
  type GroupMembershipPage,
  type MemberRow,
  type PermissionGroupRef,
} from "@/lib/sharing"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { UserPicker } from "@/components/user-picker"

const PAGE = 50

type Access = "loading" | "manage" | "denied" | "failed"

export function GroupsPanel({ cube }: { cube: string }) {
  const [access, setAccess] = useState<Access>("loading")
  const [groups, setGroups] = useState<PermissionGroupRef[]>([])
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState("")
  const [newName, setNewName] = useState("")
  const [busy, setBusy] = useState(false)
  // Only the latest list load may paint.
  const seq = useRef(0)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const load = useCallback(() => {
    const mine = ++seq.current
    void fetchGroups(cube).then((result) => {
      if (!mounted.current || seq.current !== mine) return
      if (!result.ok) {
        if (result.status === 403) {
          setAccess("denied")
        } else {
          setAccess((a) => (a === "manage" ? a : "failed"))
          setError(result.message)
        }
        return
      }
      setGroups(result.value)
      setAccess("manage")
      setError(null)
      // A selected group that the list no longer carries is dropped, so no
      // request ever targets a group of a stale list.
      setSelected((s) => (result.value.some((g) => g.id === s) ? s : ""))
    })
  }, [cube])

  useEffect(() => load(), [load])

  const create = async () => {
    setBusy(true)
    try {
      const result = await createGroup({ cube, name: newName })
      if (!mounted.current) return
      if (!result.ok) {
        toast.error(result.message)
      } else {
        toast.success(`Created group ${result.value.name}`)
        setNewName("")
        setSelected(result.value.id)
      }
      // The list is the source of truth after any mutation; a 403 flips the
      // panel to the neutral sentence through the same path.
      load()
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  if (access === "loading") return <Skeleton role="status" className="h-24 w-full" aria-label="Loading groups" />
  if (access === "denied")
    return (
      <Card>
        <CardHeader>
          <CardTitle>Groups</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Groups of this entity are managed by its record owners or an administrator.
          </p>
        </CardContent>
      </Card>
    )
  if (access === "failed")
    return (
      <Card>
        <CardHeader>
          <CardTitle>Groups</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <p role="alert" className="text-sm text-destructive">
            {error ?? "the group list could not be loaded"}
          </p>
          <Button size="sm" variant="outline" className="self-start" onClick={() => load()}>
            Retry
          </Button>
        </CardContent>
      </Card>
    )

  const group = groups.find((g) => g.id === selected) ?? null

  return (
    <Card>
      <CardHeader>
        <CardTitle>Groups</CardTitle>
        <CardDescription>
          Permission groups of this entity. Sharing a record with a group opens it to every member.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* A background refresh that failed: the list below may be stale. */}
        {error && (
          <div className="flex flex-wrap items-center gap-2">
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
            <Button size="sm" variant="outline" onClick={() => load()}>
              Retry
            </Button>
          </div>
        )}
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (newName.trim() !== "") void create()
          }}
        >
          <div className="flex flex-col gap-1">
            <Label htmlFor="groups-new-name">New group name</Label>
            <Input
              id="groups-new-name"
              className="w-64"
              value={newName}
              disabled={busy}
              onChange={(e) => setNewName(e.target.value)}
            />
          </div>
          <Button type="submit" size="sm" disabled={busy || newName.trim() === ""}>
            Create group
          </Button>
        </form>
        {groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">Groups: none</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor="groups-select">Group</Label>
            <Select value={selected} onValueChange={setSelected}>
              <SelectTrigger id="groups-select" className="w-64" aria-label="Group">
                <SelectValue placeholder="choose a group" />
              </SelectTrigger>
              <SelectContent>
                {groups.map((g) => (
                  <SelectItem key={g.id} value={g.id}>
                    {g.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {/* key remounts the section on group switch: no member page, draft,
            error or open confirmation of the previous group survives. */}
        {group && (
          <GroupSection key={group.id} group={group} busy={busy} setBusy={setBusy} onChanged={load} />
        )}
      </CardContent>
    </Card>
  )
}

type MembersState =
  | { kind: "loading" }
  | { kind: "ready"; page: GroupMembershipPage; rows: MemberRow[] }
  | { kind: "failed"; message: string }

function GroupSection({
  group,
  busy,
  setBusy,
  onChanged,
}: {
  group: PermissionGroupRef
  busy: boolean
  setBusy: (b: boolean) => void
  onChanged: () => void
}) {
  const [name, setName] = useState(group.name)
  const [offset, setOffset] = useState(0)
  const [members, setMembers] = useState<MembersState>({ kind: "loading" })
  const [username, setUsername] = useState("")
  const pickerRef = useRef<HTMLInputElement | null>(null)
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
      void (async () => {
        const result = await fetchGroupMembersPage({ groupId: group.id, offset: at, limit: PAGE })
        if (!mounted.current || seq.current !== mine) return
        if (!result.ok) {
          // 403 (refused for this group), 404 (gone), 0 (network) and an
          // invalid body all show the server's/adapter's message; none of
          // them ever renders as "no members".
          setMembers({ kind: "failed", message: result.message })
          return
        }
        const names = await lookupUserNames(result.value.rows.map((r) => r.userId))
        if (!mounted.current || seq.current !== mine) return
        setMembers({ kind: "ready", page: result.value, rows: memberRowsOf(result.value.rows, names) })
        // The last row of a later page was removed: step back one page.
        if (result.value.rows.length === 0 && at > 0) setOffset(Math.max(0, at - PAGE))
      })()
    },
    [group.id],
  )

  useEffect(() => load(offset), [load, offset])

  const refetch = () => load(offset)

  const after = (result: { ok: boolean; status?: number; message?: string }, success: string) => {
    if (!result.ok) {
      toast.error(result.message ?? "request failed")
      // A refusal or a vanished group is re-judged by the group list.
      if (result.status === 403 || result.status === 404) onChanged()
    } else {
      toast.success(success)
    }
    refetch()
  }

  const rename = async () => {
    setBusy(true)
    try {
      const result = await renameGroup({ groupId: group.id, name })
      if (!mounted.current) return
      if (!result.ok) {
        toast.error(result.message)
        if (result.status === 403 || result.status === 404) onChanged()
      } else {
        toast.success(`Renamed group to ${result.value.name}`)
        onChanged()
      }
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const add = async () => {
    setBusy(true)
    try {
      const target = username.trim()
      const result = await addGroupMember({ groupId: group.id, username: target })
      if (!mounted.current) return
      after(result, `Added @${target} to ${group.name}`)
      if (result.ok) {
        setUsername("")
        requestAnimationFrame(() => pickerRef.current?.focus())
      }
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const remove = async (row: MemberRow) => {
    setBusy(true)
    try {
      const result = await removeGroupMemberById({ groupId: group.id, userId: row.userId })
      if (!mounted.current) return
      after(result, `Removed @${result.ok ? result.value.username : ""} from ${group.name}`)
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const page = members.kind === "ready" ? members.page : null
  const rows = members.kind === "ready" ? members.rows : []
  const shownFrom = page && rows.length > 0 ? page.offset + 1 : 0
  const shownTo = page ? page.offset + rows.length : 0
  const knownNames = rows.flatMap((r) => (r.username ? [r.username] : []))

  return (
    <section aria-label={`Group ${group.name}`} className="flex flex-col gap-4 border-t pt-4">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim() !== "" && name.trim() !== group.name) void rename()
        }}
      >
        <div className="flex flex-col gap-1">
          <Label htmlFor="groups-rename">Group name</Label>
          <Input id="groups-rename" className="w-64" value={name} disabled={busy} onChange={(e) => setName(e.target.value)} />
        </div>
        <Button type="submit" size="sm" variant="outline" disabled={busy || name.trim() === "" || name.trim() === group.name}>
          Rename
        </Button>
      </form>

      {members.kind === "loading" && <Skeleton role="status" className="h-12 w-full" aria-label="Loading members" />}
      {members.kind === "failed" && (
        <div className="flex flex-col gap-2">
          <p role="alert" className="text-sm text-destructive">
            {members.message}
          </p>
          <Button size="sm" variant="outline" className="self-start" onClick={refetch}>
            Retry
          </Button>
        </div>
      )}
      {page && (
        <>
          {rows.length === 0 && page.total === 0 ? (
            <p className="text-sm text-muted-foreground">Members: none</p>
          ) : (
            <ul aria-label="Members" className="flex flex-col gap-2">
              {rows.map((row) => (
                <MemberItem key={row.membershipId} row={row} busy={busy} onRemove={remove} />
              ))}
            </ul>
          )}
          {(page.total > PAGE || page.offset > 0) && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>
                Showing {shownFrom}-{shownTo} of {page.total}
              </span>
              <Button size="sm" variant="outline" disabled={page.offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                Previous
              </Button>
              <Button size="sm" variant="outline" disabled={!membersHasMore(page)} onClick={() => setOffset(offset + PAGE)}>
                Next
              </Button>
            </div>
          )}
        </>
      )}

      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (username.trim() !== "") void add()
        }}
      >
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium">Add member</span>
          <UserPicker ref={pickerRef} value={username} exclude={knownNames} onChange={setUsername} />
        </div>
        <Button type="submit" size="sm" disabled={busy || username.trim() === ""}>
          Add member
        </Button>
      </form>
    </section>
  )
}

// One member row with a two-step remove. The target is the row's account id,
// resolved to a username by the adapter right before the request; a row whose
// lookup failed shows the opaque id and can still be removed if the directory
// answers at click time. The operator never types the target.
function MemberItem({ row, busy, onRemove }: { row: MemberRow; busy: boolean; onRemove: (row: MemberRow) => void }) {
  const [confirming, setConfirming] = useState(false)
  const label = row.username ? `@${row.username}` : row.userId
  const removeRef = useRef<HTMLButtonElement | null>(null)
  const refocus = useRef(false)
  // The Remove button only exists once the confirm step is closed, so focus
  // is restored after that render, not in the same tick.
  useEffect(() => {
    if (!confirming && refocus.current) {
      refocus.current = false
      removeRef.current?.focus()
    }
  }, [confirming])
  const cancel = () => {
    refocus.current = true
    setConfirming(false)
  }
  return (
    <li
      className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm"
      onKeyDown={(e) => {
        if (e.key === "Escape" && confirming) cancel()
      }}
    >
      <span className="font-medium">{label}</span>
      {!row.username && <Badge variant="secondary">username unresolved</Badge>}
      {confirming ? (
        <span role="group" aria-label={`Confirm remove ${label}`} className="ml-auto flex flex-wrap items-center gap-1">
          <Button
            variant="destructive"
            size="sm"
            disabled={busy}
            aria-label={`Confirm remove ${label}`}
            onClick={() => {
              setConfirming(false)
              onRemove(row)
            }}
          >
            Confirm remove
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} aria-label={`Cancel remove ${label}`} onClick={cancel}>
            Cancel
          </Button>
        </span>
      ) : (
        <Button
          variant="outline"
          size="sm"
          ref={removeRef}
          className="ml-auto"
          disabled={busy}
          aria-label={`Remove ${label}`}
          onClick={() => setConfirming(true)}
        >
          Remove
        </Button>
      )}
    </li>
  )
}
