// Drops a throwaway test database only once its last backend is really gone (QWB-72).
//
// pg-pool's end() resolves before the client socket has closed, so a DROP DATABASE ... WITH (FORCE)
// issued straight after it races the file's OWN closing backend. When FORCE wins, the FATAL
// "terminating connection due to administrator command" lands on the still-open socket, the pool
// emits 'error' with nobody listening, and node:test reports the file as "test failed" after every
// test in it passed -- only under load (the full suite), never when the file runs alone.
// Waiting for pg_stat_activity to drain removes the race; FORCE stays only as the last resort.

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

export const dropThrowawayDb = async (admin, dbName) => {
  for (let i = 0; i < 40; i++) {
    const r = await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1`, [dbName])
    if (r.rows[0].n === 0) break
    await wait(50)
  }
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
}
