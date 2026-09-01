"use client"

// The create form, driven by the same cube metadata as the list and detail
// (QWB-49). The caller names the fields to show -- the cube's basic set, not
// every editable field (QWB-54, F1) -- while labels, required flags,
// nullability and the relation picker come from the published metadata: no
// field label is hard-coded here, and a name the schema does not define (or
// does not accept on create) is dropped.
//
// Submit POSTs the filled fields through the server proxy (the token stays in
// the cookie) and lands on the new row's detail page; qwbe's own refusal
// message is shown on the form. The form logic that survives without a DOM
// (the payload build) lives in lib/cube.ts and is unit-tested there.

import { useRouter } from "next/navigation"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import {
  apiFetch,
  createPayloadOf,
  cubeApiPath,
  errorBody,
  errorMessage,
  metadataApiPath,
  rowHref,
  routeOf,
  type CubeMetadata,
  type Row,
} from "@/lib/cube"
import { RelationTypeahead } from "@/components/relation-typeahead"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"

export function CubeCreateForm({
  cube,
  fields,
}: {
  cube: string
  // The field names to show, in display order.
  fields: string[]
}) {
  const router = useRouter()
  const [meta, setMeta] = useState<CubeMetadata | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [refusal, setRefusal] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  // The submit only exists once the client has hydrated: before that, typed
  // values sit in the DOM while React's state is still empty, and a submit
  // would send an empty payload (the same race the login form gates).
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setHydrated(true), 0)
    return () => clearTimeout(t)
  }, [])

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

  // The caller's order decides the display order; only fields the schema
  // actually accepts on create are rendered.
  const formFields = useMemo(
    () =>
      meta
        ? fields.flatMap((name) => {
            const field = meta.fields.find((f) => f.name === name && f.editable)
            return field ? [field] : []
          })
        : [],
    [meta, fields],
  )

  const setValue = (name: string, value: string) =>
    setValues((v) => ({ ...v, [name]: value }))

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const { payload, missing } = createPayloadOf(formFields, values)
    if (missing.length > 0) {
      setRefusal(`Required: ${missing.join(", ")}`)
      return
    }
    setRefusal(null)
    setPending(true)
    const response = await apiFetch(cubeApiPath(cube), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })
    setPending(false)
    if (!response.ok) {
      // qwbe's message, matched to the payload it refused; the typed values
      // stay in the form so a fix does not start from zero.
      setRefusal(errorMessage(await errorBody(response)))
      return
    }
    const row = (await response.json()) as Row
    toast.success("Created")
    // The detail page shows what was actually stored; when this app has no
    // route for the cube, back to the list.
    router.push(rowHref(cube, String(row.id)) ?? routeOf(cube))
  }

  if (loadError) return <p role="alert">{loadError}</p>
  if (!meta) return <Skeleton className="h-64 w-full" />

  return (
    <Card className="w-full max-w-2xl">
      <CardContent>
        <form onSubmit={onSubmit}>
          <FieldGroup>
            {formFields.map((f) => (
              <Field key={f.name}>
                {f.relation ? (
                  // The picker carries its own label (it is a combobox, not a
                  // plain input, so a htmlFor label would not reach it); the
                  // aria-label names the field in form mode.
                  <RelationTypeahead
                    field={f}
                    variant="form"
                    value={values[f.name] ?? ""}
                    onChange={(id) => setValue(f.name, id)}
                  />
                ) : (
                  <>
                    <FieldLabel htmlFor={`create-${f.name}`}>{f.label}</FieldLabel>
                    {/* ponytail: every form field so far is free text (the two
                        cubes' basic sets); if a create set ever gains an enum
                        or number field, renderKindOf/coerce in lib/cube.ts are
                        the classifiers to drive a Select/checkbox from. */}
                    <Input
                      id={`create-${f.name}`}
                      value={values[f.name] ?? ""}
                      required={f.required}
                      onChange={(e) => setValue(f.name, e.target.value)}
                    />
                  </>
                )}
              </Field>
            ))}
            {refusal && (
              <p role="alert" className="text-sm text-destructive">
                {refusal}
              </p>
            )}
            <div className="flex gap-2">
              <Button type="submit" disabled={pending || !hydrated}>
                {pending ? "Saving..." : "Create"}
              </Button>
            </div>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  )
}
