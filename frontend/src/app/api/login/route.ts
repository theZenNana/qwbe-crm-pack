// Plain Request/Response handlers (no next/server imports) so this route can
// be unit tested with node:test and a stubbed fetch.
import {
  loginToQwbe,
  serializeSessionCookie,
  sessionCookie,
} from "../../../lib/session.ts"

export async function POST(request: Request) {
  // CSRF: a cross-site POST could plant an attacker-controlled session
  // cookie in the victim's browser, so only same-origin requests are served.
  const origin = request.headers.get("origin")
  if (origin && origin !== new URL(request.url).origin) {
    return Response.json({ error: "cross-origin request rejected" }, { status: 403 })
  }
  const apiBase = process.env.QWBE_API_URL
  if (!apiBase) {
    return Response.json(
      { error: "server misconfigured: QWBE_API_URL is not set" },
      { status: 500 },
    )
  }
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const result = await loginToQwbe(apiBase, body.username, body.password)

  if (!result.ok) {
    return Response.json({ error: result.message }, { status: result.status })
  }

  const cookie = serializeSessionCookie(
    sessionCookie(result.token, result.expiresAt, process.env.NODE_ENV === "production"),
  )
  // The token goes into the Set-Cookie header only; the body never carries it.
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json", "set-cookie": cookie },
  })
}
