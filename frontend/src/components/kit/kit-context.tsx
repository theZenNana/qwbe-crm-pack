"use client"

// The scoped ra-core context the kit-based pages live in (QWB-54).
//
// shadcn-admin-kit's components need ra-core's provider tree (data provider,
// query client, i18n and notification contexts) and a react-router context --
// their internals import Link and router hooks. This wrapper provides both
// WITHOUT taking over routing: the MemoryRouter stays inside the subtree, so
// Next's App Router keeps owning the browser URL, and navigation to real pages
// is done by the renderers with Next's own router.
//
// Data flows through qwbeDataProvider over apiFetch: the same-origin proxy
// with the token in its httpOnly cookie. No browser token here.

import { useMemo } from "react"
import { MemoryRouter } from "react-router"
import { CoreAdminContext } from "ra-core"
import { QueryClient } from "@tanstack/react-query"

import { apiFetch } from "@/lib/cube.ts"
import { qwbeDataProvider } from "@/lib/qwbe-data-provider.ts"

export function KitContext({ children }: { children: React.ReactNode }) {
  const dataProvider = useMemo(() => qwbeDataProvider(apiFetch), [])
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      }),
    [],
  )
  return (
    <MemoryRouter>
      <CoreAdminContext dataProvider={dataProvider} queryClient={queryClient}>
        {children}
      </CoreAdminContext>
    </MemoryRouter>
  )
}
