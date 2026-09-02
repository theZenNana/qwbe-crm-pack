// Session and proxy logic for the CRM frontend, kept free of framework
// imports so it can be unit tested with a stubbed fetch.
// Follows qwbe docs/external-frontend-auth.md: the browser never sees the
// token; it lives in an httpOnly cookie and qwbe is called server-side only.

// Path "/" so the browser also sends the cookie to pages (for example /me),
// not only to the /api route handlers that read it.
export const COOKIE_PATH = "/"

// The host this request was addressed to, proxies included.
export const hostOf = (headers: { get(name: string): string | null }): string | null =>
  headers.get("x-forwarded-host") ?? headers.get("host")

// Browsers do not scope cookies by port; the port comes from the request host,
// not the API URL, so two frontends on localhost keep separate sessions.
export const sessionCookieName = (host: string | null | undefined): string => {
  const port = host?.match(/:(\d+)$/)?.[1]
  return port ? `qwbe_session_${port}` : "qwbe_session"
}

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
  host: string | null = null,
): SessionCookieOptions {
  // loginToQwbe already rejects a past or unparseable expiresAt; this is a
  // last guard so an invalid date never reaches a Set-Cookie header.
  const t = Date.parse(expiresAt)
  if (!Number.isFinite(t) || t <= Date.now()) {
    throw new Error(`invalid session expiry: ${expiresAt}`)
  }
  return {
    name: sessionCookieName(host),
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: production,
    path: COOKIE_PATH,
    expires: new Date(expiresAt),
  }
}

// Cookie options that clear an existing session cookie on the next response:
// same name and path, empty value, already expired.
export function expireSessionCookie(
  production = false,
  host: string | null = null,
): SessionCookieOptions {
  return {
    name: sessionCookieName(host),
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: production,
    path: COOKIE_PATH,
    expires: new Date(0),
  }
}

// Serializes cookie options into a Set-Cookie header value. Kept here so the
// route handlers stay thin and the format is unit tested.
export function serializeSessionCookie(options: SessionCookieOptions): string {
  const parts = [
    `${options.name}=${options.value}`,
    `Path=${options.path}`,
    "HttpOnly",
    "SameSite=Lax",
    `Expires=${options.expires.toUTCString()}`,
  ]
  if (options.secure) parts.push("Secure")
  return parts.join("; ")
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
  const expires = Date.parse(body.expiresAt ?? "")
  if (
    typeof body.token !== "string" ||
    typeof body.expiresAt !== "string" ||
    !Number.isFinite(expires) ||
    expires <= Date.now()
  ) {
    return { ok: false, status: 502, message: "unexpected login response from qwbe" }
  }
  return { ok: true, token: body.token, expiresAt: body.expiresAt }
}

export type ProxyResult = {
  status: number
  contentType: string
  body: string
  // Set on a 401 so the caller can expire the stale session cookie on the
  // way out. The 401 itself is passed through to the client.
  clearCookie?: boolean
}

// Forwards one request to qwbe with the Authorization header taken from the
// session cookie. A 401 from qwbe is passed through with its body so the
// client can detect the dead session (docs/external-frontend-auth.md, step 4).
export async function proxyToQwbe(
  apiBase: string,
  path: string,
  method: string,
  body: string | null,
  token: string | undefined,
  contentType: string | null = null,
  fetchImpl: typeof fetch = fetch,
): Promise<ProxyResult> {
  if (!token) {
    return { status: 401, contentType: "text/plain", body: "", clearCookie: true }
  }
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
  }
  // An empty body (for example a bodyless DELETE) is forwarded as no body
  // and with no content-type at all.
  const hasBody = body !== null && body !== ""
  if (hasBody) headers["content-type"] = contentType ?? "application/json"
  const res = await fetchImpl(`${apiBase}/${path}`, {
    method,
    headers,
    body: hasBody ? body : undefined,
  })
  const resBody = await res.text()
  if (res.status === 401) {
    return {
      status: 401,
      contentType: res.headers.get("content-type") ?? "text/plain",
      body: resBody,
      clearCookie: true,
    }
  }
  return {
    status: res.status,
    contentType: res.headers.get("content-type") ?? "application/json",
    body: resBody,
  }
}
