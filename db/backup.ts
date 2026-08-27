/**
 * §AC - local SQLite backups.
 *
 * The observation history is becoming the most valuable thing in this project:
 * cache entries can be refetched, a year of "what this radar saw" cannot. Once
 * the observer runs unattended, a corrupt page or a bad migration would take
 * that with it.
 *
 * This uses better-sqlite3's online backup API rather than copying the file.
 * Copying a WAL-mode database while a scheduler is mid-write yields a file that
 * looks fine and restores wrong; the backup API takes a consistent snapshot of
 * a live database, checkpointing WAL content into it.
 *
 * Local only. No cloud, no encryption, no off-site copy - those are separate
 * decisions, and the NAS move is where they belong.
 */

import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import type { DB } from "./index.js"

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

export function backupDir(): string {
  const configured = process.env.BACKUP_DIR
  if (!configured) return path.join(ROOT, "data", "backups")
  return path.isAbsolute(configured) ? configured : path.resolve(ROOT, configured)
}

export function backupRetention(): number {
  const raw = Number(process.env.BACKUP_RETENTION)
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 14
}

export function backupIntervalHours(): number {
  const raw = Number(process.env.BACKUP_INTERVAL_HOURS)
  return Number.isFinite(raw) && raw > 0 ? raw : 24
}

export interface BackupFile {
  file: string
  path: string
  bytes: number
  createdAt: string
}

/** Existing backups, newest first. */
export function listBackups(dir = backupDir()): BackupFile[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter(f => f.startsWith("travel-radar-") && f.endsWith(".db"))
    .map(f => {
      const full = path.join(dir, f)
      const stat = fs.statSync(full)
      return { file: f, path: full, bytes: stat.size, createdAt: stat.mtime.toISOString() }
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** Delete everything past the retention count. Returns what was removed. */
export function pruneBackups(retention = backupRetention(), dir = backupDir()): string[] {
  const removed: string[] = []
  for (const backup of listBackups(dir).slice(retention)) {
    try {
      fs.unlinkSync(backup.path)
      removed.push(backup.file)
    } catch { /* a locked or already-deleted file is not worth failing over */ }
  }
  return removed
}

export interface BackupResult {
  path: string
  bytes: number
  durationMs: number
  pruned: string[]
}

/**
 * Take one timestamped backup and apply retention.
 * `at` is injectable so tests do not depend on the clock.
 */
export async function backupDatabase(
  db: DB,
  options: { dir?: string; retention?: number; at?: Date } = {},
): Promise<BackupResult> {
  const dir = options.dir ?? backupDir()
  const retention = options.retention ?? backupRetention()
  const at = options.at ?? new Date()
  const stamp = at.toISOString().replace(/[:.]/g, "-").slice(0, 19)
  const target = path.join(dir, `travel-radar-${stamp}.db`)

  fs.mkdirSync(dir, { recursive: true })
  const started = Date.now()
  await db.backup(target)
  const bytes = fs.statSync(target).size

  return { path: target, bytes, durationMs: Date.now() - started, pruned: pruneBackups(retention, dir) }
}

/**
 * Back up only when the newest backup is older than the interval. This is what
 * the scheduler calls each tick, so an unattended run keeps a rolling window
 * without a cron entry or a second process.
 */
export async function backupIfDue(
  db: DB,
  options: { dir?: string; retention?: number; intervalHours?: number; at?: Date } = {},
): Promise<BackupResult | null> {
  const dir = options.dir ?? backupDir()
  const interval = options.intervalHours ?? backupIntervalHours()
  const at = options.at ?? new Date()
  const newest = listBackups(dir)[0]
  if (newest && at.getTime() - Date.parse(newest.createdAt) < interval * 3600_000) return null
  return backupDatabase(db, { dir, retention: options.retention, at })
}
