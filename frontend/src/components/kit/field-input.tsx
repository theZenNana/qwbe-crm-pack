"use client"

// The one kit input per editable field, derived from the metadata alone --
// the same classifier the list's inline editor uses (renderKindOf): an enum
// is a SelectInput, a boolean a BooleanInput, an integer or number a
// TextInput of type number, a declared relation the kit's ReferenceInput +
// AutocompleteInput, everything else a TextInput. REAL shadcn-admin-kit 1.0.7
// components; no homemade input per field. Used by the in-place form of the
// reusable detail renderer (cube-show.tsx) for every entity.

import { useEffect, useState } from "react"
import { required as requiredValidator } from "ra-core"
import {
  AutocompleteInput,
  BooleanInput,
  ReferenceInput,
  SelectInput,
  TextInput,
} from "shadcn-admin-kit"

import { relationMeta, renderKindOf, type CubeMetadata, type FieldMetadata } from "@/lib/cube.ts"

export function KitFieldInput({ field }: { field: FieldMetadata }) {
  const validate = field.required ? requiredValidator() : undefined

  if (field.relation) {
    // The metadata guarantees a declared target once relation is set.
    return <RelationFieldInput field={field as RelationFieldMetadata} validate={validate} />
  }

  if (renderKindOf(field) === "select") {
    return (
      <SelectInput
        source={field.name}
        label={field.label}
        validate={validate}
        choices={(field.enum ?? []).map((value) => ({ id: value, name: value }))}
        emptyText={field.nullable ? "—" : undefined}
      />
    )
  }
  if (renderKindOf(field) === "checkbox") {
    return <BooleanInput source={field.name} label={field.label} />
  }
  // A number edits in a native number input; the value stays a string in the
  // form and is coerced by type on save (coerce), so a cleared nullable
  // number still travels as null, not 0.
  const numeric = field.type === "integer" || field.type === "number"
  return (
    <TextInput
      source={field.name}
      label={field.label}
      validate={validate}
      type={numeric ? "number" : undefined}
      step={field.type === "integer" ? 1 : field.type === "number" ? "any" : undefined}
    />
  )
}

// A declared relation edits with the kit's reference picker: the choices come
// from the data provider's getList on the target cube (the `q` filter scans
// exactly the fields the target's manifest declares searchable), the current
// value's title from getOne. The title field is the target's own metadata
// title (the same derivation every relation surface uses), fetched once per
// session.
export type RelationFieldMetadata = FieldMetadata & {
  relation: { target: string; entity: string; summary: string | null }
}

export function RelationFieldInput({
  field,
  validate,
}: {
  field: RelationFieldMetadata
  validate: unknown
}) {
  const [targetMeta, setTargetMeta] = useState<CubeMetadata | null>(null)
  useEffect(() => {
    let alive = true
    relationMeta(field.relation.target).then((meta) => {
      if (alive) setTargetMeta(meta)
    })
    return () => {
      alive = false
    }
  }, [field.relation.target])

  // The target metadata's title field: the first required field, or nothing
  // (AutocompleteInput then falls back to the record representation).
  const titleField = targetMeta?.fields.find((f) => f.required)
  return (
    <ReferenceInput source={field.name} reference={field.relation.target}>
      <AutocompleteInput
        label={field.label}
        validate={validate as never}
        optionText={titleField ? titleField.name : "id"}
        // An empty input on a nullable relation means "unlink"; qwbe refuses
        // an empty string on a non-nullable one with its own message.
        parse={(value: string) => (value === "" ? null : value)}
      />
    </ReferenceInput>
  )
}
