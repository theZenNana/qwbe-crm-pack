"use client"

// Saved views for ANY metadata-driven list (QWB-62 stage F2/F3). Generic: the
// component takes the target cube name and its published metadata; no entity
// name is known here.
//
// Applying and managing are kept apart. Applying fetches the LATEST stored row
// (a shared view may have been edited or revoked since it was listed), decodes
// it, sanitises it against the live metadata (lib/views applyView: pinned
// filters always win, unknown fields are dropped with a visible warning) and
// hands the result to the list. A 403/404 on apply is "gone": the list falls
// back to its default state, the picker refreshes, and nothing retries.
//
// Managing (save, rename, delete, share) is offered per the caller's OWN access
// on that view as the permissions cube reports it (lib/views fetchViewAccess):
// a read grantee sees the view and gets no edit affordance; holding the views
// route permission alone is never entity authority. The server rechecks every
// call, and its refusal is shown verbatim.
//
// A view never carries data: it stores parameters only, and the list request
// stays gated by the target cube's own permissions.

import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import type { CubeMetadata, ListControls } from "@/lib/cube"
import {
  VIEW_ACTIONS,
  VIEW_ENTITY_TYPE,
  VIEWS_CUBE,
  applyView,
  configFromState,
  createView,
  deleteView,
  fetchView,
  fetchViewAccess,
  listViews,
  parseViewConfig,
  updateView,
  viewRights,
  type AppliedView,
  type ListState,
  type SavedViewRow,
  type ViewAccess,
} from "@/lib/views"
import { SharingPanel } from "@/components/sharing-panel"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

const DEFAULT = "__default__"
const SHARE_NOTE =
  "Sharing a view shares its layout and filters only, never the rows: every recipient still sees only what their own permissions allow."

export function ListViews({
  targetCube,
  meta,
  controls,
  fixedFilters,
  state,
  activeId,
  onApply,
}: {
  targetCube: string
  meta: CubeMetadata
  controls: ListControls
  fixedFilters: Readonly<Record<string, string>>
  // The list's current state (what "Save" stores).
  state: ListState
  activeId: string | null
  // null, null = back to the default list.
  onApply: (view: SavedViewRow | null, applied: AppliedView | null) => void
}) {
  const [views, setViews] = useState<SavedViewRow[] | null>(null)
  const [access, setAccess] = useState<Record<string, ViewAccess>>({})
  const [loadError, setLoadError] = useState<string | null>(null)
  // The permissions lookup failed: no right is granted, and the picker says
  // why management is hidden instead of silently dropping it.
  const [accessError, setAccessError] = useState<string | null>(null)
  // The access map is stale (first load, or a save that triggered a refresh):
  // the "you cannot change this view" hint waits for it, so a freshly created
  // (owned) view is never called read-only. Set by the callers of load(), not
  // inside it (the initial effect must not set state synchronously).
  const [loading, setLoading] = useState(true)
  // What the last apply had to drop or why it fell back; shown, never silent.
  const [notice, setNotice] = useState<string[]>([])
  const [manage, setManage] = useState(false)
  const [busy, setBusy] = useState(false)
  const seq = useRef(0)
  // Apply has its own guard so a refresh never cancels an apply, nor the reverse.
  const pickSeq = useRef(0)

  // Only the latest load may paint (same guard as sharing-panel).
  const load = useCallback(() => {
    const mine = ++seq.current
    void (async () => {
      const [result, acc] = await Promise.all([listViews(targetCube), fetchViewAccess()])
      if (seq.current !== mine) return
      setLoading(false)
      if (!result.ok) {
        setLoadError(result.message)
        setViews([])
        return
      }
      setViews(result.value.rows)
      setAccess(acc.ok ? acc.value : {})
      setAccessError(acc.ok ? null : acc.message)
      setLoadError(null)
    })()
  }, [targetCube])
  useEffect(() => load(), [load])

  const applyRow = (row: SavedViewRow) => {
    const config = parseViewConfig(row)
    if (!config) {
      setNotice([`view "${row.name}" has an unreadable configuration and was not applied`])
      onApply(null, null)
      return
    }
    const applied = applyView(config, meta, controls, fixedFilters)
    setNotice(applied.warnings)
    onApply(row, applied)
  }

  const pick = async (id: string) => {
    const mine = ++pickSeq.current
    if (id === DEFAULT) {
      setBusy(false)
      setNotice([])
      onApply(null, null)
      return
    }
    setBusy(true)
    const result = await fetchView(id)
    if (pickSeq.current !== mine) return
    setBusy(false)
    if (!result.ok) {
      // Revoked or deleted since it was listed: fall back, refresh, no retry.
      setNotice([`that view is no longer available (${result.message}); showing the default list`])
      onApply(null, null)
      load()
      return
    }
    setViews((vs) => vs?.map((v) => (v.id === id ? result.value : v)) ?? vs)
    applyRow(result.value)
  }

  const active = views?.find((v) => v.id === activeId) ?? null
  const rights = viewRights(active ? access[active.id] : undefined)
  const own = active ? access[active.id]?.source === "owner" : false

  if (views === null) return null
  if (loadError && views.length === 0) {
    return (
      <span role="status" className="text-xs text-muted-foreground">
        saved views unavailable: {loadError}
      </span>
    )
  }

  return (
    <div className="flex w-full flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">View</span>
          <Select value={activeId ?? DEFAULT} onValueChange={(v) => void pick(v)} disabled={busy}>
            <SelectTrigger className="w-56" aria-label="Saved view">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT}>Default</SelectItem>
              {views.map((v) => (
                <SelectItem key={v.id} value={v.id}>
                  {v.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button type="button" size="sm" variant="outline" aria-expanded={manage} onClick={() => setManage((m) => !m)}>
          {manage ? "Close views" : "Manage views"}
        </Button>
      </div>
      {(notice.length > 0 || active || accessError) && (
        <p role="status" className="text-xs text-muted-foreground">
          {active && `View "${active.name}" controls the columns. `}
          {active && !own && `Updated ${active.updatedAt.slice(0, 10)}. `}
          {notice.join(" ")}
          {accessError && ` Permissions unavailable (${accessError}); management of saved views is hidden.`}
        </p>
      )}
      {manage && (
        <ManageViews
          key={active?.id ?? DEFAULT}
          targetCube={targetCube}
          meta={meta}
          fixedFilters={fixedFilters}
          state={state}
          active={active}
          rights={rights}
          rightsPending={loading}
          busy={busy}
          setBusy={setBusy}
          onSaved={(row) => {
            setViews((vs) => {
              const rest = (vs ?? []).filter((v) => v.id !== row.id)
              return [...rest, row].sort((a, b) => a.name.localeCompare(b.name))
            })
            setLoading(true)
            load()
            applyRow(row)
          }}
          onDeleted={(id) => {
            setViews((vs) => (vs ?? []).filter((v) => v.id !== id))
            setNotice([])
            if (id === activeId) onApply(null, null)
          }}
        />
      )}
    </div>
  )
}

function ManageViews({
  targetCube,
  meta,
  fixedFilters,
  state,
  active,
  rights,
  rightsPending,
  busy,
  setBusy,
  onSaved,
  onDeleted,
}: {
  targetCube: string
  meta: CubeMetadata
  fixedFilters: Readonly<Record<string, string>>
  state: ListState
  active: SavedViewRow | null
  rights: ReturnType<typeof viewRights>
  // The access map is being refreshed: no read-only hint until it lands.
  rightsPending: boolean
  busy: boolean
  setBusy: (b: boolean) => void
  onSaved: (row: SavedViewRow) => void
  onDeleted: (id: string) => void
}) {
  // The column draft starts from what the list shows now; the checked fields
  // keep the order below, moved with the arrow buttons (no drag-and-drop).
  const [cols, setCols] = useState<string[]>(state.columns)
  const [name, setName] = useState(active?.name ?? "")
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [share, setShare] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const config = () => configFromState({ ...state, columns: cols }, fixedFilters)

  const run = async (
    action: () => Promise<{ ok: true; value: SavedViewRow } | { ok: false; message: string }>,
    done: (row: SavedViewRow) => void,
    ok: string,
  ) => {
    setBusy(true)
    setError(null)
    try {
      const result = await action()
      if (!result.ok) {
        setError(result.message)
        return
      }
      toast.success(ok)
      done(result.value)
    } finally {
      setBusy(false)
    }
  }

  const move = (field: string, by: -1 | 1) =>
    setCols((c) => {
      const i = c.indexOf(field)
      const j = i + by
      if (i < 0 || j < 0 || j >= c.length) return c
      const next = [...c]
      next[i] = c[j]
      next[j] = c[i]
      return next
    })

  return (
    <div className="flex flex-col gap-3 rounded-md border p-3 text-sm">
      <fieldset className="flex flex-col gap-1">
        <legend className="text-xs font-medium text-muted-foreground">Columns (checked, in order)</legend>
        {[...cols, ...meta.fields.map((f) => f.name).filter((n) => !cols.includes(n))].map((n) => {
          const field = meta.fields.find((f) => f.name === n)
          if (!field) return null
          const at = cols.indexOf(n)
          return (
            <label key={n} className="flex items-center gap-2">
              <Checkbox
                checked={at >= 0}
                aria-label={`Show column ${field.label}`}
                onCheckedChange={(c) => setCols((cur) => (c === true ? [...cur, n] : cur.filter((x) => x !== n)))}
              />
              <span className="min-w-40">{field.label}</span>
              {at >= 0 && (
                <>
                  <Button type="button" size="sm" variant="ghost" aria-label={`Move ${field.label} up`} disabled={at === 0} onClick={() => move(n, -1)}>
                    Up
                  </Button>
                  <Button type="button" size="sm" variant="ghost" aria-label={`Move ${field.label} down`} disabled={at === cols.length - 1} onClick={() => move(n, 1)}>
                    Down
                  </Button>
                </>
              )}
            </label>
          )
        })}
      </fieldset>
      <p className="text-xs text-muted-foreground">
        Saving stores these columns with the current filters, search, sort and page size.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Name</span>
          <Input className="w-56" aria-label="View name" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <Button
          type="button"
          size="sm"
          disabled={busy || name.trim() === ""}
          onClick={() =>
            run(
              () => createView({ targetCube, name, config: config() }),
              onSaved,
              `Saved view "${name.trim()}"`,
            )
          }
        >
          Save as new view
        </Button>
        {active && rights.edit && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || name.trim() === ""}
            onClick={() =>
              run(
                () => updateView(active.id, { name, config: config() }),
                onSaved,
                `Updated view "${name.trim()}"`,
              )
            }
          >
            Update this view
          </Button>
        )}
        {active && rights.delete && !confirmDelete && (
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setConfirmDelete(true)}>
            Delete this view
          </Button>
        )}
        {active && rights.delete && confirmDelete && (
          <span role="group" aria-label="Confirm delete view" className="flex items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() =>
                run(() => deleteView(active.id), () => onDeleted(active.id), `Deleted view "${active.name}"`)
              }
            >
              Confirm delete
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
          </span>
        )}
        {active && rights.share && (
          <Button type="button" size="sm" variant="outline" aria-expanded={share} onClick={() => setShare((s) => !s)}>
            {share ? "Hide sharing" : "Share this view"}
          </Button>
        )}
      </div>
      {active && !rights.edit && !rightsPending && (
        <p className="text-xs text-muted-foreground">You can apply this view but not change it; save your changes as a new view.</p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {active && share && rights.share && (
        <SharingPanel
          cube={VIEWS_CUBE}
          entityType={VIEW_ENTITY_TYPE}
          id={active.id}
          levels={["read", "custom"]}
          customActions={VIEW_ACTIONS}
          defaultLevel="read"
          title={`Share view "${active.name}"`}
          note={SHARE_NOTE}
        />
      )}
    </div>
  )
}
