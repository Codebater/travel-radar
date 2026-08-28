/**
 * Deterministic sparse sampling over the Active Observation Set.
 *
 * Same shape as the flight observer's date strategy: a fixed check-in grid
 * over the horizon, successive runs rotating BETWEEN the previous run's grid
 * points, nights drawn from each property's own typical stay lengths. Fully
 * deterministic on (anchor date, runIndex) — a dry-run shows the exact run,
 * and a repeated run asks the same questions.
 *
 * The plan is trimmed to the request budget BEFORE anything is fetched, and
 * every trim is reported — a small cycle must never be mistaken for a quiet
 * market. Priority order decides who survives a trim: P1 properties lose
 * coverage last.
 */

import type { StoredStayProperty } from "./registry.js"
import type { StaysConfig } from "./config.js"

export interface PlannedStayItem {
  property: StoredStayProperty
  checkIn: string                 // YYYY-MM-DD
  checkOut: string
  nights: number
  /** Also fetch the day-class calendar for this property in this run. */
  wantCalendar: boolean
  /** Where this sample came from — the run records how budget was aimed. */
  kind: "sparse" | "cheap-window" | "neighbor" | "window-probe"
  detail?: string
}

export interface StayRunPlan {
  runIndex: number
  items: PlannedStayItem[]
  /** rates requests + calendar requests, the number the budget must cover */
  plannedRequests: number
  scopeReduced: string[]
}

/**
 * The check-in grid for one run: every stepDays from the first offset to the
 * horizon, with a per-run phase shift that interleaves successive runs
 * between each other's samples rather than repeating them or drifting.
 */
export function checkInGrid(config: StaysConfig["sampling"], runIndex: number, anchor: Date): string[] {
  const { firstCheckInOffsetDays: first, stepDays: step, horizonDays: horizon } = config
  const phases = Math.max(1, step)                      // one distinct phase per day of step
  const phase = runIndex % phases
  const dates: string[] = []
  for (let offset = first + phase; offset <= horizon; offset += step) {
    dates.push(isoDay(anchor, offset))
  }
  return dates
}

export interface TargetedInput {
  property: StoredStayProperty
  checkIn: string
  nights: number
  kind: "cheap-window" | "neighbor" | "window-probe"
  detail: string
}

export function planStayRun(
  properties: StoredStayProperty[],
  config: StaysConfig,
  runIndex: number,
  anchor: Date,
  opts: {
    calendarSupported?: (p: StoredStayProperty) => boolean
    /** Extra evidence-guided samples (cheap windows, neighbours), pre-deduped. */
    targeted?: TargetedInput[]
  } = {},
): StayRunPlan {
  const s = config.sampling
  const scopeReduced: string[] = []
  const grid = checkInGrid(s, runIndex, anchor)

  // Priority first, then id for determinism. Only observable properties plan.
  const ordered = [...properties].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))

  const items: PlannedStayItem[] = []
  ordered.forEach((property, propertyIndex) => {
    // Rotate each property's slice of the grid by run AND by property, so two
    // properties never sample identical dates forever and one run spreads
    // across the horizon instead of clustering at its start.
    const per = Math.max(1, s.datesPerPropertyPerRun)
    const start = (runIndex * per + propertyIndex) % Math.max(1, grid.length)
    const nightsChoices = property.typicalStayNights.length
      ? property.typicalStayNights
      : [config.observation.defaultNights]

    for (let i = 0; i < per && i < grid.length; i++) {
      const gridIdx = (start + i * Math.max(1, Math.floor(grid.length / per))) % grid.length
      const checkIn = grid[gridIdx]
      const nights = nightsChoices[(gridIdx + runIndex) % nightsChoices.length]
      items.push({
        property,
        checkIn,
        checkOut: addDaysIso(checkIn, nights),
        nights,
        wantCalendar: false,
        kind: "sparse",
      })
    }

    // Calendar cadence: one calendar fetch per property every N runs, offset
    // by property index so the load spreads across runs instead of spiking.
    const calendarDue = (runIndex + propertyIndex) % Math.max(1, s.calendarEveryNRuns) === 0
    const supported = opts.calendarSupported ? opts.calendarSupported(property) : true
    if (calendarDue && supported) {
      const first = items.find(i => i.property.id === property.id)
      if (first) first.wantCalendar = true
    }
    if (calendarDue && !supported) {
      scopeReduced.push(`calendar skipped for ${property.id}: marked unsupported`)
    }
  })

  // Targeted samples (cheap windows, neighbours) join AFTER the sparse grid:
  // the grid is the radar's food and always eats first. One question per
  // (property, check-in) — a targeted sample duplicating a sparse one adds
  // nothing.
  const asked = new Set(items.map(i => `${i.property.id}|${i.checkIn}`))
  for (const t of opts.targeted ?? []) {
    const key = `${t.property.id}|${t.checkIn}`
    if (asked.has(key)) continue
    asked.add(key)
    items.push({
      property: t.property,
      checkIn: t.checkIn,
      checkOut: addDaysIso(t.checkIn, t.nights),
      nights: t.nights,
      wantCalendar: false,
      kind: t.kind,
      detail: t.detail,
    })
  }

  // Trim to the observation budget BEFORE anything is fetched. Requests =
  // one per item + one per wanted calendar. Drop whole items from the LOWEST
  // priority end; drop calendars before rates (a rate is the radar's food).
  const ceiling = config.observation.maxRequestsPerRun
  let planned = items.length + items.filter(i => i.wantCalendar).length
  if (planned > ceiling) {
    scopeReduced.push(
      `plan of ${planned} requests trimmed to budget ${ceiling} — ` +
      `${properties.length} properties is more than one run covers; raise maxRequestsPerRun or expect rotation`,
    )
    for (let i = items.length - 1; i >= 0 && planned > ceiling; i--) {
      if (items[i].wantCalendar) { items[i].wantCalendar = false; planned-- }
    }
    while (planned > ceiling && items.length > 0) {
      items.pop()
      planned = items.length + items.filter(i => i.wantCalendar).length
    }
  }

  return { runIndex, items, plannedRequests: planned, scopeReduced }
}

function isoDay(anchor: Date, offsetDays: number): string {
  return new Date(anchor.getTime() + offsetDays * 86_400_000).toISOString().slice(0, 10)
}

function addDaysIso(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}
