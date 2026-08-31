import { redirect } from "next/navigation"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

import { fetchMe } from "./fetch-me"

function ConfigError() {
  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Server configuration error</CardTitle>
          <CardDescription>
            QWBE_API_URL is not set; the identity of the signed-in user cannot
            be verified.
          </CardDescription>
        </CardHeader>
      </Card>
    </main>
  )
}

export default async function MePage() {
  const apiBase = process.env.QWBE_API_URL
  if (!apiBase) return <ConfigError />

  const result = await fetchMe(apiBase)
  if (!result.ok) {
    // A dead token rides on every /api call until it is cleared, so an
    // expired session goes through the logout handler (GET clears the
    // cookie) before landing on /login.
    redirect(result.expired ? "/api/logout" : "/login")
  }
  const me = result.me

  return (
    // flex-1, not min-h-svh: the nav above is part of the page now, and a full
    // viewport height under it would push the card below the fold.
    <main className="flex flex-1 items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardDescription>Signed in as</CardDescription>
          <CardTitle>{String(me.username ?? "user")}</CardTitle>
        </CardHeader>
        <CardContent>
          {/* Logging out lives in the nav, on every page. A second button here
              would say the same thing twice, and leave two controls with the
              same accessible name for anyone reading the page by name. */}
          <p className="text-sm text-muted-foreground">
            Your qwbe account, as this app sees it.
          </p>
        </CardContent>
      </Card>
    </main>
  )
}
