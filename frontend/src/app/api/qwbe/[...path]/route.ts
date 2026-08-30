import { cookies } from "next/headers"
import { NextRequest, NextResponse } from "next/server"

import { SESSION_COOKIE, proxyToQwbe } from "@/lib/session"

type Params = { params: Promise<{ path: string[] }> }

async function handle(request: NextRequest, { params }: Params) {
  const { path } = await params
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  const body = ["GET", "HEAD"].includes(request.method)
    ? null
    : await request.text()

  const result = await proxyToQwbe(
    process.env.QWBE_API_URL ?? "",
    path.join("/"),
    request.method,
    body,
    token,
  )

  if (result.redirect) {
    const response = NextResponse.redirect(new URL(result.redirect, request.url))
    if (result.clearCookie) response.cookies.delete(SESSION_COOKIE)
    return response
  }
  return new NextResponse(result.body, {
    status: result.status,
    headers: { "content-type": result.contentType },
  })
}

export const GET = handle
export const POST = handle
export const PUT = handle
export const PATCH = handle
export const DELETE = handle
