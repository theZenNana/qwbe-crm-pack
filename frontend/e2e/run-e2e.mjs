// One command runs everything (QWB-51): npm run e2e
//
// 1. Copies the merged qwbe platform from its repository WITHOUT touching the repository
//    (git archive of origin/main) into /tmp/qwbe-e2e, and installs the crm-pack cubes the
//    way plugins/crm-pack/probes/crm.mjs does (copy under core/plugins/crm-pack).
// 2. Starts qwbe and the Next.js frontend on free ports (never 4500/4510), each with
//    nohup from INSIDE this script, records the PIDs, and polls both URLs with curl-style
//    fetches before any browser step. If either is not up, it stops with a clear message.
// 3. Seeds data through the qwbe API with a real login (idempotent), runs the six Orca
//    scenarios, then tears down: seed rows deleted, servers killed, work directory removed.
// 4. Exits non-zero if any scenario is RED or the stack could not be proven up.

import { execSync, spawnSync } from "node:child_process"
import { createServer } from "node:net"
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"

import { CONFIG, isForbiddenPort, writeResults } from "./lib.mjs"
import { makeClient, seedDown, seedUp } from "./seed.mjs"
import { closeTabs, runAll } from "./scenarios.mjs"

const fail = (msg) => {
  console.error(`\nE2E STOP: ${msg}\n`)
  writeResults([`**STOPPED** — ${msg}`])
  process.exit(2)
}

const log = (m) => console.log(m)

const ORCA_CLI = process.env.ORCA_CLI ?? "/home/lucian/.config/orca/linux-orca-cli-shim/orca"

// --- free ports (never 4500/4510) -------------------------------------------------
const freePort = async () => {
  for (let i = 0; i < 50; i++) {
    const p = await new Promise((resolve) => {
      const srv = createServer()
      srv.on("error", () => resolve(0))
      srv.listen(0, "127.0.0.1", () => {
        const { port } = srv.address()
        srv.close(() => resolve(port))
      })
    })
    if (p && !isForbiddenPort(p)) return p
  }
  fail("could not find a free port")
}

// --- stack startup (nohup from inside this script, PIDs recorded) -----------------
const nohup = (cmd, logfile) => {
  const out = execSync(`nohup ${cmd} > ${logfile} 2>&1 & echo $!`, { encoding: "utf8" })
  return Number(out.trim().split("\n").pop())
}

const poll = async (url, { expect, tries = 60, delay = 1000 }) => {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url)
      if (expect.includes(r.status)) return true
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, delay))
  }
  return false
}

const pids = []
const killStack = () => {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM")
    } catch {
      /* already gone */
    }
  }
  spawnSync("sleep", ["1"])
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      /* already gone */
    }
  }
}

// ---------------------------------------------------------------------------------

log("== QWB-51 e2e: copy the merged platform ==")
if (process.platform !== "linux") fail("this suite drives the Orca desktop app and only runs on the Orca host")
rmSync(CONFIG.workDir, { recursive: true, force: true })
mkdirSync(CONFIG.workDir, { recursive: true })
execSync(`git -C ${CONFIG.qwbeRepo} archive origin/main | tar -x -C ${CONFIG.workDir}`)
// Install the crm-pack cubes the way probes/crm.mjs does: copy the plugin under
// core/plugins/crm-pack. The plugin's node_modules contains a relative qwbe-core symlink
// that pointed at the source checkout; repoint it at THIS copy.
cpSync(CONFIG.crmPack, join(CONFIG.workDir, "core", "plugins", "crm-pack"), {
  recursive: true,
  filter: (src) => !src.includes(`${CONFIG.crmPack}/node_modules/.cache`),
})
const coreLink = join(CONFIG.workDir, "core", "plugins", "crm-pack", "node_modules", "qwbe-core")
if (existsSync(coreLink)) {
  rmSync(coreLink)
  execSync(`ln -s ../../.. ${coreLink}`)
}
log("== install dependencies (qwbe core) ==")
execSync("npm ci --no-audit --no-fund --loglevel=error", { cwd: join(CONFIG.workDir, "core"), stdio: "inherit" })

const qwbePort = CONFIG.qwbePort || (await freePort())
const fePort = CONFIG.frontendPort || (await freePort())
if (isForbiddenPort(qwbePort) || isForbiddenPort(fePort)) fail("picked a forbidden port (4500/4510)")
CONFIG.qwbePort = qwbePort
CONFIG.frontendPort = fePort
const qwbeLog = "/tmp/qwbe-e2e-qwbe.log"
const feLog = "/tmp/qwbe-e2e-frontend.log"

log(`== start qwbe on :${qwbePort} and frontend on :${fePort} (nohup, PIDs recorded) ==`)
pids.push(
  nohup(
    `env QWBE_PORT=${qwbePort} QWBE_DATA_DIR=${CONFIG.dataDir} QWBE_ADMIN_PASSWORD=${CONFIG.password} ` +
      `QWBE_READER_PASSWORD=reader QWBE_MOUNTED=${CONFIG.mounted} ` +
      `QWBE_ALLOWED_ORIGINS=http://localhost:${fePort} node src/main.ts`,
    qwbeLog,
  ),
)
// Frontend runs from THIS repository's frontend/ directory (the code under test).
pids.push(nohup(`env QWBE_API_URL=http://127.0.0.1:${qwbePort} npx next dev -p ${fePort}`, feLog))

log("== prove both servers are up (curl-poll) ==")
const qwbeUp = await poll(`http://127.0.0.1:${qwbePort}/openapi.json`, { expect: [200, 401] })
if (!qwbeUp) fail(`qwbe did not come up on :${qwbePort} — see ${qwbeLog}`)
const feUp = await poll(`http://localhost:${fePort}/login`, { expect: [200], tries: 90 })
if (!feUp) fail(`frontend did not come up on :${fePort} — see ${feLog}`)
log(`both up: qwbe :${qwbePort}, frontend :${fePort}`)

let api
let seed
try {
  log("== seed ==")
  api = await makeClient(qwbePort).catch((e) => fail(`seed could not log in through the qwbe API: ${e.message}`))
  seed = await seedUp(api, log)

  // Orca runtime must be ready before any browser step.
  const status = spawnSync(ORCA_CLI, ["status", "--json"], { encoding: "utf8", timeout: 30_000 })
  let ok = false
  try {
    ok = JSON.parse(status.stdout).result?.runtime?.state === "ready"
  } catch {
    /* unparsable */
  }
  if (!ok) fail(`Orca runtime is not ready (orca status did not report state=ready):\n${status.stdout.slice(0, 400)} ${status.stderr.slice(0, 200)}`)

  log("== scenarios ==")
  let scenarioError = null
  try {
    await runAll(api, seed)
  } catch (e) {
    scenarioError = e
  }
  closeTabs()

  log("== teardown: delete the seed, kill the servers ==")
  await seedDown(api).catch((e) => console.error(`teardown: seed deletion failed: ${e.message}`))
  killStack()
  rmSync(CONFIG.workDir, { recursive: true, force: true })

  const results = writeResults([
    `Stack: qwbe :${qwbePort}, frontend :${fePort} (both proven up before the browser steps).`,
    scenarioError ? `Runner error after scenarios started: ${scenarioError.message}` : "",
  ].filter(Boolean))

  const reds = results.filter((r) => r.verdict !== "PASS")
  if (scenarioError) {
    console.error(`\nE2E FAIL: runner error: ${scenarioError.stack}`)
    process.exit(1)
  }
  if (reds.length > 0) {
    console.error(`\nE2E FAIL: ${reds.length} scenario(s) not PASS`)
    process.exit(1)
  }
  console.log("\nE2E PASS: all scenarios green")
} catch (e) {
  killStack()
  rmSync(CONFIG.workDir, { recursive: true, force: true })
  fail(`unexpected failure: ${e.stack ?? e.message}`)
}


