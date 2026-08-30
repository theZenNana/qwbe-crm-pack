import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"

import { SESSION_COOKIE } from "@/lib/session"

export async function POST(request: NextRequest) {
  // qwbe's /auth/logout deletes the sessions server-side. With an already
  // expired token it answers 401, which is expected and non-fatal: the
  // cookie is cleared either way (external-frontend-auth.md, step 5).
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  const apiBase = process.env.QWBE_API_URL
  if (token && apiBase) {
    await fetch(`${apiBase}/auth/logout`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    }).catch(() => null)
  }
  const response = NextResponse.redirect(new URL("/login", request.url))
  response.cookies.delete(SESSION_COOKIE)
  return response
}
