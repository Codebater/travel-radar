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

// Credentials are removed rather than faked: a fake key would still produce a
// real outbound request.
delete process.env.SERP_API_KEY
delete process.env.ATF_API_KEY

process.env.SERPAPI_MONTHLY_BUDGET ??= "90"
process.env.SERPAPI_RESERVE_CALLS ??= "10"

afterAll(() => {
  closeDb()
})
