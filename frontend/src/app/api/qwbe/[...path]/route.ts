import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"

import { SESSION_COOKIE, expireSessionCookie, proxyToQwbe } from "@/lib/session"

type Params = { params: Promise<{ path: string[] }> }

// Percent-encoded traversal: a decoded ".." segment would let a caller
// escape the intended qwbe prefix.
function isTraversal(segment: string): boolean {
  try {
    return decodeURIComponent(segment) === ".."
  } catch {
    return true
  }
}

async function handle(request: NextRequest, { params }: Params) {
  const apiBase = process.env.QWBE_API_URL
  if (!apiBase) {
    return new NextResponse("server misconfigured: QWBE_API_URL is not set", {
      status: 500,
    })
  }
  const { path } = await params
  if (path.some(isTraversal)) {
    return new NextResponse("invalid path", { status: 400 })
  }
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  const body = ["GET", "HEAD"].includes(request.method)
    ? null
    : await request.text()

  const result = await proxyToQwbe(
    apiBase,
    // Re-encode each segment: Next's catch-all decoded the raw path, so a
    // percent-encoded %2F inside a segment (a child cube name in the catalog
    // route) arrived as two segments and qwbe's one-segment param lost it.
    `${path.map(encodeURIComponent).join("/")}${request.nextUrl.search}`,
    request.method,
    body,
    token,
    request.headers.get("content-type"),
  )

  const response = new NextResponse(result.body, {
    status: result.status,
    // no-store: an authenticated response body must not be cached.
    headers: {
      "content-type": result.contentType,
      "cache-control": "no-store",
    },
  })
  if (result.clearCookie) {
    response.cookies.set(expireSessionCookie(process.env.NODE_ENV === "production"))
  }
  return response
}

export const GET = handle
export const POST = handle
export const PUT = handle
export const PATCH = handle
export const DELETE = handle
