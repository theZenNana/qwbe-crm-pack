import { cookies } from "next/headers"

import { SESSION_COOKIE } from "@/lib/session"

// Server-side call to qwbe on behalf of the /me page. Returns null when the
// session is missing or expired, so the page can redirect to /login.
export async function fetchMe(apiBase: string): Promise<Record<string, unknown> | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  if (!token) return null
  const res = await fetch(`${apiBase}/auth/me`, {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
  })
  if (!res.ok) return null
  return (await res.json()) as Record<string, unknown>
}
