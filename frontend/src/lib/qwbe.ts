// The one place that calls qwbe on behalf of the signed-in person: it reads the
// session cookie, hands the token to proxyToQwbe (the only function that puts
// it in a request header) and reports a dead session through clearCookie, so
// the caller can send the browser to /login instead of painting a 401
// (QWB-54).
// Route handlers and server components both call this; nothing else reads the
// cookie or names the header.
//
// It lives beside session.ts, not inside it, only because `next/headers` cannot
// be imported under `node --test` -- session.ts is the unit-tested half.
import { cookies } from "next/headers"

import {
  SESSION_COOKIE,
  expireSessionCookie,
  proxyToQwbe,
  serializeSessionCookie,
  type ProxyResult,
} from "./session"

export type QwbeRequest = {
  method?: string
  body?: string | null
  contentType?: string | null
}

export async function qwbeFetch(
  path: string,
  request: QwbeRequest = {},
): Promise<ProxyResult> {
  const apiBase = process.env.QWBE_API_URL
  if (!apiBase) {
    return {
      status: 500,
      contentType: "text/plain",
      body: "server misconfigured: QWBE_API_URL is not set",
    }
  }
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  return proxyToQwbe(
    apiBase,
    path,
    request.method ?? "GET",
    request.body ?? null,
    token,
    request.contentType ?? null,
  )
}

// The single Set-Cookie value that clears the session, built from the same
// serializer /api/login writes the cookie with: the two agree by construction
// instead of by convention.
export function clearedSessionCookie(): string {
  return serializeSessionCookie(expireSessionCookie(process.env.NODE_ENV === "production"))
}
