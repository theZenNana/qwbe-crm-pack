import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"

import { POST } from "./route.ts"

const realFetch = globalThis.fetch

function loginRequest(body: unknown, origin = "http://localhost:3000") {
  return new Request("http://localhost:3000/api/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  })
}

afterEach(() => {
  globalThis.fetch = realFetch
})

function stubQwbeLogin() {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ token: "tok-1", expiresAt: "2099-01-01T00:00:00Z" }), {
      status: 200,
    })) as unknown as typeof fetch
}

describe("POST /api/login", () => {
  it("answers with a token-free body and puts the token in a per-instance Set-Cookie", async () => {
    // With a port on the API base the cookie name carries it: two stacks on
    // localhost must not share one session cookie (QWB-54).
    process.env.QWBE_API_URL = "http://127.0.0.1:4500"
    stubQwbeLogin()
    const res = await POST(loginRequest({ username: "u", password: "p" }))
    assert.equal(res.status, 200)
    const body = (await res.json()) as { ok?: boolean; token?: string }
    assert.equal(body.ok, true)
    assert.equal(body.token, undefined)
    assert.ok(!JSON.stringify(body).includes("tok-1"))
    const setCookie = res.headers.get("set-cookie") ?? ""
    assert.ok(setCookie.includes("qwbe_session_4500=tok-1"))
    assert.ok(setCookie.includes("HttpOnly"))
  })

  it("rejects a cross-origin request with 403", async () => {
    process.env.QWBE_API_URL = "http://qwbe.test"
    let called = false
    globalThis.fetch = (async () => {
      called = true
      return new Response("", { status: 200 })
    }) as unknown as typeof fetch
    const res = await POST(
      loginRequest({ username: "u", password: "p" }, "http://evil.test"),
    )
    assert.equal(res.status, 403)
    assert.equal(called, false)
  })

  it("answers 500 naming QWBE_API_URL when it is not configured", async () => {
    delete process.env.QWBE_API_URL
    const res = await POST(loginRequest({ username: "u", password: "p" }))
    assert.equal(res.status, 500)
    const body = (await res.json()) as { error?: string }
    assert.ok(body.error?.includes("QWBE_API_URL"))
  })
})
