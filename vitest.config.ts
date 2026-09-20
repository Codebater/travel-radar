import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // Default run covers the offline logic tests only. Every provider is mocked;
    // nothing here calls SerpAPI, Roame, ATF, AwardWallet or Google.
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    // better-sqlite3 is a native addon and segfaults when worker threads are
    // torn down while database handles are still finalising. Child processes
    // shut down cleanly.
    threads: false,
  },
})
