#!/usr/bin/env tsx
/**
 * Shadow anomaly engine admin.
 *
 *   npx tsx anomaly/cli.ts evaluate            judge observations not yet judged
 *   npx tsx anomaly/cli.ts backfill            re-judge EVERYTHING (§Y, no look-ahead)
 *   npx tsx anomaly/cli.ts candidates [--min 70] [--type cash|award] [--limit 20]
 *   npx tsx anomaly/cli.ts show <id>           one decision in full
 *   npx tsx anomaly/cli.ts feedback <id> <GOOD_DEAL|NORMAL|BAD_SIGNAL> [note]
 *   npx tsx anomaly/cli.ts report [--since ISO]   §X false-positive analysis
 *
 * Every command is database-only: no provider is contacted and no API budget
 * can be spent here. And none of them notify anybody - that is the point.
 */

import "../load-env.js"
import { getDb } from "../db/index.js"
import { loadAnomalyConfig } from "./config.js"
import { evaluateNewObservations, recomputeHistory } from "./engine.js"
import { evaluateOpenJaws } from "./openjaw.js"
import { listCandidates, getCandidate, recordFeedback } from "./store.js"
import { buildReport } from "./report.js"
import { rebuildClusters } from "./clustering.js"
import type { FeedbackVerdict } from "./types.js"

const [command, ...args] = process.argv.slice(2)

function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined
}

// Fixed locale: toLocaleString() follows the machine's locale, which turned
// 12800 into "12.800" on this box and read as twelve-point-eight.
const int = new Intl.NumberFormat("en-US")

function money(c: { type: string; priceAmount: number | null; priceCurrency: string | null; points: number | null; taxesAmount: number | null; taxesCurrency: string | null }): string {
  if (c.type === "cash") return `${c.priceAmount} ${c.priceCurrency}`
  const taxes = c.taxesAmount !== null ? ` + ${c.taxesAmount} ${c.taxesCurrency ?? ""}`.trimEnd() : ""
  return `${int.format(c.points ?? 0)} pts${taxes}`
}

function main() {
  const db = getDb()
  const config = loadAnomalyConfig()

  switch (command) {
    case "evaluate":
    case "backfill": {
      const fromScratch = command === "backfill"
      console.log(
        fromScratch
          ? "Re-judging every stored observation against ONLY its own past (no look-ahead)."
          : "Judging observations recorded since the last evaluation.",
      )
      const summary = fromScratch ? recomputeHistory({ db, config }) : evaluateNewObservations({ db, config })
      // §2 open jaws are decisions about PAIRS of observations, so they are not
      // reached by the row-driven pass above. Re-assembling them here means a
      // backfill re-judges the whole picture, not the part of it that happens
      // to be one row per decision.
      const jaws = evaluateOpenJaws({ db, config, quiet: true })
      // Scores just changed, so the families that present them are stale.
      // Rebuilding here keeps the feed's stored "best member" honest without
      // anybody having to remember a second command.
      const clustered = rebuildClusters(db, { minScore: 0 })
      console.log(`\nEvaluated          ${summary.evaluated} (cash ${summary.byType.cash}, award ${summary.byType.award})`)
      console.log(`Candidates >= ${config.candidateThreshold}   ${summary.candidates}`)
      console.log(`Below threshold    ${summary.belowThreshold}${config.storeBelowThreshold ? " (stored for review)" : " (not stored)"}`)
      console.log(`Skipped, thin      ${summary.skippedThinBaseline} (fewer than ${config.minSamplesToEmit} prior comparable observations)`)
      console.log(`Skipped, no data   ${summary.skippedNoBaseline}`)
      console.log(
        `Open jaws          ${jaws.combinationsFound} assembled, ${jaws.combinationsStored} recorded, ` +
        `${jaws.candidates} at or above ${config.candidateThreshold}` +
        `${jaws.noComparator > 0 ? `, ${jaws.noComparator} with no comparable round trip` : ""}`,
      )
      console.log(`Top score          ${summary.topScore ?? "n/a"}`)
      console.log(`Duration           ${summary.durationMs}ms`)
      console.log(`Clusters rebuilt    ${clustered.clusters} families from ${clustered.candidatesClustered} candidates`)
      console.log(`\nEXPERIMENTAL - decisions stored, nothing sent. Alerts are off by design.`)
      break
    }

    case "candidates": {
      const min = Number(flag("min") ?? config.candidateThreshold)
      const limit = Number(flag("limit") ?? 20)
      const type = flag("type") as "cash" | "award" | undefined
      const rows = listCandidates(db, { minScore: min, limit, type, status: "candidate" })
      if (rows.length === 0) { console.log(`No candidates at or above ${min}.`); break }
      console.log(`Shadow candidates >= ${min} (EXPERIMENTAL - no alerts were sent)\n`)
      for (const c of rows) {
        console.log(
          `#${String(c.id).padEnd(5)} ${String(c.score).padStart(5)}  ${c.route} ${c.cabin.padEnd(9)} ${c.type.padEnd(5)} ` +
          `${c.departureDate}${c.returnDate ? `+${c.returnDate}` : ""}  ${money(c)}`,
        )
        console.log(
          `        vs median ${int.format(c.baseline.median)}${c.type === "award" ? " pts" : ""}, ` +
          `${c.baseline.percentBelowMedian}% below, ${c.baseline.percentile}th pct of ${c.baseline.count} obs ` +
          `(${c.baseline.confidence}${c.baseline.scope === "strict" ? "" : `, ${c.baseline.scope}`})` +
          `${c.cpp?.cpp != null ? `, ${c.cpp.cpp}c/pt` : ""}`,
        )
        console.log(`        ${c.reasons.map(r => r.code).join(" ")}${c.presetsMatched.length ? `  [would match: ${c.presetsMatched.join(", ")}]` : ""}`)
        if (c.feedback) console.log(`        feedback: ${c.feedback.verdict}`)
      }
      break
    }

    case "show": {
      const id = Number(args[0])
      const c = id ? getCandidate(db, id) : null
      if (!c) { console.error(`Unknown candidate: ${args[0]}`); process.exit(1) }
      console.log(JSON.stringify(c, null, 2))
      break
    }

    case "feedback": {
      const id = Number(args[0])
      const verdict = (args[1] || "").toUpperCase() as FeedbackVerdict
      const note = args.slice(2).join(" ") || null
      if (!id || !["GOOD_DEAL", "NORMAL", "BAD_SIGNAL"].includes(verdict)) {
        console.error("Usage: anomaly feedback <id> <GOOD_DEAL|NORMAL|BAD_SIGNAL> [note]")
        process.exit(1)
      }
      recordFeedback(db, id, verdict, { note, source: "cli" })
      console.log(`Recorded ${verdict} for candidate #${id}`)
      break
    }

    case "report": {
      const report = buildReport(db, { since: flag("since") })
      const t = report.totals
      console.log(`Shadow engine report (${report.generatedAt})\n`)
      console.log(`Decisions stored   ${t.decisions}  (candidates ${t.candidates}, below threshold ${t.belowThreshold})`)
      console.log(`By type            cash ${t.cash}, award ${t.award}`)
      console.log(`Human verdicts     GOOD_DEAL ${report.verdicts.GOOD_DEAL}, NORMAL ${report.verdicts.NORMAL}, BAD_SIGNAL ${report.verdicts.BAD_SIGNAL} (${t.withFeedback} judged)`)

      if (report.presets.length) {
        console.log(`\nWould have matched presets (config only, no alerts):`)
        for (const p of report.presets) console.log(`  ${p.preset.padEnd(8)} ${p.candidates}`)
      }

      console.log(`\nReason codes on candidates${report.verdicts.BAD_SIGNAL + report.verdicts.GOOD_DEAL + report.verdicts.NORMAL === 0 ? " (no verdicts yet - correlation column stays empty until you judge some)" : ""}:`)
      for (const r of report.reasonCorrelation.slice(0, 20)) {
        console.log(
          `  ${r.code.padEnd(30)} ${String(r.candidates).padStart(5)} candidates` +
          (r.judged > 0 ? `  judged ${r.judged}: good ${r.good} / normal ${r.normal} / bad ${r.bad} → ${r.badSignalRate}% bad` : ""),
        )
      }

      console.log(`\nCandidates per route (a high rate means this route floods the list):`)
      for (const r of report.routeVolume.slice(0, 20)) {
        console.log(
          `  ${r.route} ${r.cabin.padEnd(9)} ${r.type.padEnd(5)} ${String(r.candidates).padStart(5)} of ${String(r.observations).padStart(6)} obs ` +
          `(${r.candidateRate}%), avg ${r.averageScore}, max ${r.maxScore}`,
        )
      }

      console.log(`\nScore distribution:`)
      for (const b of report.scoreBuckets) console.log(`  ${b.bucket.padEnd(8)} ${String(b.count).padStart(6)}${b.judgedBad ? `  (${b.judgedBad} judged bad)` : ""}`)

      console.log(`\nBaseline confidence of candidates:`)
      for (const c of report.confidenceMix) console.log(`  ${c.confidence.padEnd(13)} ${String(c.candidates).padStart(6)}  avg score ${c.averageScore}`)

      console.log(`\n${report.note}`)
      break
    }

    default:
      console.log(`Unknown command: ${command ?? "(none)"}

Commands:
  evaluate                    judge observations not yet judged
  backfill                    re-judge everything (baseline still capped at each observation's own past)
  candidates [--min N] [--type cash|award] [--limit N]
  show <id>                   one decision in full, including its score breakdown
  feedback <id> <GOOD_DEAL|NORMAL|BAD_SIGNAL> [note]
  report [--since ISO]        false-positive analysis

All commands are local database work. Nothing here calls a provider, spends
budget, or notifies anybody - the engine runs in shadow mode.`)
      process.exit(command ? 1 : 0)
  }
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("anomaly/cli.ts")
if (isMain) {
  try {
    main()
  } catch (err) {
    console.error("❌", (err as Error).message)
    process.exit(1)
  }
}
