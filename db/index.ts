/**
 * SQLite connection, migration runner and low-level helpers.
 *
 * SQLite rather than PostgreSQL: one private user, modest volume, and the
 * database has to survive being mounted as a single Docker volume later.
 * better-sqlite3 rather than node:sqlite because node:sqlite is still flagged
 * experimental on Node 22 and warns that its API may change.
 */

import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import Database from "better-sqlite3"

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const MIGRATIONS_DIR = path.join(ROOT, "db", "migrations")

export const DEFAULT_DB_PATH = path.join(ROOT, "data", "travel-radar.db")

export type DB = Database.Database

let cached: DB | null = null
let cachedPath: string | null = null

function resolveDbPath(explicit?: string): string {
  const configured = explicit || process.env.DATABASE_PATH
  if (!configured) return DEFAULT_DB_PATH
  return path.isAbsolute(configured) ? configured : path.resolve(ROOT, configured)
}

/**
 * Apply any migration files not yet recorded, inside a transaction each.
 * Files are applied in filename order; the applied set lives in the database so
 * the same file is never run twice.
 */
export function migrate(db: DB): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name       TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`)

  const applied = new Set(
    db.prepare("SELECT name FROM schema_migrations").all().map((r: any) => r.name as string)
  )

  const files = fs.existsSync(MIGRATIONS_DIR)
    ? fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith(".sql")).sort()
    : []

  const ran: string[] = []
  for (const file of files) {
    if (applied.has(file)) continue
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8")
    const tx = db.transaction(() => {
      db.exec(sql)
      db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)")
        .run(file, new Date().toISOString())
    })
    tx()
    ran.push(file)
  }
  return ran
}

/**
 * Open (or reuse) the database. WAL keeps readers from blocking the writer, and
 * busy_timeout makes concurrent writers wait rather than fail — two search
 * processes bumping the same usage counter is expected, not exceptional.
 */
export function getDb(explicitPath?: string): DB {
  const dbPath = resolveDbPath(explicitPath)
  if (cached && cachedPath === dbPath) return cached

  fs.mkdirSync(path.dirname(dbPath), { recursive: true })

  const db = new Database(dbPath)
  db.pragma("journal_mode = WAL")
  db.pragma("busy_timeout = 5000")
  db.pragma("foreign_keys = ON")
  db.pragma("synchronous = NORMAL")

  migrate(db)

  cached = db
  cachedPath = dbPath
  return db
}

/** Close the shared handle. Used by tests and by clean shutdown. */
export function closeDb(): void {
  if (cached) {
    try { cached.close() } catch { /* already closed */ }
  }
  cached = null
  cachedPath = null
}

/** Open a throwaway in-memory database with the schema applied — for tests. */
export function createMemoryDb(): DB {
  const db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  migrate(db)
  return db
}

export function nowIso(): string {
  return new Date().toISOString()
}

/** Current accounting period, YYYY-MM. */
export function currentPeriod(at: Date = new Date()): string {
  return at.toISOString().slice(0, 7)
}
