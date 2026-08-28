/**
 * The Luxury Universe — the property registry.
 *
 * Two concepts, deliberately separate:
 *
 *   Luxury Universe        every property interesting enough to have a row.
 *                          Meant to grow to hundreds. Holding a property costs
 *                          nothing; observing it costs requests.
 *   Active Observation Set the subset with active=true, the only properties
 *                          any observation loop touches. Budget-limited.
 *
 * The metadata (tier, priority, all-inclusive capability, typical stay
 * lengths, provider refs, nearest airports) exists so a LATER phase can
 * promote and demote membership on evidence. No automatic promotion exists
 * yet; in Phase 8a `config/stay-properties.json` is the only control surface,
 * and seeding applies it verbatim — including `active` — because there is no
 * other writer to conflict with. The moment a runtime promotion mechanism
 * exists, that rule must be revisited (see the observer's upsert doctrine:
 * a flag the operator set must not be silently flipped by a reseed).
 */

import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { nowIso, type DB } from "../db/index.js"
import type { BoardBasis } from "../providers/stays/types.js"

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CONFIG_PATH = path.join(ROOT, "config", "stay-properties.json")

export type LuxuryTier = "ultra" | "luxury" | "upper"
export type AllInclusiveCapability = "only" | "available" | "none" | "unknown"

export interface StayPropertyConfig {
  id: string
  name: string
  destinationGroup: string
  country: string
  region?: string
  nearestAirports: string[]
  luxuryTier: LuxuryTier
  allInclusive: AllInclusiveCapability
  defaultBoard: BoardBasis
  typicalStayNights: number[]
  priority: number
  active: boolean
  /** Provider-native identities, keyed by provider name. Missing = no coverage. */
  refs: Record<string, string>
  /** Explicit hotel loyalty affiliation (MARRIOTT_BONVOY, HILTON_HONORS, …) —
   *  DATA, never inferred from the property name. Unset = independent or
   *  unknown, and nothing downstream may guess. */
  loyaltyProgram?: string
  notes?: string
}

export interface StayDestinationGroup {
  label: string
  airports: string[]
}

export interface StayUniverseConfig {
  description?: string
  updated?: string
  destinationGroups: Record<string, StayDestinationGroup>
  properties: StayPropertyConfig[]
}

const TIERS: LuxuryTier[] = ["ultra", "luxury", "upper"]
const AI_CAPABILITIES: AllInclusiveCapability[] = ["only", "available", "none", "unknown"]
const BOARDS: BoardBasis[] = ["room_only", "breakfast", "half_board", "full_board", "all_inclusive", "unknown"]
const IATA = /^[A-Z]{3}$/
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/

let cached: StayUniverseConfig | null = null

export function loadStayUniverse(force = false, configPath = CONFIG_PATH): StayUniverseConfig {
  if (cached && !force && configPath === CONFIG_PATH) return cached
  const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as StayUniverseConfig
  const problems = validateUniverse(raw)
  if (problems.length) {
    throw new Error(`invalid stay-properties config:\n  - ${problems.join("\n  - ")}`)
  }
  if (configPath === CONFIG_PATH) cached = raw
  return raw
}

/**
 * Exported for tests. Returns every problem rather than the first one — a
 * hand-maintained 50-entry file deserves a full report, not a whack-a-mole.
 */
export function validateUniverse(config: StayUniverseConfig): string[] {
  const problems: string[] = []
  if (!config.destinationGroups || typeof config.destinationGroups !== "object") {
    return ["destinationGroups missing"]
  }
  if (!Array.isArray(config.properties)) return ["properties is not an array"]

  const seen = new Set<string>()
  for (const p of config.properties) {
    const where = p?.id ?? "(missing id)"
    if (!p.id || !SLUG.test(p.id)) problems.push(`${where}: id must be a kebab-case slug`)
    if (seen.has(p.id)) problems.push(`${where}: duplicate id`)
    seen.add(p.id)
    if (!p.name?.trim()) problems.push(`${where}: name missing`)
    if (!config.destinationGroups[p.destinationGroup]) {
      problems.push(`${where}: unknown destinationGroup "${p.destinationGroup}"`)
    }
    if (!p.country?.trim()) problems.push(`${where}: country missing`)
    if (!Array.isArray(p.nearestAirports) || p.nearestAirports.length === 0
        || p.nearestAirports.some(a => !IATA.test(a))) {
      problems.push(`${where}: nearestAirports must be a non-empty list of IATA codes`)
    }
    if (!TIERS.includes(p.luxuryTier)) problems.push(`${where}: bad luxuryTier "${p.luxuryTier}"`)
    if (!AI_CAPABILITIES.includes(p.allInclusive)) problems.push(`${where}: bad allInclusive "${p.allInclusive}"`)
    if (!BOARDS.includes(p.defaultBoard)) problems.push(`${where}: bad defaultBoard "${p.defaultBoard}"`)
    if (!Array.isArray(p.typicalStayNights) || p.typicalStayNights.length === 0
        || p.typicalStayNights.some(n => !Number.isInteger(n) || n <= 0 || n > 30)) {
      problems.push(`${where}: typicalStayNights must be positive integers ≤ 30`)
    }
    if (!Number.isInteger(p.priority) || p.priority < 1 || p.priority > 9) {
      problems.push(`${where}: priority must be an integer 1..9`)
    }
    if (typeof p.active !== "boolean") problems.push(`${where}: active must be boolean`)
    if (p.refs == null || typeof p.refs !== "object") {
      problems.push(`${where}: refs must be an object (may be empty)`)
    } else {
      for (const [provider, ref] of Object.entries(p.refs)) {
        if (typeof ref !== "string" || !ref.trim()) problems.push(`${where}: empty ref for ${provider}`)
      }
    }
  }
  return problems
}

export interface SeedSummary {
  inserted: number
  updated: number
  refsWritten: number
  /** Property ids present in the DATABASE but no longer in the config. */
  orphaned: string[]
}

/**
 * Upsert the universe into the database. Metadata always follows the config
 * (it is the single source of truth in this phase). Properties removed from
 * the config are NOT deleted — their observation history must survive — but
 * they are deactivated and reported, so a silent config edit cannot leave a
 * ghost property spending observation budget.
 */
export function seedStayProperties(db: DB, config: StayUniverseConfig): SeedSummary {
  const now = nowIso()
  const summary: SeedSummary = { inserted: 0, updated: 0, refsWritten: 0, orphaned: [] }

  const upsert = db.prepare(`
    INSERT INTO stay_properties (
      id, name, destination_group, country, region, nearest_airports, luxury_tier,
      all_inclusive, default_board, typical_stay_nights, priority, active, notes,
      created_at, updated_at
    ) VALUES (
      @id, @name, @destinationGroup, @country, @region, @nearestAirports, @luxuryTier,
      @allInclusive, @defaultBoard, @typicalStayNights, @priority, @active, @notes,
      @now, @now
    )
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      destination_group = excluded.destination_group,
      country = excluded.country,
      region = excluded.region,
      nearest_airports = excluded.nearest_airports,
      luxury_tier = excluded.luxury_tier,
      all_inclusive = excluded.all_inclusive,
      default_board = excluded.default_board,
      typical_stay_nights = excluded.typical_stay_nights,
      priority = excluded.priority,
      active = excluded.active,
      notes = excluded.notes,
      updated_at = excluded.updated_at
  `)
  const upsertRef = db.prepare(`
    INSERT INTO stay_property_refs (property_id, provider, ref)
    VALUES (?, ?, ?)
    ON CONFLICT(property_id, provider) DO UPDATE SET ref = excluded.ref
  `)
  const exists = db.prepare("SELECT 1 FROM stay_properties WHERE id = ?")

  const tx = db.transaction(() => {
    for (const p of config.properties) {
      const already = exists.get(p.id)
      upsert.run({
        id: p.id,
        name: p.name,
        destinationGroup: p.destinationGroup,
        country: p.country,
        region: p.region ?? null,
        nearestAirports: JSON.stringify(p.nearestAirports),
        luxuryTier: p.luxuryTier,
        allInclusive: p.allInclusive,
        defaultBoard: p.defaultBoard,
        typicalStayNights: JSON.stringify(p.typicalStayNights),
        priority: p.priority,
        active: p.active ? 1 : 0,
        notes: p.notes ?? null,
        now,
      })
      if (already) summary.updated++
      else summary.inserted++
      for (const [provider, ref] of Object.entries(p.refs)) {
        upsertRef.run(p.id, provider, ref)
        summary.refsWritten++
      }
    }

    const configIds = new Set(config.properties.map(p => p.id))
    const dbIds = db.prepare("SELECT id FROM stay_properties").all() as { id: string }[]
    for (const { id } of dbIds) {
      if (!configIds.has(id)) {
        summary.orphaned.push(id)
        db.prepare("UPDATE stay_properties SET active = 0, updated_at = ? WHERE id = ?").run(now, id)
      }
    }
  })
  tx()
  return summary
}

// ── Reads ────────────────────────────────────────────────────────────────────

export interface StoredStayProperty {
  id: string
  name: string
  destinationGroup: string
  country: string
  region: string | null
  nearestAirports: string[]
  luxuryTier: LuxuryTier
  allInclusive: AllInclusiveCapability
  defaultBoard: BoardBasis
  typicalStayNights: number[]
  priority: number
  active: boolean
  notes: string | null
  refs: Record<string, string>
}

export function listStayProperties(db: DB, opts: { activeOnly?: boolean } = {}): StoredStayProperty[] {
  const rows = db.prepare(`
    SELECT * FROM stay_properties
    ${opts.activeOnly ? "WHERE active = 1" : ""}
    ORDER BY priority ASC, id ASC
  `).all() as Record<string, unknown>[]
  const refRows = db.prepare("SELECT property_id, provider, ref FROM stay_property_refs")
    .all() as { property_id: string; provider: string; ref: string }[]
  const refsById = new Map<string, Record<string, string>>()
  for (const r of refRows) {
    const refs = refsById.get(r.property_id) ?? {}
    refs[r.provider] = r.ref
    refsById.set(r.property_id, refs)
  }
  return rows.map(r => hydrate(r, refsById.get(r.id as string) ?? {}))
}

export function getStayProperty(db: DB, id: string): StoredStayProperty | null {
  const row = db.prepare("SELECT * FROM stay_properties WHERE id = ?").get(id) as
    Record<string, unknown> | undefined
  if (!row) return null
  const refRows = db.prepare("SELECT provider, ref FROM stay_property_refs WHERE property_id = ?")
    .all(id) as { provider: string; ref: string }[]
  return hydrate(row, Object.fromEntries(refRows.map(r => [r.provider, r.ref])))
}

function hydrate(row: Record<string, unknown>, refs: Record<string, string>): StoredStayProperty {
  return {
    id: row.id as string,
    name: row.name as string,
    destinationGroup: row.destination_group as string,
    country: row.country as string,
    region: (row.region as string) ?? null,
    nearestAirports: JSON.parse(row.nearest_airports as string) as string[],
    luxuryTier: row.luxury_tier as LuxuryTier,
    allInclusive: row.all_inclusive as AllInclusiveCapability,
    defaultBoard: row.default_board as BoardBasis,
    typicalStayNights: JSON.parse(row.typical_stay_nights as string) as number[],
    priority: row.priority as number,
    active: row.active === 1,
    notes: (row.notes as string) ?? null,
    refs,
  }
}
