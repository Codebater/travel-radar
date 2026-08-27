import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // Default run covers the credential-free logic tests only.
    // awardwiz-scrapers/scrapers.test.ts drives real airline sites through
    // headless Chrome and has every scraper commented out upstream; run it
    // explicitly with `npm run test:scrapers` when working on those.
    include: ["tests/**/*.test.ts"],
  },
})
