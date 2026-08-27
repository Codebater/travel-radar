/**
 * §17/§19 - 23:00 to 08:00, Prague time, and the morning digest.
 *
 * The naive implementations are both wrong, and wrong in ways that only show up
 * twice a year:
 *
 *   - "add one or two hours to UTC" fails on the DST transitions. Prague's
 *     23:00-08:00 window is 8 UTC hours on the March night and 10 in October,
 *     and both changeovers land INSIDE the window.
 *   - `new Date().getHours()` reads the machine's timezone, and this machine is
 *     not necessarily in Prague. Setting `process.env.TZ` would fix it and
 *     break everything else: `nowIso()`, `observation_runs.started_at` and the
 *     backup filenames are all UTC by design.
 *
 * So every conversion goes through `Intl.DateTimeFormat` with an explicit
 * timeZone, which is the only thing in the platform that actually knows when
 * Prague changes its clocks.
 *
 * The digest is "slot due", not "fire at 08:00". The scheduler sleeps AFTER its
 * work (`await setTimeout(tickSeconds * 1000)`), and a laptop that was closed
 * overnight wakes with `now` hours past the slot. A design that waits for 08:00
 * to come round again would simply never send it.
 */

import type { NotificationConfig } from "./config.js"

interface Parts { year: string; month: string; day: string; hour: string; minute: string }

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  })
}

const cache = new Map<string, Intl.DateTimeFormat>()

function partsIn(timeZone: string, instant: Date): Parts {
  let fmt = cache.get(timeZone)
  if (!fmt) { fmt = formatterFor(timeZone); cache.set(timeZone, fmt) }
  const out: Record<string, string> = {}
  for (const part of fmt.formatToParts(instant)) {
    if (part.type !== "literal") out[part.type] = part.value
  }
  // en-CA with hour12:false renders midnight as "24" in some ICU versions.
  if (out.hour === "24") out.hour = "00"
  return out as unknown as Parts
}

/** Does this runtime actually know the zone? If not, everything below is a guess. */
export function timezoneSupported(timeZone: string): boolean {
  try {
    const probe = formatterFor(timeZone)
    return probe.resolvedOptions().timeZone === timeZone
  } catch {
    return false
  }
}

/** The Prague calendar date of an instant, as YYYY-MM-DD. */
export function localDay(instant: Date, config: NotificationConfig): string {
  const p = partsIn(config.quietHours.timezone, instant)
  return `${p.year}-${p.month}-${p.day}`
}

/** The Prague wall-clock hour of an instant, 0-23. */
export function localHour(instant: Date, config: NotificationConfig): number {
  return Number(partsIn(config.quietHours.timezone, instant).hour)
}

function hourOf(hhmm: string): number {
  const [h] = hhmm.split(":")
  const parsed = Number(h)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Is it quiet right now?
 *
 * If the runtime does not know Europe/Prague, this returns TRUE - fail closed.
 * The failure mode of guessing wrong in the other direction is a phone buzzing
 * at 04:00, which is precisely the thing quiet hours exist to prevent.
 */
export function isQuiet(instant: Date, config: NotificationConfig): boolean {
  if (!timezoneSupported(config.quietHours.timezone)) return true
  const hour = localHour(instant, config)
  const start = hourOf(config.quietHours.start)
  const end = hourOf(config.quietHours.end)
  // The window wraps midnight, which is why this is not a simple range test.
  return start > end ? (hour >= start || hour < end) : (hour >= start && hour < end)
}

/**
 * The digest slot an instant belongs to: the Prague DATE of the morning that
 * will deliver it.
 *
 * Something queued at 23:30 on the 27th belongs to the morning of the 28th.
 * Something queued at 02:00 on the 28th belongs to the same morning.
 */
export function digestSlotFor(instant: Date, config: NotificationConfig): string {
  const hour = localHour(instant, config)
  const end = hourOf(config.quietHours.end)
  const start = hourOf(config.quietHours.start)

  // Past the evening boundary means the slot is tomorrow's morning.
  let slot = localDay(instant, config)
  if (start > end && hour >= start) {
    slot = localDay(new Date(instant.getTime() + 24 * 3600_000), config)
  }

  // And if that morning has already been and gone, the next one is tomorrow's.
  //
  // This is not a nicety. An alert deferred to the digest during WAKING hours -
  // which is exactly what happens when the daily cap is reached - would
  // otherwise be filed under today's 08:00, which is in the past, so the digest
  // phase would fire it immediately in the same pass. The cap would be
  // completely inert while appearing to work.
  const due = slotDueAt(slot, config)
  if (due !== null && due.getTime() <= instant.getTime()) {
    slot = localDay(new Date(instant.getTime() + 24 * 3600_000), config)
  }
  return slot
}

/**
 * The UTC instant at which a slot becomes due: `quietHours.end` local time on
 * that Prague date.
 *
 * Found by search rather than arithmetic. Adding an offset assumes an offset;
 * this asks the formatter what the local hour actually is at a candidate
 * instant and walks to the one that answers correctly, so a DST night needs no
 * special case because there is no case.
 */
export function slotDueAt(slot: string, config: NotificationConfig): Date | null {
  const end = hourOf(config.quietHours.end)
  const base = Date.parse(`${slot}T00:00:00Z`)
  if (!Number.isFinite(base)) return null
  // Prague is UTC+1 or UTC+2, so the answer is within a day either side of the
  // naive guess. Scanning at 15-minute resolution costs nothing and is exact.
  for (let minutes = -24 * 60; minutes <= 24 * 60; minutes += 15) {
    const probe = new Date(base + minutes * 60_000)
    const p = partsIn(config.quietHours.timezone, probe)
    if (`${p.year}-${p.month}-${p.day}` === slot && Number(p.hour) === end && p.minute === "00") {
      return probe
    }
  }
  return null
}

/** Is this slot's morning in the past? Then it is due NOW, however late. */
export function slotIsDue(slot: string, now: Date, config: NotificationConfig): boolean {
  const due = slotDueAt(slot, config)
  return due !== null && due.getTime() <= now.getTime()
}
