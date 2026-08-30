import { redirect } from "next/navigation"

import { Button } from "@/components/ui/button"

import { fetchMe } from "./fetch-me"

export default async function MePage() {
  const apiBase = process.env.QWBE_API_URL
  const me = apiBase ? await fetchMe(apiBase) : null
  if (!me) redirect("/login")

  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <div className="flex flex-col items-center gap-2 text-center">
        <p className="text-muted-foreground text-sm">Signed in as</p>
        <h1 className="text-2xl font-semibold">
          {String(me.username ?? JSON.stringify(me))}
        </h1>
        <form action="/api/logout" method="post">
          <Button type="submit" variant="outline" className="mt-4">
            Log out
          </Button>
        </form>
      </div>
    </main>
  )
}
