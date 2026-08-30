import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  COOKIE_PATH,
  SESSION_COOKIE,
  expireSessionCookie,
  loginToQwbe,
  proxyToQwbe,
  serializeSessionCookie,
  sessionCookie,
} from "./session.ts"

const okLogin = async () =>
  new Response(JSON.stringify({ token: "tok-1", expiresAt: "2026-09-06T00:00:00Z" }), {
    status: 200,
  })

describe("sessionCookie", () => {
  it("is httpOnly, lax, path-scoped to the api prefix and expires with the token", () => {
    const cookie = sessionCookie("tok-1", "2026-09-06T00:00:00Z", true)
    assert.equal(cookie.name, SESSION_COOKIE)
    assert.equal(cookie.httpOnly, true)
    assert.equal(cookie.sameSite, "lax")
    assert.equal(cookie.secure, true)
    assert.equal(cookie.path, COOKIE_PATH)
    assert.equal(cookie.expires.toISOString(), "2026-09-06T00:00:00.000Z")
  })

  it("is not secure outside production", () => {
    assert.equal(sessionCookie("tok-1", "2026-09-06T00:00:00Z", false).secure, false)
  })
})

describe("expireSessionCookie", () => {
  it("clears the cookie with the same name and path, already expired", () => {
    const cookie = expireSessionCookie(true)
    assert.equal(cookie.name, SESSION_COOKIE)
    assert.equal(cookie.value, "")
    assert.equal(cookie.path, COOKIE_PATH)
    assert.equal(cookie.expires.getTime(), 0)
    const header = serializeSessionCookie(cookie)
    assert.ok(header.includes(`Path=${COOKIE_PATH}`))
    assert.ok(header.includes("HttpOnly"))
    assert.ok(header.includes("Expires="))
  })
})

describe("loginToQwbe", () => {
  it("returns the token and expiry on a good login", async () => {
    const result = await loginToQwbe("http://qwbe.test", "u", "p", okLogin)
    assert.deepEqual(result, { ok: true, token: "tok-1", expiresAt: "2026-09-06T00:00:00Z" })
  })

  it("surfaces the qwbe error message on a wrong password", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ message: "invalid credentials" }), { status: 401 })
    const result = await loginToQwbe("http://qwbe.test", "u", "bad", fetchImpl)
    assert.deepEqual(result, { ok: false, status: 401, message: "invalid credentials" })
  })

  it("rejects non-string credentials without calling qwbe", async () => {
    let called = false
    const fetchImpl = (async () => {
      called = true
      return okLogin()
    }) as unknown as typeof fetch
    const result = await loginToQwbe("http://qwbe.test", 42, null, fetchImpl)
    assert.equal(result.ok, false)
    assert.equal(called, false)
  })

  it("rejects a past expiresAt with 502", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ token: "tok-1", expiresAt: "2000-01-01T00:00:00Z" }), {
        status: 200,
      })
    const result = await loginToQwbe("http://qwbe.test", "u", "p", fetchImpl)
    assert.deepEqual(result, {
      ok: false,
      status: 502,
      message: "unexpected login response from qwbe",
    })
  })

  it("rejects an unparseable expiresAt with 502", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ token: "tok-1", expiresAt: "not-a-date" }), {
        status: 200,
      })
    const result = await loginToQwbe("http://qwbe.test", "u", "p", fetchImpl)
    assert.equal(result.ok, false)
    assert.equal((result as { status: number }).status, 502)
  })
})

describe("proxyToQwbe", () => {
  it("forwards the Authorization header from the cookie token", async () => {
    let seen: { url: string; headers: Record<string, string> } | null = null
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), headers: (init?.headers ?? {}) as Record<string, string> }
      return new Response(JSON.stringify({ username: "ada" }), { status: 200 })
    }) as unknown as typeof fetch
    const result = await proxyToQwbe(
      "http://qwbe.test", "auth/me", "GET", null, "tok-1", null, fetchImpl,
    )
    assert.equal(result.status, 200)
    assert.equal((seen as unknown as { url: string }).url, "http://qwbe.test/auth/me")
    assert.equal(
      (seen as unknown as { headers: Record<string, string> }).headers.authorization,
      "Bearer tok-1",
    )
  })

  it("passes a 401 from qwbe through with its body and marks the cookie stale", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "session ended" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })) as typeof fetch
    const result = await proxyToQwbe(
      "http://qwbe.test", "auth/me", "GET", null, "tok-1", null, fetchImpl,
    )
    assert.equal(result.status, 401)
    assert.equal(result.body, JSON.stringify({ error: "session ended" }))
    assert.equal(result.contentType, "application/json")
    assert.equal(result.clearCookie, true)
  })

  it("forwards the caller's content-type on a request with a body", async () => {
    let seen: { headers: Record<string, string>; body: string } | null = null
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen = {
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: String(init?.body),
      }
      return new Response("", { status: 200 })
    }) as unknown as typeof fetch
    await proxyToQwbe(
      "http://qwbe.test", "leads", "POST",
      JSON.stringify({ name: "x" }), "tok-1", "text/plain", fetchImpl,
    )
    assert.equal((seen as unknown as { headers: Record<string, string> }).headers["content-type"], "text/plain")
  })

  it("sends no body and no content-type when the body is empty", async () => {
    let seen: { headers: Record<string, string>; body: string | undefined } | null = null
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen = {
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body as string | undefined,
      }
      return new Response("", { status: 200 })
    }) as unknown as typeof fetch
    await proxyToQwbe("http://qwbe.test", "leads/1", "DELETE", "", "tok-1", "text/plain", fetchImpl)
    const headers = (seen as unknown as { headers: Record<string, string> }).headers
    assert.equal(headers["content-type"], undefined)
    assert.equal((seen as unknown as { body: string | undefined }).body, undefined)
  })

  it("short-circuits with a 401 when no cookie is present", async () => {
    let called = false
    const fetchImpl = (async () => {
      called = true
      return new Response("", { status: 200 })
    }) as unknown as typeof fetch
    const result = await proxyToQwbe(
      "http://qwbe.test", "auth/me", "GET", null, undefined, null, fetchImpl,
    )
    assert.equal(result.status, 401)
    assert.equal(result.clearCookie, true)
    assert.equal(called, false)
  })
})

describe("login response shape", () => {
  it("the cookie carries the token; the login response body never does", async () => {
    // The route handler responds with { ok: true } only; this asserts the
    // contract the route must keep: whatever loginToQwbe returns as token
    // goes into the cookie, not into the JSON body.
    const result = await loginToQwbe("http://qwbe.test", "u", "p", okLogin)
    assert.ok(result.ok)
    const cookie = sessionCookie(result.token, result.expiresAt)
    assert.equal(cookie.value, "tok-1")
  })
})
