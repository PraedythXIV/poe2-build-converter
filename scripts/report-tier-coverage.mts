// Fixture coverage report for the affix-tier matcher. Parses tests/fixtures/pob2-build.xml
// through the REAL pipeline (src/convert summarize -> src/items/tiers lookup, per item domain
// via domainForItem) and reports what fraction of the build's item mod lines resolve to an
// EXACT in-domain tier entry (approx/out-of-range results count as misses — the UI hides
// them), listing every miss.
// Run: npx vite-node scripts/report-tier-coverage.mts   (also spawned by build-mod-tiers.mjs)
//
// Exits non-zero if any modTiers.json key is NOT a fixed point of normalizeModLine — that means
// the builder's canonicalize() drifted from the runtime normalizer and lookups would silently
// miss; tests/itemTiers.test.ts asserts the same invariant plus a coverage floor.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'

// parsePob uses the platform DOMParser (browser native; polyfill for plain node)
;(globalThis as unknown as { DOMParser: typeof DOMParser }).DOMParser = new JSDOM().window.DOMParser

const { summarize } = await import('../src/convert/summarize')
const { lookupTier, normalizeModLine, tierPatternCount } = await import('../src/items/tiers')
const { domainForItem } = await import('../src/items/detailsPanel')
const modTiers = (await import('../src/data/modTiers.json')).default as Record<string, unknown>

// ── normalizer lockstep guard ──
const driftedKeys = Object.keys(modTiers).filter((k) => k !== '_provenance' && normalizeModLine(k) !== k)
if (driftedKeys.length) {
  console.error(`DRIFT: ${driftedKeys.length} modTiers.json keys are not normalizeModLine fixed points:`)
  for (const k of driftedKeys.slice(0, 10)) console.error(`  "${k}" -> "${normalizeModLine(k)}"`)
  process.exit(1)
}
console.log(`normalizer lockstep: all ${tierPatternCount} patterns are fixed points`)

// ── fixture coverage ──
const xml = readFileSync(join(process.cwd(), 'tests', 'fixtures', 'pob2-build.xml'), 'utf8')
const summary = summarize(xml)

let total = 0
let matched = 0
const approxLines: string[] = []
const misses: string[] = []
for (const item of [...summary.items, ...summary.jewels]) {
  const domain = domainForItem(item)
  for (const line of item.mods) {
    total++
    const hit = lookupTier(line, domain)
    if (!hit) {
      misses.push(`${item.slot}: ${line}`)
      continue
    }
    if (hit.approx) {
      // out of every stored roll range — the UI renders the unknown state, so this is a miss
      approxLines.push(`${item.slot}: ${line} (nearest T${hit.tier}/${hit.count} ${hit.min}-${hit.max})`)
      continue
    }
    matched++
  }
}

const pct = total ? ((100 * matched) / total).toFixed(1) : '0'
console.log(`fixture mod lines: ${total}, exact in-domain matches: ${matched} (${pct}%)`)
console.log(`out-of-range / approx — hidden in the UI, counted as misses (${approxLines.length}):`)
for (const a of approxLines) console.log(`  ${a}`)
console.log(`unmatched (${misses.length}):`)
for (const m of misses) console.log(`  ${m}`)
