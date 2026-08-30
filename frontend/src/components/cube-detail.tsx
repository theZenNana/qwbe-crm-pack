"use client"

// The detail page body, assembled from the same cube metadata as the list
// (QWB-49). One block per published field: label, value, with a link for a
// filled relation. Optional child lists (for example the derived contacts of
// one organization) reuse the generic CubeList with a pinned filter.

import Link from "next/link"
import { useEffect, useState } from "react"

import {
  type CubeMetadata,
  type Row,
  cubeApiPath,
  hrefForRelation,
  metadataApiPath,
  routeOf,
  titleOf,
} from "@/lib/cube"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { CubeList } from "@/components/cube-list"

export type ChildList = {
  // The cube the child rows live in, e.g. "crm/contacts".
  cube: string
  // The field on the child that points back to this row, e.g. "accountId".
  field: string
  label?: string
}

export function CubeDetail({
  cube,
  id,
  childLists = [],
}: {
  cube: string
  id: string
  childLists?: ChildList[]
}) {
  const [meta, setMeta] = useState<CubeMetadata | null>(null)
  const [row, setRow] = useState<Row | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    Promise.all([
      fetch(metadataApiPath(cube)).then(async (r) => {
        if (!r.ok) throw new Error(`metadata request failed: ${r.status}`)
        return (await r.json()) as CubeMetadata
      }),
      fetch(cubeApiPath(cube, `/${id}`)).then(async (r) => {
        if (!r.ok) throw new Error(`row request failed: ${r.status}`)
        return (await r.json()) as Row
      }),
    ])
      .then(([m, r]) => {
        if (alive) {
          setMeta(m)
          setRow(r)
        }
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      alive = false
    }
  }, [cube, id])

  if (error) return <p role="alert">{error}</p>
  if (!meta || !row) return <Skeleton className="h-64 w-full" />

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{titleOf(meta, row)}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col">
          {meta.fields.map((field, index) => {
            const value = row[field.name]
            return (
              <div key={field.name}>
                {index > 0 && <Separator />}
                <div className="grid grid-cols-[10rem_1fr] gap-2 py-2 text-sm">
                  <span className="text-muted-foreground">{field.label}</span>
                  <span>
                    {field.relation &&
                     value !== null &&
                     value !== undefined &&
                     hrefForRelation(field.relation.target, String(value)) ? (
                      <Link
                        className="underline"
                        href={hrefForRelation(field.relation.target, String(value))!}
                      >
                        {String(value)}
                      </Link>
                    ) : field.type === "boolean" ? (
                      value ? (
                        "yes"
                      ) : (
                        "no"
                      )
                    ) : (
                      (value ?? "—")?.toString()
                    )}
                  </span>
                </div>
              </div>
            )
          })}
        </CardContent>
      </Card>
      {childLists.map((child) => (
        <section key={child.cube} className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">{child.label ?? child.cube}</h2>
          <CubeList cube={child.cube} fixedFilters={{ [child.field]: id }} />
          <Link className="text-sm underline" href={routeOf(child.cube)}>
            All rows
          </Link>
        </section>
      ))}
    </div>
  )
}
