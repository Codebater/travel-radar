#!/usr/bin/env tsx
/**
 * Award Travel Finder — autonomous-agent credential provisioning.
 *
 * WHY THIS IS A SEPARATE, OPERATOR-RUN COMMAND
 * ATF offers two identity types. The MCP server is OAuth 2.1 whose
 * authorization server advertises only `authorization_code` and
 * `refresh_token` — no `client_credentials` — so a token cannot be minted
 * without a human consent screen. It is therefore unusable for a radar that
 * must run unattended on a NAS. (The vendor README's claim that an X-API-Key
 * header still works on MCP does not hold: that endpoint answers 401 to a key.)
 *
 * The officially supported autonomous path is the REST API with an X-API-Key
 * issued by POST /api/v1/agent/register — declared `security: []`, no browser,
 * no consent step. That call PROVISIONS AN ACCOUNT, which is why it lives here
 * as an explicit command you run rather than something the app does on its own.
 *
 *   npx tsx atf-register.ts --email you@example.com --name "Travel Radar"
 *   npx tsx atf-register.ts --dry-run          # show the exact request, send nothing
 *
 * Both fields are optional per the vendor spec (attribution / abuse contact
 * only). The issued key is written to ~/.openclaw/credentials/
 * awardtravelfinder.json and NEVER printed — the vendor shows it once, so it is
 * stored immediately. No cookies, no passwords, ever.
 */

import "./load-env.js"
import fs from "fs"
import path from "path"
import os from "os"

const REGISTER_URL = "https://awardtravelfinder.com/api/v1/agent/register"
const VERIFY_URL = "https://awardtravelfinder.com/api/v1/agent/me"

function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir()
}
const CREDENTIALS_PATH = path.join(homeDir(), ".openclaw", "credentials", "awardtravelfinder.json")

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined
}
const dryRun = args.includes("--dry-run")
const force = args.includes("--force")

/** Show only enough of a key to recognise it; never the secret itself. */
function fingerprint(key: string): string {
  return `${key.slice(0, 4)}…${key.slice(-4)} (${key.length} chars)`
}

async function main() {
  if (fs.existsSync(CREDENTIALS_PATH) && !force) {
    try {
      const existing = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8"))
      if (existing.apiKey || existing.api_key) {
        console.log(`An ATF key is already stored at ${CREDENTIALS_PATH}`)
        console.log(`  ${fingerprint(existing.apiKey || existing.api_key)}`)
        console.log(`\nThe vendor documents this endpoint as rate limited per IP and says:`)
        console.log(`"Do not call it more than once per agent — reuse the key you were issued."`)
        console.log(`\nRe-register anyway with --force (the old key is overwritten and lost).`)
        return
      }
    } catch { /* unreadable file — fall through and replace it */ }
  }

  const body: Record<string, string> = {}
  const email = flag("email")
  const name = flag("name") ?? "Extreme Travel Radar"
  if (email) body.operator_email = email
  body.agent_name = name

  console.log(`POST ${REGISTER_URL}`)
  console.log(`  ${JSON.stringify(body)}`)
  console.log(`  → provisions a free-tier ATF account and issues one API key.`)

  if (dryRun) {
    console.log(`\n--dry-run: nothing was sent.`)
    return
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  let resp: Response
  try {
    resp = await fetch(REGISTER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (err) {
    console.error(`❌ registration request failed: ${(err as Error).message}`)
    process.exit(1)
  } finally {
    clearTimeout(timer)
  }

  const text = await resp.text()
  let payload: any = null
  try { payload = JSON.parse(text) } catch { /* non-JSON body */ }

  if (!resp.ok) {
    // Deliberately truncated: an error body could echo submitted values.
    console.error(`❌ HTTP ${resp.status}: ${text.slice(0, 200)}`)
    if (resp.status === 429) console.error(`   Rate limited per IP — wait before retrying.`)
    process.exit(1)
  }

  const apiKey: string | undefined = payload?.api_key ?? payload?.apiKey ?? payload?.key
  if (!apiKey) {
    console.error(`❌ no api_key in the response. Keys present: ${Object.keys(payload ?? {}).join(", ") || "(none)"}`)
    process.exit(1)
  }

  fs.mkdirSync(path.dirname(CREDENTIALS_PATH), { recursive: true })
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify({
    apiKey,
    agentName: name,
    registeredAt: new Date().toISOString(),
    note: "Issued by POST /api/v1/agent/register. Shown once by the vendor — do not delete.",
  }, null, 2) + "\n")

  console.log(`\n✅ Key issued and stored: ${CREDENTIALS_PATH}`)
  console.log(`   ${fingerprint(apiKey)} — the value itself is never printed or logged.`)
  if (payload?.plan || payload?.tier) console.log(`   plan: ${JSON.stringify(payload.plan ?? payload.tier)}`)

  // Verify with the vendor's own zero-cost identity endpoint.
  try {
    const me = await fetch(VERIFY_URL, { headers: { "X-API-Key": apiKey, Accept: "application/json" } })
    const meBody = await me.json().catch(() => null) as any
    console.log(`\nVerification GET /agent/me → HTTP ${me.status}`)
    if (meBody) {
      const safe = { ...meBody }
      for (const k of ["api_key", "apiKey", "key", "token"]) delete safe[k]
      console.log(`   ${JSON.stringify(safe).slice(0, 300)}`)
    }
  } catch (err) {
    console.log(`\nVerification skipped: ${(err as Error).message}`)
  }

  console.log(`\nNext: npm run providers   (ATF should now report configured)`)
}

main().catch(err => {
  console.error("❌", (err as Error).message)
  process.exit(1)
})
