import { NextRequest, NextResponse } from "next/server"

import { loginToQwbe, sessionCookie } from "@/lib/session"

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const result = await loginToQwbe(process.env.QWBE_API_URL ?? "", body.username, body.password)

  if (!result.ok) {
    return NextResponse.json({ error: result.message }, { status: result.status })
  }

  const response = NextResponse.json({ ok: true })
  response.cookies.set(
    sessionCookie(result.token, result.expiresAt, process.env.NODE_ENV === "production"),
  )
  return response
}
