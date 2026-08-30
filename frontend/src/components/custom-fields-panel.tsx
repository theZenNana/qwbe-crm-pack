"use client"

// The custom-field definitions panel (QWB-52). Reachable from every entity
// list: lists the cube's current custom fields, and lets an ADMINISTRATOR add
// one (name, type, required, options for a select) or delete one -- no code,
// no redeploy. Definitions are served by the customfields pack through the
// same server-side proxy as everything else; the token never leaves the
// httpOnly cookie.
//
// The panel is visible ONLY to a user whose effective permissions include
// customfields:write (qwbe's /auth/me publishes them). A user without it gets
// no panel at all, and a direct call to the definition endpoints answers 403
// from qwbe -- the message shown here is qwbe's own.

import { useCallback, useEffect, useState } from "react"

import {
  canDefineFields,
  errorBody,
  errorMessage,
} from "@/lib/cube"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

// The definition types the customfields pack accepts. Published back into the
// target cube's metadata with the type mapping in qwbe's catalogue.
const FIELD_TYPES = ["text", "number", "date", "bool", "select"] as const

// One definition as the customfields list endpoint returns it (a row of the
// pack's own table; deleted definitions are soft-deleted and filtered here).
export type CustomFieldDef = {
  id: string
  targetCube: string
  name: string
  label: string
  fieldType: string
  options: string[]
  required: boolean
  deleted: boolean
}

export function CustomFieldsPanel({
  cube,
  onChanged,
}: {
  // The full cube name the definitions target, e.g. "crm/contacts".
  cube: string
  // Called after a definition is added or deleted, so the caller can re-read
  // the cube's metadata and the new column appears (or the old one disappears)
  // without a page reload.
  onChanged: () => void
}) {
  const [allowed, setAllowed] = useState<boolean | null>(null)
  const [open, setOpen] = useState(false)
  const [defs, setDefs] = useState<CustomFieldDef[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Permission check first: without customfields:write this component renders
  // nothing, whatever else it would have fetched.
  useEffect(() => {
    let alive = true
    fetch("/api/qwbe/auth/me")
      .then(async (r) => (r.ok ? ((await r.json()) as { permissions?: string[] }) : null))
      .then((me) => {
        if (alive) setAllowed(canDefineFields(me?.permissions ?? []))
      })
      .catch(() => {
        if (alive) setAllowed(false)
      })
    return () => {
      alive = false
    }
  }, [])

  const loadDefs = useCallback(() => {
    let alive = true
    fetch(`/api/qwbe/customfields?cube=${encodeURIComponent(cube)}&limit=200`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`definitions request failed: ${r.status}`)
        return (await r.json()) as { rows?: CustomFieldDef[] }
      })
      .then((p) => {
        if (alive)
          setDefs((p.rows ?? []).filter((d) => d.deleted === false && d.targetCube === cube))
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      alive = false
    }
  }, [cube])

  useEffect(() => {
    if (open) loadDefs()
  }, [open, loadDefs])

  if (allowed === null || !allowed) return null

  return (
    <div className="flex flex-col gap-2">
      <Button variant="outline" size="sm" className="self-start" onClick={() => setOpen((o) => !o)}>
        {open ? "Hide custom fields" : "Custom fields"}
      </Button>
      {open && (
        <Card>
          <CardHeader>
            <CardTitle>Custom fields</CardTitle>
            <CardDescription>
              Fields defined at runtime for this entity. They appear in the
              list, the detail page and inline edit as soon as they are defined.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Required</TableHead>
                  <TableHead>Options</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(defs ?? []).map((d) => (
                  <TableRow key={d.id}>
                    <TableCell>{d.label || d.name}</TableCell>
                    <TableCell>{d.fieldType}</TableCell>
                    <TableCell>{d.required ? "yes" : "no"}</TableCell>
                    <TableCell>{d.options.length > 0 ? d.options.join(", ") : "—"}</TableCell>
                    <TableCell>
                      <DeleteButton
                        id={d.id}
                        name={d.label || d.name}
                        onDeleted={() => {
                          setError(null)
                          loadDefs()
                          onChanged()
                        }}
                        onError={setError}
                      />
                    </TableCell>
                  </TableRow>
                ))}
                {defs !== null && defs.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-muted-foreground">
                      No custom fields defined.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
            <DefineForm
              cube={cube}
              onDefined={() => {
                setError(null)
                loadDefs()
                onChanged()
              }}
              onError={setError}
            />
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function DeleteButton({
  id,
  name,
  onDeleted,
  onError,
}: {
  id: string
  name: string
  onDeleted: () => void
  onError: (message: string) => void
}) {
  const [busy, setBusy] = useState(false)
  return (
    <Button
      variant="destructive"
      size="sm"
      disabled={busy}
      aria-label={`Delete ${name}`}
      onClick={async () => {
        setBusy(true)
        try {
          const r = await fetch(`/api/qwbe/customfields/${encodeURIComponent(id)}`, {
            method: "DELETE",
          })
          if (!r.ok) {
            onError(errorMessage(await errorBody(r)))
          } else {
            onDeleted()
          }
        } finally {
          setBusy(false)
        }
      }}
    >
      Delete
    </Button>
  )
}

// The add form. Everything it sends is what the customfields pack's create
// schema accepts; a refusal (bad name, select without options, duplicate,
// no permission) is answered with qwbe's own message.
function DefineForm({
  cube,
  onDefined,
  onError,
}: {
  cube: string
  onDefined: () => void
  onError: (message: string) => void
}) {
  const [name, setName] = useState("")
  const [label, setLabel] = useState("")
  const [fieldType, setFieldType] = useState<string>("text")
  const [required, setRequired] = useState(false)
  const [options, setOptions] = useState("")
  const [busy, setBusy] = useState(false)

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async (e) => {
        e.preventDefault()
        setBusy(true)
        try {
          const r = await fetch("/api/qwbe/customfields", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              targetCube: cube,
              name,
              label,
              fieldType,
              required,
              options:
                fieldType === "select"
                  ? options
                      .split(",")
                      .map((o) => o.trim())
                      .filter((o) => o.length > 0)
                  : [],
            }),
          })
          if (!r.ok) {
            onError(errorMessage(await errorBody(r)))
          } else {
            setName("")
            setLabel("")
            setFieldType("text")
            setRequired(false)
            setOptions("")
            onDefined()
          }
        } finally {
          setBusy(false)
        }
      }}
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="cf-name">Name</Label>
          <Input
            id="cf-name"
            className="w-48"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. lead_source"
            required
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="cf-label">Label</Label>
          <Input
            id="cf-label"
            className="w-48"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="optional"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="cf-type">Type</Label>
          <Select value={fieldType} onValueChange={setFieldType}>
            <SelectTrigger id="cf-type" className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FIELD_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {fieldType === "select" && (
          <div className="flex flex-col gap-1">
            <Label htmlFor="cf-options">Options (comma-separated)</Label>
            <Input
              id="cf-options"
              className="w-64"
              value={options}
              onChange={(e) => setOptions(e.target.value)}
              placeholder="email, phone"
              required
            />
          </div>
        )}
        <div className="flex items-center gap-2 pb-2">
          <Checkbox
            id="cf-required"
            checked={required}
            onCheckedChange={(c) => setRequired(c === true)}
          />
          <Label htmlFor="cf-required">Required</Label>
        </div>
        <Button type="submit" size="sm" disabled={busy} className="mb-0.5">
          Add field
        </Button>
      </div>
    </form>
  )
}
