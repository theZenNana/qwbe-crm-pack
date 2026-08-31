import { NextRequest, NextResponse } from "next/server"

import { clearedSessionCookie, qwbeFetch } from "@/lib/qwbe"

function redirectToLogin(request: NextRequest) {
  // 303 so the browser switches to GET: a 307 would keep the POST method and
  // the /login page would answer 405.
  const response = NextResponse.redirect(new URL("/login", request.url), 303)
  response.headers.set("set-cookie", clearedSessionCookie())
  return response
}

// Normal logout: end the qwbe session, then clear the cookie.
export async function POST(request: NextRequest) {
  // qwbe's /auth/logout deletes the sessions server-side. With an already
  // expired token it answers 401, which is expected and non-fatal: the
  // cookie is cleared either way (external-frontend-auth.md, step 5).
  await qwbeFetch("auth/logout", { method: "POST" }).catch(() => null)
  return redirectToLogin(request)
}

// Called from a server component that saw a 401: the token is already dead and
// a server component cannot write a cookie, so this clears it and sends the
// browser to /login.
export async function GET(request: NextRequest) {
  return redirectToLogin(request)
}
