#!/usr/bin/env node
// Uploads a vtiger export (JSON Lines) into a qwbe staging set, in chunks (QWB-50).
//
// The chunk contract lives in the staging cube: a chunk is raw TEXT that must end on a
// LINE boundary, one request may hold at most MAX_CHUNK_CHARS (2,000,000) characters, and
// each chunk carries the absolute line number of its first line so malformed lines report
// file lines. This tool reads the file as a stream, buffers whole lines, and posts a chunk
// when the buffer would overflow -- never a partial line, never the whole file in memory.
//
// Environment: QWBE_URL (default http://127.0.0.1:4500), QWBE_USER and QWBE_PASSWORD
// (both required -- the tool exits 2 without them, no default credentials).
//
// Usage: node tools/vtiger-to-staging.mjs <file.jsonl> [setName]
// Prints: the set id, the row count and the malformed count. Never a row value.
// On a failed chunk it prints the absolute line range, the set id and the HTTP status,
// and exits non-zero, so the operator can resume from a known line.

import { createReadStream } from "node:fs"
import { basename } from "node:path"
import { createInterface } from "node:readline"

const file = process.argv[2]
if (!file) {
  console.error("usage: node tools/vtiger-to-staging.mjs <file.jsonl> [setName]")
  process.exit(2)
}
const base = (process.env.QWBE_URL ?? "http://127.0.0.1:4500").replace(/\/$/, "")
for (const name of ["QWBE_USER", "QWBE_PASSWORD"]) {
  if (!process.env[name]) {
    console.error(`set ${name} in the environment (no default credentials)`)
    process.exit(2)
  }
}
const user = process.env.QWBE_USER
const password = process.env.QWBE_PASSWORD

const call = async (path, options = {}) => {
  const r = await fetch(base + path, options)
  const text = await r.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  // Non-2xx: print method, path and status only. A rejected chunk's 400 body embeds the
  // whole chunk text (raw customer rows) -- never echo any part of the response body.
  if (r.status >= 300) throw new Error(`${options.method ?? "GET"} ${path} -> HTTP ${r.status}`)
  return body
}

const login = await call("/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: user, password }),
})
const H = { authorization: `Bearer ${login.token}`, "content-type": "application/json" }

const set = await call("/staging/sets", {
  method: "POST",
  headers: H,
  body: JSON.stringify({
    name: process.argv[3] ?? basename(file).replace(/\.jsonl$/, ""),
    format: "jsonl",
    sourceFile: basename(file),
  }),
})

// 1.9M chars: safely under the cube's 2,000,000-char cap, and always a whole number of lines.
// QWB50_MAX_CHARS exists so the tests can force real chunk boundaries and rejections.
const MAX_CHARS = Number(process.env.QWB50_MAX_CHARS) || 1_900_000
const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity })

let buf = []
let bufChars = 0
let lineNo = 0
let chunkStart = 1
let totalParsed = 0
let totalMalformed = 0
let oversized = 0

const flush = async () => {
  if (buf.length === 0) return
  const text = buf.join("\n")
  const from = chunkStart
  const to = lineNo
  try {
    const res = await call(`/staging/sets/${set.id}/chunks`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ text, startLine: chunkStart }),
    })
    totalParsed += res.parsed ?? 0
    totalMalformed += res.malformed?.length ?? 0
  } catch (err) {
    // A rejected chunk must not abort silently: report the absolute line range and the set
    // id, and exit non-zero so the next attempt can resume from a known line.
    console.error(`chunk FAILED: lines ${from}-${to} (set ${set.id}): ${err.message}`)
    console.error(`resume from line ${from}; nothing after it was uploaded`)
    process.exit(1)
  }
  buf = []
  bufChars = 0
  chunkStart = lineNo + 1
}

for await (const line of rl) {
  lineNo++
  if (line.length + 1 > MAX_CHARS) {
    // A single line over the cap can never be posted: refuse it, count it, keep going.
    oversized++
    continue
  }
  // Flush BEFORE appending: the buffer must never grow past the cap, not by one line.
  if (bufChars + line.length + 1 > MAX_CHARS) await flush()
  buf.push(line)
  bufChars += line.length + 1
}
await flush()

await call(`/staging/sets/${set.id}/finish`, { method: "POST", headers: H })
const state = await call(`/staging/sets/${set.id}`, { headers: H })

console.log(`set id:        ${set.id}`)
console.log(`rows:          ${state.rowCount}`)
console.log(`malformed:     ${state.malformedCount}`)
console.log(`chunks parsed: ${totalParsed} rows, ${totalMalformed} malformed lines counted`)
if (oversized > 0) {
  console.log(`oversized:     ${oversized} single lines larger than the chunk cap were refused, not posted`)
  process.exitCode = 1
}
