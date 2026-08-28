/**
 * Test environment guard.
 *
 * Tests must never spend money or touch the developer's real database. This
 * points DATABASE_PATH at a throwaway file and strips provider credentials from
 * the environment, so a test that accidentally reaches a real provider fails
 * with "unconfigured" instead of quietly billing an API call.
 */

import os from "os"
import path from "path"
import { afterAll } from "vitest"
import { closeDb } from "../db/index.js"

process.env.DATABASE_PATH = path.join(
  os.tmpdir(), `travel-radar-test-${process.pid}.db`,
)

// Credentials are set to EMPTY, not deleted: the .env loader honours a
// defined-empty value as "deliberately off", whereas a deleted variable would
// be silently refilled from the developer's real .env the moment any module
// imports load-env — and a test could then bill a real API call.
process.env.SERP_API_KEY = ""
process.env.ATF_API_KEY = ""

process.env.SERPAPI_MONTHLY_BUDGET ??= "90"
process.env.SERPAPI_RESERVE_CALLS ??= "10"

// Xotelo is KEYLESS, so blanking a credential cannot protect us. Point its
// base URL at an unroutable loopback port instead: a stay test that forgets
// to inject a fetch stub fails fast with a connection error rather than
// quietly hammering a donation-run public API from CI.
process.env.XOTELO_API_BASE = "http://127.0.0.1:9/blocked-in-tests"
process.env.AGODA_API_BASE = "http://127.0.0.1:9/blocked-in-tests"
process.env.SERPAPI_HOTELS_API_BASE = "http://127.0.0.1:9/blocked-in-tests"

// Package sellers are keyless too — same unroutable-port treatment for every
// host the providers can reach (TUI's stable API host, both CloudFront hosts,
// and CHECK24), so a forgotten fetch stub fails fast instead of touching a
// live seller from CI.
process.env.TUI_PACKAGES_OFFER_BASE = "http://127.0.0.1:9/blocked-in-tests"
process.env.TUI_PACKAGES_CALENDAR_BASE = "http://127.0.0.1:9/blocked-in-tests"
process.env.CHECK24_PACKAGES_API_BASE = "http://127.0.0.1:9/blocked-in-tests"

// The FX source is keyless too; same treatment.
process.env.MARKET_FX_API_BASE = "http://127.0.0.1:9/blocked-in-tests"

// The Gondola MCP endpoint is keyless too — a hotel-award test that forgets
// to stub it must fail fast, never reach the real server.
process.env.HOTEL_AWARDS_MCP_URL = "http://127.0.0.1:9/blocked-in-tests"

// Backups go to a throwaway directory for the same reason the database does.
// Without this, any test that runs the scheduler writes a snapshot of the test
// database into the operator's REAL backup set — which then looks like the
// newest backup, so the next genuine one is skipped as "not due" and a restore
// hands back an empty database.
process.env.BACKUP_DIR = path.join(
  os.tmpdir(), `travel-radar-test-backups-${process.pid}`,
)

afterAll(() => {
  closeDb()
})
