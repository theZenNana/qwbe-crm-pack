import { NextRequest, NextResponse } from "next/server"

import { sessionCookieName } from "@/lib/session"

// Without a session cookie there is nothing worth rendering: every list would
// fetch, take a 401 and stand there empty. One guard for all pages, native to
// the framework, instead of a check repeated in each of them (QWB-54).
export function middleware(request: NextRequest) {
  if (request.cookies.has(sessionCookieName())) return NextResponse.next()
  const login = new URL("/login", request.url)
  login.searchParams.set("next", request.nextUrl.pathname + request.nextUrl.search)
  return NextResponse.redirect(login)
}

export const config = {
  // /api is excluded on purpose: those are fetch() calls, and a redirect to an
  // HTML page would reach the caller as a 200 it cannot parse. The proxy
  // answers 401 there and the browser leaves for /login itself.
  matcher: ["/((?!api/|login|_next/|favicon.ico).*)"],
}
