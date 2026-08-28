#!/usr/bin/env tsx
/**
 * The migration's before-and-after proof: is this database intact, and what is
 * in it?
 *
 * Run on the Windows copy before it travels and on the NAS copy after it
 * lands. Two matching outputs - `integrity_check: ok` and identical row counts
 * - are what "safely migrated" means; anything less is a feeling.
 *
 * Read-only by construction: the database is opened with SQLITE_OPEN_READONLY,
 * so this can be pointed at a live file or a backup without becoming another
 * writer.
 */

import Database from "better-sqlite3"
import fs from "fs"

const target = process.argv[2] || process.env.DATABASE_PATH || "data/travel-radar.db"

if (!fs.existsSync(target)) {
  console.error(`❌ no database at ${target}`)
  process.exit(1)
}

const db = new Database(target, { readonly: true })

const integrity = (db.prepare("PRAGMA integrity_check").get() as any).integrity_check
const foreignKeys = db.prepare("PRAGMA foreign_key_check").all()

// Every table the deployment brief names as must-be-preserved, plus the ledger
// that proves the schema itself came across.
const TABLES = [
  "flight_prices", "award_prices", "search_requests", "search_cache",
  "observation_jobs", "observation_runs",
  "discovery_jobs", "discovery_runs",
  "open_jaw_pairs", "candidate_clusters", "deal_candidates", "deal_feedback",
  "notifications", "notification_queue", "notification_events",
  "balance_snapshots", "provider_usage", "provider_events",
  "schema_migrations",
]

console.log(`database          ${target}`)
console.log(`size              ${(fs.statSync(target).size / 1e6).toFixed(1)} MB`)
console.log(`integrity_check   ${integrity}`)
console.log(`foreign_key_check ${foreignKeys.length === 0 ? "ok" : `${foreignKeys.length} VIOLATION(S)`}`)
console.log("")

for (const table of TABLES) {
  try {
    const count = (db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as any).c
    console.log(`  ${table.padEnd(22)} ${count}`)
  } catch {
    console.log(`  ${table.padEnd(22)} (table missing)`)
  }
}

const migrations = db.prepare("SELECT name FROM schema_migrations ORDER BY name").all() as { name: string }[]
console.log(`\nmigrations: ${migrations.map(m => m.name.split("_")[0]).join(" ")}`)

db.close()

if (integrity !== "ok" || foreignKeys.length > 0) {
  console.error("\n❌ this database is NOT sound - do not migrate it, and do not start on it")
  process.exit(1)
}
console.log("\n✅ sound")
