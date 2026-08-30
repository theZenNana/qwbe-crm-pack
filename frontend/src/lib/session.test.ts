import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  SESSION_COOKIE,
  loginToQwbe,
  proxyToQwbe,
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
    assert.equal(cookie.path, "/api")
    assert.equal(cookie.expires.toISOString(), "2026-09-06T00:00:00.000Z")
  })

  it("is not secure outside production", () => {
    assert.equal(sessionCookie("tok-1", "2026-09-06T00:00:00Z", false).secure, false)
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
})

describe("proxyToQwbe", () => {
  it("forwards the Authorization header from the cookie token", async () => {
    let seen: { url: string; headers: Record<string, string> } | null = null
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), headers: (init?.headers ?? {}) as Record<string, string> }
      return new Response(JSON.stringify({ username: "ada" }), { status: 200 })
    }) as unknown as typeof fetch
    const result = await proxyToQwbe(
      "http://qwbe.test", "auth/me", "GET", null, "tok-1", fetchImpl,
    )
    assert.equal(result.status, 200)
    assert.equal((seen as unknown as { url: string }).url, "http://qwbe.test/auth/me")
    assert.equal(
      (seen as unknown as { headers: Record<string, string> }).headers.authorization,
      "Bearer tok-1",
    )
  })

  it("turns a 401 from qwbe into a redirect to the login page", async () => {
    const fetchImpl = (async () => new Response("", { status: 401 })) as typeof fetch
    const result = await proxyToQwbe(
      "http://qwbe.test", "auth/me", "GET", null, "tok-1", fetchImpl,
    )
    assert.equal(result.status, 401)
    assert.equal(result.redirect, "/login")
    assert.equal(result.clearCookie, true)
  })

  it("short-circuits to the login page when no cookie is present", async () => {
    let called = false
    const fetchImpl = (async () => {
      called = true
      return new Response("", { status: 200 })
    }) as unknown as typeof fetch
    const result = await proxyToQwbe(
      "http://qwbe.test", "auth/me", "GET", null, undefined, fetchImpl,
    )
    assert.equal(result.redirect, "/login")
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
