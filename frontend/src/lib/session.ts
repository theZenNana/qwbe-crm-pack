// Session and proxy logic for the CRM frontend, kept free of framework
// imports so it can be unit tested with a stubbed fetch (QWB-48).
// Follows qwbe docs/external-frontend-auth.md: the browser never sees the
// token; it lives in an httpOnly cookie and qwbe is called server-side only.

export const SESSION_COOKIE = "qwbe_session"
export const COOKIE_PATH = "/api"

export type SessionCookieOptions = {
  name: string
  value: string
  httpOnly: true
  sameSite: "lax"
  secure: boolean
  path: string
  expires: Date
}

export function sessionCookie(
  token: string,
  expiresAt: string,
  production = false,
): SessionCookieOptions {
  return {
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: production,
    path: COOKIE_PATH,
    expires: new Date(expiresAt),
  }
}

export type LoginResult =
  | { ok: true; token: string; expiresAt: string }
  | { ok: false; status: number; message: string }

export async function loginToQwbe(
  apiBase: string,
  username: unknown,
  password: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<LoginResult> {
  if (typeof username !== "string" || typeof password !== "string") {
    return { ok: false, status: 400, message: "username and password are required" }
  }
  const res = await fetchImpl(`${apiBase}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null
    return {
      ok: false,
      status: res.status,
      message: body?.message ?? `login failed with status ${res.status}`,
    }
  }
  const body = (await res.json()) as { token?: string; expiresAt?: string }
  if (typeof body.token !== "string" || typeof body.expiresAt !== "string") {
    return { ok: false, status: 502, message: "unexpected login response from qwbe" }
  }
  return { ok: true, token: body.token, expiresAt: body.expiresAt }
}

export type ProxyResult = {
  status: number
  contentType: string
  body: string
  // Set when qwbe answered 401: the caller must send the browser to /login.
  redirect?: string
  clearCookie?: boolean
}

// Forwards one request to qwbe with the Authorization header taken from the
// session cookie. A 401 from qwbe becomes a redirect to the login page.
export async function proxyToQwbe(
  apiBase: string,
  path: string,
  method: string,
  body: string | null,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<ProxyResult> {
  if (!token) {
    return { status: 401, contentType: "text/plain", body: "", redirect: "/login", clearCookie: true }
  }
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
  }
  if (body !== null) headers["content-type"] = "application/json"
  const res = await fetchImpl(`${apiBase}/${path}`, { method, headers, body })
  const resBody = await res.text()
  if (res.status === 401) {
    return { status: 401, contentType: "text/plain", body: "", redirect: "/login", clearCookie: true }
  }
  return {
    status: res.status,
    contentType: res.headers.get("content-type") ?? "application/json",
    body: resBody,
  }
}
