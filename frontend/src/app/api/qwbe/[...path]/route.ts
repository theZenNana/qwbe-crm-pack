import { NextRequest, NextResponse } from "next/server"

import { clearedSessionCookie, qwbeFetch } from "@/lib/qwbe"

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

// A thin wrapper over qwbeFetch: this handler only decides what a browser
// request maps to; the token, the header and the dead-session rule live in
// one place (src/lib/qwbe.ts).
async function handle(request: NextRequest, { params }: Params) {
  const { path } = await params
  if (path.some(isTraversal)) {
    return new NextResponse("invalid path", { status: 400 })
  }
  const body = ["GET", "HEAD"].includes(request.method)
    ? null
    : await request.text()

  const result = await qwbeFetch(
    // Re-encode each segment: Next's catch-all decoded the raw path, so a
    // percent-encoded %2F inside a segment (a child cube name in the catalog
    // route) arrived as two segments and qwbe's one-segment param lost it.
    `${path.map(encodeURIComponent).join("/")}${request.nextUrl.search}`,
    {
      method: request.method,
      body,
      contentType: request.headers.get("content-type"),
    },
  )

  const headers: Record<string, string> = {
    "content-type": result.contentType,
    // no-store: an authenticated response body must not be cached.
    "cache-control": "no-store",
  }
  if (result.clearCookie) headers["set-cookie"] = clearedSessionCookie()
  return new NextResponse(result.body, { status: result.status, headers })
}

export const GET = handle
export const POST = handle
export const PUT = handle
export const PATCH = handle
export const DELETE = handle
