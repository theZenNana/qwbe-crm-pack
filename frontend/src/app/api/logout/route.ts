import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"

import { SESSION_COOKIE, expireSessionCookie } from "@/lib/session"

function withExpiredCookie(response: NextResponse) {
  // Set an expired cookie with the same name and path instead of delete():
  // delete() emits Path=/ which does not match the stored cookie.
  response.cookies.set(expireSessionCookie(process.env.NODE_ENV === "production"))
}

function redirectToLogin(request: NextRequest) {
  // 303 so the browser switches to GET: a 307 would keep the POST method and
  // the /login page would answer 405.
  return NextResponse.redirect(new URL("/login", request.url), 303)
}

// Normal logout: end the qwbe session, then clear the cookie.
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
  const response = redirectToLogin(request)
  withExpiredCookie(response)
  return response
}

// Called from /me when qwbe answered 401: the token is already dead, so just
// clear the cookie and send the browser to /login.
export async function GET(request: NextRequest) {
  const response = redirectToLogin(request)
  withExpiredCookie(response)
  return response
}
