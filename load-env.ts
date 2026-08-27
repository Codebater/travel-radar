/**
 * .env loader — imported for its side effect by every entry point (search,
 * serve, db CLI, observer CLI), so credentials configured in .env are visible
 * no matter which door the process came in through.
 *
 * The real environment always wins, including when it deliberately sets a
 * variable to empty: `SERP_API_KEY=` in the environment means "do not use
 * SerpAPI", and .env must not silently switch a paid provider back on.
 */

import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const envPath = path.join(ROOT, ".env")

if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, "utf-8")
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eqIdx = trimmed.indexOf("=")
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim()
      const val = trimmed.slice(eqIdx + 1).trim()
      if (process.env[key] === undefined) process.env[key] = val
    }
  }
}
