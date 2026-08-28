/**
 * The Stay Opportunity Score: 0–100, component-based, explainable.
 *
 * Assembly rules carried over from the flight engine because each one was
 * paid for there:
 *   - a component whose input is UNCOMPUTABLE is dropped and the surviving
 *     weights renormalise — but it is still REPORTED at weight 0 so a reader
 *     sees what was missing;
 *   - a component that ran and scored a legitimate ZERO keeps its weight —
 *     renormalising away a real zero silently inflates every other component
 *     (measured on the flight side: ×1/(1−w) per dropped zero);
 *   - a no-history decision is CAPPED: evidence outranks assertion.
 */

export interface StayScorePart {
  /** null = uncomputable (drop + renormalise); a number = computed, keep. */
  raw: number | null
  weight: number
  detail: string
}

export interface StayScoreComponent {
  raw: number | null
  weight: number          // effective (post-renormalisation) weight, 0 if dropped
  points: number
  detail: string
}

export interface StayScoreResult {
  score: number
  components: Record<string, StayScoreComponent>
  weightsVersion: string
  capped: boolean
}

export function assembleStayScore(
  parts: Record<string, StayScorePart>,
  weightsVersion: string,
  cap?: { max: number; detail: string },
): StayScoreResult {
  const entries = Object.entries(parts)
  const usable = entries.filter(([, p]) => p.raw !== null)
  const totalWeight = usable.reduce((sum, [, p]) => sum + p.weight, 0)

  const components: Record<string, StayScoreComponent> = {}
  let score = 0
  for (const [name, part] of entries) {
    if (part.raw === null || totalWeight === 0) {
      components[name] = { raw: null, weight: 0, points: 0, detail: `not available — ${part.detail}` }
      continue
    }
    const weight = part.weight / totalWeight
    const points = clamp01(part.raw) * weight * 100
    components[name] = { raw: part.raw, weight: round3(weight), points: round1(points), detail: part.detail }
    score += points
  }

  let capped = false
  if (cap && score > cap.max) {
    components.noHistoryCap = {
      raw: null, weight: 0, points: round1(cap.max - score), detail: cap.detail,
    }
    score = cap.max
    capped = true
  }

  if (!Number.isFinite(score)) score = 0
  return {
    score: Math.round(Math.max(0, Math.min(100, score)) * 10) / 10,
    components,
    weightsVersion,
    capped,
  }
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}
function round1(n: number): number {
  return Math.round(n * 10) / 10
}
function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}
