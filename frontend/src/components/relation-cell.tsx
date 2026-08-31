"use client"

// One relation cell's display text (QWB-54, ticket 11).
//
// The target row's human title, read from the caller's batch-resolved cache
// (use-relation-titles: one request per target cube per page). Until the
// batch lands -- or when it failed, or the row was deleted in between -- the
// raw id shows, exactly the fallback the old per-cell fetch had; the cell
// never blocks the page on it.

import Link from "next/link"

import { hrefForRelation } from "@/lib/cube"

export function RelationCell({
  target,
  id,
  resolve,
}: {
  target: string
  id: string
  // (target, id) -> title, or null while unresolved. Stable across renders;
  // the cache lives in the caller's hook.
  resolve: (target: string, id: string) => string | null
}) {
  const title = resolve(target, id) ?? id
  return <>{title}</>
}

// The link wrapper a relation cell renders under, when this app has a route
// for the target cube. Kept separate from RelationCell so the edit button can
// wrap the same text WITHOUT a link inside it (a link inside a button would
// navigate on the click that should have started the edit).
export function RelationLink({
  target,
  id,
  children,
}: {
  target: string
  id: string
  children: React.ReactNode
}) {
  const href = hrefForRelation(target, id)
  if (!href) return <>{children}</>
  return (
    <Link className="underline" href={href}>
      {children}
    </Link>
  )
}
