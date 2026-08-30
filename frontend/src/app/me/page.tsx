import { redirect } from "next/navigation"

import { Button } from "@/components/ui/button"
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
    <main className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardDescription>Signed in as</CardDescription>
          <CardTitle>{String(me.username ?? "user")}</CardTitle>
        </CardHeader>
        <CardContent>
          <form action="/api/logout" method="post">
            <Button type="submit" variant="outline">
              Log out
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}
