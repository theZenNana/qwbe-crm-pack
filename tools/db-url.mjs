/** Connection URL from the environment; null when neither spelling is set. Never a default. */
export const dbUrl = () => {
  if (process.env.QWBE_DATABASE_URL) return process.env.QWBE_DATABASE_URL
  if (process.env.QWBE_PG_PASSWORD) {
    const u = new URL("postgres://localhost/postgres")
    u.hostname = process.env.QWBE_PG_HOST ?? "localhost"
    u.port = process.env.QWBE_PG_PORT ?? "5433"
    u.username = process.env.QWBE_PG_USER ?? "postgres"
    u.password = process.env.QWBE_PG_PASSWORD
    return u.toString()
  }
  return null
}

/** For tests: the URL object, or a throw when the environment is not set. */
export const requireDbUrl = () => {
  const url = dbUrl()
  if (!url) throw new Error("set QWBE_PG_PASSWORD in the environment (no password default)")
  return new URL(url)
}
