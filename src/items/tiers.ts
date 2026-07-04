// Affix-tier matcher: maps a parsed PoB item mod line ("+92 to maximum Life") to its tier
// family in the vendored src/data/modTiers.json (built offline by scripts/build-mod-tiers.mjs
// from the GGG Mods/Stats tables + stat_descriptions.csd — no runtime network access).
//
// TIER CONVENTION — T1 = strongest. PoE2 shipped ascending tiers in EA 0.1.x, but patch 0.2.0
// aligned the in-game display with the PoE1 community convention (T1 = best roll), which is
// what the in-game display and the trade site show today. modTiers.json stores each family weakest-first with
// explicit `t` indices (t = count .. 1), so T1 is always the last entry.
//
// Honesty contract: lookups are PER DOMAIN (gear / flask / jewel — modTiers.json shape v2
// stores one ladder per domain under g/f/j). A line that doesn't normalize onto a known
// pattern, or whose pattern has no ladder for the queried domain, returns null (callers say
// "tiers unknown" rather than guessing) — there is NO cross-domain fallback. A matched pattern
// whose VALUE falls outside every tier's roll range returns the nearest tier flagged
// `approx: true` — this happens for class-scaled ladders (two-hand weapons roll higher than
// the stored base ladder), desecrated/corrupted rolls, and hybrid lines that share a pattern
// with a pure family. Renderers MUST NOT display approx results as tiers (the product rule is
// "nothing approximate, ever"); the flag exists so callers can tell "out of range" from "match".

import modTiersJson from '../data/modTiers.json'

/** Item domain a mod line is looked up against (GGG Mods.Domain 1 / 2 / 11). 'flask' covers
 *  flasks AND charms — they share Mods domain 2 and therefore one ladder set. */
export type TierDomain = 'gear' | 'flask' | 'jewel'

/** One tier row as emitted by the builder (weakest-first array; t = count .. 1, T1 strongest). */
export interface TierEntry {
  t: number
  min: number
  max: number
  /** Minimum item level the tier can spawn at (the Mods table's required `Level`). */
  ilvl: number
  /** Extra placeholder roll ranges, for lines like "Adds # to # Physical Damage". */
  more?: number[][]
}

export interface TierMatch {
  /** Tier index, T1 = strongest. */
  tier: number
  /** Total tiers in the family (so callers can render "T2 of 13"). */
  count: number
  /** Displayed roll range of the matched tier (first numeric placeholder). */
  min: number
  max: number
  ilvl: number
  /** True when the line's value fell outside every tier and the nearest one was reported. */
  approx: boolean
}

/** Per-domain ladders for one pattern (modTiers.json shape v2). Absent key = no ladder. */
export interface TierDomainLadders {
  g?: TierEntry[]
  f?: TierEntry[]
  j?: TierEntry[]
}

interface TierTable {
  [pattern: string]: TierDomainLadders
}

const DOMAIN_KEY: Record<TierDomain, keyof TierDomainLadders> = { gear: 'g', flask: 'f', jewel: 'j' }

// Cast away the giant literal type resolveJsonModule would infer (same pattern as lookups.ts);
// _provenance is metadata, every other key is a normalized pattern.
const { _provenance, ...TIERS } = modTiersJson as unknown as TierTable & {
  _provenance: { patch: string; captured: string }
}

/** Trailing parenthesised source flags the PoB parser/preview may append to a mod line. */
const FLAG_SUFFIX_RE = /\s*\((?:rune|enchant|implicit|crafted|fractured|desecrated)\)\s*$/i
/** Signed integer or decimal anywhere in a line. */
const NUMBER_RE = /[+-]?\d+(?:\.\d+)?/g

/**
 * Canonicalize a mod line into the modTiers.json key space:
 * strip "(rune)"-style flags, numbers -> "#" ("5 to 10" -> "# to #", "+4.96%" -> "#%"),
 * collapse whitespace, lowercase. MUST stay in lockstep with `canonicalize` in
 * scripts/build-mod-tiers.mjs — tests assert every table key is a fixed point of this function.
 */
export function normalizeModLine(line: string): string {
  return line
    .replace(FLAG_SUFFIX_RE, '')
    .replace(NUMBER_RE, '#')
    .replace(/[+-]#/g, '#') // a sign the builder left in front of a substituted placeholder
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** First number on the line — drives value-in-range tier selection. Expects a flag-stripped
 *  line (callers strip FLAG_SUFFIX_RE once and share it with normalizeModLine). */
function firstValue(stripped: string): number | null {
  const m = stripped.match(NUMBER_RE)
  return m ? Number(m[0]) : null
}

/**
 * Build a lookup against a given tier table (exported so tests can inject a small fixture).
 * Only the requested domain's ladder is consulted (default 'gear'); a pattern with no ladder
 * for that domain returns null — never a cross-domain fallback.
 * Selection: scan weakest -> strongest and return the first tier whose [min, max] contains the
 * line's first number (ties to the weaker tier on overlapping ranges — never overclaims).
 * Out-of-range values return the boundary-nearest tier with `approx: true` (renderers hide
 * these — see the honesty contract above). Lines with no number only match single-tier
 * families (multi-tier would be a guess -> null).
 */
export function createTierLookup(table: TierTable): (line: string, domain?: TierDomain) => TierMatch | null {
  return (line, domain = 'gear') => {
    // Strip the trailing source flag once and share it: normalizeModLine re-strips harmlessly
    // (already gone), and firstValue reads the numeric value off the same stripped line.
    const stripped = line.replace(FLAG_SUFFIX_RE, '')
    const tiers = table[normalizeModLine(stripped)]?.[DOMAIN_KEY[domain]]
    if (!tiers || tiers.length === 0) return null

    const match = (entry: TierEntry, approx: boolean): TierMatch => ({
      tier: entry.t,
      count: tiers.length,
      min: entry.min,
      max: entry.max,
      ilvl: entry.ilvl,
      approx,
    })

    const v = firstValue(stripped)
    if (v == null) return tiers.length === 1 ? match(tiers[0]!, false) : null

    for (const entry of tiers) {
      if (v >= entry.min && v <= entry.max) return match(entry, false)
    }
    // out of every range: nearest by distance to the closest range boundary
    let best = tiers[0]!
    let bestDist = Infinity
    for (const entry of tiers) {
      const dist = v < entry.min ? entry.min - v : v - entry.max
      if (dist < bestDist) {
        bestDist = dist
        best = entry
      }
    }
    return match(best, true)
  }
}

/** Tier lookup against the vendored game data, per item domain (default 'gear').
 *  Returns null for unmatched lines and for patterns with no ladder in that domain. */
export const lookupTier: (line: string, domain?: TierDomain) => TierMatch | null = createTierLookup(TIERS)

/** Number of known patterns (provenance/debug surface, also asserted by tests). */
export const tierPatternCount: number = Object.keys(TIERS).length
