/**
 * The Observer umbrella overview — reporting only, nothing invented.
 *
 * Pinned claims: a domain without a running scheduler NEVER shows a next
 * run; manual-only modules say so honestly; Deal Radar (and other read-time
 * projections) are explicitly excluded from background jobs; and the current
 * flight-vs-stays scheduler split is represented exactly as it is.
 */

import fs from "fs"
import { beforeEach, describe, expect, it } from "vitest"
import { createMemoryDb, type DB } from "../db/index.js"
import { buildObserverOverview } from "../observer/overview.js"
import { upsertJob } from "../observer/store.js"
import { acquireStayLease } from "../stays/lease.js"

let db: DB
beforeEach(() => { db = createMemoryDb() })

const domain = (o: ReturnType<typeof buildObserverOverview>, name: string) => {
  const d = o.domains.find(d => d.domain === name)
  if (!d) throw new Error(`domain ${name} missing`)
  return d
}

describe("no fabricated state", () => {
  it("no domain shows a next run when no scheduler is actually running — even with jobs seeded", () => {
    // Enabled flight jobs exist, but the scheduler lease is NOT held.
    upsertJob(db, {
      name: "PRG-BKK", origin: "PRG", destination: "BKK", cabins: ["business"],
      cashProviders: ["fast_flights"], awardProviders: [], priority: 1,
      frequencyHours: 24, jitterMinutes: 5, dateStrategy: { kind: "fixed", dates: ["2026-11-10"] } as never,
      enabled: true,
    } as never)
    const o = buildObserverOverview(db)
    for (const d of o.domains) {
      expect(d.nextRunAt).toBeNull()
    }
    expect(domain(o, "flights").note).toMatch(/stopped/)
  })

  it("empty ledgers report null last runs and zero counts — never invented health", () => {
    const o = buildObserverOverview(db)
    for (const d of o.domains) {
      expect(d.lastRunAt).toBeNull()
    }
    expect(domain(o, "fare-radar").observations).toBe(0)
    expect(domain(o, "hotel-awards").observations).toBe(0)
  })
})

describe("honest scheduling labels", () => {
  it("Phase 8 modules and hotel awards are manual-only; flights ride the main scheduler; stays have their own", () => {
    const o = buildObserverOverview(db)
    expect(domain(o, "flights").scheduling).toBe("scheduled")
    expect(domain(o, "stays").scheduling).toBe("own-scheduler")
    for (const name of ["fare-radar", "packages-market", "fx", "hotel-awards"]) {
      expect(domain(o, name).scheduling).toBe("manual-only")
      expect(domain(o, name).note).toMatch(/manual|probe/i)
    }
    expect(domain(o, "hotel-awards").note).toMatch(/probe\/manual only/)
    expect(domain(o, "notifications").scheduling).toBe("scheduled")   // last tick step of the main scheduler
  })

  it("the flight/stay scheduler distinction reflects real lease state", () => {
    acquireStayLease(db, "test-holder", 300)
    const o = buildObserverOverview(db)
    expect(domain(o, "stays").note).toMatch(/RUNNING \(holder test-holder\)/)
    expect(domain(o, "stays").note).toMatch(/separate lease by design/)
    expect(domain(o, "flights").note).toMatch(/main Observer scheduler/)
    // Stays never borrow the flight scheduler's next-run machinery.
    expect(domain(o, "stays").nextRunAt).toBeNull()
  })
})

describe("exclusions — read-time surfaces are not background jobs", () => {
  it("Deal Radar is explicitly excluded as a read-only projection", () => {
    const o = buildObserverOverview(db)
    const dealRadar = o.excluded.find(e => e.name === "Deal Radar")
    expect(dealRadar).toBeDefined()
    expect(dealRadar!.reason).toMatch(/read-only projection/)
    expect(o.domains.some(d => /deal/i.test(d.domain))).toBe(false)
  })

  it("user-initiated searches are excluded — they may spend the metered reserve", () => {
    const o = buildObserverOverview(db)
    expect(o.excluded.some(e => /Dashboard searches/.test(e.name) && /metered reserve/.test(e.reason))).toBe(true)
  })
})

describe("page wiring", () => {
  it("observer.html renders the umbrella and keeps the flight controls/status sections intact", () => {
    const html = fs.readFileSync("observer.html", "utf-8")
    expect(html).toContain("api/observer/overview")
    expect(html).toContain('id="domainCards"')
    expect(html).toContain("No scheduled next run")
    // Flight sections intact:
    expect(html).toContain('id="schedulerBanner"')
    expect(html).toContain('id="jobsBody"')
    expect(html).toContain('id="healthCards"')
    expect(html).toContain("api/observer/status")
    // Explicit distinctions:
    expect(html).toMatch(/stays run on their OWN scheduler/i)
    expect(html).toContain("Extreme Travel Radar")
  })
})
