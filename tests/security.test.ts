/**
 * Regression tests for the Phase 1 security fixes.
 *
 * These boot the real serve.ts as a child process on an ephemeral port and
 * exercise it over HTTP, so they fail if a later refactor quietly removes a
 * protection. No provider is contacted: every request either gets rejected
 * before a search starts, or asks for a static file.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { getDb } from "../db/index.js"
import { spawn, type ChildProcess } from "child_process"
import fs from "fs"
import net from "net"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CANARY = "phase1-regression-canary-value"
const NTFY_TOPIC_CANARY = "phase7-topic-canary-do-not-leak"
const NTFY_TOKEN_CANARY = "tk_phase7tokencanarydonotleak"

let server: ChildProcess
let base: string
let port: number
let createdEnv = false

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address()
      const p = typeof addr === "object" && addr ? addr.port : 0
      srv.close(() => resolve(p))
    })
  })
}

beforeAll(async () => {
  // A .env with a canary value, so "the server must not serve .env" is testable.
  const envPath = path.join(ROOT, ".env")
  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, `SERP_API_KEY=${CANARY}\n`)
    createdEnv = true
  }

  port = await freePort()
  base = `http://127.0.0.1:${port}`

  server = spawn(
    process.execPath,
    [path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), path.join(ROOT, "serve.ts"), "--port", String(port)],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        // No credentials: a request that slips past validation cannot spend money.
        SERP_API_KEY: "", ATF_API_KEY: "",
        // ...except the notification destination, which is set to canaries ON
        // PURPOSE: the point is to prove that a server holding a real topic and
        // token never serves either of them.
        NTFY_TOPIC: NTFY_TOPIC_CANARY,
        NTFY_TOKEN: NTFY_TOKEN_CANARY,
        NTFY_SERVER: "https://ntfy.example.com",
        NOTIFICATIONS_ENABLED: "false",
        DATABASE_PATH: path.join(os.tmpdir(), `travel-radar-sec-${process.pid}.db`),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )

  // Wait for the listener rather than sleeping a fixed amount.
  const deadline = Date.now() + 45_000
  for (;;) {
    try {
      await fetch(`${base}/dashboard.html`)
      break
    } catch {
      if (Date.now() > deadline) throw new Error("serve.ts did not start within 45s")
      await new Promise(r => setTimeout(r, 250))
    }
  }
}, 60_000)

afterAll(() => {
  server?.kill()
  if (createdEnv) fs.rmSync(path.join(ROOT, ".env"), { force: true })
})

describe("secrets are not downloadable", () => {
  it("refuses .env and does not leak its contents", async () => {
    const res = await fetch(`${base}/.env`)
    expect(res.status).toBe(403)
    expect(await res.text()).not.toContain(CANARY)
  })

  it("refuses a percent-encoded dotfile", async () => {
    expect((await fetch(`${base}/%2Eenv`)).status).toBe(403)
  })

  it("refuses dot-directories such as .git", async () => {
    expect((await fetch(`${base}/.git/config`)).status).toBe(403)
    expect((await fetch(`${base}/.npmrc`)).status).toBe(403)
  })

  it("refuses file types the dashboard never loads", async () => {
    for (const p of ["/search.ts", "/requirements.txt", "/serve.ts"]) {
      expect((await fetch(`${base}${p}`)).status).toBe(403)
    }
  })
})

describe("path containment", () => {
  it("refuses traversal outside the project root", async () => {
    for (const p of ["/../../../Windows/win.ini", "/..%2f..%2f..%2fetc%2fpasswd", "/....//....//package.json"]) {
      const res = await fetch(`${base}${p}`)
      expect([403, 404]).toContain(res.status)
    }
  })

  it("still serves the files the dashboard needs", async () => {
    expect((await fetch(`${base}/`)).status).toBe(200)
    expect((await fetch(`${base}/dashboard.html`)).status).toBe(200)
    expect((await fetch(`${base}/data/hub-connections.json`)).status).toBe(200)
  })
})

describe("input validation on /api/search", () => {
  const cases: [string, string][] = [
    ["shell metacharacters in origin", "from=LAX%3Bcalc&to=CDG&date=2026-11-10"],
    ["command substitution attempt", "from=%24%28whoami%29&to=CDG&date=2026-11-10"],
    ["pipe in destination", "from=LAX&to=CDG%7Cls&date=2026-11-10"],
    ["short IATA code", "from=LA&to=CDG&date=2026-11-10"],
    ["long IATA code", "from=LAXX&to=CDG&date=2026-11-10"],
    ["malformed date", "from=LAX&to=CDG&date=not-a-date"],
    ["impossible date", "from=LAX&to=CDG&date=2026-13-45"],
    ["injected date argument", "from=LAX&to=CDG&date=2026-11-10%20--evil"],
    ["unknown cabin class", "from=LAX&to=CDG&date=2026-11-10&class=hax"],
    ["unknown source", "from=LAX&to=CDG&date=2026-11-10&sources=evil"],
    ["malformed return date", "from=LAX&to=CDG&date=2026-11-10&return=nope"],
  ]

  for (const [name, qs] of cases) {
    it(`rejects ${name} with 400`, async () => {
      const res = await fetch(`${base}/api/search?${qs}`)
      expect(res.status).toBe(400)
      const body = await res.json() as { error?: string }
      expect(body.error).toBeTruthy()
    })
  }

  it("does not echo the rejected value back as HTML", async () => {
    const res = await fetch(`${base}/api/search?from=%3Cscript%3E&to=CDG&date=2026-11-10`)
    expect(res.headers.get("content-type")).toContain("application/json")
  })
})

describe("cross-origin protection", () => {
  it("refuses an API call from another origin", async () => {
    const res = await fetch(`${base}/api/search?from=LAX&to=CDG&date=2026-11-10`, {
      headers: { Origin: "https://evil.example" },
    })
    expect(res.status).toBe(403)
  })

  it("refuses cross-origin calls to the new Phase 2/3 endpoints too", async () => {
    for (const p of ["/api/providers", "/api/price-history?from=PRG&to=BKK", "/api/results/latest"]) {
      const res = await fetch(`${base}${p}`, { headers: { Origin: "https://evil.example" } })
      expect(res.status).toBe(403)
    }
  })

  it("allows the dashboard's own origin", async () => {
    const res = await fetch(`${base}/api/providers`, { headers: { Origin: base } })
    expect(res.status).toBe(200)
  })
})

describe("network binding", () => {
  it("listens on loopback only by default", async () => {
    // Binding to the same port on a non-loopback address must still be possible,
    // which it would not be had serve.ts bound 0.0.0.0.
    const probe = net.createServer()
    const bound = await new Promise<boolean>(resolve => {
      probe.once("error", () => resolve(false))
      probe.listen(port, "0.0.0.0", () => resolve(true))
    })
    probe.close()
    expect(bound).toBe(true)
  })
})

describe("Phase 3 endpoints", () => {
  it("serves /api/results/latest from the database (404 on a fresh one)", async () => {
    // Every suite in this run shares one DATABASE_PATH (vitest runs them in a
    // single process), so "fresh" has to be made true rather than assumed: an
    // earlier suite exercising runSearch persists a result, and this assertion
    // then silently depended on file ordering. Clearing the table is the
    // difference between testing the endpoint and testing the schedule.
    getDb().prepare("DELETE FROM search_results").run()

    const res = await fetch(`${base}/api/results/latest`)
    expect(res.status).toBe(404)
    const body = await res.json() as { error?: string }
    expect(body.error).toContain("no search")
  })

  it("reports award providers and balances in /api/providers without spending", async () => {
    const res = await fetch(`${base}/api/providers`)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    const awardNames = (body.awards || []).map((p: any) => p.provider)
    expect(awardNames).toContain("roame")
    expect(awardNames).toContain("atf")
    expect(body.balances?.provider).toBe("awardwallet")
    // Coverage matrix is served alongside, with its audit date.
    expect(body.coverage?.programs?.MILES_AND_MORE).toBeTruthy()
    // No award provider health check may consume quota.
    const atfUsage = (body.usage || []).find((u: any) => u.provider === "atf")
    expect(atfUsage?.attempted ?? 0).toBe(0)
  })

  it("returns award stats sections in /api/price-history", async () => {
    const res = await fetch(`${base}/api/price-history?from=PRG&to=BKK`)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(Array.isArray(body.cash)).toBe(true)
    expect(Array.isArray(body.awards)).toBe(true)
  })
})

describe("duplicate request collapsing", () => {
  it("collapses concurrent identical searches into one", async () => {
    // A double-clicked "Refresh live price" must not issue two provider calls.
    // Without credentials nothing is billable here, but the server must still
    // report all four as one shared search.
    const url = `${base}/api/search?from=PRG&to=SIN&date=2026-11-14&class=ECON&sources=google&refresh=1`
    const started = Date.now()
    const responses = await Promise.all([0, 1, 2, 3].map(() => fetch(url)))
    const elapsed = Date.now() - started

    for (const r of responses) expect(r.status).toBe(200)
    const bodies = await Promise.all(responses.map(r => r.json() as Promise<any>))
    // All four must be the same search result, not four independent ones.
    const stamps = new Set(bodies.map(b => b.meta.searchedAt))
    expect(stamps.size).toBe(1)
    // Four sequential searches would take far longer than one.
    expect(elapsed).toBeLessThan(40_000)
  }, 60_000)
})

describe("round-trip persistence (review finding)", () => {
  it("persists the MERGED payload, not the reversed return leg, as the latest result", async () => {
    // The high-severity review finding: serve.ts ran runSearch twice for a
    // round trip (outbound, then return); each persisted its own payload, so
    // the return leg (persisted last) became /api/results/latest and a
    // dashboard reload showed only the reversed route. Uses the free cash
    // provider only — nothing metered is configured in this environment.
    const res = await fetch(
      `${base}/api/search?from=PRG&to=SIN&date=2026-12-05&return=2026-12-19&class=ECON&sources=google`)
    expect(res.status).toBe(200)

    const latest = await fetch(`${base}/api/results/latest`)
    expect(latest.status).toBe(200)
    const payload = await latest.json() as any
    // The persisted latest must be the outbound-rooted MERGED result...
    expect(payload.meta.origin).toBe("PRG")
    expect(payload.meta.destination).toBe("SIN")
    expect(payload.meta.returnDate).toBe("2026-12-19")
    // ...containing both directions, not just one leg.
    const directions = new Set(payload.flights.map((f: any) => f.direction || "outbound"))
    expect(directions.has("outbound")).toBe(true)
    expect(directions.has("return")).toBe(true)
    expect(payload.meta.totalFlights).toBe(payload.flights.length)
  }, 120_000)
})

describe("§39 the notification destination is never served", () => {
  // On a public ntfy server the topic IS the access control, so a topic that
  // appears in an API response or a page is the same class of mistake as
  // serving .env. The server under test is deliberately holding one.

  it("does not leak the topic or the token through /api/alerts", async () => {
    const res = await fetch(`${base}/api/alerts`)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toContain(NTFY_TOPIC_CANARY)
    expect(body).not.toContain(NTFY_TOKEN_CANARY)
    // It DOES say which host it is pointed at, which is operationally useful
    // and not a secret.
    const parsed = JSON.parse(body) as any
    expect(parsed.channel.detail).toContain("ntfy.example.com")
    expect(parsed.channel.detail).toContain("topic hidden")
  })

  it("does not leak them through any page the dashboard serves", async () => {
    for (const page of ["/alerts.html", "/deals.html", "/observer.html", "/dashboard.html"]) {
      const body = await (await fetch(`${base}${page}`)).text()
      expect(body).not.toContain(NTFY_TOPIC_CANARY)
      expect(body).not.toContain(NTFY_TOKEN_CANARY)
    }
  })

  it("refuses a cross-origin read of the alerts endpoint", async () => {
    const res = await fetch(`${base}/api/alerts`, { headers: { Origin: "https://evil.example" } })
    expect(res.status).toBe(403)
  })

  it("does not hand out a wildcard CORS header to any page", async () => {
    // The wildcard used to go out on every path while the Origin allowlist
    // guarded only /api/*, so any tab could read the dashboard cross-origin.
    for (const path of ["/alerts.html", "/deals.html", "/api/alerts"]) {
      const res = await fetch(`${base}${path}`)
      expect(res.headers.get("access-control-allow-origin")).not.toBe("*")
    }
  })

  it("offers no write route for notifications", async () => {
    // Two forged sends would silence the radar for the day, and the /api/
    // Origin guard only fires when an Origin header is present - which
    // <img>, <script> and plain navigations do not send. Sending stays
    // CLI-only, exactly as observer:start does.
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await fetch(`${base}/api/alerts`, {
        method, headers: { "Content-Type": "application/json" }, body: "{}",
      })
      // Either the route ignores the method and answers read-only, or there is
      // no such route. What must NOT exist is a handler that sends anything.
      expect([200, 403, 404, 405]).toContain(res.status)
    }
    for (const path of ["/api/notify", "/api/notify/send", "/api/alerts/send", "/api/notify/test"]) {
      const res = await fetch(`${base}${path}`, { method: "POST" })
      expect([403, 404]).toContain(res.status)
    }
  })
})

describe("stay-plan re-check route spends nothing before the explicit run", () => {
  const post = (body: unknown) => fetch(`${base}/api/hotel-awards/recheck-windows`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  })

  it("refuses an unconfigured destination up front and caps the preview at the config budget — no usage row appears", async () => {
    expect((await post({ location: "nowhere", windows: [{ checkIn: "2026-11-01", nights: 5 }] })).status).toBe(400)
    const many = Array.from({ length: 20 }, (_, i) => ({ checkIn: `2026-11-${String(i + 1).padStart(2, "0")}`, nights: 2 }))
    const pv = await post({ location: "bangkok", windows: many, preview: true, maxWindows: 100 })
    expect(pv.status).toBe(200)
    const p = await pv.json() as any
    expect(p.preview).toBe(true)
    expect(p.plan.windows).toHaveLength(8)
    expect(p.plan.dropped).toHaveLength(12)
    expect(JSON.stringify(p)).not.toMatch(/csrfSecret|"session"/)
    // Neither the 400 nor the preview constructed a provider: no roame_hotels
    // usage was recorded on this fresh database.
    const status = await (await fetch(`${base}/api/hotel-awards/status`)).json() as any
    expect(status.usage).toBeNull()
    expect((await fetch(`${base}/api/hotel-awards/recheck-windows`)).status).toBe(405)
  })

  it("the status pre-flight and the balances snapshot are reads with no secrets", async () => {
    const s = await fetch(`${base}/api/hotel-awards/status`)
    expect(s.status).toBe(200)
    const text = await s.text()
    expect(text).not.toMatch(/csrfSecret|\.openclaw/)
    const b = await fetch(`${base}/api/balances`)
    expect(b.status).toBe(200)
    expect(b.headers.get("cache-control")).toBe("no-store")
    const body = await b.json() as any
    expect(["none", "snapshot"]).toContain(body.state)
    expect(JSON.stringify(body)).not.toContain("1392260")           // the upstream demo/fallback value never appears
  })
})

describe("provider endpoints do not spend money", () => {
  it("reports health without performing a billable call", async () => {
    const res = await fetch(`${base}/api/providers`)
    expect(res.status).toBe(200)
    const body = await res.json() as any

    const serp = body.cash.find((p: any) => p.provider === "serpapi")
    expect(serp).toBeTruthy()
    expect(["ok", "unconfigured", "degraded"]).toContain(serp.status)

    // The point of the assertion: checking health must never consume quota.
    const usage = body.usage.find((u: any) => u.provider === "serpapi")
    expect(usage?.attempted ?? 0).toBe(0)
    expect(serp.quota?.estimatedUsed ?? 0).toBe(0)
    // And the reserve must still be held back.
    expect(serp.quota?.reserve ?? 0).toBeGreaterThan(0)
  })

  it("checking health twice still spends nothing", async () => {
    await fetch(`${base}/api/providers`)
    const body = await (await fetch(`${base}/api/providers`)).json() as any
    const usage = body.usage.find((u: any) => u.provider === "serpapi")
    expect(usage?.attempted ?? 0).toBe(0)
  })
})
