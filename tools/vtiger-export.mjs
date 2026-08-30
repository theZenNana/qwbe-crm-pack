#!/usr/bin/env node
// The vtiger structural exporter (QWB-50).
//
// Reads from the vtiger MariaDB and writes JSON Lines, one object per active entity row,
// joining crmentity + base table + *cf companion + address block. It streams: the driver
// query runs in stream mode and rows are written as they arrive, so a 74k-row export never
// holds the result set in memory.
//
// Credentials come ONLY from the environment, never hard-coded, never printed:
//   VTIGER_DB_HOST (default 127.0.0.1), VTIGER_DB_PORT (default 3306),
//   VTIGER_DB_USER, VTIGER_DB_PASSWORD, VTIGER_DB_NAME
//
// Two modes:
//   default / --dry-run : prints the SQL, the column list and the row COUNT. No data leaves.
//   --write             : streams the JSONL to /home/lucian/WebProjects/vtiger-export/
//                         and prints ONLY the output path and the row count.
//
// Usage: node tools/vtiger-export.mjs <accounts|contacts> [--write]

import { createWriteStream, mkdirSync } from "node:fs"
import { join } from "node:path"
import mysql from "mysql2/promise"
import { buildQuery, cfColumnQuery, ENTITIES } from "./vtiger-export-query.mjs"

const EXPORT_DIR = "/home/lucian/WebProjects/vtiger-export"

const args = process.argv.slice(2)
const write = args.includes("--write")
const entity = args.find((a) => !a.startsWith("--"))
if (!ENTITIES.includes(entity)) {
  console.error(`usage: node tools/vtiger-export.mjs <${ENTITIES.join("|")}> [--write]`)
  process.exit(2)
}

const cfg = {
  host: process.env.VTIGER_DB_HOST ?? "127.0.0.1",
  port: Number(process.env.VTIGER_DB_PORT ?? 3306),
  user: process.env.VTIGER_DB_USER,
  password: process.env.VTIGER_DB_PASSWORD,
  database: process.env.VTIGER_DB_NAME,
}
if (!cfg.user || !cfg.password || !cfg.database) {
  console.error("set VTIGER_DB_USER, VTIGER_DB_PASSWORD and VTIGER_DB_NAME in the environment")
  process.exit(2)
}

const conn = await mysql.createConnection({ ...cfg, multipleStatements: false })

const [cfRows] = await conn.query(cfColumnQuery(entity))
const cfColumns = cfRows.map((r) => r.Field)
const { sql, countSql, columns } = buildQuery(entity, cfColumns)

const [countRows] = await conn.query(countSql)
const total = Number(countRows[0].n)

console.log(`entity:      ${entity}`)
console.log(`columns:     ${columns.length} (${cfColumns.filter((c) => c !== (entity === "accounts" ? "accountid" : "contactid")).length} cf_*)`)
console.log(`active rows: ${total}`)
if (!write) {
  console.log("--- SQL that a --write run would execute ---")
  console.log(sql)
  console.log("dry run: nothing was written. Pass --write to export.")
  await conn.end()
  process.exit(0)
}

mkdirSync(EXPORT_DIR, { recursive: true })
const outDir = process.env.QWB50_EXPORT_DIR ?? EXPORT_DIR // override used only by the fixture tests
const outPath = join(outDir, `${entity}.jsonl`)
const out = createWriteStream(outPath, { encoding: "utf8" })

// Stream mode: `rowsAsStream` is NOT a mysql2 API (the old call threw TypeError and
// --write never produced a file). The real API is the Readable returned by
// Query.prototype.stream(): rows flow one at a time, nothing accumulates.
const stream = conn.connection.query(sql).stream()
let n = 0
for await (const row of stream) {
  out.write(JSON.stringify(row) + "\n")
  n++
  if (n % 5000 === 0) console.error(`  ... ${n} rows written`)
}
await new Promise((res, rej) => {
  out.end(res)
  out.on("error", rej)
})
console.log(`written: ${outPath}`)
console.log(`rows:    ${n}`)
await conn.end()
