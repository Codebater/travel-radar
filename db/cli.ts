#!/usr/bin/env tsx
/**
 * Database and provider admin.
 *
 *   npx tsx db/cli.ts migrate            apply pending migrations
 *   npx tsx db/cli.ts status             where the database is and what is in it
 *   npx tsx db/cli.ts providers          provider health, quota and usage (spends nothing)
 *   npx tsx db/cli.ts cache:clear [name] drop cached payloads (all, or one provider)
 *   npx tsx db/cli.ts cache:prune        drop only expired entries
 *   npx tsx db/cli.ts history FROM TO    observed price stats for a route
 */

import "../load-env.js"
import { getDb, migrate, DEFAULT_DB_PATH, currentPeriod } from "./index.js"
import { allUsage, clearCache, pruneCache, priceHistory, awardPriceHistory } from "./repositories.js"
import { providerHealth } from "../providers/cash-flights/index.js"
import { awardProviderHealth } from "../providers/award-flights/index.js"
import { balancesHealth } from "../providers/balances/index.js"

const [command, ...args] = process.argv.slice(2)

function dbPath(): string {
  return process.env.DATABASE_PATH || DEFAULT_DB_PATH
}

async function main() {
  switch (command) {
    case "migrate": {
      const db = getDb()
      const ran = migrate(db)
      console.log(ran.length === 0
        ? `✅ Schema already current (${dbPath()})`
        : `✅ Applied ${ran.length} migration(s): ${ran.join(", ")}`)
      break
    }

    case "status": {
      const db = getDb()
      console.log(`Database: ${dbPath()}`)
      console.log(`Journal mode: ${db.pragma("journal_mode", { simple: true })}`)
      const tables = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
      ).all() as { name: string }[]
      for (const { name } of tables) {
        const count = (db.prepare(`SELECT COUNT(*) c FROM "${name}"`).get() as any).c
        console.log(`  ${name.padEnd(20)} ${String(count).padStart(7)} rows`)
      }
      break
    }

    case "providers": {
      const db = getDb()
      const health = [...await providerHealth(db), ...await awardProviderHealth(db), balancesHealth(db)]
      const usage = allUsage(db)
      console.log(`Provider status (${currentPeriod()}) — no billable calls made\n`)
      for (const h of health) {
        const icon = h.status === "ok" ? "✓" : h.status === "unconfigured" ? "○" : h.status === "degraded" ? "⚠" : "✗"
        console.log(` ${icon} ${h.provider.padEnd(14)} ${h.status.padEnd(13)} ${h.detail}`)
        if (h.quota) {
          const q = h.quota
          console.log(`   ${"".padEnd(14)} local estimate: ${q.estimatedUsed}/${q.budget} used, ` +
                      `${q.automationRemaining} automation calls left (${q.reserve} reserved)`)
          if (q.reportedRemaining !== null) {
            console.log(`   ${"".padEnd(14)} provider reports: ${q.reportedRemaining}/${q.reportedLimit ?? "?"} remaining (${q.reportedAt})`)
          }
        }
      }
      if (usage.length > 0) {
        console.log(`\nUsage this period:`)
        for (const u of usage) {
          console.log(`  ${u.provider.padEnd(14)} attempted=${u.attempted} ok=${u.succeeded} failed=${u.failed}` +
                      `${u.lastError ? `  last error: ${u.lastError.slice(0, 60)}` : ""}`)
        }
      }
      break
    }

    case "cache:clear": {
      const provider = args[0]
      const removed = clearCache(getDb(), provider)
      console.log(`🧹 Cleared ${removed} cached entr${removed === 1 ? "y" : "ies"}${provider ? ` for ${provider}` : ""}`)
      console.log(`   Price history is untouched — it is append-only by design.`)
      break
    }

    case "cache:prune": {
      const removed = pruneCache(getDb())
      console.log(`🧹 Removed ${removed} expired cache entr${removed === 1 ? "y" : "ies"}`)
      break
    }

    case "history": {
      const [origin, destination, date] = args
      if (!origin || !destination) {
        console.error("Usage: npx tsx db/cli.ts history PRG BKK [2026-11-10]")
        process.exit(1)
      }
      const db2 = getDb()
      const stats = priceHistory(db2, { origin, destination, departureDate: date })
      const awardStats = awardPriceHistory(db2, { origin, destination, departureDate: date })
      if (stats.length === 0 && awardStats.length === 0) {
        console.log(`No observations recorded for ${origin.toUpperCase()}→${destination.toUpperCase()}`)
        break
      }
      for (const s of stats) {
        console.log(`CASH ${origin.toUpperCase()}→${destination.toUpperCase()} [${s.currency}]`)
        console.log(`  observations ${s.observations}`)
        console.log(`  min ${s.min}  median ${s.median}  average ${s.average}  max ${s.max}`)
        console.log(`  latest ${s.latest} at ${s.latestAt}`)
        console.log(`  first observed ${s.firstAt}`)
      }
      if (awardStats.length > 0) {
        console.log(`
AWARDS — points observed by this radar (not market-wide history):`)
        for (const a of awardStats) {
          console.log(`  ${a.loyaltyProgram} ${a.cabin}: n=${a.observations}  ` +
                      `min ${a.minPoints.toLocaleString()}  median ${a.medianPoints.toLocaleString()}  ` +
                      `avg ${a.averagePoints.toLocaleString()}  max ${a.maxPoints.toLocaleString()}  ` +
                      `latest ${a.latestPoints.toLocaleString()}` +
                      `${a.minTaxes !== null ? `  min taxes ${a.minTaxes} ${a.minTaxesCurrency}` : ""}`)
        }
      }
      break
    }

    default:
      console.log(`Unknown command: ${command ?? "(none)"}

Commands:
  migrate               apply pending migrations
  status                database location and row counts
  providers             provider health, quota and usage (spends nothing)
  cache:clear [name]    drop cached payloads (all, or one provider)
  cache:prune           drop only expired entries
  history FROM TO [DATE]  observed price stats for a route`)
      process.exit(command ? 1 : 0)
  }
}

main().catch(err => {
  console.error("❌", (err as Error).message)
  process.exit(1)
})
