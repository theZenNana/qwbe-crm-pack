import { cookies } from "next/headers"

import { SESSION_COOKIE } from "@/lib/session"

export type FetchMeResult =
  | { ok: true; me: Record<string, unknown> }
  // expired is true when qwbe answered 401: the cookie is a dead token and
  // must be cleared, not just abandoned.
  | { ok: false; expired: boolean }

// Server-side call to qwbe on behalf of the /me page.
export async function fetchMe(apiBase: string): Promise<FetchMeResult> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  if (!token) return { ok: false, expired: false }
  const res = await fetch(`${apiBase}/auth/me`, {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
  })
  if (!res.ok) return { ok: false, expired: res.status === 401 }
  return { ok: true, me: (await res.json()) as Record<string, unknown> }
}
