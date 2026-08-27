/**
 * Transfer Partner Graph
 * 
 * Maps bank/credit card points → airline/hotel programs with transfer ratios.
 * Used to determine: "Can wiz get these miles, and how?"
 * 
 * Sources: TPG, NerdWallet, program pages (as of Feb 2026)
 */

export interface TransferPartner {
  from: string          // Source program key
  fromName: string      // Display name
  to: string            // Destination program key  
  toName: string        // Display name
  ratio: number         // STANDARD published ratio: 1.0 = 1:1, 2.0 = 1:2
  transferTime: string  // "instant" | "1-2 days" | "3-5 days"
  notes?: string
  /**
   * Temporary promotional bonus. Only populated from an explicit, dated
   * source — a temporary bonus hardcoded as a permanent fact would poison
   * every CPP calculation after it expires. No reliable structured feed for
   * these exists today, so entries below carry no bonus; the field is the
   * architecture for when one does.
   */
  bonus?: {
    ratio: number       // effective ratio during the promotion
    startDate: string   // YYYY-MM-DD inclusive
    endDate: string     // YYYY-MM-DD inclusive
    source: string      // where this was announced
  }
}

/**
 * The ratio in effect on a given date: the promotional ratio inside the bonus
 * window, the standard ratio outside it.
 */
export function effectiveRatio(partner: TransferPartner, on: Date = new Date()): number {
  if (!partner.bonus) return partner.ratio
  const day = on.toISOString().slice(0, 10)
  if (day >= partner.bonus.startDate && day <= partner.bonus.endDate) return partner.bonus.ratio
  return partner.ratio
}

// ─── Transfer Partner Data ───────────────────────────────────────────────────

export const TRANSFER_PARTNERS: TransferPartner[] = [
  // Chase Ultimate Rewards
  { from: "chase-ur", fromName: "Chase UR", to: "UNITED", toName: "United MileagePlus", ratio: 1.0, transferTime: "instant" },
  { from: "chase-ur", fromName: "Chase UR", to: "BRITISH_AIRWAYS", toName: "BA Avios", ratio: 1.0, transferTime: "instant" },
  { from: "chase-ur", fromName: "Chase UR", to: "FLYING_BLUE", toName: "Flying Blue", ratio: 1.0, transferTime: "instant" },
  { from: "chase-ur", fromName: "Chase UR", to: "AEROPLAN", toName: "Aeroplan", ratio: 1.0, transferTime: "instant" },
  { from: "chase-ur", fromName: "Chase UR", to: "VIRGIN_ATLANTIC", toName: "Virgin Atlantic", ratio: 1.0, transferTime: "instant" },
  { from: "chase-ur", fromName: "Chase UR", to: "SINGAPORE", toName: "Singapore KrisFlyer", ratio: 1.0, transferTime: "1-2 days" },
  { from: "chase-ur", fromName: "Chase UR", to: "southwest", toName: "Southwest RR", ratio: 1.0, transferTime: "instant" },
  { from: "chase-ur", fromName: "Chase UR", to: "hyatt", toName: "World of Hyatt", ratio: 1.0, transferTime: "instant" },
  { from: "chase-ur", fromName: "Chase UR", to: "marriott", toName: "Marriott Bonvoy", ratio: 1.0, transferTime: "1-2 days" },
  { from: "chase-ur", fromName: "Chase UR", to: "IHG", toName: "IHG One Rewards", ratio: 1.0, transferTime: "1-2 days" },
  // NOTE: Chase → Emirates ENDED Oct 2025

  // Amex Membership Rewards (wiz may have)
  { from: "amex-mr", fromName: "Amex MR", to: "DELTA", toName: "Delta SkyMiles", ratio: 1.0, transferTime: "instant" },
  { from: "amex-mr", fromName: "Amex MR", to: "FLYING_BLUE", toName: "Flying Blue", ratio: 1.0, transferTime: "instant" },
  { from: "amex-mr", fromName: "Amex MR", to: "BRITISH_AIRWAYS", toName: "BA Avios", ratio: 1.0, transferTime: "instant" },
  { from: "amex-mr", fromName: "Amex MR", to: "AEROPLAN", toName: "Aeroplan", ratio: 1.0, transferTime: "instant" },
  { from: "amex-mr", fromName: "Amex MR", to: "VIRGIN_ATLANTIC", toName: "Virgin Atlantic", ratio: 1.0, transferTime: "instant" },
  { from: "amex-mr", fromName: "Amex MR", to: "SINGAPORE", toName: "Singapore KrisFlyer", ratio: 1.0, transferTime: "1-2 days" },
  { from: "amex-mr", fromName: "Amex MR", to: "ANA", toName: "ANA Mileage Club", ratio: 1.0, transferTime: "1-2 days" },
  { from: "amex-mr", fromName: "Amex MR", to: "CATHAY", toName: "Cathay Asia Miles", ratio: 1.0, transferTime: "1-2 days" },
  { from: "amex-mr", fromName: "Amex MR", to: "EMIRATES", toName: "Emirates Skywards", ratio: 1.0, transferTime: "instant" },
  { from: "amex-mr", fromName: "Amex MR", to: "QATAR", toName: "Qatar Privilege Club", ratio: 1.0, transferTime: "1-2 days" },
  { from: "amex-mr", fromName: "Amex MR", to: "ETIHAD", toName: "Etihad Guest", ratio: 1.0, transferTime: "instant" },
  { from: "amex-mr", fromName: "Amex MR", to: "hilton", toName: "Hilton Honors", ratio: 2.0, transferTime: "instant", notes: "1:2 ratio (good for Hilton)" },
  { from: "amex-mr", fromName: "Amex MR", to: "marriott", toName: "Marriott Bonvoy", ratio: 1.0, transferTime: "1-2 days" },

  // Bilt Rewards
  { from: "bilt", fromName: "Bilt Rewards", to: "UNITED", toName: "United MileagePlus", ratio: 1.0, transferTime: "instant" },
  { from: "bilt", fromName: "Bilt Rewards", to: "AMERICAN", toName: "AA AAdvantage", ratio: 1.0, transferTime: "instant" },
  { from: "bilt", fromName: "Bilt Rewards", to: "ALASKA", toName: "Alaska Mileage Plan", ratio: 1.0, transferTime: "instant" },
  { from: "bilt", fromName: "Bilt Rewards", to: "FLYING_BLUE", toName: "Flying Blue", ratio: 1.0, transferTime: "instant" },
  { from: "bilt", fromName: "Bilt Rewards", to: "AEROPLAN", toName: "Aeroplan", ratio: 1.0, transferTime: "instant" },
  { from: "bilt", fromName: "Bilt Rewards", to: "BRITISH_AIRWAYS", toName: "BA Avios", ratio: 1.0, transferTime: "instant" },
  { from: "bilt", fromName: "Bilt Rewards", to: "VIRGIN_ATLANTIC", toName: "Virgin Atlantic", ratio: 1.0, transferTime: "instant" },
  { from: "bilt", fromName: "Bilt Rewards", to: "EMIRATES", toName: "Emirates Skywards", ratio: 1.0, transferTime: "instant" },
  { from: "bilt", fromName: "Bilt Rewards", to: "TURKISH", toName: "Turkish Miles&Smiles", ratio: 1.0, transferTime: "instant" },
  { from: "bilt", fromName: "Bilt Rewards", to: "hyatt", toName: "World of Hyatt", ratio: 1.0, transferTime: "instant" },
  { from: "bilt", fromName: "Bilt Rewards", to: "IHG", toName: "IHG One Rewards", ratio: 1.0, transferTime: "instant" },

  // Marriott → Airlines (typically 3:1, with 5K bonus per 60K transferred)
  { from: "marriott", fromName: "Marriott Bonvoy", to: "UNITED", toName: "United MileagePlus", ratio: 0.333, transferTime: "3-5 days", notes: "3:1 ratio, +5K bonus per 60K" },
  { from: "marriott", fromName: "Marriott Bonvoy", to: "ALASKA", toName: "Alaska Mileage Plan", ratio: 0.333, transferTime: "3-5 days", notes: "3:1 ratio, +5K bonus per 60K" },
  { from: "marriott", fromName: "Marriott Bonvoy", to: "DELTA", toName: "Delta SkyMiles", ratio: 0.333, transferTime: "3-5 days", notes: "3:1 ratio, +5K bonus per 60K" },
  { from: "marriott", fromName: "Marriott Bonvoy", to: "BRITISH_AIRWAYS", toName: "BA Avios", ratio: 0.333, transferTime: "3-5 days", notes: "3:1 ratio, +5K bonus per 60K" },
  { from: "marriott", fromName: "Marriott Bonvoy", to: "AEROPLAN", toName: "Aeroplan", ratio: 0.333, transferTime: "3-5 days", notes: "3:1 ratio, +5K bonus per 60K" },
  { from: "marriott", fromName: "Marriott Bonvoy", to: "FLYING_BLUE", toName: "Flying Blue", ratio: 0.333, transferTime: "3-5 days", notes: "3:1 ratio, +5K bonus per 60K" },
]

// ─── Query Functions ─────────────────────────────────────────────────────────

/** Find all ways to get miles in a specific program */
export function findTransferPaths(toProgramKey: string): TransferPartner[] {
  return TRANSFER_PARTNERS.filter(tp => tp.to === toProgramKey)
}

/** Find all programs a source can transfer to */
export function findTransferOptions(fromProgramKey: string): TransferPartner[] {
  return TRANSFER_PARTNERS.filter(tp => tp.from === fromProgramKey)
}

/** 
 * Given balances and a target program + amount needed, 
 * find the best way to fund it (including combinations)
 */
export interface FundingPath {
  source: string
  sourceName: string
  sourceBalance: number
  pointsToTransfer: number  // How many source points needed
  milesReceived: number     // How many target miles you get
  ratio: number
  transferTime: string
  covers: boolean           // Does this single source cover the full amount?
  notes?: string
}

export function findFundingPaths(
  toProgramKey: string,
  amountNeeded: number,
  balances: { programKey: string; program: string; balance: number }[]
): FundingPath[] {
  const paths: FundingPath[] = []
  
  // Check direct balance first
  const directBalance = balances.find(b => b.programKey === toProgramKey)
  if (directBalance && directBalance.balance > 0) {
    paths.push({
      source: toProgramKey,
      sourceName: directBalance.program,
      sourceBalance: directBalance.balance,
      pointsToTransfer: 0,
      milesReceived: directBalance.balance,
      ratio: 1.0,
      transferTime: "already have",
      covers: directBalance.balance >= amountNeeded,
      notes: "Direct balance",
    })
  }
  
  // Check transfer partners
  const transferPaths = findTransferPaths(toProgramKey)
  for (const tp of transferPaths) {
    const sourceBalance = balances.find(b => b.programKey === tp.from)
    if (!sourceBalance || sourceBalance.balance <= 0) continue

    const ratio = effectiveRatio(tp)
    const milesFromTransfer = Math.floor(sourceBalance.balance * ratio)
    const pointsNeededFromSource = Math.ceil(amountNeeded / ratio)
    
    paths.push({
      source: tp.from,
      sourceName: tp.fromName,
      sourceBalance: sourceBalance.balance,
      pointsToTransfer: Math.min(pointsNeededFromSource, sourceBalance.balance),
      milesReceived: Math.min(milesFromTransfer, amountNeeded),
      ratio,
      transferTime: tp.transferTime,
      covers: milesFromTransfer >= amountNeeded || (directBalance?.balance || 0) + milesFromTransfer >= amountNeeded,
      notes: tp.notes,
    })
  }
  
  // Sort: direct first, then by most miles available
  return paths.sort((a, b) => {
    if (a.transferTime === "already have") return -1
    if (b.transferTime === "already have") return 1
    if (a.covers && !b.covers) return -1
    if (!a.covers && b.covers) return 1
    return b.milesReceived - a.milesReceived
  })
}

/**
 * Quick check: can the user afford this award through any combination?
 */
export function canAfford(
  toProgramKey: string,
  amountNeeded: number,
  balances: { programKey: string; program: string; balance: number }[]
): { affordable: boolean; bestPath: string; details: string; totalAvailable: number; shortfall: number } {
  const paths = findFundingPaths(toProgramKey, amountNeeded, balances)
  const totalAvailable = paths.reduce((sum, p) => sum + p.milesReceived, 0)
  const shortfall = Math.max(0, amountNeeded - totalAvailable)

  if (paths.length === 0) {
    return { affordable: false, bestPath: "none", details: "No balance or transfer path available", totalAvailable: 0, shortfall: amountNeeded }
  }
  
  // Direct balance covers it
  const direct = paths.find(p => p.transferTime === "already have" && p.covers)
  if (direct) {
    return { 
      affordable: true, 
      bestPath: "direct",
      details: `Have ${direct.sourceBalance.toLocaleString()} ${direct.sourceName} (need ${amountNeeded.toLocaleString()})`,
      totalAvailable, shortfall: 0,
    }
  }
  
  // Single transfer covers it
  const singleTransfer = paths.find(p => p.covers && p.transferTime !== "already have")
  if (singleTransfer) {
    return {
      affordable: true,
      bestPath: "transfer",
      details: `Transfer ${singleTransfer.pointsToTransfer.toLocaleString()} ${singleTransfer.sourceName} → ${amountNeeded.toLocaleString()} miles (${singleTransfer.transferTime})`,
      totalAvailable, shortfall: 0,
    }
  }
  
  // Combination might work
  if (totalAvailable >= amountNeeded) {
    return {
      affordable: true,
      bestPath: "combination",
      details: `Combine multiple sources (${totalAvailable.toLocaleString()} available across ${paths.length} sources)`,
      totalAvailable, shortfall: 0,
    }
  }

  return {
    affordable: false,
    bestPath: "insufficient",
    details: `Only ${totalAvailable.toLocaleString()} available, need ${amountNeeded.toLocaleString()}`,
    totalAvailable, shortfall,
  }
}
